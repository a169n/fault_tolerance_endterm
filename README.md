# Fault-Tolerant University Information System

A small distributed university platform (students, payments, transcripts,
timetables), built **twice**: a **baseline** and a **fault-tolerant** version. Both
versions get the same faults injected, and the measured difference shows what the
fault-tolerance mechanisms buy.

Both versions are **one and the same code and image**. The only difference is the
switch `FT_ENABLED=0|1` (plus `RESTART_POLICY`), so every measured difference is
caused by the mechanisms and nothing else.

Stack: Python + FastAPI, PostgreSQL 16 with streaming replication, Docker Compose,
Prometheus. The experiment harness is TypeScript on Node 22.

## Project map

```text
docker-compose.yml        the deployment: 2 replicas per service, DB primary + standby,
                          and every infrastructure mechanism (H1–H5), labelled

app/                      everything that runs inside the containers
├── services/             WHAT the system does: the business logic
│   ├── gateway.py          single entry point; wires the mechanisms together
│   ├── student.py          2 replicas
│   ├── payment.py          2 replicas, the money path
│   ├── transcript.py       1 instance, serves stale data when the DB is down
│   ├── timetable.py        2 replicas, long-running jobs
│   └── schedule.py         pure timetable placement algorithm
├── fault_tolerance/      HOW it survives failures (README.md = full list)
│   ├── software/           S1–S10, one file per mechanism
│   │   ├── retry.py              S1 retry + exponential backoff
│   │   ├── timeouts.py           S2 timeouts (+ S8 fail-fast writes)
│   │   ├── circuit_breaker.py    S3
│   │   ├── health_check.py       S4
│   │   ├── idempotency.py        S5 no double charges
│   │   ├── checkpoint_rollback.py S6 payments
│   │   ├── degradation.py        S7 stale cache
│   │   └── job_checkpoint.py     S10 timetable jobs
│   └── infrastructure/     code side of H1 and H2
│       ├── load_balancer.py      H1 round robin over replicas
│       └── db_failover.py        H2 read from the standby
├── core/                 plumbing: db.py, eventlog.py (+ /metrics), service.py
└── fault_injection.py    /chaos endpoints the experiments use to break things

config/                   PostgreSQL schema + seed data + roles, pg_hba.conf,
                          prometheus/ (scrape config, alert rules + tests), grafana/ (dashboard)

experiments/              HOW the experiments are run
├── scenarios.ts            the 6 failure scenarios: inject + repair
├── workload.ts             load generator, records every request
├── run.ts                  one experiment end to end
├── campaign.ts             all 6 scenarios in a row
├── metrics.ts              MTTF, MTBF, MTTR, availability, data consistency
├── demo.ts                 live demonstration of 4 failure-and-recovery scenarios
├── env.ts                  mode → .env builder (pure, tested by env.test.ts)
└── up.ts                   deploy a mode (npm run up:baseline | up:midterm | up:endterm)

logs/                     raw data: logs/<scenario>__<mode>/{workload,events}.jsonl.gz
reports/                  everything written up
├── REPORT.md               ◀ the technical report (start here)
├── ARCHITECTURE.md         diagrams: deployment and code layers
├── COMPARISON.md           baseline vs fault-tolerant
├── METHODOLOGY.md          how the experiments were run and measured
├── EXPERIMENT-LOG.md       every run, one row each
└── runs/<scenario>__<mode>/REPORT.md, metrics.json   one report per run (run.ts writes metrics.json)

```

## Running

Same commands on Windows, macOS and Linux. Needs Docker and Node.js 22.6 or newer
(`node --version`; with nvm: `nvm use 22`). No other dependencies.

