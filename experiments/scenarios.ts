import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chaosHeaders as headersFor, parseEnv } from './env.ts';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const dc = async (...args: string[]): Promise<void> => {
  await exec('docker', ['compose', ...args], { cwd: ROOT }).catch((e) => {
    console.error(`  ! docker compose ${args.join(' ')}: ${e.message.split('\n')[0]}`);
  });
};

// x-chaos-token from .env (written by npm run up:<mode>). Read on each call so a regenerated .env is
// picked up; the endterm services refuse /chaos* without it (403), baseline and midterm ignore it.
export const chaosHeaders = (): Record<string, string> => {
  const file = `${ROOT}.env`;
  return existsSync(file) ? headersFor(parseEnv(readFileSync(file, 'utf8'))) : {};
};

const chaos = async (port: number, body: unknown): Promise<void> => {
  await fetch(`http://localhost:${port}/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...chaosHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
};

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
  durationMs: number;
  injectAtMs: number;
  repairAtMs: number;
  inject: () => Promise<void>;
  repair: () => Promise<void>;
  rampAtMs?: number;
  rampConcurrency?: number;
};

const D = 70_000;
const INJECT = 20_000;
const REPAIR = 45_000;

export const SCENARIOS: Record<string, Scenario> = {
  'app-crash': {
    name: 'app-crash',
    title: 'Application crash',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => crash(3011),
    repair: () => dc('start', 'student-1'),
  },

  'db-failure': {
    name: 'db-failure',
    title: 'Database failure',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('stop', 'postgres-primary'),
    repair: () => dc('start', 'postgres-primary'),
  },

  'net-timeout': {
    name: 'net-timeout',
    title: 'Network / service timeout',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => chaos(3011, { latencyMs: 3000 }),
    repair: () => chaos(3011, { latencyMs: 0 }),
  },

  'node-failure': {
    name: 'node-failure',
    title: 'Hardware / node failure',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('kill', 'student-1', 'payment-1'),
    repair: () => dc('start', 'student-1', 'payment-1'),
  },

  'txn-interrupt': {
    name: 'txn-interrupt',
    title: 'Corrupted / lost transaction',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { await chaos(3021, { crashAfterCheckpoint: true }); await chaos(3022, { crashAfterCheckpoint: true }); },
    repair: () => dc('start', 'payment-1', 'payment-2'),
  },

  'high-load': {
    name: 'high-load',
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
