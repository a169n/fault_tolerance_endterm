// Acceptance criteria and alert correctness, evaluated on a run's metrics.json (RunResult).
// Pure, so it is unit-tested and the aggregation (Task 17) can re-evaluate stored runs.
import type { Consistency, Metrics } from './metrics.ts';
import type { Scenario } from './scenarios.ts';
import { bruteForceVerdict, burstVerdict, type BruteForce, type BurstSummary } from './attacks.ts';

export type ExpectedAlerts = { mustFire: string[]; mayFire: string[] };

export type AlertCorrectness = { correct: boolean; missing: string[]; unexpected: string[] };

export type CriterionResult = { id: string; describe: string; pass: boolean };

export type Restore = {
  ok: boolean;
  durationMs: number;
  healthy: boolean;
  replicationStreaming: boolean;
  chaosReset: Record<string, boolean>;
  dbReset: boolean;
  alertsClear: boolean | null;   // null: Prometheus could not be asked
  firingAtStart: string[];
  error?: string;
};

// The content of reports/endterm/runs/<scenario>__<mode>__r<N>/metrics.json.
export type RunResult = {
  scenario: string;
  title: string;
  kind: Scenario['kind'];
  mode: string;
  rep: number;
  runId: string;
  t0: number;
  t1: number;
  injectTs: number;
  repairTs: number;
  restore: Restore;
  expectedAlerts: ExpectedAlerts;
  alertCorrectness: AlertCorrectness;
  metrics: Metrics;
  consistency: Consistency;
  verify: Record<string, unknown> | null;
  acceptance: CriterionResult[];
};

export type Criterion = { id: string; describe: string; check: (m: RunResult) => boolean };

// The result of a security scenario's verify() (E9/E10), stored in metrics.json as RunResult.verify.
export type SecurityVerify = {
  attacks?: { attempts: number; denied: number; statusCounts: Record<string, number> };
  attackPaymentsInDb?: number;   // rows in payments whose idempotency_key starts with attack-
  evilStudents?: number;         // students whose id starts with evil-
  auditDenies?: number;          // audit lines (outcome=deny) whose rid is one of the attack rids
  malformed?: { sent: number; serverErrors: number; statusCounts: Record<string, number> };
  burst?: BurstSummary;
  bruteForce?: BruteForce;
  instances?: { allUpAfter: boolean; restarted: string[] };
};

