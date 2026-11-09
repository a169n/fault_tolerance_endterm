import { spawnSync } from 'node:child_process';
import { isMode } from './env.ts';
import { writeEnvFile } from './env-file.ts';

const arg = process.argv[2] === 'ft' ? 'midterm' : process.argv[2];  // up:ft is the midterm name
if (!arg || !isMode(arg)) {
  console.log('usage: npm run up:baseline | npm run up:midterm | npm run up:endterm');
  process.exit(1);
}

writeEnvFile(arg);  // compose reads mode + secrets from .env
console.log(`mode: ${arg}`);
const r = spawnSync('docker', ['compose', 'up', '-d', '--build', '--remove-orphans'], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
process.exit(r.status ?? 1);
