// course-gate: the only way out of course-box. Design: ../../README.md
// Port 8081: the model API. It holds the real key and passes only requests it can check.
// Port 8080: CONNECT to port 443 of exactly listed hosts. Nothing else.
// Runs only this file. No packages. Logs never hold headers, bodies or the key.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, isIP, BlockList } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MODEL_HOST = 'api.openai.com';
const MAX_BODY = 10 * 1024 * 1024;

// ---------- request check: everything not known is refused ----------

const TOP = new Set(['model', 'input', 'stream', 'prompt_cache_key', 'store', 'max_output_tokens', 'reasoning', 'include', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'text']);
const ROLES = new Set(['user', 'assistant', 'developer', 'system']);
const TEXT_PARTS = new Set(['input_text', 'output_text', 'refusal', 'summary_text', 'reasoning_text']);
const CLIENT_TOOLS = new Set(['function', 'custom']);

class Refused extends Error {}
const need = (ok, reason) => { if (!ok) throw new Refused(reason); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const name = (v) => JSON.stringify(String(v).slice(0, 60));
const onlyKeys = (o, keys, where) => { for (const k of Object.keys(o)) need(keys.includes(k), `${where}: key ${name(k)}`); };
const inline = (v) => typeof v === 'string' && v.startsWith('data:');

function checkTools(tools) {
  need(Array.isArray(tools), 'tools is not a list');
  for (const t of tools) need(isObject(t) && CLIENT_TOOLS.has(t.type), `tool type ${name(t?.type)}: only function and custom`);
}

function checkParts(parts) {
  if (typeof parts === 'string') return;
  need(Array.isArray(parts), 'content is not text or a list');
  for (const p of parts) {
    need(isObject(p), 'content part is not an object');
    if (TEXT_PARTS.has(p.type)) continue;
    need(p.type === 'input_image' || p.type === 'input_file', `content part ${name(p.type)}`);
    need(!('file_id' in p) && !('file_url' in p), 'a file by id or address');
    if (p.type === 'input_image') need(inline(p.image_url), 'an image that is not inline data');
    else need(inline(p.file_data) && !('image_url' in p), 'a file that is not inline data');
  }
}

function checkItem(item) {
  need(isObject(item), 'input item is not an object');
  switch (item.type) {
    case undefined:
    case 'message':
      need(ROLES.has(item.role) && 'content' in item && !('tools' in item), 'message without a known role and content');
      return checkParts(item.content);
    case 'additional_tools':
      onlyKeys(item, ['type', 'id', 'role', 'tools'], 'additional_tools');
      return checkTools(item.tools);
    case 'configuration_update':
      return onlyKeys(item, ['type', 'id', 'reasoning'], 'configuration_update');
    case 'function_call':
    case 'custom_tool_call':
      return;
    case 'function_call_output':
    case 'custom_tool_call_output':
      return checkParts(item.output);
    case 'reasoning':
      if (item.summary !== undefined) checkParts(item.summary);
      if (item.content !== undefined && item.content !== null) checkParts(item.content);
      return;
    default:
      throw new Refused(`input item ${name(item.type)}`);
  }
}

export function checkRequest(body, { models, maxOutputTokens }) {
  try {
    need(isObject(body), 'body is not a JSON object');
    for (const k of Object.keys(body)) need(TOP.has(k), `field ${name(k)}`);
    need(models.has(body.model), `model ${name(body.model)} is not on the list`);
    need(body.store === undefined || body.store === false, 'store is not false');
    need(body.include === undefined || (Array.isArray(body.include) && body.include.every((i) => i === 'reasoning.encrypted_content')), 'include');
    if (body.tools !== undefined) checkTools(body.tools);
    const choice = body.tool_choice;
    need(choice === undefined || ['auto', 'none', 'required'].includes(choice) || CLIENT_TOOLS.has(choice?.type), 'tool_choice');
    if (typeof body.input !== 'string') {
      need(Array.isArray(body.input), 'input is not text or a list');
      body.input.forEach(checkItem);
    }
    const asked = body.max_output_tokens;
    const max = Number.isInteger(asked) && asked > 0 ? Math.min(asked, maxOutputTokens) : maxOutputTokens;
    return { ok: true, body: { ...body, store: false, max_output_tokens: max } };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    return { ok: false, reason: 'the body could not be checked' };
  }
}

// ---------- addresses ----------

const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]])
  blocked.addSubnet(net, bits, 'ipv4');

// IPv4 only on purpose: every IPv6 answer counts as not public.
export const isPublicIPv4 = (ip) => isIP(ip) === 4 && !blocked.check(ip, 'ipv4');

