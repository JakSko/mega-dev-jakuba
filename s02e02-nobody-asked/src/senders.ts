// Who may wake the agent (spec R3). Checked in code before any model call.
import type { Message } from './agentmail.ts';

// "Display Name <user@domain>" or "user@domain" -> "user@domain", lower case.
export function addressOf(from: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

const domainOf = (addr: string) => addr.split('@').pop() ?? '';

// A domain vouches for the From address only when it is the From domain or its parent
// (relaxed alignment, as DMARC uses it).
function aligned(vouching: string | undefined, fromDomain: string): boolean {
  if (!vouching) return false;
  const v = vouching.toLowerCase();
  return fromDomain === v || fromDomain.endsWith(`.${v}`);
}

// Mail written by machines: never answered, so two agents cannot loop.
function isAutomatic(m: Message, addr: string): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers ?? {})) h[k.toLowerCase()] = String(v).toLowerCase();
  if (h['auto-submitted'] && h['auto-submitted'] !== 'no') return true;
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(h['precedence'] ?? '')) return true;
  if (h['x-autoreply'] || h['x-autorespond'] || h['list-id']) return true;
  return /^(mailer-daemon|postmaster|no-?reply|bounce[s]?)@/.test(addr);
}

export type SenderCheck = { ok: true; sender: string } | { ok: false; reason: string };

export function checkSender(m: Message, opts: { allowed: string[]; own: string }): SenderCheck {
  const addr = addressOf(m.from ?? '');
  if (!addr.includes('@')) return { ok: false, reason: 'no sender address' };
  if (addr === opts.own.toLowerCase()) return { ok: false, reason: 'our own mail' };
  if ((m.labels ?? []).includes('sent')) return { ok: false, reason: 'our own mail' };
  if (isAutomatic(m, addr)) return { ok: false, reason: 'automatic mail' };
  if (!opts.allowed.map((a) => a.toLowerCase()).includes(addr)) return { ok: false, reason: 'sender not on the allowlist' };
  // Provider's verdicts only; the Authentication-Results header itself can be forged.
  const a = m.authentication_results ?? {};
  const fromDomain = domainOf(addr);
  const ok =
    (a.dmarc === 'pass' && aligned(a.dmarc_domain ?? fromDomain, fromDomain)) ||
    (a.dkim === 'pass' && aligned(a.dkim_domain, fromDomain)) ||
    (a.spf === 'pass' && aligned(a.spf_domain, fromDomain));
  if (!ok) return { ok: false, reason: `not authenticated (spf=${a.spf ?? '-'}, dkim=${a.dkim ?? '-'}, dmarc=${a.dmarc ?? '-'})` };
  return { ok: true, sender: addr };
}
