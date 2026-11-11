// Preload for the course collectors: saves every fetch reply exactly, so log.md can hold it.
// Usage: FETCH_LOG_DIR=<dir> node --import <this file> collectors/all.mjs ...
// The session token (?t=) is cut from the saved URL; the body is saved as received.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FETCH_LOG_DIR;
if (!dir) throw new Error('FETCH_LOG_DIR not set');
mkdirSync(dir, { recursive: true });
const realFetch = globalThis.fetch;
let n = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  url.searchParams.set('t', 'MASKED');
  const at = new Date().toISOString();
  const res = await realFetch(input, init);
  const text = await res.clone().text();
  n += 1;
  const name = `${String(n).padStart(2, '0')}-${url.pathname.split('/').filter(Boolean).slice(-2).join('-')}`;
  writeFileSync(join(dir, `${name}.body.json`), text);
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify({ at, method: init?.method ?? 'GET', url: url.toString(), status: res.status, headers: Object.fromEntries(res.headers) }, null, 2) + '\n');
  return res;
};
