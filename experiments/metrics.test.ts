import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, consistencyFrom, outages, pct, throughput } from './metrics.ts';
import { foldAlerts, type AlertObs } from './alerts.ts';
import { parseStatsLine, summarizeResources } from './resources.ts';
import type { Rec } from './workload.ts';

const T0 = 1_000_000;

// one request every 100 ms for 10 s; every request in [4 s, 7 s) fails
function recsWithGap(): Rec[] {
  const recs: Rec[] = [];
  for (let t = 0; t < 10_000; t += 100) {
    const ok = t < 4_000 || t >= 7_000;
    recs.push({ ts: T0 + t, op: 'students', status: ok ? 200 : 503, ok, degraded: false, ms: 20, rid: `r-${t}`, rateLimited: false });
  }
  return recs;
}

const ledger = { completed: 0, pending: 0, rolledBack: 0, failedPay: 0, charged: 0, balances: 0 };
const pay = (intent: string, status: number): Rec => ({
  ts: T0, op: 'payments', status, ok: status < 400, degraded: false, ms: 5, intent, rid: `rid-${intent}`, rateLimited: status === 429,
});

test('outages: one 3 s run of failures -> one outage of about 3000 ms', () => {
  const { outages: outs } = outages(recsWithGap(), T0, T0 + 10_000);
  assert.equal(outs.length, 1);
  assert.ok(Math.abs(outs[0].durationMs - 3_000) <= 100, `duration ${outs[0].durationMs}`);
  assert.equal(outs[0].open, false);
});

test('pct is nearest-rank: pct([1..100], 95) === 95', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(pct(xs, 95), 95);
  assert.equal(pct(xs, 50), 50);
  assert.equal(pct(xs, 100), 100);
  assert.equal(pct([7], 99), 7);
  assert.equal(pct([], 95), 0);
});

test('consistencyFrom: lostRecords === 1 when one acknowledged intent is missing from the DB rows', () => {
  const recs = [pay('k1', 201), pay('k2', 201), pay('k3', 200)];
  const rows = [{ key: 'k1', state: 'completed' }, { key: 'k2', state: 'completed' }];  // k3 acknowledged, not in the DB
  const c = consistencyFrom(recs, { ...ledger, completed: 2 }, rows);
  assert.equal(c.lostRecords, 1);
  assert.deepEqual(c.lostIntents, ['k3']);
  assert.equal(c.phantomRecords, 0);
  assert.equal(c.integrityBasis, 'idempotency-key');
});

test('consistencyFrom: an acknowledged intent rolled back in the DB is lost; a completed row with no 2xx ack is a phantom', () => {
  const recs = [pay('k1', 201), pay('k2', 503)];
  const rows = [{ key: 'k1', state: 'rolled_back' }, { key: 'k2', state: 'completed' }];
  const c = consistencyFrom(recs, { ...ledger, completed: 1, rolledBack: 1 }, rows);
  assert.equal(c.lostRecords, 1);
  assert.equal(c.phantomRecords, 1);
});

test('consistencyFrom: duplicate charges add the DB count (completed rows per key > 1) to the client-side count', () => {
  const recs = [pay('k1', 201), pay('k1', 201), pay('k2', 201)];
  const rows = [{ key: 'k1', state: 'completed' }, { key: 'k2', state: 'completed' }, { key: 'k2', state: 'completed' }];
  const c = consistencyFrom(recs, { ...ledger, completed: 3 }, rows);
  assert.equal(c.duplicateChargesClient, 1);
  assert.equal(c.duplicateChargesDb, 1);
  assert.equal(c.duplicateCharges, 2);
});

test('consistencyFrom: falls back to counts when the DB keys are not the client keys (baseline ignores Idempotency-Key)', () => {
  const recs = [pay('k1', 201), pay('k2', 201), pay('k3', 201)];
  const rows = [{ key: 'uuid-a', state: 'completed' }, { key: 'uuid-b', state: 'completed' }];
  const c = consistencyFrom(recs, { ...ledger, completed: 2 }, rows);
  assert.equal(c.integrityBasis, 'count');
  assert.equal(c.lostRecords, 1);
});

