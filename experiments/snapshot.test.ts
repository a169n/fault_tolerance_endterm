import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardUrl, parseTag, timeWindow } from './snapshot.ts';

test('dashboardUrl: the university dashboard over the run window, in kiosk mode', () => {
  assert.equal(dashboardUrl('http://localhost:3000', 1_000, 71_000), 'http://localhost:3000/d/university?from=1000&to=71000&kiosk');
  assert.equal(dashboardUrl('http://localhost:3000/', 1, 2), 'http://localhost:3000/d/university?from=1&to=2&kiosk');
});

test('timeWindow: t0..t1 of the run, widened by the padding on both sides', () => {
  assert.deepEqual(timeWindow({ t0: 10_000, t1: 80_000 }, 0), { from: 10_000, to: 80_000 });
  assert.deepEqual(timeWindow({ t0: 10_000, t1: 80_000 }, 5_000), { from: 5_000, to: 85_000 });
});

test('parseTag: <scenario>__<mode>__r<N>; anything else (a path, traversal) is rejected', () => {
  assert.deepEqual(parseTag('db-failure__endterm__r2'), { scenario: 'db-failure', mode: 'endterm', rep: 2 });
  assert.equal(parseTag('../etc__endterm__r1'), null);
  assert.equal(parseTag('db-failure__endterm'), null);
});
