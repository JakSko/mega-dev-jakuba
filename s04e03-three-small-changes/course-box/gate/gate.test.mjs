// Tests of the gate. Local fake servers only; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTcp, connect as tcpConnect } from 'node:net';
import { createGate, checkRequest, isPublicIPv4, configFromEnv } from './gate.mjs';

const REAL = 'sk-test-REAL-KEY-0123456789abcdef';
const LIMITS = { models: new Set(['gpt-6.2-sol']), maxOutputTokens: 4000 };

const fn = { type: 'function', name: 'read', parameters: { type: 'object', properties: { image_url: { type: 'string' } } } };
// The shape Pi 1.6.1 sends for openai/gpt-6.2-sol (captured on a fake server, 2026-11-26):
// tools travel inside `input`, not in the top-level `tools` field.
const piBody = () => ({
  model: 'gpt-6.2-sol', stream: true, prompt_cache_key: 'k', store: false, max_output_tokens: 128000,
  reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'],
  input: [
    { type: 'additional_tools', role: 'developer', tools: [structuredClone(fn)] },
    { role: 'developer', content: 'rules' },
    { role: 'user', content: [{ type: 'input_text', text: 'say ok' }] },
    { type: 'configuration_update', reasoning: { effort: 'high' } },
  ],
});
const history = [
  { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'x' },
  { type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'a', annotations: [] }] },
  { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"image_url":"https://x.example"}' },
  { type: 'function_call_output', call_id: 'c1', output: 'text with https://x.example' },
  { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
];

test('the request Pi sends passes; output tokens are capped and store stays false', () => {
  const body = piBody();
  body.input.push(...history);
  const r = checkRequest(body, LIMITS);
  assert.equal(r.reason, undefined);
  assert.equal(r.body.max_output_tokens, 4000);
  assert.equal(r.body.store, false);
  const bare = piBody(); delete bare.max_output_tokens; delete bare.store;
  const b = checkRequest(bare, LIMITS).body;
  assert.deepEqual([b.max_output_tokens, b.store], [4000, false]);
});

const bad = {
  'model not on the list': (b) => { b.model = 'gpt-6.2-astra'; },
  'unknown top-level field': (b) => { b.service_tier = 'priority'; },
  'stored prompt': (b) => { b.prompt = { id: 'pmpt_1' }; },
  'earlier response': (b) => { b.previous_response_id = 'resp_1'; },
  background: (b) => { b.background = true; },
  'store true': (b) => { b.store = true; },
  'other include': (b) => { b.include = ['file_search_call.results']; },
  'server tool at top level': (b) => { b.tools = [{ type: 'web_search' }]; },
  'server tool inside additional_tools': (b) => { b.input[0].tools.push({ type: 'mcp', server_url: 'https://evil.example', server_label: 'x' }); },
  'additional_tools without a list': (b) => { b.input[0].tools = { type: 'mcp' }; },
  'extra key beside the tools': (b) => { b.input[0].more_tools = [{ type: 'mcp' }]; },
  'tools in a configuration update': (b) => { b.input[3].tools = [{ type: 'web_search' }]; },
  'server tool choice': (b) => { b.tool_choice = { type: 'web_search_preview' }; },
  'remote image': (b) => { b.input[2].content.push({ type: 'input_image', image_url: 'https://evil.example/?d=1' }); },
  'remote image as object': (b) => { b.input[2].content.push({ type: 'input_image', image_url: { url: 'https://evil.example/a' } }); },
  'remote image in a tool result': (b) => { b.input.push({ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'https://evil.example/a' }] }); },
  'remote file': (b) => { b.input[2].content.push({ type: 'input_file', file_url: 'https://evil.example/f' }); },
  'account file id': (b) => { b.input[2].content.push({ type: 'input_file', file_id: 'file-1' }); },
  'url in file_data': (b) => { b.input[2].content.push({ type: 'input_file', file_data: 'https://evil.example/f' }); },
  'unknown content part': (b) => { b.input[2].content.push({ type: 'input_audio_url', url: 'x' }); },
  'item reference': (b) => { b.input.push({ type: 'item_reference', id: 'msg_9' }); },
  'item reference without a type': (b) => { b.input.push({ id: 'msg_9' }); },
  'unknown item type': (b) => { b.input.push({ type: 'mcp_approval_response' }); },
};
for (const [name, change] of Object.entries(bad)) {
  test(`refused: ${name}`, () => {
    const b = piBody(); change(b);
    const r = checkRequest(b, LIMITS);
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  });
}

