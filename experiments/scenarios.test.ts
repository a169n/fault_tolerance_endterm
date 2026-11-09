import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from './scenarios.ts';
import { evaluate, type RunResult } from './acceptance.ts';

// The scenario table of Task 15 (docs/superpowers/plans/2026-11-09-endterm-resilient-university.md).
const TABLE: Record<string, { kind: string; mustFire: string[]; mayFire: string[]; criteria: number }> = {
  'app-crash': { kind: 'fault', mustFire: [], mayFire: ['InstanceDown'], criteria: 3 },
  'db-failure': { kind: 'fault', mustFire: ['DatabaseDown'], mayFire: ['HighErrorRate', 'InstanceDown'], criteria: 4 },
  'net-timeout': { kind: 'fault', mustFire: [], mayFire: ['HighLatencyP95'], criteria: 2 },
  'node-failure': { kind: 'fault', mustFire: ['InstanceDown'], mayFire: [], criteria: 3 },
  'txn-interrupt': { kind: 'fault', mustFire: [], mayFire: ['PaymentsStuckPending', 'HighErrorRate', 'InstanceDown'], criteria: 4 },
  'high-load': { kind: 'fault', mustFire: [], mayFire: ['HighLatencyP95'], criteria: 4 },
  'gateway-failure': { kind: 'fault', mustFire: ['InstanceDown'], mayFire: [], criteria: 3 },
  'error-spike': { kind: 'monitoring', mustFire: ['HighErrorRate'], mayFire: ['InstanceDown'], criteria: 3 },
  'unauthorized-access': { kind: 'security', mustFire: ['AuthFailureSpike'], mayFire: [], criteria: 6 },
  'abuse': { kind: 'security', mustFire: ['AuthFailureSpike'], mayFire: ['InstanceDown'], criteria: 6 },
};

// A run that meets every endterm target in the table.
function goodRun(over: Record<string, any> = {}): RunResult {
  const base: Record<string, any> = {
    metrics: {
      availability: { requestBased: 0.9999, readRequestBased: 0.9999 },
      requests: { errorRate: 0.0001, rateLimited: 0 },
      response: { p95Ms: 200 },
      throughput: { preFaultRps: 100, duringFaultRps: 95, postRepairRps: 100 },
      alerts: ['InstanceDown', 'DatabaseDown', 'HighErrorRate'].map((name) => ({ name, detectionMs: 6_000, resolvedAfterRepairMs: 10_000 })),
      resources: [{ name: 'gateway-1', maxCpuPct: 10, maxMemMiB: 80 }],
    },
    consistency: { duplicateCharges: 0, lostRecords: 0, orphanedPending: 0, ledgerBalanced: true },
    alertCorrectness: { correct: true, missing: [], unexpected: [] },
    verify: {
      attacks: { attempts: 80, denied: 80, statusCounts: { 401: 40, 403: 40 } },
      attackPaymentsInDb: 0,
      evilStudents: 0,
      auditDenies: 80,
      malformed: { sent: 204, serverErrors: 0, statusCounts: { 422: 200, 400: 2, 413: 2 } },
      burst: { sent: 1000, ok: 60, limited: 940, limitedWithRetryAfter: 940, other: 0, firstLimitedAt: 60, elapsedMs: 2_000 },
      bruteForce: { statuses: [...Array(10).fill(401), ...Array(40).fill(429)], elapsedMs: 1_500 },
      instances: { allUpAfter: true, restarted: [] },
    },
  };
  for (const [k, v] of Object.entries(over)) base[k] = v === null || typeof v !== 'object' ? v : { ...base[k], ...v };
  return base as unknown as RunResult;
}

test('the ten scenarios of the table exist with their kind, expected alerts and acceptance criteria', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(TABLE).sort());
  for (const [name, row] of Object.entries(TABLE)) {
    const s = SCENARIOS[name];
    assert.equal(s.name, name);
    assert.equal(s.kind, row.kind, name);
    assert.deepEqual(s.expectedAlerts, { mustFire: row.mustFire, mayFire: row.mayFire }, name);
    assert.equal(s.acceptance.length, row.criteria, name);
    assert.equal(new Set(s.acceptance.map((c) => c.id)).size, s.acceptance.length, `${name}: duplicate criterion id`);
    assert.ok(s.injectAtMs === 20_000 && s.repairAtMs === 45_000, name);
  }
  assert.ok(Object.values(SCENARIOS).filter((s) => s.kind !== 'security').length >= 4);  // spec §6
  assert.ok(Object.values(SCENARIOS).filter((s) => s.kind === 'security').length >= 2);
  for (const name of ['unauthorized-access', 'abuse']) assert.equal(typeof SCENARIOS[name].verify, 'function');
});

test('a run meeting every endterm target passes every criterion of every scenario', () => {
  for (const s of Object.values(SCENARIOS)) {
    const failed = evaluate(s, goodRun()).filter((c) => !c.pass).map((c) => c.id);
    assert.deepEqual(failed, [], s.name);
  }
});

const failedIds = (name: string, r: RunResult) => evaluate(SCENARIOS[name], r).filter((c) => !c.pass).map((c) => c.id);

test('db-failure: read availability below 99 % or DatabaseDown later than 10 s fails', () => {
  assert.deepEqual(failedIds('db-failure', goodRun({ metrics: { availability: { requestBased: 0.8, readRequestBased: 0.98 } } })),
    ['read-availability-ge-99pct']);
  const late = goodRun();
  late.metrics.alerts = [{ name: 'DatabaseDown', detectionMs: 12_000 } as any];
  assert.deepEqual(failedIds('db-failure', late), ['DatabaseDown-detect-le-10000ms']);
});

test('high-load: a run without resource samples fails "resources recorded"', () => {
  assert.deepEqual(failedIds('high-load', goodRun({ metrics: { resources: [] } })), ['resources-recorded']);
});

test('unauthorized-access: one attack that got through fails, and so does a missing audit event', () => {
  const through = goodRun({ verify: { attacks: { attempts: 80, denied: 79, statusCounts: { 201: 1, 401: 40, 403: 39 } }, attackPaymentsInDb: 1 } });
  assert.deepEqual(failedIds('unauthorized-access', through), ['attacks-all-denied', 'attacker-payments-in-db-eq-0']);
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: { auditDenies: 79 } })), ['audit-denies-ge-attempts']);
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: { evilStudents: 1 } })), ['evil-students-eq-0']);
  assert.ok(failedIds('unauthorized-access', goodRun({ verify: null as any })).length >= 4);  // no evidence is not a pass
});

test('abuse: a 5xx caused by malformed input, an unlimited burst or a restarted instance fails', () => {
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { malformed: { sent: 204, serverErrors: 1 } } })), ['malformed-input-no-5xx']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { burst: { sent: 1000, ok: 1000, limited: 0, limitedWithRetryAfter: 0, other: 0, firstLimitedAt: null, elapsedMs: 2_000 } } })),
    ['burst-429-after-quota']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { bruteForce: { statuses: Array(50).fill(401), elapsedMs: 1_500 } } })),
    ['bruteforce-429-after-5']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { instances: { allUpAfter: true, restarted: ['gateway-1'] } } })),
    ['instances-stay-up']);
});
