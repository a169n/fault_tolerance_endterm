import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildEnv, formatEnv, isMode, parseEnv } from './env.ts';

const arg = process.argv[2] === 'ft' ? 'midterm' : process.argv[2];  // up:ft is the midterm name
if (!arg || !isMode(arg)) {
  console.log('usage: npm run up:baseline | npm run up:midterm | npm run up:endterm');
  process.exit(1);
}

const envFile = new URL('../.env', import.meta.url);
const existing = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
writeFileSync(envFile, formatEnv(buildEnv(arg, existing)), { mode: 0o600 });  // compose reads mode + secrets from .env
try { chmodSync(envFile, 0o600); } catch { /* not supported on every filesystem (Windows) */ }
console.log(`mode: ${arg}`);
const r = spawnSync('docker', ['compose', 'up', '-d', '--build'], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
process.exit(r.status ?? 1);
