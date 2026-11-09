-- Least privilege for the application role (Task 12; THREAT-MODEL.md B4.T2).
-- Runs after every CREATE TABLE in 10-30; the roles themselves are created by 00-roles.sh.
-- app_rw can read and write the business tables but never delete, truncate or change the schema:
-- a compromised or buggy service cannot wipe the ledger. Resetting state between experiments is an
-- operator action done as the superuser over docker exec (experiments/run.ts).

-- Only the roles that need it may connect to this database (PUBLIC can by default).
REVOKE ALL ON DATABASE university FROM PUBLIC;
GRANT CONNECT ON DATABASE university TO app_rw, monitor;

-- PostgreSQL 16 already denies CREATE on schema public to PUBLIC; stated here so it stays true.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;

GRANT SELECT, INSERT, UPDATE ON students, payments, grades, timetable_jobs TO app_rw;
-- app_users: the auth service only reads it and seeds the demo users (INSERT ... ON CONFLICT DO
-- NOTHING). No UPDATE, so no service can change an existing user's role or password hash. Every
-- service still shares app_rw, so one could INSERT a new user; per-service roles are residual risk
-- R16 (THREAT-MODEL.md §10).
GRANT SELECT, INSERT ON app_users TO app_rw;
GRANT SELECT ON courses, rooms TO app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;   -- payments.id (BIGSERIAL): nextval only