// ---------- settings ----------

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const list = (v) => new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
function count(env, key, fallback) {
  const v = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${key} must be a whole number`);
  return v;
}

export function configFromEnv(env) {
  const hosts = list(env.GATE_HOSTS);
  for (const h of hosts)
    if (!HOST.test(h) || h === MODEL_HOST || /\.(internal|local|localhost)$/.test(h)) throw new Error(`host not allowed in GATE_HOSTS: ${name(h)}`);
  const config = { models: list(env.GATE_MODELS), hosts, maxRequests: count(env, 'GATE_MAX_REQUESTS', 0), maxOutputTokens: count(env, 'GATE_MAX_OUTPUT_TOKENS', 4000), apiKey: env.OPENAI_API_KEY ?? '' };
  if (config.models.size && config.maxRequests && !config.apiKey) throw new Error('OPENAI_API_KEY is not set');
  return config;
}

// ---------- the two servers ----------

const defaultLookup = async (host) => (await dnsLookup(host, { all: true, family: 4 })).map((a) => a.address);
const defaultConnect = (ip) => tcpConnect({ host: ip, port: 443 });

export function createGate({ models, hosts, maxRequests, maxOutputTokens, apiKey, upstream, lookup = defaultLookup, connect = defaultConnect, log = (line) => console.log(JSON.stringify(line)) }) {
  let used = 0;
  const note = (port, target, decision, extra = {}) => log({ time: new Date().toISOString(), port, target: String(target).split('?')[0].slice(0, 200), decision, ...extra });
  const redact = (text) => (apiKey ? text.split(apiKey).join('[key]') : text).replace(/sk-[A-Za-z0-9_*.-]+/g, '[key]');

  const model = createServer((req, res) => {
    const target = `${req.method} ${req.url}`;
    const refuse = (status, reason) => {
      note('model', target, 'refused', { status, reason });
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: { type: 'course_gate', message: `course-gate refused: ${reason}` } }));
    };
    if (req.method !== 'POST' || req.url !== '/v1/responses') return refuse(403, 'only POST /v1/responses');
    if (req.headers['content-encoding']) return refuse(403, 'encoded body');
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY) { over = true; refuse(413, 'body too large'); } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return refuse(403, 'body is not JSON'); }
      const checked = checkRequest(parsed, { models, maxOutputTokens });
      if (!checked.ok) return refuse(403, checked.reason);
      if (used >= maxRequests) return refuse(429, `request limit ${maxRequests} reached`);
      used += 1;
      const number = used;
      // The checked object is sent, not the bytes that came in.
      const out = Buffer.from(JSON.stringify(checked.body));
      const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const up = send(new URL('/v1/responses', upstream), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: req.headers.accept ?? '*/*', authorization: `Bearer ${apiKey}`, 'content-length': out.length, 'user-agent': 'course-gate' },
        timeout: 10 * 60 * 1000,
      }, (reply) => {
        const status = reply.statusCode;
        note('model', target, 'sent', { status, model: checked.body.model, request: number, of: maxRequests });
        if (status >= 300 && status < 400) { reply.resume(); return refuse(502, 'the model host answered with a redirect'); }
        const headers = { 'content-type': reply.headers['content-type'] ?? 'application/octet-stream' };
        if (status < 300) { res.writeHead(status, headers); return reply.pipe(res); }
        let text = '';
        reply.setEncoding('utf8');
        reply.on('data', (d) => { if (text.length < 65536) text += d; });
        reply.on('end', () => { res.writeHead(status, headers); res.end(redact(text)); });
      });
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', (e) => {
        if (res.headersSent) return res.destroy();
        refuse(502, `the model host could not be reached (${e.code ?? 'error'})`);
      });
      res.on('close', () => up.destroy());
      up.end(out);
    });
  });
  model.on('upgrade', (req, socket) => { note('model', `${req.method} ${req.url}`, 'refused', { reason: 'upgrade' }); socket.destroy(); });

  const proxy = createServer((req, res) => {
    note('proxy', `${req.method} ${req.url}`, 'refused', { reason: 'not CONNECT' });
    res.writeHead(405, { connection: 'close' });
    res.end();
  });
  proxy.on('connect', async (req, client, head) => {
    client.on('error', () => client.destroy());
    const refuse = (reason) => {
      note('proxy', req.url, 'refused', { reason });
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    };
    const match = /^([^:]+):443$/.exec(req.url);
    if (!match) return refuse('only name:443');
    const host = match[1];
    if (!hosts.has(host) || host === MODEL_HOST) return refuse('host is not on the list');
    let addresses;
    try { addresses = await lookup(host); } catch { return refuse('name not found'); }
    if (!addresses.length || !addresses.every(isPublicIPv4)) return refuse('no address, or one that is not public');
    // Connect to the address that was checked, so a second DNS answer cannot change it.
    const server = connect(addresses[0]);
    let open = false;
    server.setTimeout(10000, () => server.destroy(new Error('timeout')));
    server.once('connect', () => {
      open = true;
      server.setTimeout(0);
      note('proxy', req.url, 'tunnel');
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) server.write(head);
      server.pipe(client);
      client.pipe(server);
    });
    server.on('error', () => (open ? client.destroy() : refuse('connection failed')));
    server.on('close', () => open && client.end());
    client.on('close', () => server.destroy());
  });

  return { model, proxy };
}

// ---------- production start: the upstream is fixed here, no setting changes it ----------

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const config = configFromEnv(process.env);
  const gate = createGate({ ...config, upstream: new URL(`https://${MODEL_HOST}`) });
  gate.model.listen(8081, '0.0.0.0');
  gate.proxy.listen(8080, '0.0.0.0');
  console.log(JSON.stringify({ event: 'start', models: [...config.models], hosts: [...config.hosts], maxRequests: config.maxRequests, maxOutputTokens: config.maxOutputTokens, key: config.apiKey ? 'set' : 'not set' }));
}
