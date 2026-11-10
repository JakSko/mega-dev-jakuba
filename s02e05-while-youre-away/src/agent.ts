import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { check, type Act, type Check, type Policy } from './acts.ts';
import type { Log } from './guard.ts';
import { readBody, type Event } from './service.ts';

// The S02E05 agent: free acts alone, gated acts held for the human, a ping to the human's
// phone, and an approve page that needs the owner code. Course text is data: only the act id
// and the policy decide. Approval comes only through the owner path (spec R6, R7).

export type CourseMessage = { from: string; subject: string; text: string; replyUrl: string };

export type Held = {
  id: string;
  acts: Act[];
  from: string;
  subject: string;
  text: string;
  replyUrl: string;
  receivedAt: number;
  state: 'held' | 'approved' | 'declined' | 'expired' | 'locked';
  tries: number;
  closedAt?: number;
};

export type DoneAct = { id: string; act: Act; at: number; by: 'policy' | 'human' };

export type AgentConfig = {
  policy: Policy;
  publicUrl: string; // base for the approve link in the ping
  ownerCode: string; // the code only the human has (D4)
  ntfy: { url: string; topic: string } | null;
  varDir: string | null; // null = memory only (tests)
  log: Log;
  now?: () => number; // ms
  fetch?: typeof fetch;
  heldMs?: number; // default 60 min (brief: a held act has 60 minutes from its message to its DONE)
  maxTries?: number; // owner-code tries per held id
  allowHttpReply?: boolean; // tests only
  testMode?: boolean; // enables the /_test/ sink
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const digest = (s: string) => createHash('sha256').update(s).digest();

export class Agent {
  cfg: AgentConfig;
  now: () => number;
  fetch: typeof fetch;
  heldMs: number;
  maxTries: number;
  held = new Map<string, Held>();
  done: DoneAct[] = [];
  timers = new Map<string, NodeJS.Timeout>();
  sink: { at: number; path: string; body: string }[] = [];

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? Date.now;
    this.fetch = cfg.fetch ?? fetch;
    this.heldMs = cfg.heldMs ?? 60 * 60 * 1000;
    this.maxTries = cfg.maxTries ?? 5;
    this.restore();
  }

  // ---- state on disk (a volume on the host) ----

  private file(name: string): string | null {
    return this.cfg.varDir ? `${this.cfg.varDir}/${name}` : null;
  }

  private save(): void {
    const f = this.file('held.json');
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...this.held.values()], null, 1));
  }

  private restore(): void {
    const f = this.file('held.json');
    if (f) {
      try {
        for (const h of JSON.parse(readFileSync(f, 'utf8')) as Held[]) this.held.set(h.id, h);
      } catch {
        // no file yet
      }
    }
    const d = this.file('acts.jsonl');
    if (d) {
      try {
        this.done = readFileSync(d, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        // no file yet
      }
    }
    for (const h of this.held.values()) if (h.state === 'held') this.schedule(h);
  }

  private record(id: string, act: Act, by: DoneAct['by']): void {
    const entry: DoneAct = { id, act, at: this.now(), by };
    this.done.push(entry);
    const d = this.file('acts.jsonl');
    if (d) {
      mkdirSync(dirname(d), { recursive: true });
      appendFileSync(d, JSON.stringify(entry) + '\n');
    }
    this.cfg.log({ event: 'act', id, act, by, verdict: 'done' });
  }

  // ---- outgoing ----

  async reply(id: string, replyUrl: string, text: string, hide = ''): Promise<number> {
    const shown = hide ? text.split(hide).join('<course code>') : text;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.fetch(replyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        const body = (await r.text()).slice(0, 2000);
        this.cfg.log({ event: 'reply', id, attempt, status: r.status, text: shown, response: body });
        if (r.ok) return r.status;
      } catch (err) {
        this.cfg.log({ event: 'reply', id, attempt, status: 'error', text: shown, why: String((err as Error)?.message ?? err) });
      }
      if (attempt === 1) await new Promise((res) => setTimeout(res, 1000));
    }
    return 0;
  }

  async ping(id: string, title: string, message: string, click?: string): Promise<void> {
    if (!this.cfg.ntfy) {
      this.cfg.log({ event: 'ping', id, verdict: 'skipped, no ntfy configured', title });
      return;
    }
    const headers: Record<string, string> = { Title: title, Priority: click ? 'high' : 'default', Tags: click ? 'warning' : 'information_source' };
    if (click) headers.Click = click;
    try {
      const r = await this.fetch(`${this.cfg.ntfy.url}/${this.cfg.ntfy.topic}`, { method: 'POST', headers, body: message });
      this.cfg.log({ event: 'ping', id, status: r.status, title, click: click ?? null });
    } catch (err) {
      this.cfg.log({ event: 'ping', id, status: 'error', title, why: String((err as Error)?.message ?? err) });
    }
  }

  // ---- the work ----

  parse(body: unknown): CourseMessage | string {
    if (!body || typeof body !== 'object') return 'body is not an object';
    const b = body as Record<string, unknown>;
    for (const k of ['text', 'replyUrl'] as const) if (typeof b[k] !== 'string' || !b[k]) return `missing ${k}`;
    let url: URL;
    try {
      url = new URL(b.replyUrl as string);
    } catch {
      return 'replyUrl is not a URL';
    }
    if (url.protocol !== 'https:' && !(this.cfg.allowHttpReply && url.protocol === 'http:')) return 'replyUrl is not https';
    return { from: String(b.from ?? ''), subject: String(b.subject ?? ''), text: b.text as string, replyUrl: b.replyUrl as string };
  }

  async handle(event: Event): Promise<void> {
    const m = this.parse(event.body);
    if (typeof m === 'string') {
      this.cfg.log({ event: 'decision', id: event.id, verdict: 'not handled', why: m });
      return;
    }
    const c: Check = check(`${m.subject}\n${m.text}`, this.cfg.policy);
    this.cfg.log({ event: 'decision', id: event.id, from: m.from, kind: c.kind, acts: c.acts, why: c.why });

    if (c.kind === 'free') {
      for (const a of c.acts) this.record(event.id, a, 'policy');
      await this.reply(event.id, m.replyUrl, c.acts.map((a) => `DONE: ${a}`).join('\n'));
      return;
    }

    if (c.kind === 'unclear' && c.acts.length === 0) {
      await this.reply(
        event.id,
        m.replyUrl,
        `NOT DONE: ${c.why}. I do not guess with acts, so nothing was done. Ask again with one act: post_status, ack_alert, archive_report, purge_cache, release_hold or rotate_key.`,
      );
      // No act, nothing for the human to decide: no ping (a notification belongs to an ask that
      // needs the owner, and the status log counts each row against the message it belongs to).
      this.cfg.log({ event: 'decision', id: event.id, verdict: 'no act: replied, owner not notified' });
      return;
    }

    const existing = this.held.get(event.id);
    if (existing) {
      this.cfg.log({ event: 'decision', id: event.id, verdict: 'already held', state: existing.state });
      return;
    }
    // Per act (Jakub, option A): a free act is done now, a gated act is held. When the message is
    // unclear (a negation or an unknown act-like word), every known act in it is held for the human.
    const doNow = c.kind === 'gated' ? c.acts.filter((a) => this.cfg.policy[a] === 'free') : [];
    const hold = c.acts.filter((a) => !doNow.includes(a));
    for (const a of doNow) this.record(event.id, a, 'policy');
    const h: Held = { id: event.id, acts: hold, from: m.from, subject: m.subject, text: m.text, replyUrl: m.replyUrl, receivedAt: this.now(), state: 'held', tries: 0 };
    this.held.set(h.id, h);
    this.save();
    this.schedule(h);
    // One line per ask, in the message's order of acts; exact lines only (course: no_action_lines).
    await this.reply(event.id, m.replyUrl, c.acts.map((a) => (doNow.includes(a) ? `DONE: ${a}` : `HOLD: ${a}`)).join('\n'));
    await this.ping(event.id, `Approve ${hold.join(', ')}?`, `${m.from || 'The course'} asks: "${m.text.slice(0, 300)}"\n${doNow.length ? `Done alone: ${doNow.join(', ')}. ` : ''}Tap: tick, owner code + course code.`, this.approveUrl(h.id));
  }

  approveUrl(id: string): string {
    return `${this.cfg.publicUrl.replace(/\/$/, '')}/approve/${id}`;
  }

  private schedule(h: Held): void {
    const left = h.receivedAt + this.heldMs - this.now();
    const t = setTimeout(() => void this.expire(h.id), Math.max(0, left));
    this.timers.set(h.id, t);
  }

  async expire(id: string): Promise<void> {
    const h = this.held.get(id);
    this.timers.delete(id);
    if (!h || h.state !== 'held') return;
    h.state = 'expired';
    h.closedAt = this.now();
    this.save();
    this.cfg.log({ event: 'decision', id, verdict: 'expired, no approval in time', acts: h.acts });
    await this.reply(id, h.replyUrl, h.acts.map((a) => `HOLD: ${a}`).join('\n'));
  }

  // Approve or decline, bound to one held id (R7). The code is compared in constant time and
  // never logged; after maxTries wrong codes the id is locked.
  async decide(id: string, code: string, decision: string, approveActs: string[] = [], courseCode = ''): Promise<{ status: number; message: string }> {
    const h = this.held.get(id);
    if (!h) return { status: 404, message: 'No held request with this id.' };
    if (h.state !== 'held') return { status: 409, message: `This request is already ${h.state}.` };
    if (this.now() > h.receivedAt + this.heldMs) {
      await this.expire(id);
      return { status: 410, message: 'Too late: the 60 minutes are over. Nothing was done.' };
    }
    const ok = code.length > 0 && timingSafeEqual(digest(code), digest(this.cfg.ownerCode));
    if (!ok) {
      h.tries++;
      this.cfg.log({ event: 'approval', id, verdict: 'wrong code', tries: h.tries });
      if (h.tries >= this.maxTries) {
        h.state = 'locked';
        h.closedAt = this.now();
        this.clear(id);
        this.save();
        this.cfg.log({ event: 'approval', id, verdict: 'locked after wrong codes' });
        await this.reply(id, h.replyUrl, h.acts.map((a) => `HOLD: ${a}`).join('\n'));
        return { status: 403, message: 'Locked after too many wrong codes. Nothing was done.' };
      }
      this.save();
      return { status: 403, message: `Wrong code. ${this.maxTries - h.tries} tries left.` };
    }
    const approved = decision === 'decline' ? [] : h.acts.filter((a) => approveActs.includes(a));
    const cc = courseCode.trim();
    if (decision !== 'decline') {
      if (approved.length === 0) return { status: 400, message: 'Tick at least one act to approve, or press Decline all.' };
      if (!cc || cc.length > 64 || !/^[!-~ ]+$/.test(cc)) return { status: 400, message: 'Enter the course code from the course page (one line, printable characters).' };
    }
    this.clear(id);
    h.closedAt = this.now();
    const ask = (a: Act) => `HOLD: ${a}`;
    if (approved.length === 0) {
      h.state = 'declined';
      this.save();
      this.cfg.log({ event: 'approval', id, verdict: 'declined by the human', acts: h.acts });
      await this.reply(id, h.replyUrl, h.acts.map(ask).join('\n'));
      return { status: 200, message: 'Declined. The course was told nothing was done and asked to confirm.' };
    }
    h.state = 'approved';
    this.save();
    const held = h.acts.filter((a) => !approved.includes(a));
    this.cfg.log({ event: 'approval', id, verdict: 'approved by the human', approved, stillHeld: held });
    for (const a of approved) this.record(id, a, 'human');
    // Reply line for a held act after the owner's go: DONE, the act, CODE and the owner's code.
    const lines = h.acts.map((a) => (approved.includes(a) ? `DONE: ${a} CODE: ${cc}` : ask(a)));
    const status = await this.reply(id, h.replyUrl, lines.join('\n'), cc);
    return { status: 200, message: status ? `Sent to the course (HTTP ${status}): ${approved.map((a) => `DONE ${a}`).join(', ')}${held.length ? `; asked to confirm ${held.join(', ')}` : ''}.` : 'Approved, but the reply to the course failed: check the log.' };
  }

  private clear(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---- routes: the approve page and the test sink ----

  page(h: Held | undefined, note = ''): string {
    const body = !h
      ? '<p>No held request with this id.</p>'
      : `<p><b>${esc(h.acts.join(', '))}</b> asked by ${esc(h.from || 'the course')}</p>
<p class="t">${esc(h.subject)}</p><blockquote>${esc(h.text)}</blockquote>
<p>State: <b>${esc(h.state)}</b>${h.state === 'held' ? `, ${Math.max(0, Math.round((h.receivedAt + this.heldMs - this.now()) / 60000))} min left` : ''}</p>
${
  h.state === 'held'
    ? `<form method="post"><p>Approve these acts (unticked = held, the sender is asked to confirm):</p>
${h.acts.map((a) => `<label class="c"><input type="checkbox" name="act" value="${esc(a)}"> ${esc(a)}</label>`).join('')}
<input type="password" name="code" autocomplete="current-password" placeholder="owner code" required>
<input type="text" name="courseCode" autocomplete="off" autocapitalize="off" placeholder="course code (from the course page)">
<button name="decision" value="approve">Approve ticked</button> <button name="decision" value="decline" class="no">Decline all</button></form>`
    : ''
}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Approve</title>
<style>body{font:16px system-ui;margin:16px;max-width:520px}blockquote{background:#f3f3f3;padding:8px;margin:8px 0;white-space:pre-wrap}input,button{font-size:18px;padding:10px;margin:6px 0;width:100%;box-sizing:border-box}button.no{background:#fee}label.c{display:block;font-size:20px;margin:8px 0}label.c input{width:auto;transform:scale(1.5);margin-right:10px}.n{background:#eef;padding:8px}</style></head>
<body><h1>Held act</h1>${note ? `<p class="n">${esc(note)}</p>` : ''}${body}</body></html>`;
  }

  route = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const html = (status: number, s: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      res.end(s);
    };
    const m = path.match(/^\/approve\/(m_[0-9a-f]{16})$/);
    if (m) {
      const id = m[1];
      if (req.method === 'GET') {
        this.cfg.log({ event: 'approval', id, verdict: 'page opened' });
        html(200, this.page(this.held.get(id)));
        return true;
      }
      if (req.method === 'POST') {
        const raw = (await readBody(req, 4096)) ?? '';
        const form = new URLSearchParams(raw);
        const r = await this.decide(id, form.get('code') ?? '', form.get('decision') ?? 'approve', form.getAll('act'), form.get('courseCode') ?? '');
        html(r.status, this.page(this.held.get(id), r.message));
        return true;
      }
    }
    if (this.cfg.testMode && path.startsWith('/_test/')) {
      if (req.method === 'POST' && path.startsWith('/_test/reply')) {
        const raw = (await readBody(req, 16384)) ?? '';
        this.sink.push({ at: this.now(), path, body: raw });
        this.cfg.log({ event: 'test sink', path, body: raw });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      }
      if (req.method === 'GET' && path === '/_test/replies') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.sink));
        return true;
      }
    }
    return false;
  };
}
