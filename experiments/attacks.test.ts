import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ABUSE_PREFIX, ATTACK_CATEGORIES, ATTACK_PREFIX, MALFORMED_PAYMENT_BODIES, QUOTAS,
  abuseSet, algNoneToken, attackSet, bruteForceSet, bruteForceVerdict, burstSet, burstVerdict, hs256, summarizeBurst,
  type SentResult,
} from './attacks.ts';

const SECRET = 'test-secret-not-used-anywhere';
const NOW = 1_800_000_000;
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const bearer = (h: Record<string, string>) => h.authorization?.replace(/^Bearer /, '');

test('test attack set covers 7 categories', () => {
  const set = attackSet({ tag: 't1', s7Token: 'S7TOKEN', jwtSecret: SECRET, nowS: NOW });
  assert.equal(ATTACK_CATEGORIES.length, 7);
  assert.deepEqual([...new Set(set.map((a) => a.category))].sort(), [...ATTACK_CATEGORIES].sort());
  // no token: both a payment and a student creation
  const noToken = set.filter((a) => a.category === 'no-token');
  assert.ok(noToken.every((a) => a.headers.authorization === undefined));
  assert.deepEqual([...new Set(noToken.map((a) => `${a.method} ${a.path}`))].sort(), ['POST /api/payments', 'POST /api/students']);
  // the student-token attacks use s7's real token and target what s7 may not do
  const byCat = (c: string) => set.filter((a) => a.category === c);
  assert.ok(byCat('pay-for-other-student').every((a) => bearer(a.headers) === 'S7TOKEN' && JSON.parse(a.body!).studentId === 's8'));
  assert.ok(byCat('create-student').every((a) => a.method === 'POST' && a.path === '/api/students' && /^evil-\d+$/.test(JSON.parse(a.body!).id)));
  assert.ok(byCat('list-all-students').every((a) => a.method === 'GET' && a.path === '/api/students' && bearer(a.headers) === 'S7TOKEN'));
  // categories are interleaved (round-major), so the denials accumulate evenly over the attack
  assert.deepEqual(new Set(set.slice(0, 8).map((a) => a.category)).size, 7);
});

test('every attack request carries an attack- idempotency key', () => {
  const set = attackSet({ tag: 't1', s7Token: 'S7TOKEN', jwtSecret: SECRET, nowS: NOW });
  for (const a of set) {
    assert.ok(a.headers['idempotency-key'].startsWith(ATTACK_PREFIX), a.headers['idempotency-key']);
    assert.equal(a.key, a.headers['idempotency-key']);
    assert.match(a.rid, /^[A-Za-z0-9._-]{8,64}$/);      // accepted verbatim by app/core/context.py
    assert.equal(a.headers['x-request-id'], a.rid);
  }
  assert.equal(new Set(set.map((a) => a.key)).size, set.length);  // one key per attempt
});

test('attack volume clears the AuthFailureSpike threshold (more than 60 denials in 30 s)', () => {
  const set = attackSet({ tag: 't', s7Token: 'x', jwtSecret: SECRET, nowS: NOW });
  assert.ok(set.length > 60, `only ${set.length} attempts`);
});

test('forged, expired and alg:none tokens are what their category says', () => {
  const set = attackSet({ tag: 't', s7Token: 'x', jwtSecret: SECRET, nowS: NOW });
  const tok = (c: string) => bearer(set.find((a) => a.category === c)!.headers)!;
  const verifies = (t: string) => {
    const [h, p, s] = t.split('.');
    return createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') === s;
  };

  const forged = tok('forged-signature');
  assert.equal(decode(forged.split('.')[0]).alg, 'HS256');
  assert.equal(verifies(forged), false);                 // signed with another key
  assert.equal(decode(forged.split('.')[1]).exp > NOW, true);

  const expired = tok('expired-token');
  assert.equal(verifies(expired), true);                 // a genuine signature: rejected only for exp
  assert.ok(decode(expired.split('.')[1]).exp <= NOW);

  const none = tok('alg-none');
  const [h, p, s] = none.split('.');
  assert.equal(decode(h).alg, 'none');
  assert.equal(s, '');
  assert.equal(decode(p).aud, 'ftu-api');
});