test('private, local and reserved addresses are not public', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.254', '192.168.1.11', '192.168.65.254', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'not-an-ip']) assert.equal(isPublicIPv4(ip), false, ip);
  for (const ip of ['1.1.1.1', '93.184.216.34', '172.32.0.1']) assert.equal(isPublicIPv4(ip), true, ip);
});

test('settings: empty by default; the model host, IPs and wildcards cannot be listed', () => {
  const c = configFromEnv({});
  assert.deepEqual([c.models.size, c.hosts.size, c.maxRequests], [0, 0, 0]);
  for (const GATE_HOSTS of ['api.openai.com', 'API.OPENAI.COM', '192.168.1.1', '*.example.com', 'localhost', 'a.example.com:443', 'host.docker.internal'])
    assert.throws(() => configFromEnv({ GATE_HOSTS }), /host/, GATE_HOSTS);
  assert.throws(() => configFromEnv({ GATE_MODELS: 'gpt-6.2-sol', GATE_MAX_REQUESTS: '3' }), /OPENAI_API_KEY/);
  assert.throws(() => configFromEnv({ GATE_MAX_REQUESTS: 'many' }), /GATE_MAX_REQUESTS/);
});

const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s.address().port)));

async function setup(t, { reply, maxRequests = 10, hosts = [], lookup, connect } = {}) {
  const seen = [], logs = [];
  const upstream = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      (reply ?? ((r) => { r.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'a=1' }); r.end('data: done\n\n'); }))(res);
    });
  });
  const up = await listen(upstream);
  const gate = createGate({ ...LIMITS, hosts: new Set(hosts), maxRequests, apiKey: REAL, upstream: new URL(`http://127.0.0.1:${up}`), lookup, connect, log: (l) => logs.push(l) });
  const model = await listen(gate.model), proxy = await listen(gate.proxy);
  t.after(() => { for (const s of [upstream, gate.model, gate.proxy]) { s.close(); s.closeAllConnections(); } });
  const call = (path = '/v1/responses', { method = 'POST', body = JSON.stringify(piBody()), headers = {} } = {}) => new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: model, path, method, headers: { 'content-type': 'application/json', authorization: 'Bearer dummy', ...headers } }, (res) => {
      let text = ''; res.on('data', (d) => (text += d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', fail); r.end(body);
  });
  return { seen, logs, call, model, proxy };
}

test('model port: the dummy key is swapped for the real one and only safe headers travel', async (t) => {
  const g = await setup(t);
  const r = await g.call('/v1/responses', { headers: { 'openai-organization': 'org-x', cookie: 'c=1', 'x-leak': 'data' } });
  assert.deepEqual([r.status, r.text], [200, 'data: done\n\n']);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(g.seen[0].headers.authorization, `Bearer ${REAL}`);
  for (const h of ['openai-organization', 'cookie', 'x-leak', 'session-id']) assert.equal(g.seen[0].headers[h], undefined, h);
  assert.equal(JSON.parse(g.seen[0].body).max_output_tokens, 4000);
  assert.ok(!JSON.stringify(g.logs).includes('REAL-KEY') && !JSON.stringify(g.logs).includes('say ok'));
});

