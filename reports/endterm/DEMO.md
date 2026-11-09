# Demonstration script

The live demo is [`experiments/demo.ts`](../../experiments/demo.ts) (`npm run demo`). It runs against the
local Docker stack only, with synthetic data. The spec asks for at least 3 scenarios, including one
service failure and one security test. The default order covers both kinds and adds a database failure:

| # | Demo | Kind | What the audience sees |
|---|---|---|---|
| 1 | `app-crash` | service failure | student-1 kills itself; reads stay 2xx and the restart policy brings it back |
| 2 | `db-failure` | data-store failure | reads served by the standby or stale cache, payments fail fast |
| 3 | `gateway-failure` | service failure (endterm addition) | gateway-1 is killed under live traffic; a per-second status histogram stays 2xx |
| 4 | `unauthorized` | security | missing/forged/expired/`alg:none` tokens get 401, s7 paying for s8 gets 403; audit lines by `rid`; DB unchanged |
| 5 | `abuse` | security / misuse | malformed input gets 422/400/413 (never 5xx), a burst gets 429 with `Retry-After`, brute force gets 429; every instance stays healthy |

Four more demos run on request: `outlier` (a slow replica is ejected, shown by the gateway gauge),
`alerts` (Prometheus alerts during a database failure), `node-failure` and `timetable` (both from the
midterm).

> **Recording:** _not yet recorded. The fallback screen capture is made in the rehearsal (Task 18 Step 2) and linked here._

## Before the demo

1. Bring up the mode to show. All three work, and each demo prints what to expect in the deployed mode:

   ```bash
   npm run up:endterm      # or up:baseline / up:midterm for the contrast
   npm run mode            # prints baseline | midterm | endterm
   ```

2. Open these three windows next to the terminal:
   - Grafana: `http://localhost:3000/d/university` (anonymous read-only)
   - Prometheus alerts: `http://localhost:9090/alerts`
   - a second terminal for `tail -f logs/events.jsonl | grep <rid>` when you want to show one request's trail.
3. Do not run the demo while an experiment or the campaign is running. Both drive the same stack, and
   the demo's faults would land in the campaign's measurements.

The demo reads its secrets from the generated `.env` and never prints them:
- `DEMO_PASSWORD`: endterm logs in as `bursar` (staff) for the client traffic, as `s7` for the security demos, and as `admin` for the timetable job.
- `CHAOS_TOKEN`: sent as `x-chaos-token` on every `/chaos` call. Endterm refuses `/chaos` without it, and baseline and midterm ignore it.
- `JWT_SECRET`: used only to make an *expired* token with a genuine signature, and a forged one signed with a different key.

In baseline and midterm there is no authentication in the request path, so the demo does not log in
and sends its requests without `Authorization`.

## Running it

```bash
npm run demo                    # default order: app-crash, db-failure, gateway-failure, unauthorized, abuse
npm run demo -- full            # all nine demos
npm run demo -- unauthorized    # one demo
```

With more than one demo, it waits for Enter between them. Every demo starts with a line
`expected in <mode>: ...` and ends with `Grafana (this step): <url>`. That link opens the dashboard on
that demo's own time window, padded by 15 s on each side.

## Script, step by step

The "expected" blocks below come from the design (the `EXPECT` table in `demo.ts`). They are **not a
recorded run**. `N`, `M` and `<...>` stand for numbers the live run prints. The rehearsal checks them
against the real output.

### 1. Application crash (`app-crash`, about 12 s)

Say: "student-1 kills its own process. Watch the read histogram."

```text
  before   students: 200 xN
  >> student-1 crashed (POST /chaos/crash)
  during   students: ...
           gateway view: {...}   (the gateway's health-check verdict per instance; empty in baseline, which has no health check)
  after 8s students: ...
```

| Mode | Expected |
|---|---|
| baseline | `during` and `after` show failures (no health check or retry; the restart policy is `no`, so student-1 stays down) |
| midterm | `during` is all 2xx (the health check and retry route around it); student-1 is back `after 8s` |
| endterm | as midterm |

Point at: Grafana "Instance health" (student-1 drops and comes back), and `InstanceDown` on the
Prometheus page (it may fire if the restart takes more than 4 s).

### 2. Database failure (`db-failure`, about 10 s)

Say: "We stop the PostgreSQL primary."

