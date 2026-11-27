// A fake course for the rehearsal, on this machine only (127.0.0.1:8787). It keeps what it is sent in memory and
// in a log file, and its board is longer than 20,000 characters on purpose. It is not the course's behaviour.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const LOG = process.argv[2] ?? '/tmp/rehearsal-course.jsonl';
// An optional second file gives the board's { requests, plan } (the smoke run needs a request a model can do).
const given = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null;
const state = { plan: given?.plan ?? null, claims: [], results: [] };
const requests = given?.requests ?? ['r1', 'r2', 'r3'].map((id) => ({ id, title: `rehearsal ${id}`, text: `${id} `.repeat(2500) }));

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!req.headers.authorization) return send(401, { error: 'no authorization' });
    let data = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      return send(400, { error: 'not json' });
    }
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, bytes: Buffer.byteLength(body) }) + '\n');
    if (req.method === 'GET' && req.url === '/c/board') return send(200, { requests, ...state, end: 'END-OF-BOARD' });
    if (req.method === 'POST' && req.url === '/c/board/plan') return send(200, (state.plan = { at: new Date().toISOString(), jobs: data.jobs }));
    if (req.method === 'POST' && req.url === '/c/board/claims') return send(200, (state.claims.push(data), data));
    if (req.method === 'POST' && req.url === '/c/board/results') {
      const paths = [...String(data.diff).matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]);
      state.results.push({ job: data.job, paths, ranOn: data.ranOn, at: new Date().toISOString() });
      return send(200, { job: data.job, paths });
    }
    return send(404, { error: 'not here' });
  });
}).listen(8787, '127.0.0.1', () => console.log('fake course on 127.0.0.1:8787'));
