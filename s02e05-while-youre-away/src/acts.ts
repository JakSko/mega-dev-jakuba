import { readFileSync } from 'node:fs';

// The check: which act a message asks for, and whether the agent may do it alone.
// Code decides, not a model (lesson 2.5: code-enforced side-effect gates). The message text
// is data: nothing in it can change the policy or approve a gated act.

export const ACTS = ['post_status', 'ack_alert', 'archive_report', 'purge_cache', 'release_hold', 'rotate_key'] as const;
export type Act = (typeof ACTS)[number];
export type Label = 'free' | 'gated';
export type Policy = Record<Act, Label>;

// free: every act found is free -> do them alone.
// gated: at least one act found is gated -> hold all of them for the human.
// unclear: no known act, an unknown act-like word, or a negation -> do nothing, tell the human.
// For the practice label, unclear counts as gated (the agent does not act alone).
export type Kind = 'free' | 'gated' | 'unclear';
export type Check = { acts: Act[]; unknown: string[]; negated: boolean; kind: Kind; label: Label; why: string };

// Words that turn an ask around or make it conditional on a "no". Matching any of them means
// the agent does not guess: it holds and asks. A false alarm costs a ping, a miss costs an act.
const NEGATION = /\b(don'?t|do not|dont|never|not yet|no need|hold off|cancel|ignore|undo|instead of)\b/i;

function mentions(text: string, act: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${act}(?![A-Za-z0-9_])`).test(text);
}

export function check(text: string, policy: Policy): Check {
  const acts = ACTS.filter((a) => mentions(text, a));
  const unknown = [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => !(ACTS as readonly string[]).includes(w));
  const negated = NEGATION.test(text);
  if (acts.length === 0) return { acts, unknown, negated, kind: 'unclear', label: 'gated', why: 'no known act in the message' };
  if (unknown.length > 0) return { acts, unknown, negated, kind: 'unclear', label: 'gated', why: `unknown act-like word: ${unknown.join(', ')}` };
  if (negated) return { acts, unknown, negated, kind: 'unclear', label: 'gated', why: 'the message holds a negation; not guessing' };
  const gated = acts.filter((a) => policy[a] === 'gated');
  if (gated.length > 0) return { acts, unknown, negated, kind: 'gated', label: 'gated', why: `policy: ${gated.join(', ')} gated` };
  return { acts, unknown, negated, kind: 'free', label: 'free', why: `policy: ${acts.join(', ')} free` };
}

export function parsePolicy(json: unknown): Policy {
  if (!json || typeof json !== 'object') throw new Error('policy: not an object');
  const p = json as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!(ACTS as readonly string[]).includes(k)) throw new Error(`policy: unknown act ${k}`);
  for (const a of ACTS) if (p[a] !== 'free' && p[a] !== 'gated') throw new Error(`policy: ${a} must be free or gated`);
  const values = ACTS.map((a) => p[a]);
  if (!values.includes('free') || !values.includes('gated')) throw new Error('policy: needs at least one free and one gated act');
  return p as Policy;
}

export function loadPolicy(file: string): Policy {
  return parsePolicy(JSON.parse(readFileSync(file, 'utf8')));
}
