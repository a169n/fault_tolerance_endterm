import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { runWorkload, type Rec } from './workload.ts';
import { SCENARIOS, dc } from './scenarios.ts';
import { gzipSync } from 'node:zlib';
import { computeMetrics, consistencyFrom } from './metrics.ts';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const writeJsonlGz = (path: string, rows: unknown[]): void =>
  writeFileSync(`${path}.gz`, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
const ms = (v: number | null | undefined) => (v == null ? 'n/a' : `${v} ms`);
const pctStr = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} %`);
const GATEWAY = 'http://localhost:8080';   // nginx: the entry point clients use
const INSTANCES = [8081, 8082, 3011, 3012, 3021, 3022, 3031, 3041, 3042, 3051];  // both gateways (direct) + every service replica + auth-1

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readFrom(path: string, offset: number): string {
  const size = statSync(path).size;
  if (size <= offset) return '';
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return buf.toString('utf8');
}

const psql = async (sql: string): Promise<string> => {
  const { stdout } = await exec(
    'docker',
    ['compose', 'exec', '-T', 'postgres-primary', 'psql', '-U', 'postgres', '-d', 'university', '-t', '-A', '-F', '|', '-c', sql],
    { cwd: ROOT },
  );
  return stdout.trim();
};

async function ensureHealthy(): Promise<void> {
  process.stdout.write('  restoring platform ');
  await dc('start');
  for (let i = 0; i < 90; i++) {
    const checks = await Promise.all(
      INSTANCES.map((p) =>
        fetch(`http://localhost:${p}/health`, { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false),
      ),
    );
    const gw = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    const repl = await psql('select count(*) from pg_stat_replication;').catch(() => '0');
    if (checks.every(Boolean) && gw && repl.trim() === '1') {
      console.log('ok (all instances up, standby streaming)');
      return;
    }
    process.stdout.write('.');
    await sleep(1000);
  }
  throw new Error('platform did not become healthy within 90 s');
}

async function main(): Promise<void> {
  const name = process.argv[2];
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.log(`usage: node experiments/run.ts <${Object.keys(SCENARIOS).join('|')}>`);
    process.exit(1);
  }

  console.log(`\n=== ${scenario.title} (${name}) ===`);
  await ensureHealthy();

  const health = await (await fetch(`${GATEWAY}/health`)).json();
  const mode = health.ft ? 'ft' : 'baseline';
  console.log(`  mode: ${mode.toUpperCase()}`);

  await psql("TRUNCATE payments; UPDATE students SET balance = 0;");

  const runId = `${name}-${mode}-${Date.now()}`;
  const eventsPath = `${ROOT}logs/events.jsonl`;
  const eventsOffset = statSync(eventsPath).size;
  const t0 = Date.now();
  let injectTs = 0;
  let repairTs = 0;

  setTimeout(async () => {
    injectTs = Date.now();
    console.log(`  T+${((injectTs - t0) / 1000).toFixed(1)}s  INJECT`);
    await scenario.inject();
  }, scenario.injectAtMs);

  setTimeout(async () => {
    repairTs = Date.now();
    console.log(`  T+${((repairTs - t0) / 1000).toFixed(1)}s  REPAIR`);
    await scenario.repair();
  }, scenario.repairAtMs);

  console.log(`  running workload for ${scenario.durationMs / 1000}s ...`);
  const recs = await runWorkload({
    gateway: GATEWAY,
    durationMs: scenario.durationMs,
    concurrency: 10,
    rampAtMs: scenario.rampAtMs,
    rampConcurrency: scenario.rampConcurrency,
    runId,
  });
  const t1 = Date.now();

  const events = readFrom(eventsPath, eventsOffset)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ts >= t0 - 2000 && e.ts <= t1 + 2000);

  const ledger = await psql(
    `select
       (select count(*) from payments where state='completed'),
       (select count(*) from payments where state='pending'),
       (select count(*) from payments where state='rolled_back'),
       (select count(*) from payments where state='failed'),
       (select coalesce(sum(amount),0) from payments where state='completed'),
       (select coalesce(sum(balance),0) from students);`,
  ).catch(() => '0|0|0|0|0|0');
  const [completed, pending, rolledBack, failedPay, charged, balances] = ledger.split('|').map(Number);

  const consistency = consistencyFrom(recs, {
    completed, pending, rolledBack, failedPay, charged, balances,
  });

  const metrics = computeMetrics(recs, events, t0, t1, injectTs || t0 + scenario.injectAtMs);

  const logDir = `${ROOT}logs/${name}__${mode}`;
  const dir = `${ROOT}reports/runs/${name}__${mode}`;
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeJsonlGz(`${logDir}/workload.jsonl`, recs);
  writeJsonlGz(`${logDir}/events.jsonl`, events);
  writeFileSync(`${dir}/metrics.json`, JSON.stringify({ scenario: name, mode, t0, t1, injectTs, repairTs, metrics, consistency }, null, 2));

  console.log(`  availability ${pctStr(metrics.availability.requestBased)} req / ${pctStr(metrics.availability.timeBased)} time` +
    ` | failed ${metrics.requests.failed}/${metrics.requests.total}` +
    ` | detect ${ms(metrics.response.detectionMs)} | recover ${ms(metrics.response.recoveryMs)}`);
  console.log(`  -> ${dir.replace(ROOT, '')}/metrics.json, raw data in ${logDir.replace(ROOT, '')}/`);
}

await main();
