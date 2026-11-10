import { readFileSync } from 'node:fs';
import { courseSign, messageId } from '../src/course.ts';

// Sends one test message to the live agent, signed like the course (or unsigned), with the
// replyUrl on the host's own test sink. The key is read from a file and never printed.
//   node scripts/send_test.ts <agent url> <keyFile|none> "<text>"

const [url, keyFile, text] = process.argv.slice(2);
if (!url || !keyFile || !text) {
  console.error('usage: send_test.ts <agent url> <keyFile|none> "<text>"');
  process.exit(2);
}
const base = url.replace(/\/$/, '');
const raw = JSON.stringify({ from: 'ops-bot', subject: 'harness test', text, replyUrl: `${base}/_test/reply/${Date.now()}` });
const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'jakub-harness-test' };
if (keyFile !== 'none') {
  const ts = String(Math.floor(Date.now() / 1000));
  headers['x-course-timestamp'] = ts;
  headers['x-course-signature'] = courseSign(readFileSync(keyFile, 'utf8').trim(), ts, raw);
}
const r = await fetch(`${base}/`, { method: 'POST', headers, body: raw });
console.log(`POST ${base}/ -> ${r.status} ${await r.text()}  id=${messageId(raw)}`);
