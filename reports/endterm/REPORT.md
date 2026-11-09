# Resilient University Information System — Endterm Technical Report

Course: Fault Tolerance and Dependable Computing — Endterm project (continuation of the midterm)

Team: Aibyn Talgatov, CSE-2505M (`a169n` / `Aibyn`) and Gani Uapov, CSE-2502M (`9an1`). How the work
was done, and by whom, is in §11.6.

**Status of this document.** Sections 1 to 7 and the appendix describe the design, the implementation
and the methodology. They do not depend on the measured results. Sections 8, 9 and 10 are filled in
from `reports/endterm/RESULTS.md` once the three-mode campaign has finished. Until then they hold a
placeholder and **this report makes no claim about how the endterm system performs**. The only
measured numbers below are midterm numbers, each one cited from the committed midterm report
(`reports/REPORT.md`) or comparison (`reports/COMPARISON.md`), and the dependency-audit count of §5.4,
cited from its committed output file.

---

## 1. Introduction and relationship to the midterm project

The midterm project built a small university platform (students, payments, transcripts, timetables)
twice from one image: a **baseline** with no fault-tolerance logic and a **fault-tolerant** version
(`FT_ENABLED=1`). It injected six faults into each and measured the difference
([`reports/REPORT.md`](../REPORT.md), [`reports/COMPARISON.md`](../COMPARISON.md)). The midterm
submission is frozen at git tag `midterm-final` (commit `51100cf`).

The endterm extends that system. It does not replace it (spec §4). The same four business services,
the same payment workflow (idempotency key, checkpoint before the charge, rollback sweep), the same
PostgreSQL primary with a hot standby and the same TypeScript experiment harness are reused. On top of
them the endterm adds the four topics of the assignment:

- **cloud and microservice resilience:** a redundant gateway pair behind nginx, per-instance outlier
  ejection, a liveness/readiness split and container healthchecks;
- **fault detection and observability:** correlation IDs on every hop, request, latency, upstream and
  security metrics, an always-on Prometheus/Grafana/postgres-exporter monitoring plane and six alert
  rules with unit tests;
- **security and intrusion tolerance:** an auth service issuing short-lived JWTs, an authorization
  policy enforced at the gateway, audit logging, strict input validation, rate limiting, generated
  secrets, least-privilege database roles and a locked-down chaos endpoint;
- **verification and fault injection:** unit, harness, configuration and integration tests, a CI
  pipeline, four new scenarios (ten in total, E1 to E10), explicit acceptance criteria, alert and
  resource capture, key-level integrity checks, three repetitions per mode and three modes.

### 1.1 Three deployable modes

The midterm's two modes become three, all from one image and one `docker-compose.yml`
(`experiments/env.ts`, `npm run up:<mode>`):

| Mode | `FT_ENABLED` | `ENDTERM_ENABLED` | Restart policy | nginx config | Role in the comparison |
|---|---|---|---|---|---|
| baseline | 0 | 0 | `no` | `single.conf` (gateway-1 only) | the midterm baseline: redundancy exists, no software uses it |
| midterm | 1 | 0 | `unless-stopped` | `single.conf` | the midterm fault-tolerant system |
| endterm | 1 | 1 | `unless-stopped` | `redundant.conf` (gateway-1 ⇄ gateway-2) | this project |

`ENDTERM_ENABLED=1` gates every new **behaviour**: outlier ejection, the second gateway in rotation,
authentication and authorization, strict validation, rate limiting, the required payment
`Idempotency-Key` and the chaos-token check. Correlation IDs, metrics, structured logs, Prometheus,
Grafana, the alert rules, Docker healthchecks, database passwords and least-privilege roles are on in
**every** mode. They are how the three modes are measured, and how credentials are handled; they are
not behaviour under test. This keeps the comparison fair: all three modes are observed by the same
instruments, and only the mechanisms under test differ.

### 1.2 Major changes since `midterm-final`

Taken from `git log midterm-final..HEAD`. Every change is described in more detail in the section
named in the last column.

| Commit(s) | Change | Section |
|---|---|---|
| `ffc453b` | endterm implementation plan and the assignment specs added to `docs/` | — |
| `d66a0eb` | third deployable mode (`ENDTERM_ENABLED`), mode → `.env` builder, generated secrets in a git-ignored `.env` | 1.1, 5.2 |
| `f833e97` | unit tests for the midterm mechanisms (the midterm had none) | 6 |
| `b1cb300` | request/correlation IDs across nginx, gateway and services; hostile IDs replaced | 4.2 |
| `05734f7`, `be348bb` | Prometheus metrics: requests, latency, upstream attempts, health, breakers, ejection, auth denials, stale payments | 4.3 |
| `81b8070` | Prometheus, Grafana and postgres-exporter always on; six alert rules with promtool tests; Grafana dashboard | 4.4, 4.5 |
| `7d41652` | `/health/live` vs `/health/ready`; Docker healthchecks on every app container | 3.3 |
| `846f63d` | per-instance outlier ejection (S11) | 3.4 |
| `fdd68dd` | nginx in front of `gateway-1` and `gateway-2` (H6); payments require a client `Idempotency-Key` in endterm | 3.2, 3.6 |
| `6e7510b` | STRIDE threat model ([`THREAT-MODEL.md`](THREAT-MODEL.md)) | 2.4 |
| `b9023fd`, `ce08f9e` | `auth` service: scrypt password hashes, HS256 JWTs (15 min) | 5.1 |
| `e8e47d1`, `2fbb33e` | gateway authorization matrix (fail closed) and audit log | 5.1, 5.3 |
| `2a7c486` | strict input validation and request limits | 5.1 |
| `91663ec` | per-principal and per-IP rate limiting | 5.1 |
| `d6745f1` | secrets out of the repository, `scram-sha-256`, least-privilege roles `app_rw` / `repl` / `monitor`, loopback-only ports, chaos-endpoint token | 5.1, 5.2 |
| `9f6541c`, `981592c` | auth-aware workload, alert and resource capture, key-level integrity, acceptance criteria, repetitions | 6, 7 |
| `65139a9`, `1597ceb`, `4b3636d` | four new scenarios: gateway-failure, error-spike, unauthorized-access, abuse | 7 |
| `c33badc` | integration suite against a live endterm stack; GitHub Actions CI with config and dependency checks | 6 |
| `6d44ebc`, `4e1578f` | aggregation (`RESULTS.md`, `results.csv`) and Grafana snapshot scripts | 7.6 |
| `d4917b9` | demonstration: service failure, security and alerting scenarios ([`DEMO.md`](DEMO.md)) | 7.7 |
| `af7df16`, `67bd595` | raw campaign data for the baseline and midterm modes | 8 (pending) |
| `1d0bbf9` | updated architecture diagrams, run instructions, mechanism list | 3 |

What did **not** change: the business services and their APIs, the payment workflow, the business
tables of the database schema (new: `app_users` for the auth service), the midterm mechanisms S1 to
S10 and H1 to H5, and the workload mix (60 % student reads, 20 % transcript reads, 20 % payments).
There are still more than three independently identifiable services (gateway, auth, student, payment,
transcript, timetable) plus the data-storage component (PostgreSQL primary and standby), as spec §4
requires.

### 1.3 Requirement → where implemented → evidence

This table covers every bullet of spec §§3, 4, 5, 6, 7 and 9. "Pending" in the evidence column means
the evidence is a measured result that the campaign produces and §8 reports; the mechanism exists,
but this report does not yet claim that it works (spec §4: a mechanism in a diagram is not evidence).