test('consistencyFrom: no DB rows (query failed) -> key-level fields are null', () => {
  const c = consistencyFrom([pay('k1', 201)], ledger);
  assert.equal(c.lostRecords, null);
  assert.equal(c.phantomRecords, null);
});

test('throughput: successful requests per second before the fault, during it and after the repair', () => {
  const recs = recsWithGap();  // 10 ok/s except [4 s, 7 s)
  const t = throughput(recs, T0, T0 + 4_000, T0 + 7_000, T0 + 10_000);
  assert.equal(t.preFaultRps, 10);
  assert.equal(t.duringFaultRps, 0);
  assert.equal(t.postRepairRps, 10);
});

test('computeMetrics: avgMs, errorRate, rateLimited, alert detection and resources', () => {
  const recs = recsWithGap();
  recs.push({ ts: T0 + 9_950, op: 'students', status: 429, ok: false, degraded: false, ms: 1, rid: 'x-429', rateLimited: true });
  const alerts: AlertObs[] = [{ name: 'HighErrorRate', firstPendingTs: T0 + 5_000, firstFiringTs: T0 + 9_000, resolvedTs: null }];
  const resources = [
    { ts: T0, name: 'a', cpuPct: 10, memMiB: 50 },
    { ts: T0 + 2_000, name: 'a', cpuPct: 30, memMiB: 40 },
  ];
  const m = computeMetrics(recs, [], T0, T0 + 10_000, T0 + 4_000, { repairTs: T0 + 7_000, alerts, resources });
  assert.equal(m.response.avgMs, 20);
  assert.equal(m.requests.rateLimited, 1);
  assert.equal(m.requests.errorRate, 31 / 101);
  assert.deepEqual(m.alerts.map((a) => [a.name, a.detectionMs]), [['HighErrorRate', 5_000]]);
  assert.deepEqual(m.resources, [{ name: 'a', maxCpuPct: 30, maxMemMiB: 50, samples: 2 }]);
  assert.equal(m.throughput.duringFaultRps, 0);
});

test('foldAlerts: pending, then firing, then resolved, per alert name', () => {
  const s = new Map<string, AlertObs>();
  foldAlerts(s, [{ labels: { alertname: 'A' }, state: 'pending', activeAt: new Date(T0 - 500).toISOString() }], T0);
  foldAlerts(s, [{ labels: { alertname: 'A' }, state: 'firing' }, { labels: { alertname: 'A' }, state: 'pending' }], T0 + 1_000);
  foldAlerts(s, [], T0 + 2_000);
  foldAlerts(s, [], T0 + 3_000);
  assert.deepEqual(s.get('A'), { name: 'A', firstPendingTs: T0 - 500, firstFiringTs: T0 + 1_000, resolvedTs: T0 + 2_000 });
});

test('foldAlerts: a pending alert that never fires has no firing time; firing again clears the resolution', () => {
  const s = new Map<string, AlertObs>();
  foldAlerts(s, [{ labels: { alertname: 'P' }, state: 'pending' }], T0);
  foldAlerts(s, [], T0 + 1_000);
  assert.equal(s.get('P')!.firstFiringTs, null);
  assert.equal(s.get('P')!.resolvedTs, null);

  foldAlerts(s, [{ labels: { alertname: 'B' }, state: 'firing' }], T0);
  foldAlerts(s, [], T0 + 1_000);
  foldAlerts(s, [{ labels: { alertname: 'B' }, state: 'firing' }], T0 + 2_000);
  assert.equal(s.get('B')!.firstFiringTs, T0);
  assert.equal(s.get('B')!.resolvedTs, null);
});

test('parseStatsLine reads docker stats JSON (CPU %, memory in MiB)', () => {
  const line = JSON.stringify({ Name: 'fault-tolerance-student-1-1', CPUPerc: '12.50%', MemUsage: '1.5GiB / 7.6GiB' });
  assert.deepEqual(parseStatsLine(line, T0), { ts: T0, name: 'fault-tolerance-student-1-1', cpuPct: 12.5, memMiB: 1536 });
  assert.equal(parseStatsLine(JSON.stringify({ Name: 'x', CPUPerc: '0.00%', MemUsage: '512KiB / 1GiB' }), T0)!.memMiB, 0.5);
  assert.equal(parseStatsLine('not json', T0), null);
  assert.deepEqual(summarizeResources([]), []);
});
