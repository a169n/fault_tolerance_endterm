// Acceptance criteria and alert correctness, evaluated on a run's metrics.json (RunResult).
// Pure, so it is unit-tested and the aggregation (Task 17) can re-evaluate stored runs.
import type { Consistency, Metrics } from './metrics.ts';
import type { Scenario } from './scenarios.ts';

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
};
