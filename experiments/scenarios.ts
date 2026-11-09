import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chaosHeaders as headersFor, parseEnv } from './env.ts';
import type { Criterion, ExpectedAlerts } from './acceptance.ts';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const dc = async (...args: string[]): Promise<void> => {
  await exec('docker', ['compose', ...args], { cwd: ROOT }).catch((e) => {
    console.error(`  ! docker compose ${args.join(' ')}: ${e.message.split('\n')[0]}`);
  });
};

// Operator queries run as the superuser over `docker exec` (pg_hba.conf: local postgres trust), on
// purpose: resetting state is an operator action on the host, and the application role app_rw has no
// TRUNCATE or DELETE (least privilege, Task 12). Never give app_rw these rights.
export const psql = async (sql: string): Promise<string> => {
  const { stdout } = await exec(
    'docker',
    ['compose', 'exec', '-T', 'postgres-primary', 'psql', '-U', 'postgres', '-d', 'university', '-v', 'ON_ERROR_STOP=1',
      '-t', '-A', '-F', '|', '-c', sql],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.trim();
};

// .env (written by npm run up:<mode>), read on each call so a regenerated .env is picked up.
export const dotEnv = (): Record<string, string> => {
  const file = `${ROOT}.env`;
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
};

// x-chaos-token from .env: the endterm services refuse /chaos* without it (403), baseline and midterm ignore it.
export const chaosHeaders = (): Record<string, string> => headersFor(dotEnv());

// true when the instance accepted the configuration (2xx)
export const chaos = async (port: number, body: unknown): Promise<boolean> =>
  fetch(`http://localhost:${port}/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...chaosHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.ok).catch(() => false);

// The service replicas that expose /chaos (student, payment, transcript, timetable), by host port.
export const CHAOS_PORTS = [3011, 3012, 3021, 3022, 3031, 3041, 3042];
export const CHAOS_RESET = { latencyMs: 0, failRate: 0, crashAfterCheckpoint: false };

const crash = async (port: number): Promise<void> => {
  await fetch(`http://localhost:${port}/chaos/crash`, {
    method: 'POST',
    headers: chaosHeaders(),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
};

export type Scenario = {
  name: string;
  title: string;
  kind: 'fault' | 'security' | 'monitoring';
  durationMs: number;
  injectAtMs: number;
  repairAtMs: number;
  inject: () => Promise<unknown>;
  repair: () => Promise<unknown>;
  rampAtMs?: number;
  rampConcurrency?: number;
  expectedAlerts: ExpectedAlerts;  // mustFire / mayFire (reports/endterm/ALERTS.md); anything else is unexpected
  acceptance: Criterion[];         // evaluated on metrics.json after the run (acceptance.ts)
  verify?: () => Promise<Record<string, unknown>>;  // security checks after the run (DB queries); stored in metrics.json
};

// The six midterm scenarios get their expected alerts and acceptance criteria in Task 15.
const NONE: Pick<Scenario, 'expectedAlerts' | 'acceptance'> = { expectedAlerts: { mustFire: [], mayFire: [] }, acceptance: [] };

const D = 70_000;
const INJECT = 20_000;
const REPAIR = 45_000;

export const SCENARIOS: Record<string, Scenario> = {
  'app-crash': {
    name: 'app-crash',
    kind: 'fault',
    ...NONE,
    title: 'Application crash',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => crash(3011),
    repair: () => dc('start', 'student-1'),
  },

  'db-failure': {
    name: 'db-failure',
    kind: 'fault',
    ...NONE,
    title: 'Database failure',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('stop', 'postgres-primary'),
    repair: () => dc('start', 'postgres-primary'),
  },

  'net-timeout': {
    name: 'net-timeout',
    kind: 'fault',
    ...NONE,
    title: 'Network / service timeout',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => chaos(3011, { latencyMs: 3000 }),
    repair: () => chaos(3011, { latencyMs: 0 }),
  },

  'node-failure': {
    name: 'node-failure',
    kind: 'fault',
    ...NONE,
    title: 'Hardware / node failure',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('kill', 'student-1', 'payment-1'),
    repair: () => dc('start', 'student-1', 'payment-1'),
  },

  'txn-interrupt': {
    name: 'txn-interrupt',
    kind: 'fault',
    ...NONE,
    title: 'Corrupted / lost transaction',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { await chaos(3021, { crashAfterCheckpoint: true }); await chaos(3022, { crashAfterCheckpoint: true }); },
    repair: () => dc('start', 'payment-1', 'payment-2'),
  },

  'high-load': {
    name: 'high-load',
    kind: 'fault',
    ...NONE,
    title: 'High load',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => {},
    repair: async () => {},
    rampAtMs: INJECT,
    rampConcurrency: 100,
  },
};

if (process.argv[1]?.endsWith('scenarios.ts')) {
  const [, , name, step] = process.argv;
  const s = SCENARIOS[name];
  if (!s || !['inject', 'repair'].includes(step ?? '')) {
    console.log('usage: node experiments/scenarios.ts <' + Object.keys(SCENARIOS).join('|') + '> <inject|repair>');
    process.exit(1);
  }
  await (step === 'inject' ? s.inject() : s.repair());
  console.log(`${name}: ${step} done`);
}
