import { createInterface } from 'node:readline/promises';
import { SCENARIOS, chaosHeaders, dc } from './scenarios.ts';

const GW = 'http://localhost:8080';
const PAY = { studentId: 's7', amount: 100 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const title = (t: string) => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);
const json = (url: string) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({}));

async function status(method: string, path: string, body?: unknown): Promise<string> {
  try {
    const r = await fetch(GW + path, {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    return String(r.status);
  } catch {
    return '000';  // hung or refused
  }
}

async function probe(n: number, method: string, path: string, body?: unknown): Promise<string> {  // N calls -> status histogram
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const s = await status(method, path, body);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts].sort().map(([s, c]) => `${s} x${c}`).join('  ');
}

const students = (n: number) => probe(n, 'GET', '/api/students/s7');
const transcripts = (n: number) => probe(n, 'GET', '/api/transcripts/s7');
const payments = (n: number) => probe(n, 'POST', '/api/payments', PAY);

async function appCrash() {
  title('Application crash: student-1 kills its own process');
  console.log(`before   students: ${await students(20)}`);
  await SCENARIOS['app-crash'].inject();
  await sleep(500);
  console.log(`during   students: ${await students(40)}`);
  console.log(`         gateway view: ${JSON.stringify((await json(`${GW}/health`)).instances ?? {})}`);
  await sleep(8000);
  console.log(`after 8s students: ${await students(20)}   (FT: restart policy brought it back)`);
  await SCENARIOS['app-crash'].repair();
}

async function dbFailure() {
  title('Database failure: the PostgreSQL primary is stopped');
  console.log(`before   students: ${await students(10)}   transcripts: ${await transcripts(5)}   payments: ${await payments(3)}`);
  await SCENARIOS['db-failure'].inject();
  await sleep(2000);
  console.log(`during   students: ${await students(5)}   transcripts: ${await transcripts(5)}   payments: ${await payments(3)}`);
  console.log('         FT: reads from the standby (200) or stale cache (203); writes fail fast (503) instead of hanging (000)');
  await SCENARIOS['db-failure'].repair();
  await sleep(6000);
  console.log(`after    students: ${await students(10)}   transcripts: ${await transcripts(5)}   payments: ${await payments(3)}`);
}

async function nodeFailure() {
  title('Node failure: student-1 and payment-1 are killed together');
  console.log(`before   students: ${await students(20)}   payments: ${await payments(10)}`);
  await SCENARIOS['node-failure'].inject();
  await sleep(500);
  console.log(`during   students: ${await students(20)}   payments: ${await payments(10)}`);
  console.log('         FT: the surviving node carries everything; capacity drops, availability does not');
  await SCENARIOS['node-failure'].repair();
  await sleep(5000);
  console.log(`after    students: ${await students(20)}   payments: ${await payments(10)}`);
}

async function timetable() {
  title('Timetable job interrupted: the instance generating it crashes mid-job');
  const term = `demo-${Date.now()}`;
  const job = await fetch(`${GW}/api/timetables`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ term }),
  }).then((r) => r.json()).catch(() => ({}));
  const owner: string | undefined = job.owner;
  if (!owner?.startsWith('timetable-')) {
    console.log('could not start a job -- is the platform up?');
    return;
  }
  const show = async () => {
    const j = await json(`${GW}/api/timetables/${term}`);
    return `state=${j.state}  owner=${j.owner}  progress=${j.progress}`;
  };
  console.log(`job ${term} started on ${owner}`);
  await sleep(2000);
  console.log(`  t+2s   ${await show()}`);
  await fetch(`http://localhost:304${owner.slice(-1)}/chaos/crash`, { method: 'POST', headers: chaosHeaders() })  // timetable-1 -> :3041
    .catch(() => {});
  console.log(`  ${owner} crashed`);
  for (let i = 3; i <= 16; i++) {
    await sleep(1000);
    console.log(`  t+${i}s  ${await show()}`);
  }
  console.log('  FT: the job resumes from its last checkpoint on a live replica and reaches done');
  console.log("  baseline: progress stays 0/120 and the job is 'running' forever");
  await dc('start', owner);
}

const ALL: Record<string, () => Promise<void>> = {
  'app-crash': appCrash, 'db-failure': dbFailure, 'node-failure': nodeFailure, timetable,
};

const which = process.argv[2] ?? 'all';
const health = await json(`${GW}/health`);
console.log(`deployed version: ${health.ft === undefined ? 'not running' : health.ft ? 'fault-tolerant' : 'baseline'}`);

if (which === 'all') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const run of Object.values(ALL)) {
    await run();
    await rl.question('\npress Enter for the next scenario ');
  }
  rl.close();
} else if (ALL[which]) {
  await ALL[which]();
} else {
  console.log(`usage: npm run demo [-- ${Object.keys(ALL).join(' | ')}]`);
  process.exit(1);
}
