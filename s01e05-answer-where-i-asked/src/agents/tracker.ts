import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The course tracker, read live on every ping (plan §2, ADR 0004: read it, don't copy it).
export type Comment = { by: string; body: string };
export type Issue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  by: string;
  body: string;
  comments: Comment[];
};

export type TrackerRead = { ok: true; issues: Issue[] } | { ok: false; why: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function parseIssue(j: unknown): Issue | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.number !== 'number' || !Number.isInteger(o.number)) return null;
  if (o.state !== 'open' && o.state !== 'closed') return null;
  return {
    number: o.number,
    title: str(o.title),
    state: o.state,
    labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === 'string') : [],
    by: str(o.by),
    body: str(o.body),
    comments: Array.isArray(o.comments)
      ? o.comments.map((c) => ({ by: str((c as Comment)?.by), body: str((c as Comment)?.body) }))
      : [],
  };
}

export async function readTracker(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<TrackerRead> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return { ok: false, why: `tracker not reachable (${e instanceof Error ? e.name : 'error'})` };
  }
  if (!res.ok) return { ok: false, why: `tracker answered ${res.status}` };
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    return { ok: false, why: 'tracker sent no JSON' };
  }
  const list = (j as { issues?: unknown })?.issues;
  if (!Array.isArray(list)) return { ok: false, why: 'tracker JSON has no issues list' };
  const issues = list.map(parseIssue);
  if (issues.some((i) => i === null)) return { ok: false, why: 'tracker has an issue without number or state' };
  return { ok: true, issues: issues as Issue[] };
}

// What the pulse reads besides the tracker (plan §2): plan.md and the done plans.
export type PlanFiles = { plan: string; done: { file: string; text: string }[] };

export function readPlanFiles(repoDir: string): PlanFiles {
  const doneDir = join(repoDir, 'docs/plans/done');
  let done: PlanFiles['done'] = [];
  try {
    done = readdirSync(doneDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ file: `docs/plans/done/${f}`, text: readFileSync(join(doneDir, f), 'utf8') }));
  } catch {
    done = [];
  }
  let plan = '';
  try {
    plan = readFileSync(join(repoDir, 'plan.md'), 'utf8');
  } catch {
    plan = '';
  }
  return { plan, done };
}
