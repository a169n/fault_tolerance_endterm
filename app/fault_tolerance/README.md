# Fault-tolerance mechanisms — where each one lives

Every mechanism is switched by `FT_ENABLED` (software) or `RESTART_POLICY`
(self-healing). With both off you get the **baseline**: same code, same replicas,
nothing that uses them.

## Software (`software/`)


| #   | Mechanism                            | File                                                                 | One line                                                                 |
| --- | ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S1  | Retry + exponential backoff + jitter | `[software/retry.py](software/retry.py)`                             | a failed call is repeated on the next replica, waiting 50·2ⁿ ms × random |
| S2  | Timeouts                             | `[software/timeouts.py](software/timeouts.py)`                       | every wait in the system is bounded; all deadlines in one file           |
| S3  | Circuit breaker                      | `[software/circuit_breaker.py](software/circuit_breaker.py)`         | 5 failures in a row → stop calling that service for 5 s                  |
| S4  | Health checks                        | `[software/health_check.py](software/health_check.py)`               | gateway polls `/health/ready` every 1 s, dead replicas leave rotation    |
| S5  | Idempotency + duplicate detection    | `[software/idempotency.py](software/idempotency.py)`                 | same Idempotency-Key twice → original result, no second charge           |
| S6  | Checkpoint + rollback / recovery     | `[software/checkpoint_rollback.py](software/checkpoint_rollback.py)` | `pending` row before the charge; a sweep rolls back what a crash left    |
| S7  | Graceful degradation                 | `[software/degradation.py](software/degradation.py)`                 | everything failed on a read → recent stale data, HTTP 203 `degraded`     |
| S8  | Fail-fast writes                     | `[software/timeouts.py](software/timeouts.py)` `DB_ACQUIRE_S`        | no primary database → write fails in ms instead of hanging               |
| S9  | Service replication                  | see H1                                                               |                                                                          |
| S10 | Job checkpoint + lease adoption      | `[software/job_checkpoint.py](software/job_checkpoint.py)`           | timetable job saves progress; another replica resumes it after a crash   |
| S11 | Outlier ejection (endterm only)      | `[software/outlier_ejection.py](software/outlier_ejection.py)`       | 3 failed attempts in a row on one replica → out of the ring for 10 s; never more than half a pool |




## Infrastructure — assignment §8, at least 2 required


| #   | Mechanism                                    | Declared in                                                                                     | Code that uses it                                                    |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| H1  | Service replicas + load balancing            | `[docker-compose.yml](../../docker-compose.yml)`: `student-1/2`, `payment-1/2`, `timetable-1/2` | `[infrastructure/load_balancer.py](infrastructure/load_balancer.py)` |
| H2  | Database replication (primary → hot standby) | `docker-compose.yml`: `postgres-primary`, `postgres-replica`                                    | `[infrastructure/db_failover.py](infrastructure/db_failover.py)`     |
| H3  | Self-healing (automatic restart)             | `docker-compose.yml`: `restart: ${RESTART_POLICY}`                                              | — (Docker does it)                                                   |
| H4  | Storage checksums                            | `docker-compose.yml`: `--data-checksums`                                                        | — (PostgreSQL does it)                                               |
| H5  | Independent monitoring                       | `docker-compose.yml`: `prometheus`, `[config/prometheus/](../../config/prometheus/prometheus.yml)` | `GET /metrics` in `[core/eventlog.py](../core/eventlog.py)`          |
| —   | RAID, ECC memory                             | documented only (cannot exist in containers)                                                    | `[reports/REPORT.md](../../reports/REPORT.md)` §6.3–6.5              |




## Where they are used

```
client ─► services/gateway.py ── H1 load_balancer ── S4 health_check ── S11 outlier_ejection (endterm)
                │                S5 idempotency (forward key)
                │                S1 retry ─ S2 timeout ─ S3 circuit_breaker
                │                S7 degradation (stale cache)
                ▼
   services/student.py      reads ── H2 db_failover
   services/payment.py      S5 idempotency ── S6 checkpoint_rollback
   services/transcript.py   S7 degradation
   services/timetable.py    S10 job_checkpoint
                ▼
   core/db.py               S2 timeouts (S8 fail-fast) ── H2 db_failover
```