test('hs256 matches a reference HMAC-SHA256 JWT and algNoneToken has no signature', () => {
  const t = hs256({ sub: 'a' }, SECRET);
  const [h, p, s] = t.split('.');
  assert.deepEqual(decode(h), { alg: 'HS256', typ: 'JWT' });
  assert.equal(s, createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'));
  assert.ok(algNoneToken({ sub: 'a' }).endsWith('.'));
});

test('abuse set: 200 malformed payments from the rejection list, plus invalid JSON, oversized bodies and a bad path', () => {
  const set = abuseSet({ tag: 't', staffToken: 'STAFF' });
  const malformed = set.filter((a) => a.category === 'malformed-payment');
  assert.equal(malformed.length, 200);
  assert.ok(malformed.every((a) => MALFORMED_PAYMENT_BODIES.includes(a.body!)));
  assert.equal(new Set(malformed.map((a) => a.body)).size, MALFORMED_PAYMENT_BODIES.length);  // the whole list is used
  for (const c of ['invalid-json', 'oversized-1MiB', 'bad-path-segment']) assert.ok(set.some((a) => a.category === c), c);
  assert.ok(set.find((a) => a.category === 'oversized-1MiB')!.body!.length > 1024 * 1024);
  for (const a of set) {
    assert.ok(a.key.startsWith(ABUSE_PREFIX));
    assert.equal(bearer(a.headers), 'STAFF');            // staff may pay for anyone: the body, not the policy, is wrong
  }
});

test('burst set: 1000 requests with the student token; brute-force set: 50 wrong-password logins', () => {
  const burst = burstSet({ tag: 't', token: 'S7' });
  assert.equal(burst.length, 1000);
  assert.ok(burst.every((a) => bearer(a.headers) === 'S7' && a.method === 'GET' && a.path === '/api/students/s7'));
  const bf = bruteForceSet({ tag: 't' });
  assert.equal(bf.length, 50);
  assert.ok(bf.every((a) => a.path === '/auth/token' && a.headers.authorization === undefined));
  assert.equal(new Set(bf.map((a) => JSON.parse(a.body!).password)).size, 50);
});

const res = (status: number, i: number, retryAfter: string | null = status === 429 ? '1' : null): SentResult =>
  ({ category: 'x', rid: `r-${i}`, key: `k-${i}`, status, ms: 1, retryAfter, sentAt: i });

test('burstVerdict: 429 after at least one quota, Retry-After on every 429, never more than the cluster quota', () => {
  const statuses = (ok: number, limited: number) => [...Array(ok).fill(200), ...Array(limited).fill(429)].map(res);
  assert.equal(burstVerdict(summarizeBurst(statuses(60, 940), 2_000)), true);
  assert.equal(burstVerdict(summarizeBurst(statuses(1000, 0), 2_000)), false);          // never limited
  assert.equal(burstVerdict(summarizeBurst(statuses(5, 995), 2_000)), false);           // limited before one burst
  assert.equal(burstVerdict(summarizeBurst(statuses(400, 600), 2_000)), false);         // far over 2 gateways x quota
  const noRetryAfter = statuses(60, 940);
  noRetryAfter[500] = res(429, 500, null);
  assert.equal(burstVerdict(summarizeBurst(noRetryAfter, 2_000)), false);
  const with5xx = statuses(60, 940);
  with5xx[700] = res(503, 700);
  assert.equal(burstVerdict(summarizeBurst(with5xx, 2_000)), false);
  assert.equal(QUOTAS.student.burst, 20);
});

test('bruteForceVerdict: the first 5 attempts are 401, then 429s; never more 401s than the cluster quota allows', () => {
  const run = (s: number[]) => ({ statuses: s, elapsedMs: 1_500 });
  assert.equal(bruteForceVerdict(run([...Array(10).fill(401), ...Array(40).fill(429)])), true);
  assert.equal(bruteForceVerdict(run(Array(50).fill(401))), false);                     // never limited
  assert.equal(bruteForceVerdict(run([401, 401, 429, ...Array(47).fill(429)])), false);  // limited before 5
  assert.equal(bruteForceVerdict(run([...Array(40).fill(401), ...Array(10).fill(429)])), false);
  assert.equal(bruteForceVerdict(run([...Array(5).fill(401), 500, ...Array(44).fill(429)])), false);
});