// `observed` is the names of the alerts that reached `firing` during the run.
export function alertCorrectness(expected: ExpectedAlerts, observed: string[]): AlertCorrectness {
  const fired = new Set(observed);
  const allowed = new Set([...expected.mustFire, ...expected.mayFire]);
  const missing = expected.mustFire.filter((a) => !fired.has(a));
  const unexpected = [...fired].filter((a) => !allowed.has(a)).sort();
  return { correct: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

// A check that throws (a field the run could not measure) fails: missing evidence is not a pass.
export function evaluate(s: Scenario, r: RunResult): CriterionResult[] {
  return s.acceptance.map((c) => {
    let pass = false;
    try {
      pass = c.check(r) === true;
    } catch {
      pass = false;
    }
    return { id: c.id, describe: c.describe, pass };
  });
}

const pctLabel = (x: number) => `${+(x * 100).toFixed(3)}pct`;
const alert = (r: RunResult, name: string) => r.metrics.alerts.find((a) => a.name === name);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const sec = (r: RunResult): SecurityVerify => (r.verify ?? {}) as SecurityVerify;

// Reusable criteria for the scenario table (Task 15). Each reads only metrics.json fields.
export const criteria = {
  availabilityAtLeast: (min: number): Criterion => ({
    id: `availability-ge-${pctLabel(min)}`,
    describe: `request-based availability >= ${+(min * 100).toFixed(3)} %`,
    check: (r) => isNum(r.metrics.availability.requestBased) && r.metrics.availability.requestBased >= min,
  }),
  errorRateAtMost: (max: number): Criterion => ({
    id: `error-rate-le-${pctLabel(max)}`,
    describe: `error rate <= ${+(max * 100).toFixed(3)} %`,
    check: (r) => isNum(r.metrics.requests.errorRate) && r.metrics.requests.errorRate <= max,
  }),
  p95AtMost: (ms: number): Criterion => ({
    id: `p95-le-${ms}ms`,
    describe: `p95 latency <= ${ms} ms`,
    check: (r) => isNum(r.metrics.response.p95Ms) && r.metrics.response.p95Ms <= ms,
  }),
  noRateLimited: (): Criterion => ({
    id: 'rate-limited-eq-0',
    describe: 'no legitimate request is rate limited (429)',
    check: (r) => r.metrics.requests.rateLimited === 0,
  }),
  throughputDuringFaultAtLeast: (ratio: number): Criterion => ({
    id: `during-fault-rps-ge-${ratio}x-pre-fault`,
    describe: `throughput during the fault >= ${ratio} x throughput before it`,
    check: (r) => {
      const { preFaultRps, duringFaultRps } = r.metrics.throughput;
      return isNum(preFaultRps) && isNum(duringFaultRps) && preFaultRps > 0 && duringFaultRps >= ratio * preFaultRps;
    },
  }),
  noDuplicateCharges: (): Criterion => ({
    id: 'duplicates-eq-0',
    describe: 'no duplicate charge (DB and client side)',
    check: (r) => r.consistency.duplicateCharges === 0,
  }),
  noLostRecords: (): Criterion => ({
    id: 'lost-eq-0',
    describe: 'no acknowledged payment missing from the DB',
    check: (r) => r.consistency.lostRecords === 0,
  }),
  noOrphanedPending: (): Criterion => ({
    id: 'orphaned-pending-eq-0',
    describe: 'no payment left pending at the end',
    check: (r) => r.consistency.orphanedPending === 0,
  }),
  ledgerBalanced: (): Criterion => ({
    id: 'ledger-balanced',
    describe: 'sum of completed payments equals the sum of student balances',
    check: (r) => r.consistency.ledgerBalanced === true,
  }),
  alertDetectedWithin: (name: string, ms: number): Criterion => ({
    id: `${name}-detect-le-${ms}ms`,
    describe: `${name} fires within ${ms / 1000} s of the injection`,
    check: (r) => {
      const a = alert(r, name);
      return a != null && isNum(a.detectionMs) && a.detectionMs >= 0 && a.detectionMs <= ms;
    },
  }),
  alertResolvedWithin: (name: string, ms: number): Criterion => ({
    id: `${name}-resolve-le-${ms}ms-after-repair`,
    describe: `${name} resolves within ${ms / 1000} s of the repair`,
    check: (r) => {
      const a = alert(r, name);
      return a != null && isNum(a.resolvedAfterRepairMs) && a.resolvedAfterRepairMs <= ms;
    },
  }),
  alertsCorrect: (): Criterion => ({
    id: 'alerts-correct',
    describe: 'every mustFire alert fired and no unexpected alert fired',
    check: (r) => r.alertCorrectness.correct === true,
  }),
  readAvailabilityAtLeast: (min: number): Criterion => ({
    id: `read-availability-ge-${pctLabel(min)}`,
    describe: `read-request availability >= ${+(min * 100).toFixed(3)} % (reads fail over to the standby)`,
    check: (r) => isNum(r.metrics.availability.readRequestBased) && r.metrics.availability.readRequestBased >= min,
  }),
  resourcesRecorded: (): Criterion => ({
    id: 'resources-recorded',
    describe: 'CPU and memory were sampled during the run',
    check: (r) => Array.isArray(r.metrics.resources) && r.metrics.resources.length > 0,
  }),
  // ---- E9 unauthorized-access ----
  allAttacksDenied: (): Criterion => ({
    id: 'attacks-all-denied',
    describe: 'every attack attempt was denied (401/403), none got a 2xx',
    check: (r) => {
      const a = sec(r).attacks;
      if (!a || !isNum(a.attempts) || a.attempts <= 0 || !isNum(a.denied)) return false;
      const good = Object.entries(a.statusCounts).every(([s, _c]) => Number(s) === 401 || Number(s) === 403);
      return a.denied === a.attempts && good;
    },
  }),
  noAttackerPaymentsInDb: (): Criterion => ({
    id: 'attacker-payments-in-db-eq-0',
    describe: 'no payment with an attack- idempotency key reached the database',
    check: (r) => sec(r).attackPaymentsInDb === 0,
  }),
  noEvilStudents: (): Criterion => ({
    id: 'evil-students-eq-0',
    describe: 'no student with an evil- id was created',
    check: (r) => sec(r).evilStudents === 0,
  }),
  auditDeniesAtLeastAttempts: (): Criterion => ({
    id: 'audit-denies-ge-attempts',
    describe: 'at least one audit deny event per attack attempt',
    check: (r) => {
      const a = sec(r);
      return isNum(a.auditDenies) && isNum(a.attacks?.attempts) && a.auditDenies >= (a.attacks?.attempts ?? Infinity);
    },
  }),
  // ---- E10 abuse ----
  malformedNo5xx: (): Criterion => ({
    id: 'malformed-input-no-5xx',
    describe: 'no malformed request caused a 5xx',
    check: (r) => {
      const m = sec(r).malformed;
      return m != null && isNum(m.sent) && m.sent > 0 && m.serverErrors === 0;
    },
  }),
  burstLimited: (): Criterion => ({
    id: 'burst-429-after-quota',
    describe: 'the request burst got 429 after the quota, with Retry-After, and no 5xx',
    check: (r) => {
      const b = sec(r).burst;
      return b != null && burstVerdict(b);
    },
  }),
  bruteForceLimited: (): Criterion => ({
    id: 'bruteforce-429-after-5',
    describe: 'the login brute force got 429 after the 5-attempt burst',
    check: (r) => {
      const bf = sec(r).bruteForce;
      return bf != null && bruteForceVerdict(bf);
    },
  }),
  instancesStayUp: (): Criterion => ({
    id: 'instances-stay-up',
    describe: 'no instance went down or was restarted during the abuse',
    check: (r) => {
      const i = sec(r).instances;
      return i != null && i.allUpAfter === true && Array.isArray(i.restarted) && i.restarted.length === 0;
    },
  }),
};