`npm run up:<mode>` writes `.env` (see `.env.example`): the mode switches are
overwritten each time, secrets already in `.env` are kept, and missing ones are
generated randomly. `.env` is git-ignored. The midterm as submitted is tagged
`midterm-final`.

    npm run up:baseline     # deploy the baseline           (FT_ENABLED=0, ENDTERM_ENABLED=0)
    npm run up:midterm      # deploy the midterm FT system  (FT_ENABLED=1, ENDTERM_ENABLED=0)
    npm run up:endterm      # deploy the endterm system     (FT_ENABLED=1, ENDTERM_ENABLED=1)
    npm run up:ft           # alias of up:midterm, kept so the midterm docs stay valid
    npm run mode            # which mode is running now: baseline | midterm | endterm
    npm run test:harness    # unit tests of the TypeScript harness (node --test)

    npm run demo            # live demo: app crash, DB failure, node failure, timetable
    npm run demo -- db-failure   # just one scenario
    npm run exp app-crash   # one controlled experiment
    npm run campaign        # all six against the deployed version

    # Monitoring is always on: Prometheus http://localhost:9090 (alerts: /alerts),
    # Grafana http://localhost:3000/d/university (anonymous read-only; admin password in .env)
    npm run test:alerts     # promtool unit tests for the alert rules
    # Swagger UI:           http://localhost:8080/docs  (every service: :30xx/docs)

After pulling schema changes, recreate the database once: `docker compose down -v`.

## Services and ports

| Component | Port | Instances |
|---|---|---|
| nginx (entry point) | 8080 | 1; `config/nginx/single.conf` (baseline, midterm) or `redundant.conf` (endterm) |
| gateway-1 / gateway-2 | 127.0.0.1:8081 / 8082 | 2; only endterm puts gateway-2 in nginx rotation |
| student-1 / student-2 | 3011 / 3012 | 2 replicas |
| payment-1 / payment-2 | 3021 / 3022 | 2 replicas |
| timetable-1 / timetable-2 | 3041 / 3042 | 2 replicas |
| transcript-1 | 3031 | 1 |
| auth-1 | 127.0.0.1:3051 | 1; issues JWTs, reached through the gateway as `POST /auth/token` |
| postgres-primary / postgres-replica | 55432 / 55433 | primary + hot standby |
| prometheus | 127.0.0.1:9090 | 1, always on (alert rules: `config/prometheus/alerts.yml`) |
| grafana | 127.0.0.1:3000 | 1, always on (dashboard `university`) |
| postgres-exporter | 127.0.0.1:9187 | 1, always on (`pg_up`, replication) |

## Logging in

The auth service issues 15-minute JWTs (HS256) through the gateway. The demo users are
`admin` (admin), `bursar` (staff), `s7` and `s8` (students), all with `DEMO_PASSWORD` from `.env`:

    curl -s localhost:8080/auth/token -d '{"username":"bursar","password":"'$DEMO_PASSWORD'"}'

Only endterm requires the token on `/api/*` (Task 9). The gateway verifies it with
`JWT_SECRET`, so an `auth-1` outage blocks new logins but not existing sessions.

## Breaking it by hand

    curl -X POST localhost:3011/chaos/crash                              # application crash
    curl -X POST localhost:3011/chaos -d '{"latencyMs":3000}'            # slow service
    curl -X POST localhost:3021/chaos -d '{"crashAfterCheckpoint":true}' # interrupted payment
    docker compose stop postgres-primary                                 # database failure
    docker compose kill student-1 payment-1                              # node failure

`docker compose kill` is an operator stop and deliberately does **not** trip the
restart policy, which makes it a faithful "the node is gone" simulation. An
application crash must therefore come from inside the process (`/chaos/crash`).

## Measurement

Every service appends one JSON line per event to `logs/events.jsonl`:

    {"ts":…,"svc":"gateway","ft":1,"kind":"health","target":"http://student-1:3000","ok":false}
    {"ts":…,"svc":"gateway","ft":1,"kind":"route","instance":"http://student-2:3000","attempts":2}
    {"ts":…,"svc":"payment-1","ft":1,"kind":"recovery","action":"duplicate_suppressed"}

Every metric in `reports/` is computed from this log plus the per-request workload
log; no number is asserted without raw data behind it. The same events are counted
live on `GET /metrics` of every service for Prometheus.