test('model port: only POST /v1/responses; encoded, broken and refused bodies never reach the model', async (t) => {
  const g = await setup(t);
  for (const [path, method] of [['/v1/files', 'POST'], ['/v1/models', 'GET'], ['/v1/responses', 'GET'], ['/v1/responses/resp_1', 'POST'], ['/v1/responses?x=1', 'POST'], ['http://evil.example/v1/responses', 'POST']])
    assert.equal((await g.call(path, { method })).status, 403, `${method} ${path}`);
  assert.equal((await g.call('/v1/responses', { headers: { 'content-encoding': 'gzip' } })).status, 403);
  assert.equal((await g.call('/v1/responses', { body: 'not json' })).status, 403);
  assert.equal((await g.call('/v1/responses', { body: JSON.stringify({ ...piBody(), model: 'other' }) })).status, 403);
  assert.equal((await g.call('/v1/responses', { body: 'x'.repeat(11 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status, 413);
  assert.equal(g.seen.length, 0);
});

test('model port: the request limit holds for parallel requests', async (t) => {
  const g = await setup(t, { maxRequests: 2 });
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => g.call()));
  assert.deepEqual(all.map((r) => r.status).sort(), [200, 200, 429, 429, 429]);
  assert.equal(g.seen.length, 2);
});

test('model port: a redirect is not followed or passed on', async (t) => {
  const g = await setup(t, { reply: (r) => { r.writeHead(307, { location: 'https://evil.example/v1' }); r.end(); } });
  const r = await g.call();
  assert.equal(r.status, 502);
  assert.equal(r.headers.location, undefined);
  assert.equal(g.seen.length, 1);
});

test('model port: an error reply cannot show the key', async (t) => {
  const g = await setup(t, { reply: (r) => { r.writeHead(401, { 'content-type': 'application/json' }); r.end(`{"error":"bad key ${REAL} sk-proj-abc***wxyz"}`); } });
  const r = await g.call();
  assert.equal(r.status, 401);
  assert.ok(!r.text.includes('REAL-KEY') && !r.text.includes('wxyz'), r.text);
});

// Sends one CONNECT line and returns the status line and, for a tunnel, what comes back.
const tunnel = (port, target) => new Promise((ok) => {
  const s = tcpConnect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let got = '', sent = false;
  s.on('data', (d) => {
    got += d;
    if (!sent && got.startsWith('HTTP/1.1 200') && got.includes('\r\n\r\n')) { sent = true; s.write('ping'); }
    if (got.endsWith('ping')) { s.destroy(); ok(got); }
  });
  s.on('close', () => ok(got)); s.on('error', () => ok(got));
});

test('proxy port: only listed names on 443 with a public address; the checked address is the one used', async (t) => {
  const echo = createTcp((s) => s.pipe(s));
  const echoPort = await listen(echo);
  t.after(() => echo.close());
  const dialed = [];
  const table = { 'ok.example.com': ['93.184.216.34'], 'inside.example.com': ['93.184.216.34', '192.168.1.1'] };
  const g = await setup(t, {
    hosts: Object.keys(table),
    lookup: async (h) => table[h] ?? [],
    connect: (ip) => { dialed.push(ip); return tcpConnect(echoPort, '127.0.0.1'); },
  });
  assert.match(await tunnel(g.proxy, 'ok.example.com:443'), /^HTTP\/1\.1 200[\s\S]*ping$/);
  assert.deepEqual(dialed, ['93.184.216.34']);
  for (const target of ['other.example.com:443', 'ok.example.com:80', 'ok.example.com:22', 'ok.example.com.:443', 'OK.example.com:443', 'ok.example.com.evil.example:443', '93.184.216.34:443', '[::1]:443', 'host.docker.internal:443', 'api.openai.com:443', 'inside.example.com:443', 'ok.example.com'])
    assert.match(await tunnel(g.proxy, target), /^HTTP\/1\.1 403/, target);
  assert.equal(dialed.length, 1);
});

test('proxy port: plain HTTP is refused', async (t) => {
  const g = await setup(t, { hosts: ['ok.example.com'] });
  const status = await new Promise((ok) => request({ host: '127.0.0.1', port: g.proxy, path: 'http://ok.example.com/' }, (r) => { r.resume(); ok(r.statusCode); }).end());
  assert.equal(status, 405);
});