| Mode | Expected `during` line |
|---|---|
| baseline | students, transcripts and payments fail (5xx or `000`) |
| midterm | students 200 (hot standby), transcripts 200 or 203 (stale cache), payments 503 (fail fast, nothing hangs) |
| endterm | as midterm |

Point at: "DB primary `pg_up`" and "Gateway 5xx ratio". The `alerts` demo shows `DatabaseDown` firing.

### 3. Gateway failure (`gateway-failure`, 16 s)

Say: "Four clients keep reading and paying through nginx. At t+3 s we kill gateway-1, and at t+11 s we
start it again. Each line is one second of client traffic."

```text
  t+ 0s  200 xN  201 xM                 avg  .. ms  p95  .. ms
  t+ 3s  >> kill gateway-1 (docker compose kill)
  t+ 3s  ...
  t+11s  >> start gateway-1
  ...
  while gateway-1 was down: <histogram>
  instances now: gateway-1 up, gateway-2 up, ...
```

| Mode | Expected from t+3 s to t+11 s |
|---|---|
| baseline | nginx has only gateway-1 (`single.conf`): every request is `502` or `000` |
| midterm | same as baseline: the single gateway is a single point of failure |
| endterm | nginx fails over to gateway-2 (`redundant.conf`, `max_fails=1`, 1 s connect timeout): 2xx throughout. At most a handful of requests in flight at the kill take the retry path. A re-sent payment carries the client's `Idempotency-Key`, so it is not charged twice |

Point at: Grafana "Request rate by status" (no gap in endterm) and `InstanceDown{instance="gateway-1:8080"}`.

### 4. Unauthorized access (`unauthorized`, about 5 s)

Say: "An attacker tries to pay 13.37 into student s8's account five ways: with no token, with an
admin token signed with the wrong key, with an expired admin token, with an unsigned (`alg:none`)
admin token, and as student s7 with s7's real token."

```text
  each attack is POST /api/payments {studentId: "s8", amount: 13.37}
  no token                         -> 401   rid=attack-demo-<ms>-0
  forged signature (admin claims)  -> 401   rid=attack-demo-<ms>-1
  expired token (admin claims)     -> 401   rid=attack-demo-<ms>-2
  alg:none token (admin claims)    -> 401   rid=attack-demo-<ms>-3
  student s7 pays for s8           -> 403   rid=attack-demo-<ms>-4
  audit lines for these rids (logs/events.jsonl):
    gateway-N  rid=attack-demo-<ms>-0  deny 401 missing_token  POST /api/payments  sub=-
    gateway-N  rid=attack-demo-<ms>-1  deny 401 bad_signature  POST /api/payments  sub=-
    ...
    gateway-N  rid=attack-demo-<ms>-4  deny 403 not_owner  POST /api/payments  sub=s7 (student)
  attacker payments in the DB (amount 13.37): before N, after N
  PASS: all 5 refused (401 x4  403 x1); DB unchanged
  follow one request through every hop: grep attack-demo-<ms>-0 logs/events.jsonl
```

| Mode | Expected |
|---|---|
| baseline | every attack is accepted (2xx); `after` is `before + 5`; no audit lines; the verdict reads `ACCEPTED: 5 of 5 ...` |
| midterm | same as baseline |
| endterm | 401 x4, 403 x1; one audit `deny` line per rid; `after == before`; `PASS` |

Point at: the audit lines (no password, token or `Authorization` header in them, Task 9). Then run
the `grep` the demo prints. It shows every line logged under that `rid`: nginx forwards the
client's `X-Request-ID`, so the gateway's request line and its audit line carry the same id. In Grafana: "Auth denied and rate limited". Five denials are far below the
`AuthFailureSpike` threshold (more than about 60 in 30 s, ALERTS.md), so the alert does not fire here.
The `abuse` demo right after it does reach that volume.

The DB check counts payments with the attack amount 13.37, which no legitimate request uses. It runs
`psql` as the operator over `docker compose exec`, the same way the experiment harness does.

### 5. Abuse (`abuse`, about 5 to 10 s)

Say: "Now misuse rather than intrusion: bad input, a flood and a password guesser."

```text
  malformed input (23 requests: 20 bad payment bodies, invalid JSON, 1 MiB body, bad path):
    <histogram>
  burst: 1000 GETs of /api/students/s7 as s7 in <ms> ms
    2xx N   429 M (Retry-After on M, e.g. "<s>")   other 0
  login brute force: 20 wrong passwords for s7: 401 xN  429 xM   (first 429 at attempt K)
  instances after the abuse: gateway-1 up, gateway-2 up, auth-1 up, student-1 up, ...
```