**Spec §3 — Cloud computing and microservices resilience**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Service decomposition | `app/services/` (gateway, auth, student, payment, transcript, timetable), one container each, separate replicas | [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1, §4; `docker-compose.yml` |
| API gateway | `app/services/gateway.py` (`gateway-1`, `gateway-2`) behind nginx | §3.2; E7 `gateway-failure` (pending) |
| Service discovery or configuration | static upstream lists by Docker DNS name (`STUDENT_URLS`, `PAYMENT_URLS`, …) in `docker-compose.yml`; all tunables from env vars | §3.2 |
| Replicas | 2 × gateway, student, payment, timetable; hot standby DB (H1, H2) | `docker-compose.yml`; E1, E4 (pending) |
| Health/readiness checks | `/health/live` (Docker healthcheck), `/health/ready` (gateway S4 poll) in `app/core/service.py` | `tests/unit/test_health.py`; E1, E2, E4 (pending) |
| Load balancing | nginx across gateways (endterm); H1 round robin over ready, non-ejected replicas | `tests/unit/test_load_balancer.py`; E1, E7 (pending) |
| Timeout/retry/circuit breaker | S2 800 ms timeout, S1 up to 3 attempts with backoff and jitter, S3 breaker, S11 outlier ejection | `test_retry.py`, `test_circuit_breaker.py`, `test_outlier_ejection.py`; E3, E8 (pending) |
| Graceful degradation | S7 stale cache (HTTP 203 `degraded`), standby reads, fail-fast writes, logins degrade separately from requests | `test_degradation.py`; E2 (pending) |
| Deployment or scaling strategy | restart policy, healthchecks, nginx failover, replica pools; scaling and Kubernetes mapping in §3.7 | §3.6, §3.7 |
| Evidence: updated architecture diagram | [`reports/ARCHITECTURE.md`](../ARCHITECTURE.md) §1 | — |
| Evidence: configuration | `docker-compose.yml`, `config/nginx/`, `config/postgres/`, `config/prometheus/`, `config/grafana/` | — |
| Evidence: demonstration of a service/instance failure | `npm run demo` (`app-crash`, `gateway-failure`), [`DEMO.md`](DEMO.md) | rehearsal transcripts in [`demo/`](demo/); video still to be recorded by the team |

**Spec §3 — Fault detection, monitoring and observability**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Structured logs | `app/core/eventlog.py`: one JSON line per event with `ts`, `svc`, `mode`, `rid`, `level`, `kind` | §4.1; `logs/endterm/*/events.jsonl.gz` |
| Service-level metrics | `app/core/metrics.py`; `GET /metrics` on every gateway and service | `tests/unit/test_metrics.py`; §4.3 |
| Health endpoints | `/health/live`, `/health/ready` (alias `/health`) | `test_health.py` |
| Correlation/request IDs | `app/core/context.py`; nginx sets `X-Request-ID`, the gateway forwards it, every log line carries `rid` | `test_context.py` (incl. `test_hostile_request_id_replaced`), `test_request_id_propagates_to_payment_service_log` |
| Dashboards | Grafana dashboard `university` (`config/grafana/dashboards/university.json`) | §4.4; snapshots in `reports/endterm/figures/` (pending) |
| Alert rules | six rules in `config/prometheus/alerts.yml` | `alerts.test.yml` (`npm run test:alerts`); [`ALERTS.md`](ALERTS.md) |
| Detection and recovery times | `experiments/metrics.ts` (`detectionMs`, `recoveryMs`), `experiments/alerts.ts` (per-alert `detectionMs`) | §4.6; pending |
| Evidence: explanation of how an incident is detected and diagnosed | §4.7 | — |

**Spec §3 — Security, resilience and intrusion tolerance**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Authentication and authorization | `app/services/auth.py`, `app/security/tokens.py`, `passwords.py`, `policy.py`; enforced in `gateway.py` | `test_tokens.py`, `test_passwords.py`, `test_policy.py`, `test_gateway_authz.py`; E9 (pending) |
| Input validation | `app/security/validation.py`; gateway edge limits; service-side models | `test_validation.py`, `test_malformed_payment_422_not_5xx`; E10 (pending) |
| Secrets/configuration handling | `experiments/env.ts` (generated `.env`), `${VAR:?}` in compose, `00-roles.sh`, `pg_hba.conf` | `experiments/env.test.ts`; §5.2 |
| Rate limiting or abuse protection | `app/security/rate_limit.py` | `test_rate_limit.py`; E10, E6 (pending) |
| Audit logging | `app/security/audit.py` | `test_audit.py` (`test_audit_event_has_no_secrets`); E9 (pending) |
| Safe failure behaviour | fail-closed policy, 4xx (not 5xx) for bad input, an auth outage degrades only logins | `test_policy_fails_closed_on_exception`; E9, E10 (pending) |
| Least privilege | `app_rw` (no DELETE/TRUNCATE/DDL), `repl`, `monitor`; loopback-only ports | `test_app_role_cannot_truncate` |
| Evidence: threat model | [`THREAT-MODEL.md`](THREAT-MODEL.md) | — |
| Evidence: implemented controls | §5; THREAT-MODEL.md §6 | — |
| Evidence: controlled tests of ≥ 2 security or misuse scenarios | E9 `unauthorized-access`, E10 `abuse` | pending |

**Spec §3 — Verification, validation and fault-injection testing**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Unit/integration/system tests | `tests/unit/` (pytest), `experiments/*.test.ts` (node --test), `tests/integration/test_stack.py`, E1–E10 | §6; `.github/workflows/ci.yml` |
| Explicit acceptance criteria | `experiments/scenarios.ts`, `acceptance.ts` | [`TEST-PLAN.md`](TEST-PLAN.md); `acceptance.test.ts` |
| Repeatable fault injection | `experiments/run.ts`, `campaign.ts`, `/chaos` endpoints, `docker compose kill/stop/start` | §7 |
| Workload generation | `experiments/workload.ts` (auth-aware), `attacks.ts` | §7.2 |
| Data-integrity checks | key-level integrity in `experiments/metrics.ts` (duplicate, lost, orphaned, ledger balance) | `metrics.test.ts`; pending |
| Baseline-versus-resilient comparison | three modes, same scenarios, same workload | pending (§8) |
| Evidence: test plan | [`TEST-PLAN.md`](TEST-PLAN.md) | — |
| Evidence: scripts or commands | `npm run exp`, `npm run campaign`, README "Running" | — |
| Evidence: raw results/logs | `logs/endterm/<scenario>__<mode>__r<n>/`, `reports/endterm/runs/*/metrics.json` | baseline and midterm committed (`af7df16`, `67bd595`); endterm pending |
| Evidence: results table with pass/fail | `experiments/aggregate.ts` → `RESULTS.md`, `results.csv` | pending |

**Spec §4 — Scope and continuity**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Reuse the midterm services and core workflow | same services and payment workflow | §1.2 |
| Document major changes | §1.2; ARCHITECTURE.md §6 | — |
| ≥ 3 services including a data store | 6 services + PostgreSQL primary/standby | ARCHITECTURE.md §4 |
| Retain a baseline/midterm configuration | `npm run up:baseline`, `npm run up:midterm`, tag `midterm-final` | §1.1 |
| Do not claim a mechanism works from a diagram | every mechanism has a test or an experiment; results still pending are marked as such | this table |
| Synthetic data, authorised systems only | seed data in `config/postgres/`; tests only against the local stack | THREAT-MODEL.md "Scope of testing" |

**Spec §5 — Implementation requirements**

| Requirement | Where implemented | Evidence |
|---|---|---|
| 5.1 containerised; health checks; restart/replica strategy; timeouts and bounded retries; graceful degradation of a non-critical feature | `Dockerfile`, `docker-compose.yml`; H3, H7; S1, S2; S7 (transcripts and student reads from cache) | §3; E1, E2, E4 (pending) |
| 5.2 ≥ 3 metrics; structured logs; correlation across services | 9 application metrics + exporter metrics; JSONL; `rid` | §4.1–4.3 |
| 5.3 ≥ 3 alert conditions with what, threshold, expected response | 6 rules | §4.5, [`ALERTS.md`](ALERTS.md) |
| 5.4 ≥ 3 security controls | 12 controls (THREAT-MODEL.md §6) | §5 |
| 5.5 automated tests for critical workflows; repeatable fault-injection scripts | §6; §7 | CI; `npm run campaign` |

**Spec §6 — Required experiments**

| Requirement | Where implemented | Evidence |
|---|---|---|
| ≥ 6 experiments | 10 scenarios E1–E10 | TEST-PLAN.md |
| ≥ 4 fault injection or abnormal conditions | E1–E8 | TEST-PLAN.md |
| ≥ 2 security or misuse | E9, E10 | TEST-PLAN.md |
| Restore a known state between experiments | `experiments/run.ts` restore (containers, chaos, DB, health, replication, no firing alert) | §7.3; `restore` in every `metrics.json` |
| Service/instance failure | E1 app-crash, E4 node-failure, E7 gateway-failure | pending |
| Dependency timeout | E3 net-timeout (slow service), E2 db-failure (database) | pending |
| Load spike | E6 high-load (10 → 110 workers) | pending |
| Monitoring/alert test | E8 error-spike; every scenario's expected alerts | pending |
| Unauthorized access | E9 unauthorized-access | pending |
| Abusive or malformed requests | E10 abuse | pending |
| Recovery and consistency | E5 txn-interrupt | pending |
| Hypothesis, environment, steps, expected, observed, repetitions, limitations for each | TEST-PLAN.md (all but "observed"); §8 adds "observed" | pending |

**Spec §7 — Required measurements**

| Requirement | Where implemented | Evidence |
|---|---|---|
| Success/failure counts, error rate, avg and p95 latency | `experiments/metrics.ts` from `workload.jsonl` | pending |
| Detection time and recovery time | `detectionMs`, `recoveryMs`, per-alert `detectionMs` | pending |
| Availability over the test interval | request-based, time-based (1 s bins), read availability | pending |
| Alerts triggered and whether each was correct | `experiments/alerts.ts`, `acceptance.ts` (`mustFire`, `mayFire`, unexpected) | pending |
| Data integrity: missing or duplicate records | key-level integrity (duplicate charges, lost records, orphaned pending, ledger balance) | pending |
| Baseline vs midterm vs endterm | `experiments/aggregate.ts` | pending |

**Spec §9 — Deliverables**

| Deliverable | Where |
|---|---|
| Updated repository with run instructions | [`README.md`](../../README.md) |
| Updated architecture diagram and deployment/configuration files | [`ARCHITECTURE.md`](../ARCHITECTURE.md), `docker-compose.yml`, `config/` |
| Dashboard or equivalent, sample logs, metrics, alert definitions | §4; Grafana `university`; `logs/endterm/`; [`ALERTS.md`](ALERTS.md) |
| Threat model and security controls | [`THREAT-MODEL.md`](THREAT-MODEL.md), §5 |
| Automated tests and repeatable fault-injection/test scripts | `tests/`, `experiments/`, `.github/workflows/ci.yml` |
| Experiment results table and final technical report | this report; `RESULTS.md` (pending) |
| Live or recorded demo of ≥ 3 scenarios incl. one service failure and one security test | [`DEMO.md`](DEMO.md) (`app-crash`, `db-failure`, `gateway-failure`, `unauthorized`, `abuse`); rehearsal transcripts in [`demo/`](demo/), video still to be recorded by the team |

---

## 2. Updated requirements, assumptions and threat model

### 2.1 Functional scope (unchanged)

Students can be listed, read and created; payments are made against a student's ledger and read back
by idempotency key; transcripts are read; timetable jobs are started and polled. The midterm report
§2.1 describes the workflows. The endterm adds one functional surface: `POST /auth/token`, which
exchanges a username and password for a JWT, and four demo users with roles: `admin`, `bursar`
(staff), and `s7` and `s8` (students).

### 2.2 Dependability and security requirements (new or tightened)

Each requirement is written so that an experiment or a test can check it. The thresholds are the
endterm acceptance criteria in [`TEST-PLAN.md`](TEST-PLAN.md); baseline and midterm are expected to
miss several of them, and that is reported as a comparison, not as a failure.

| # | Requirement | Checked by |
|---|---|---|
| R1 | A crashed or killed service replica must keep request availability ≥ 99.9 %, with no lost or duplicate payment | E1, E4 |
| R2 | The gateway must not be a single point of failure (availability ≥ 99.5 % when one gateway is killed, no double charge) | E7 |
| R3 | A slow replica must be taken out of rotation, so that goodput during the fault stays ≥ 70 % of the pre-fault level and p95 stays ≤ 1 s | E3 |
| R4 | With the DB primary down, reads must stay ≥ 99 % available and the outage must be alerted within 10 s | E2 |
| R5 | An interrupted payment must leave no duplicate, lost or orphaned record, and the ledger must balance | E5 |
| R6 | At the 110-worker peak, error rate ≤ 1 %, p95 ≤ 1 s, and the legitimate workload must never be rate-limited | E6 |
| R7 | Each incident class of the alert table must be detected by its alert, with no unexpected alert | E2, E4, E7, E8, E9, E10 |
| R8 | Every unauthenticated or over-privileged request must be denied (401/403) and audited, with no data exposed or changed | E9 |
| R9 | Malformed input must be answered with a 4xx, never a 5xx; floods and brute force must be rate-limited; no instance may crash | E10 |
| R10 | Every request must be traceable across all hops by one correlation ID that cannot be used for log injection | unit and integration tests |

### 2.3 Assumptions

The midterm assumptions (midterm report §2.4: crash, omission and timing faults; no Byzantine faults;
one host; synthetic data) still hold. The endterm adds the security assumptions from
[`THREAT-MODEL.md`](THREAT-MODEL.md) §4:

1. The host, the Docker daemon and the pinned base images are trusted.
2. One host; the public listener is plain HTTP on `:8080` (a real deployment terminates TLS at nginx).
3. `.env` is generated per install, git-ignored and never committed.
4. The demo users share the generated `DEMO_PASSWORD`; they exist only to exercise roles on synthetic data.
5. Security behaviour is gated by `ENDTERM_ENABLED`; credential hygiene is on in every mode.

### 2.4 Threat model (summary)

The full threat model is [`THREAT-MODEL.md`](THREAT-MODEL.md). It applies STRIDE to each of five trust
boundaries of the data-flow diagram (also drawn in [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1):

| Boundary | What crosses it | Main threats | Main controls |
|---|---|---|---|
| B1 client → nginx (public) | every request | missing/forged/expired/`alg:none` tokens, brute-force logins, malformed or oversized input, floods, privilege escalation, replayed payments, log injection, access to `/metrics` and `/chaos` | JWT verification, authorization matrix, validation, rate limits, required `Idempotency-Key`, request-ID sanitisation, nginx blocks internal paths |
| B2 nginx → gateways | proxied requests, failover re-sends | gateway as SPOF, double charge on a re-sent POST, skipping nginx | two gateways, client `Idempotency-Key`, loopback-only gateway ports, the PEP in the gateway itself |
| B3 gateways → services and auth | internal HTTP | a compromised container calling services directly, chaos-endpoint abuse, tokens leaking downstream, auth outage | service-side validation, chaos token, only three headers forwarded, local token verification |
| B4 services → PostgreSQL | SQL, replication, exporter | `trust` logins, SQL injection, destructive SQL, lost/duplicate records, primary down | `scram-sha-256`, parameterised SQL, `app_rw` without DELETE/TRUNCATE/DDL, S5/S6, standby reads |
| B5 host | operator, `.env`, logs | committed or shared secrets, exposed internal ports, vulnerable dependencies | generated secrets, loopback-only ports, pinned versions, `pip-audit` in CI |

Actors in scope: anonymous clients, authenticated students trying to exceed their rights, a stolen
student token (bounded by its 900 s lifetime and the student's own rights), and faulty components.
Out of scope: a malicious insider with root on the host. THREAT-MODEL.md §10 lists thirteen residual
risks the design accepts, among them no mTLS between services (R1), per-gateway rate-limit state (R2),
no token revocation (R3), one shared HS256 key (R5), an audit log that is not tamper-evident (R6) and
no TLS on the public listener (R7).

---

## 3. Cloud/microservices architecture and resilience design

The deployment diagram, the code-layer diagram and the trust boundaries are in
[`reports/ARCHITECTURE.md`](../ARCHITECTURE.md) §1 and §2; the midterm deployment is kept unchanged in
§3 of that file for comparison. The mechanism list, with file links, is
[`app/fault_tolerance/README.md`](../../app/fault_tolerance/README.md).

### 3.1 Service decomposition

| Service | Instances | Owns | Critical? |
|---|---|---|---|
| nginx | 1 | nothing | yes: the public entry point |
| gateway | 2 | in-memory health map, outlier state, rate-limit buckets, last-good GET cache | yes: the policy enforcement point |
| auth | 1 | `app_users` (scrypt hashes) | only for new logins |
| student | 2 | `students` | yes |
| payment | 2 | `payments` | yes: the money path |
| transcript | 1 | `grades` (read-only) + local cache | non-critical; degrades to stale data |
| timetable | 2 | `courses`, `rooms`, `timetable_jobs` | non-critical, long-running jobs |
| PostgreSQL | primary + hot standby | everything | yes |

All application services are one image, selected by command. They are stateless apart from in-memory
caches, so any replica can serve any request.

### 3.2 API gateway, service discovery and configuration

- **Gateway.** Every client call goes through nginx to a gateway. The gateway routes
  `/api/{students|payments|transcripts|timetables}` to the matching pool, relays `POST /auth/token` to
  `auth-1`, and in endterm is the policy enforcement point (§5).
- **Discovery and configuration.** Pools are configured as static lists of Docker DNS names
  (`STUDENT_URLS=http://student-1:3000,http://student-2:3000`, …) in `docker-compose.yml`. Docker's
  embedded DNS resolves the names; the gateway's own health checks (S4) and outlier detector (S11)
  decide which listed instance is usable. Timeouts, quotas and thresholds come from environment
  variables with defaults in one file each (`app/fault_tolerance/software/timeouts.py`,
  `app/security/rate_limit.py`). The mode switches are written into `.env` by `npm run up:<mode>`.
- Static lists were chosen over DNS-based discovery on purpose: a killed container then shows up as
  `up == 0` in Prometheus instead of silently disappearing (ALERTS.md, "Limits of the rule set"). The
  cost is that adding a replica means editing the list (§3.7).

### 3.3 Replicas, load balancing, health and readiness

- **H1 replicas and load balancing.** Two replicas each of the gateway, student, payment and timetable
  services. nginx spreads requests across the gateways (endterm); each gateway does round robin over
  the replicas that are ready and not ejected.
- **S4 readiness.** Each gateway polls `GET /health/ready` on every replica every 1 s. Readiness
  reports whether the instance can do its job (DB reachable; for the transcript service, able to serve
  from cache). A replica that fails readiness leaves the rotation until it passes again.
- **H7 liveness.** `GET /health/live` answers 200 whenever the process is serving and never touches the
  database. The Docker healthcheck uses it (interval 2 s, 3 retries, start period 5 s). The split
  matters: with a single health endpoint, a database outage would mark every healthy process unhealthy,
  and a restart policy acting on that would restart processes that are not broken.

### 3.4 Timeouts, bounded retries, circuit breaker and outlier ejection

| Mechanism | Setting | Purpose |
|---|---|---|
| S2 timeout | 800 ms per upstream call; a DB acquire timeout for fail-fast writes (S8) | no unbounded wait anywhere |
| S1 retry | up to 3 attempts, on the next replica, exponential backoff 50·2ⁿ ms with full jitter | mask a single failed or dead replica |
| S3 circuit breaker | 5 consecutive failures open the pool's breaker for 5 s, then half-open | stop hammering a pool that is down |
| S11 outlier ejection (endterm) | 3 consecutive failed attempts on one replica eject it for 10 s; never more than half a pool | take one slow or failing replica out of the ring |

S11 closes a gap the midterm found: a per-pool breaker never opens for one slow replica among healthy
ones, because the retry on the other replica succeeds. The slow replica stays in rotation and every
request routed to it first pays the timeout (midterm report §11 and FMEA row 2, which records a
maximum latency of 3021 ms in the baseline against 1201 ms with timeout and retry). Capping ejection at
half a pool leaves a pool-wide fault, such as a database outage, to the breaker.

### 3.5 Graceful degradation

| Situation | Degraded behaviour | What keeps working |
|---|---|---|
| every attempt for a GET fails | S7: the gateway answers from its last-good copy (≤ 60 s old) with HTTP 203 and `degraded: true` | student and transcript reads |
| DB primary down | reads from the hot standby (H2); writes fail fast (S8) instead of hanging | reads |
| transcript instance or DB unavailable | transcripts from the service's cache, flagged degraded | transcript reads (the non-critical feature) |
| `auth-1` down | new logins fail; requests that already carry a token keep working, because gateways verify tokens locally | every authenticated request |
| timetable replica dies mid-job | S10: another replica adopts the job from its last checkpoint | timetable generation (non-critical) |

### 3.6 Deployment and recovery strategy

- **Restart policy (H3).** `restart: ${RESTART_POLICY}`: `unless-stopped` in midterm and endterm, `no`
  in baseline. A process that crashes from inside (E1, `/chaos/crash`) is restarted by Docker. An
  operator `docker compose kill` (E4, E7) deliberately does not trigger it, which makes it a faithful
  "the node is gone" simulation: the system must mask it with redundancy until the operator restarts
  the node.
- **Container healthchecks (H7).** Every app container and nginx has a healthcheck; `docker compose ps`
  shows the result, and the experiment restore waits for it.
- **Gateway failover (H6).** In endterm nginx (`config/nginx/redundant.conf`) sends traffic to
  `gateway-1` and `gateway-2`. On a connection error (`proxy_connect_timeout 1s`) or a timeout
  (`proxy_read_timeout 5s`) it re-sends to the other gateway with the same `X-Request-ID`, and marks the
  failed one down for 5 s (`max_fails=1 fail_timeout=5s`).
- **Safe re-send.** nginx may re-send a `POST` that the first gateway already forwarded
  (`proxy_next_upstream … non_idempotent`). If the gateway generated the idempotency key, the re-send
  would carry a different key and charge twice. Endterm therefore refuses `POST /api/payments` without a
  client `Idempotency-Key` (400); the re-send carries the same key, and S5 returns the original payment.
  This is pinned by `test_payment_without_idempotency_key_rejected` (plan Review Focus 2).
- **Monitoring plane.** Prometheus, Grafana and postgres-exporter run with `restart: unless-stopped` in
  every mode, so the instruments survive the faults they measure.

### 3.7 Scaling strategy and mapping to Kubernetes (discussion only)

Nothing in this subsection is deployed; the system runs on Docker Compose on one host. The mapping
shows how each mechanism would carry over and what would replace it.

| Here (Compose) | Kubernetes equivalent | Note |
|---|---|---|
| `student-1`, `student-2` services with the same image | a `Deployment` with `replicas: 2` | scale with `kubectl scale` or a `HorizontalPodAutoscaler` on CPU or request rate |
| static `*_URLS` lists, Docker DNS | a `Service` (ClusterIP) and its `EndpointSlice` | discovery becomes dynamic; `InstanceDown` would then need `kube-state-metrics` instead of static targets |
| `restart: unless-stopped` | `restartPolicy: Always` under a controller | a killed Pod is replaced, which Compose does not do after `kill` |
| healthcheck on `/health/live` | `livenessProbe` on `/health/live` | the same split: liveness never touches the DB |
| gateway S4 poll of `/health/ready` | `readinessProbe` on `/health/ready` | a not-ready Pod leaves the Service's endpoints |
| nginx in front of two gateways | an `Ingress` controller, or a `Service` of type LoadBalancer, over a gateway `Deployment` | removes nginx as the last single entry point when the Ingress itself is replicated |
| S11 outlier ejection in the gateway | a service mesh's outlier detection (for example Envoy `outlier_detection`) | moves ejection out of application code |
| `.env` secrets | `Secret` objects mounted as files, or an external vault | addresses residual risk R4 |
| `127.0.0.1`-only ports | `NetworkPolicy` so that only the gateways reach the services | addresses residual risk R1 in part |
| Prometheus static scrape config | Prometheus Operator `ServiceMonitor` | |
| PostgreSQL primary + standby | a `StatefulSet` under an operator with automatic promotion (for example Patroni) | removes the primary as a single point of failure for writes |
| — | a `PodDisruptionBudget` with `minAvailable: 1` per pool | keeps one replica up during node drains |

On this single host, scaling a pool means adding a service to `docker-compose.yml`, appending it to
the pool's `*_URLS` list and to `config/prometheus/prometheus.yml`, and redeploying. The rate-limit
state is per gateway, so adding gateways raises the effective cluster quota (THREAT-MODEL.md R2).

### 3.8 Remaining single points of failure

The midterm fault tree found three first-order cut sets that are single points of failure: the
gateway, the primary database and the host (midterm report §4.4). The endterm removes the gateway from
that list. What remains single:

| Component | Effect if it fails | Why it stays single here | Remedy (not implemented) |
|---|---|---|---|
| nginx | total outage | one public port on one host | two nginx instances behind a virtual IP (keepalived), or a replicated Ingress |
| postgres-primary | no writes; reads continue from the standby | no automatic promotion | Patroni or an operator with automatic failover |
| transcript-1 | transcripts only from the stale cache | non-critical feature, kept as the midterm's degradation example | a second replica |
| auth-1 | no new logins; existing tokens keep working | logins are rare compared with requests | a second replica (it is stateless apart from the DB) |
| Docker host | total outage, common mode | course deployment | replicas across at least two hosts or zones |
| postgres-exporter | `DatabaseDown` cannot fire | single observer (ALERTS.md) | a second exporter, or an alert on the absent series |

---

## 4. Monitoring, logging, metrics and alerting design

### 4.1 Structured logs

Every service appends one JSON line per event to `logs/events.jsonl` (`app/core/eventlog.py`). Every
line carries `ts`, `svc` (for example `gateway-1`, `payment-2`), `ft`, `mode`, `rid`, `level` and
`kind`. The kinds the analysis relies on are `request` (each request a service served, with status and
duration), `route` (which instance served a gateway request, after how many attempts), `attempt` and
`upstream` (each upstream call and its outcome), `health` (each readiness probe), `breaker`,
`ejection`, `recovery` (`retry_succeeded`, `duplicate_suppressed`, `checkpoint_rolled_back`) and
`audit` (security decisions, §5). For each run the harness stores the lines of its time window as
`logs/endterm/<run>/events.jsonl.gz`. Sample lines (with placeholder values) are in the README section
"Measurement".

### 4.2 Correlation IDs

nginx sets `X-Request-ID` (the client's if it sent one, otherwise its own `$request_id`) and reuses it
when it re-sends to the other gateway. Every service accepts an incoming ID only if it fully matches
`[A-Za-z0-9._-]{8,64}`; anything else (a newline, 10 KB, non-ASCII) is replaced by a fresh UUID before
it reaches a log, which prevents log injection (`test_hostile_request_id_replaced`, plan Review
Focus 4). The gateway forwards the ID to the service it calls, and both log it as `rid`. The workload
sends `x-request-id: <runId>-<n>` on every request, so each client-side record in `workload.jsonl` can
be joined to every server-side line of the same request:

    grep '"rid": "<id>"' logs/events.jsonl

### 4.3 Metrics

Every gateway and service exposes `GET /metrics` (`app/core/metrics.py`). Prometheus scrapes them every
2 s.

| Metric | Type, labels | Used for |
|---|---|---|
| `http_requests_total` | counter: `svc`, `method`, `route`, `status` | request rate, error rate (`HighErrorRate`) |
| `http_request_duration_seconds` | histogram: `svc`, `route` | p50/p95 latency (`HighLatencyP95`) |
| `upstream_attempts_total` | counter: `pool`, `instance`, `outcome` (`ok`, `error`, `timeout`, `circuit_open`) | which replica is failing |
| `instance_up` | gauge: `target` | the gateway's health verdict per replica |
| `circuit_breaker_open` | gauge: `name` | breaker state per pool |
| `instance_ejected` | gauge: `target` | outlier ejection state |
| `auth_denied_total` | counter: `reason` | denials, including rate-limit 429s (`AuthFailureSpike`) |
| `rate_limited_total` | counter: `scope` | rate-limit rejections per scope |
| `payments_stale_pending` | gauge | payments still `pending` 15 s after creation (`PaymentsStuckPending`) |
| `pg_up`, replication statistics | postgres-exporter | primary reachable (`DatabaseDown`), standbys streaming, replication lag |
| `up` | Prometheus | scrape success per target (`InstanceDown`) |

The `route` label is the route template (`/api/students/{id}`), never the raw path, so 200 student IDs
create one series, not 200 (`test_route_label_is_template`, plan Review Focus 5). Every labelled
counter is created at start-up with value 0, so `rate()` does not lose the first increments of a
series that would otherwise first appear mid-incident (ALERTS.md, "Limits of the rule set").
Prometheus stores the `instance` label of `upstream_attempts_total` as `exported_instance`, because the
scrape target already uses `instance`.

### 4.4 Dashboard

Grafana (`http://localhost:3000/d/university`, provisioned from
`config/grafana/dashboards/university.json`, anonymous read-only) has panels for request rate by
status, the gateway 5xx ratio and p50/p95 latency (both with the alert threshold drawn in), upstream
attempts by instance and outcome, instance health (from the gateway and from Prometheus `up`), outlier
ejection, circuit breakers, auth denials and rate limits, stuck payments, the DB primary and the
streaming standbys, replication lag, alerts over time and alerts firing now. `experiments/snapshot.ts`
renders the dashboard for one run's time window into `reports/endterm/figures/<run>.png`; the demo
prints a link to the same window for each step.

### 4.5 Alert rules

Six rules in `config/prometheus/alerts.yml`, each with `summary` (what it detects), `threshold` and
`response` annotations, and each covered by two promtool unit tests in `alerts.test.yml` (one series
that must fire, one just under the threshold or shorter than `for` that must not). The full table,
with the expected system and operator responses, the expected detection latency derived from the
configuration and the limits of the rule set, is [`ALERTS.md`](ALERTS.md).

| Alert | Detects | Threshold | `for` | Expected response | Must fire in |
|---|---|---|---|---|---|
| `InstanceDown` | an app instance stops answering scrapes | `up{job="university"} == 0` | 4 s | restart policy restarts it; health checks and ejection route around it; the operator checks if it still fires after 60 s | E4, E7 |
| `DatabaseDown` | the exporter cannot reach the primary | `pg_up == 0` | 4 s | standby reads, fail-fast writes, breaker; the operator restores the primary and checks replication | E2 |
| `HighErrorRate` | > 5 % of gateway responses are 5xx | 5xx share over 15 s > 0.05 | 6 s | retries, breaker, degraded responses; the operator isolates the failing replica or dependency | E8 |
| `HighLatencyP95` | gateway p95 > 1 s | `histogram_quantile(0.95, …[15s]) > 1` | 6 s | timeouts, retries, ejection; the operator ejects or scales the slow replica | — (may fire in E3, E6) |
| `AuthFailureSpike` | denials faster than 2/s averaged over 30 s | `sum(rate(auth_denied_total[30s])) > 2` | 4 s | every attempt denied and audited; the operator reviews audit lines by `rid`/`sub`, blocks the source, rotates credentials | E9, E10 |
| `PaymentsStuckPending` | a payment still `pending` 15 s after creation | `max(payments_stale_pending) > 0` | 10 s | rollback sweep; in baseline the operator reconciles by hand | — (may fire in E5) |

Gateway series are matched with `svc=~"gateway.*"`, so the rules cover both `gateway-1` and
`gateway-2`. Each scenario lists the alerts that must fire and those that may fire; any other alert
that fires during a run is **unexpected** and makes the run's alert result incorrect (§7.5).

### 4.6 Detection and recovery time: definitions

These are computed for every run by `experiments/metrics.ts` and `experiments/alerts.ts`:

- **System detection time** (`detectionMs`): from the injection to the earliest evidence of the fault
  in the data: a failed client request, a failed readiness probe, a failed upstream attempt or a failed
  upstream call, whichever comes first. A fault that the system detects but the client never sees is
  reported as masked.
- **Alert detection time** (per-alert `detectionMs`): from the injection to the first Prometheus poll
  (every 1 s, `/api/v1/alerts`) that shows the alert firing.
- **Recovery time** (`recoveryMs`): from the injection to the end of the first outage after it. Time is
  cut into 1 s bins; a bin in which no request succeeded is down.
- **Availability:** request-based (successful / all requests), time-based (up bins / non-idle bins),
  and, for E2, read availability (GETs only), because writes are designed to fail fast while the
  primary is down.

### 4.7 How an incident is detected and diagnosed

The intended path for an operator, which the demo (`npm run demo -- alerts`) walks through:

1. **Detect.** An alert goes to firing on `http://localhost:9090/alerts` and in the Grafana panel
   "Firing now". Its `summary` says what it detects and its `response` what to do.
2. **Localise.** The panels narrow it down. `HighErrorRate`: "Upstream attempts by instance and
   outcome" shows which pool and which replica return errors or timeouts, and "Instance health" and
   "Outlier ejection" show whether the gateway has already taken it out. `DatabaseDown`: "Database
   primary" and replication lag. `AuthFailureSpike`: "Auth denied" by reason.
3. **Trace one request.** Take a failing request's `rid` (from the client's own record or from an
   audit line) and `grep` it in `logs/events.jsonl`: the gateway's `route` and `attempt` lines show
   which instances were tried and what each returned, and the service lines show what happened inside.
4. **Confirm recovery.** The alert resolves, the error-ratio and latency panels return under their
   threshold lines, and for payments the integrity check (§7.4) confirms that no record was lost or
   duplicated.

---

## 5. Security controls and intrusion-tolerance strategy

Every control below is switched on by `ENDTERM_ENABLED=1` unless marked "every mode". Baseline and
midterm keep the midterm's open behaviour on purpose: they are the comparison points for E9 and E10,
where the attacks are expected to succeed, and that outcome is recorded as measured.

### 5.1 Implemented controls

| Control | Implementation | Threats (THREAT-MODEL.md) | Tests and experiments |
|---|---|---|---|
| Authentication | `auth` service; scrypt (`n=2**14, r=8, p=1`, salted) with a constant-time compare; HS256 JWTs with `iss`, `aud`, `exp`, valid 900 s; gateways verify locally with `algorithms=["HS256"]` only; the same 401 for an unknown user and a wrong password | B1.S1–S3, B1.E2 | `test_verify_rejects_bad_signature`, `_alg_none`, `_expired`, `_wrong_audience` (Review Focus 3); `test_password_roundtrip_and_wrong_password`; E9 |
| Authorization | `app/security/policy.py`: a matrix of role × route × method. A student may read only their own record and transcript and pay only into their own ledger; listing students and reading payments by key are staff/admin; creating students and timetables is admin only. Any exception in verify or authorize → 401/403 (fail closed) | B1.I1, B1.E1 | `test_policy_matrix`, `test_policy_fails_closed_on_exception`, `test_unauthorized_payment_denied_and_db_unchanged`; E9 |
| Audit logging | `app/security/audit.py`: a `kind="audit"` line with `rid`, `sub`, `role`, action, outcome and reason for every deny, every payment allow, every admin action and every login; never a password, a token or the `Authorization` header | B1.R1, B1.I3 | `test_audit_event_has_no_secrets`; E9 (audit events ≥ attempts) |
| Input validation and request limits | pydantic models with `extra='forbid'`, patterns and ranges (amount, `studentId`, names) → 422; at the gateway, body > 16 384 bytes → 413, non-JSON POST → 400, unsafe path segment → 400; all SQL parameterised | B1.T1, B1.T2, B1.D2, B4.T1 | `test_payment_rejects[*]`, `test_gateway_rejects_*`, `test_malformed_payment_422_not_5xx`; E10 |
| Rate limiting | token buckets in `app/security/rate_limit.py`: logins 1/s burst 5 per client IP; `/api/*` per user: student 10/s burst 20, staff 5 000/s, admin 1 000/s → 429 with `Retry-After` | B1.S3, B1.D1 | `test_bucket_*`, `test_login_bruteforce_limited_after_5`, `test_staff_quota_absorbs_high_load_peak` (Review Focus 1); E10, E6 (`rateLimited = 0`) |
| Duplicate-request protection | client `Idempotency-Key` required on payments; `payments.idempotency_key UNIQUE`; checkpoint and rollback (S5, S6, every FT mode) | B1.T4, B2.T1, B4.T3 | `test_payment_without_idempotency_key_rejected`, `test_payment_idempotent_end_to_end`; E5, E7 |
| Secrets handling (every mode) | secrets generated per install (24 random bytes) into a git-ignored `.env`; compose refuses to start without them (`${VAR:?}`); no password in the repository | B4.I1, B5.I1 | `experiments/env.test.ts` |
| Least privilege (every mode) | `app_rw`: SELECT/INSERT/UPDATE on business tables only, no DELETE, TRUNCATE or DDL; `repl`: replication only; `monitor`: `pg_monitor` only; `scram-sha-256` on every network line; every port except nginx `:8080` bound to `127.0.0.1` | B4.S1, B4.T2, B5.I2 | `test_app_role_cannot_truncate` |
| Chaos-endpoint lockdown | `/chaos*` needs `x-chaos-token == CHAOS_TOKEN` (constant-time compare), else 403 and an audit event; nginx answers 404 for `/chaos*` and `/metrics` | B1.I2, B3.E1 | `test_chaos_requires_token_in_endterm`, `test_chaos_token_compare_constant_time`, `test_chaos_open_in_midterm` |
| Log-injection-safe correlation IDs (every mode) | §4.2 | B1.T3 | `test_hostile_request_id_replaced` |
| Dependency and configuration checks | CI: `pip-audit -r requirements.txt`, `docker compose config` for all three modes, `promtool`, `nginx -t` | B5.T1 | CI jobs `config` and `deps`; §5.4 |
| Attack detection (every mode) | the `AuthFailureSpike` alert | B1.S1–S3, B1.E1 | `alerts.test.yml`; E9, E10 |

### 5.2 Configuration and secrets

`npm run up:<mode>` writes `.env` from `.env.example`: the mode switches are overwritten every time,
and the secrets (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REPL_PASSWORD`, `MONITOR_DB_PASSWORD`,
`JWT_SECRET`, `CHAOS_TOKEN`, `DEMO_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`) are kept if present and
generated if missing. The database roles are created from these values by
`config/postgres/init/00-roles.sh`, and the grants are in `90-grants.sql`. `pg_hba.conf` requires
`scram-sha-256` on every network line and keeps `trust` only for the superuser's local socket, which
the operator and the harness reach through `docker exec` (residual risk R12).

### 5.3 Intrusion-tolerance strategy

The aim is not only to block an attack but to keep it contained, visible and recoverable
(THREAT-MODEL.md §7):

- **Fail closed.** An exception in token verification or in the policy is a 401/403, never a pass.
- **Bounded blast radius.** A stolen token lives at most 900 s, carries one role and one `student_id`,
  and is rate-limited per subject.
- **Defence in depth on writes.** Services validate their own input even if the gateway is bypassed,
  the DB role cannot delete or truncate, and `UNIQUE(idempotency_key)` makes a double charge
  impossible at the storage layer.
- **Availability under attack.** Two gateways, validation in front of the database so that malformed
  input cannot become a 5xx, and quotas sized so that the legitimate peak is never throttled. E9 and
  E10 measure the legitimate workload's availability while the attack runs.
- **Detect and diagnose.** Every deny increments `auth_denied_total{reason}` and writes an audit line
  with `rid` and `sub`; `AuthFailureSpike` fires on a burst of denials.
- **Recover and verify.** After an attack the harness checks that no attacker payment and no `evil-*`
  student reached the database and that the ledger balances.

### 5.4 Known dependency findings

The `pip-audit` run recorded in `reports/endterm/deps/pip-audit-2026-11-09.tsv` (the same command as
the CI job `deps`) reports 24 known vulnerabilities in 2 of 26 resolved packages: `pyjwt 2.10.1` and
`starlette 0.41.3` (a dependency of FastAPI). They are recorded, not suppressed with `--ignore-vuln`.
The dependencies are pinned to the exact versions of the plan's tech stack; upgrading PyJWT and
FastAPI/Starlette to fixed versions is the first item of follow-up work. The JWT code accepts only
HS256 with explicit `iss`/`aud`/`exp` checks and is covered by the `test_verify_rejects_*` tests, but
this report makes no claim that this mitigates any specific advisory.

---

## 6. Verification and validation plan

The full plan is [`TEST-PLAN.md`](TEST-PLAN.md). Summary:

| Level | What it checks | Where | Command |
|---|---|---|---|
| Unit (Python) | each mechanism and each security control in isolation, upstreams stubbed, no containers | `tests/unit/` (20 files) | `python3 -m pytest -q tests/unit` |
| Unit (harness) | metrics, acceptance evaluation, alert folding, attack generators and verdicts, mode → `.env`, aggregation, snapshot, demo | `experiments/*.test.ts` | `npm run test:harness` |
| Configuration | alert rules (promtool unit tests), Prometheus config, nginx configs, compose for all three modes | `config/prometheus/alerts.test.yml`, CI `config` job | `npm run test:alerts` |
| Integration | the live endterm stack: login and own-record read, idempotent payment end to end, unauthorized payment denied with the DB unchanged, malformed payment 422 not 5xx, the correlation ID reaches the payment service's log, `app_rw` cannot truncate | `tests/integration/test_stack.py` | `npm run test:integration` (skips unless the stack reports `mode == "endterm"`) |
| System / fault injection | ten scenarios with acceptance criteria, three repetitions per mode, three modes | `experiments/scenarios.ts`, `run.ts`, `campaign.ts` | `npm run campaign -- --reps 3` |
| Dependencies | known vulnerabilities in the pinned Python dependencies | CI `deps` job | `pip-audit -r requirements.txt` |

The plan pins the riskiest behaviours with named tests (plan "Review Focus"): the staff quota must
absorb the high-load peak (`test_staff_quota_absorbs_high_load_peak`), a payment without
`Idempotency-Key` is rejected (`test_payment_without_idempotency_key_rejected`), forged, expired,
`alg:none` and wrong-audience tokens are rejected (`test_verify_rejects_*`), hostile request IDs are
replaced (`test_hostile_request_id_replaced`), the metric route label is the template
(`test_route_label_is_template`) and an audit event never contains a secret
(`test_audit_event_has_no_secrets`).

**Acceptance criteria.** Each scenario in `experiments/scenarios.ts` carries its endterm acceptance
criteria (TEST-PLAN.md, E1–E10) and its `mustFire` and `mayFire` alerts, and is evaluated by
`experiments/acceptance.ts` into a pass/fail list stored in the run's `metrics.json`. A criterion whose
evidence is missing fails; it never passes by default.

**Continuous integration.** `.github/workflows/ci.yml` runs five jobs: `unit`, `harness`, `config`
(compose for the three modes, promtool test and check, `nginx -t`), `deps` (`pip-audit`, with the
findings in the job summary) and `integration` (a fresh endterm stack, then `pytest -m integration`).

---

## 7. Fault-injection and security-test methodology

### 7.1 Scenarios

| # | Scenario | Kind | Inject (T+20 s) | Repair (T+45 s) | Must fire |
|---|---|---|---|---|---|
| E1 | `app-crash` | fault | `POST /chaos/crash` on student-1 | `docker compose start student-1` | — |
| E2 | `db-failure` | fault | `docker compose stop postgres-primary` | `docker compose start postgres-primary` | `DatabaseDown` |
| E3 | `net-timeout` | fault | student-1 `latencyMs: 3000` | reset to 0 | — |
| E4 | `node-failure` | fault | `docker compose kill student-1 payment-1` | `docker compose start student-1 payment-1` | `InstanceDown` |
| E5 | `txn-interrupt` | fault | `crashAfterCheckpoint: true` on both payment replicas | `docker compose start payment-1 payment-2` | — |
| E6 | `high-load` | abnormal load | +100 workers (10 → 110) | the ramp ends | — |
| E7 | `gateway-failure` | fault (new) | `docker compose kill gateway-1` | `docker compose start gateway-1` | `InstanceDown` |
| E8 | `error-spike` | monitoring (new) | `failRate: 1.0` on both student and both payment replicas | reset | `HighErrorRate` |
| E9 | `unauthorized-access` | security (new) | 63 attempts in 7 categories: no token, forged signature, expired, `alg:none`, s7 pays for s8, s7 creates `evil-N`, s7 lists all students | none | `AuthFailureSpike` |
| E10 | `abuse` | security / misuse (new) | 200 malformed payments + invalid JSON + a 1 MiB body + a bad path segment; a 1 000-request burst with a student token; 50 wrong-password logins | none | `AuthFailureSpike` |

E1 to E6 are the midterm scenarios, kept unchanged so that the midterm results stay comparable. Each
scenario's hypothesis, acceptance criteria and limitations are in [`TEST-PLAN.md`](TEST-PLAN.md). The
deviation of E8 from the plan (the payment replicas are failed as well, because failed reads degrade
to 203 and cannot raise the 5xx share) is explained there.

### 7.2 Workload

`experiments/workload.ts`: 10 concurrent workers, 60 % student reads, 20 % transcript reads, 20 %
payments (some of them client-side re-sends of the same intent with the same key), every request with
`x-request-id: <runId>-<n>`, every request recorded in `workload.jsonl` (time, route, status, latency,
key). In endterm the workload logs in once as `bursar` (staff) and sends the token on every request;
the staff quota is sized so that the workload is never rate-limited (E6 checks `rateLimited = 0`). The
attacks of E9 and E10 run alongside this legitimate workload, so its availability under attack is
measured too.

### 7.3 Known-state restore

Before every run, `experiments/run.ts`:

1. starts every container;
2. resets chaos on every instance (`latencyMs: 0`, `failRate: 0`, `crashAfterCheckpoint: false`);
3. resets the database as the superuser over `docker exec`: `TRUNCATE payments`, balances to 0, and
   any student created by a previous run removed;
4. waits until every instance is healthy and the standby is streaming;
5. waits until Prometheus shows no firing alert (up to 60 s), so that an alert from the previous run
   cannot be counted in this one.

The outcome of the restore is stored in the run's `metrics.json`.

### 7.4 Data-integrity checks

After every run the harness compares the client's view (`workload.jsonl`) with the database, key by
key: duplicate charges (completed rows per key beyond the first), lost records (payments the client
saw acknowledged that are not `completed` in the database), orphaned `pending` payments at the end,
and whether the ledger balances (the sum of completed payments equals the sum of student balances).
E9 additionally counts attacker payments (amount 13.37 or an `attack-` key) and `evil-*` students; E10
checks, with `docker inspect` snapshots, that no container restarted, stopped or disappeared during
the abuse.

### 7.5 Alert capture and correctness

`experiments/alerts.ts` polls Prometheus `/api/v1/alerts` every 1 s during the run and records, per
alert, when it went pending, when it fired and when it resolved. A run's alert result is **correct**
when every `mustFire` alert fired and no alert outside `mustFire ∪ mayFire` fired.
`experiments/resources.ts` samples `docker stats` every 2 s for CPU and memory per container.

### 7.6 Repetitions, modes and aggregation

Each scenario runs 3 times in each mode, from a fresh volume per mode (30 runs per mode, 90 in total):

    npm run up:baseline && npm run campaign -- --reps 3
    docker compose down -v && npm run up:midterm && npm run campaign -- --reps 3
    docker compose down -v && npm run up:endterm && npm run campaign -- --reps 3
    node --experimental-strip-types experiments/aggregate.ts

Each run writes `reports/endterm/runs/<scenario>__<mode>__r<n>/metrics.json` and its raw data to
`logs/endterm/<scenario>__<mode>__r<n>/` (`workload.jsonl.gz`, `events.jsonl.gz`, `alerts.json`,
`resources.jsonl.gz`). `aggregate.ts` reads every stored run (smoke runs with `--rep 0` excluded) and
writes `reports/endterm/RESULTS.md` and `results.csv`. `snapshot.ts` renders the Grafana dashboard for
a run's time window into `reports/endterm/figures/`.

### 7.7 Demonstration

`npm run demo` runs, by default, `app-crash` → `db-failure` → `gateway-failure` → `unauthorized` →
`abuse`, which covers the spec's minimum (three scenarios including one service failure and one
security test). `outlier`, `alerts`, `node-failure` and `timetable` run on request. The script and the
expected output are in [`DEMO.md`](DEMO.md).

### 7.8 Methodological limitations (known before the results)

- One host: the replicas share CPU, memory and disk, so a host fault and resource contention are
  common-mode, and E6's peak is bounded by the host.
- Three repetitions per mode give a spread, not a statistically strong estimate.
- Timing on a shared host varies; E9's 63 denials only just clear the `AuthFailureSpike` threshold if
  they fall inside one 30 s window (ALERTS.md).
- Baseline and midterm run a single gateway, so E7 compares failover against a genuine single point of
  failure, by design.
- The harness resets state as the database superuser; this is an operator action outside the threat
  model (THREAT-MODEL.md B5.E1).

---

## 8. Results and baseline-versus-midterm-versus-endterm comparison

> Pending: filled from reports/endterm/RESULTS.md after the campaign completes.

## 9. Discussion, limitations and lessons learned

> Pending: filled from reports/endterm/RESULTS.md after the campaign completes.

## 10. Conclusion and references

> Pending: filled from reports/endterm/RESULTS.md after the campaign completes.

---

## 11. Appendix: source code, configuration, test scripts, logs and additional results

### 11.1 Source code

| Path | Contents |
|---|---|
| `app/services/` | gateway (PEP), auth, student, payment, transcript, timetable |
| `app/fault_tolerance/` | S1–S11 and H1–H2 code; [`README.md`](../../app/fault_tolerance/README.md) lists every mechanism |
| `app/security/` | tokens, passwords, policy, audit, validation, rate limit |
| `app/core/` | DB access, event log, correlation context, metrics, service middleware |
| `app/fault_injection.py` | `/chaos` endpoints (token-guarded in endterm) |
| `experiments/` | workload, attacks, scenarios, runner, campaign, metrics, alerts, resources, acceptance, aggregation, snapshot, demo |

### 11.2 Configuration

| File | Purpose |
|---|---|
| `docker-compose.yml` | every container, healthchecks, restart policy, loopback port bindings, secrets from `.env` |
| `.env.example` | template; the real `.env` is generated and git-ignored |
| `config/nginx/single.conf`, `redundant.conf` | one gateway (baseline, midterm) / two with failover (endterm) |
| `config/postgres/init/00-roles.sh`, `90-grants.sql`, `pg_hba.conf` | roles, grants, authentication |
| `config/prometheus/prometheus.yml`, `alerts.yml`, `alerts.test.yml` | scrape targets, alert rules, rule tests |
| `config/grafana/provisioning/`, `config/grafana/dashboards/university.json` | data source and dashboard |
| `.github/workflows/ci.yml` | CI pipeline |

### 11.3 Test scripts and commands

| Command | What it runs |
|---|---|
| `python3 -m pytest -q tests/unit` | Python unit tests |
| `npm run test:harness` | harness tests (`experiments/**/*.test.ts`) |
| `npm run test:alerts` | promtool unit tests for the alert rules |
| `npm run test:integration` | integration suite against a live endterm stack |
| `npm run exp <scenario> -- --rep <n>` | one experiment |
| `npm run campaign -- --reps 3` | every scenario × 3 in the deployed mode |
| `npm run demo` | the demonstration |

### 11.4 Logs and results

| Path | Contents | State at the time of writing |
|---|---|---|
| `logs/endterm/<scenario>__<mode>__r<n>/` | raw workload, events, alerts and resource samples per run | baseline (`af7df16`) and midterm (`67bd595`) committed; endterm in progress |
| `reports/endterm/runs/<scenario>__<mode>__r<n>/metrics.json` | computed metrics and acceptance per run | as above |
| `reports/endterm/RESULTS.md`, `results.csv` | aggregated tables | pending |
| `reports/endterm/figures/` | Grafana snapshots | pending |
| `reports/endterm/deps/` | `pip-audit` output (§5.4) | committed |
| `logs/<scenario>__<mode>/`, `reports/runs/`, `reports/COMPARISON.md` | the midterm campaign (one run per scenario and mode) | committed at `midterm-final` |

Midterm reference figures, for orientation only. They come from the midterm campaign, one run per
scenario per mode ([`reports/COMPARISON.md`](../COMPARISON.md) §2), and are not endterm results. Over
six runs per version, the midterm baseline failed 4260 requests and recorded 3210 duplicate charges;
the fault-tolerant version (now the "midterm" mode) failed 789 requests and recorded 0 duplicate
charges. Request-based availability was 95.43 % against 99.16 %.

### 11.5 CI run

No CI run is linked yet. The workflow is committed (`c33badc`), but the branch had not been pushed
from the environment in which this work was done, so GitHub Actions has not run it. The link is added
here once it has run.

### 11.6 Individual contributions

The split below is taken from the git history and can be checked with
`git log --format='%h %an %s'`.

**Midterm (up to tag `midterm-final`).** Aibyn Talgatov (git identities `Aibyn` and `a169n`, the same
person): the initial system with the services, the database layer, S1–S9, H1–H3, the fault-injection
harness and the midterm campaign (`ab343b5`), the restructuring into `app/core`, `app/services`,
`app/fault_tolerance` and `experiments/` (`4750050`, `5433530`), and the contributions section
(`51100cf`). Gani Uapov (`9an1`): the timetable service with checkpointed jobs (S10, `3e9f5c5`,
`6d27f49`), Prometheus `/metrics` (H5, `1e26073`), Windows portability (`5ba7c95`), the re-analysis of
the net-timeout and high-load results (`9f70481`), the first demo script (`6eecb4c`) and the midterm
technical report and architecture diagram (`b8957f0`). The midterm report §14.4 has the full table.

**Endterm (`ffc453b` to the current `HEAD`).** Every commit after `midterm-final` was made by an AI
coding assistant working on the team's behalf in an agent session on this repository. These commits
carry the assistant's git author identity (`Claude`) and are not attributed to either team member
here. The assistant implemented the endterm plan task by task: the plan document, code, tests,
configuration, documentation and the data commits of the campaign runs. The git history does not
record which team member directed, reviewed or demonstrated which part of that work, so this report
does not assign it. The plan's suggested split (plan "Suggested split": Aibyn Phases 0–2 and Tasks 14
and 17; Gani Phase 3 and Tasks 15 and 16; Tasks 18 and 19 together) is a suggestion, not a record of
who did what.

> To complete before submission: each team member states here, in their own words, what they did for
> the endterm (for example directing tasks, reviewing changes, running the campaign, rehearsing and
> giving the demonstration), and which report sections they are ready to explain.

### 11.7 References

1. Endterm assignment: `docs/requirements/endterm-assignment.pdf`.
2. Midterm assignment: `docs/requirements/midterm-assignment.pdf`.
3. Midterm technical report, comparison and methodology: [`reports/REPORT.md`](../REPORT.md),
   [`reports/COMPARISON.md`](../COMPARISON.md), [`reports/METHODOLOGY.md`](../METHODOLOGY.md).
4. Endterm implementation plan: `docs/superpowers/plans/2026-11-09-endterm-resilient-university.md`.
5. A. Avižienis, J.-C. Laprie, B. Randell, C. Landwehr, "Basic Concepts and Taxonomy of Dependable
   and Secure Computing", IEEE Transactions on Dependable and Secure Computing, 1(1), 2004.
6. A. Shostack, *Threat Modeling: Designing for Security*, Wiley, 2014 (STRIDE).
7. M. T. Nygard, *Release It!*, 2nd ed., Pragmatic Bookshelf, 2018 (timeouts, circuit breakers,
   bulkheads).
8. B. Beyer, C. Jones, J. Petoff, N. R. Murphy (eds.), *Site Reliability Engineering*, O'Reilly, 2016
   (monitoring and alerting).
9. RFC 7519, JSON Web Token (JWT); RFC 8725, JSON Web Token Best Current Practices.
10. RFC 7914, The scrypt Password-Based Key Derivation Function.
11. Prometheus documentation: alerting rules and `promtool test rules`; Grafana provisioning
    documentation.
12. nginx documentation: `ngx_http_upstream_module`, `proxy_next_upstream`.
13. PostgreSQL 16 documentation: streaming replication, `pg_hba.conf`, the predefined role
    `pg_monitor`.
14. Kubernetes documentation: Deployments, Services, liveness and readiness probes, Secrets,
    NetworkPolicy, PodDisruptionBudget.
