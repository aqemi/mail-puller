// Reads secrets.json, stringifies any non-string values (e.g. the accounts array),
// then calls `wrangler secret bulk` with the result.
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';

const raw = JSON.parse(readFileSync('secrets.json', 'utf-8'));

const bulk = Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
);

const tmp = '.secrets-bulk.json';
writeFileSync(tmp, JSON.stringify(bulk));
try {
  execSync(`wrangler secret bulk ${tmp}`, { stdio: 'inherit' });
} finally {
  unlinkSync(tmp);
}