| Mode | Expected |
|---|---|
| baseline | some malformed bodies are listed as `ACCEPTED` (e.g. a negative amount) or `SERVER ERROR` (e.g. `amount: 1e9` overflows `NUMERIC(10,2)`); the burst is all 2xx; the brute force is 20 x 401 |
| midterm | same as baseline |
| endterm | malformed: only 422/400/413, nothing listed; burst: at most about 2 x (20 + 10/s x window) answered 2xx (two gateways, each with the student quota), the rest 429, every 429 with `Retry-After`; brute force: 401 for the first 5 to 10 tries (5 per gateway), then 429; every instance `up` |

Point at: Grafana "Auth denied and rate limited" (the `rate_limited` series) and, in endterm,
`AuthFailureSpike` on the Prometheus page (the burst alone is several hundred denials).

After the brute force, the login quota (1/s per client IP, burst 5) blocks new logins for a few
seconds. The demo logs in at the start of each demo and reuses its tokens for up to 10 minutes, so
this does not affect the next demo.

### Optional: outlier ejection (`outlier`, 24 s)

Say: "student-1 becomes slow: 3 s per request. Watch the latency columns and the `ejected:` column,
read from each gateway's `/metrics`."

| Mode | Expected from t+2 s to t+18 s |
|---|---|
| baseline | requests that land on student-1 take about 3 s (one attempt, no timeout); `ejected: gw1=- gw2=-` (no ejection) |
| midterm | each request that lands on student-1 pays the 800 ms attempt timeout before the retry on student-2; `ejected: gw1=- gw2=-` (the breaker is per pool and the retry succeeds, so nothing is taken out) |
| endterm | after 3 consecutive timeouts on a gateway, `ejected: gw1=student-1 gw2=student-1`, and avg/p95 drop back; every 10 s the ejection expires, student-1 is probed again and ejected again while it is still slow |

Point at: Grafana "Outlier ejection" and "Upstream attempts by instance and outcome" (`timeout` for
student-1).

### Optional: alerting (`alerts`, up to about 100 s)

Say: "Monitoring runs in every mode. We stop the primary again and watch Prometheus decide."

```text
  alerts before: (none firing or pending)   (http://localhost:9090/alerts)
  t+0.Xs  >> postgres-primary stopped
  t+X.Xs  pending  DatabaseDown
  t+X.Xs  firing   DatabaseDown
  DatabaseDown firing X.X s after the stop (1 s polling)
  ...
  >> postgres-primary started
  DatabaseDown resolved X.X s after the restart
  client traffic during the demo: <histogram>
```

The configuration bounds the detection time at about 4 to 10 s (ALERTS.md). The time the demo
prints is the live observation. Light client traffic runs throughout, because `HighErrorRate` is a
ratio and cannot fire without requests. `HighErrorRate` may fire in every mode (payments fail), and
is expected in baseline (the reads fail too).

### Optional: node failure and timetable (midterm demos)

`node-failure` kills student-1 and payment-1 together. In midterm and endterm, the surviving node
carries everything. In baseline, about half of the requests fail.

`timetable` starts a 120-step job and crashes its owner. In midterm and endterm, the job resumes
from its last checkpoint on the other replica and reaches `done`. In baseline, it stays `running`.
In endterm, the job is started with the `admin` token, because only admin may `POST /api/timetables`.

## After the demo

Every fault the demo injects is repaired by the demo itself (`docker compose start`, `/chaos` reset).
If a demo is interrupted (Ctrl-C), repair by hand:

```bash
node --experimental-strip-types experiments/scenarios.ts db-failure repair       # or app-crash / gateway-failure / node-failure
curl -s -X POST localhost:3011/chaos -H 'content-type: application/json' \
  -H "x-chaos-token: $(grep ^CHAOS_TOKEN .env | cut -d= -f2)" -d '{"latencyMs":0}'   # after an interrupted outlier demo
```

In baseline and midterm, the security demos write rows: the accepted attacker payments and some
malformed payments. The experiment harness truncates `payments` and removes non-seed students before
every run (`experiments/run.ts`), so the demo cannot leak into measurements. `npm run up:<mode>` keeps the data volumes. For a clean
database before a second demo, run `docker compose down -v` and then `npm run up:<mode>`.
