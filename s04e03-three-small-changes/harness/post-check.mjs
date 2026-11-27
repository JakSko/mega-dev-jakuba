// The check that stands before a job's result goes to the board. Both post-result.mjs copies call it right before
// their POST. It reads what is about to be sent (the diff text), not only the work tree. It fails closed: anything it
// cannot read or parse is a problem. It never repeats a secret value.
//
// In the box it lives in /harness (read-only for the team). Its inputs there: data/<desk base>/plan.json
// ({ setupCommit, jobs: [{ id, request, files }] }, written after the plan was read back from the board) and, for the
// merge job, data/<desk base>/approve-<job>.sha256 (the hash of the exact diff we approved).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_BYTES = 32 * 1024;
const MIN_SECRET = 6;
const BANNED_PATH = /(^|\/)(journal|out|night|node_modules)\/|(^|\/)(vars\.json|parked\.json|\.env[^/]*)$|\.(pem|key)$/i;
const KEY_SHAPE = /sk-[A-Za-z0-9_-]{20,}|v1\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
const MERGE_TITLE = /^merge \S+$/;

const sha = (s) => createHash('sha256').update(s).digest('hex');

function readJson(path, name, problems) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    problems.push(`cannot read ${name}`);
    return null;
  }
}

/** The paths the diff itself names (both sides of a rename), or a problem for a header we cannot read for sure. */
function diffPaths(diff, problems) {
  const paths = new Set();
  if (!diff.replace(/^\n+/, '').startsWith('diff --git ')) problems.push('the diff does not start with a diff header');
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (!m) {
      problems.push('a diff header with a quoted or spaced path: refused');
      continue;
    }
    paths.add(m[1]).add(m[2]);
  }
  return [...paths];
}

/** post-result leaves out commits titled "merge <word>", so each one must be a real job merge with only its files. */
function checkMergeCommits(top, plan, problems) {
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8', maxBuffer: 1 << 22 });
  let log;
  try {
    log = git('log', '--format=%H%x09%P%x09%s', `${plan.setupCommit}..HEAD`).split('\n').filter(Boolean);
  } catch {
    problems.push('cannot read the commits since the setup commit');
    return;
  }
  const seen = new Set();
  for (const line of log) {
    const [commit, parents, ...rest] = line.split('\t');
    const subject = rest.join('\t').trim();
    if (parents.trim().includes(' ')) problems.push('a merge commit with two parents: post-result would leave it out');
    if (!MERGE_TITLE.test(subject)) continue;
    const id = subject.slice('merge '.length);
    const job = plan.jobs.find((j) => j.id === id && j.request !== 'merge');
    const files = git('show', '--format=', '--name-only', '--no-renames', commit).split('\n').filter(Boolean);
    if (!job || seen.has(id) || files.some((f) => !job.files.includes(f))) {
      problems.push(`a merge commit "${subject}" that is not one job's merge with only that job's files`);
    }
    seen.add(id);
  }
}

export function checkPost({ top, job, diff, ranOn, dataDir, outDir }) {
  const problems = [];
  let paths = [];
  const text = typeof diff === 'string' ? diff : '';
  const plan = readJson(join(dataDir, 'plan.json'), 'plan.json', problems);
  const vars = readJson(join(top, 'vars.json'), 'vars.json', problems);
  const mine = plan?.jobs?.find((j) => j.id === job);

  if (!text.trim()) problems.push('the diff is empty');
  else paths = diffPaths(text, problems);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) problems.push(`the diff is ${bytes} bytes, over ${MAX_BYTES} bytes`);

  for (const p of paths) if (BANNED_PATH.test(p)) problems.push(`a journal, output or secret path: ${p}`);
  if (plan && !mine) problems.push(`job ${job} is not in the plan`);
  if (mine) {
    const outside = paths.filter((p) => !mine.files.includes(p));
    if (outside.length) problems.push(`outside the job's files: ${outside.join(', ')}`);
  }

  const secrets = Object.entries(vars ?? {}).filter(([, v]) => typeof v === 'string' && v.length >= MIN_SECRET);
  try {
    const account = readFileSync(join(outDir, 'account-on-file'), 'utf8').trim();
    if (account.length >= MIN_SECRET) secrets.push(['the account on file', account]);
  } catch {
    // not there before the manual
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) problems.push(`the diff holds the value of ${name}`);
    if (String(ranOn ?? '').includes(value) || String(job).includes(value)) problems.push(`ranOn or the job id holds the value of ${name}`);
  }
  if (KEY_SHAPE.test(text) || KEY_SHAPE.test(String(ranOn ?? ''))) problems.push('something in the post looks like a key or a ticket');

  if (plan) checkMergeCommits(top, plan, problems);

  const hash = sha(text);
  mkdirSync(outDir, { recursive: true });
  if (mine?.request === 'merge') {
    let approved = '';
    try {
      approved = readFileSync(join(dataDir, `approve-${job}.sha256`), 'utf8').trim();
    } catch {
      // not approved yet
    }
    if (approved !== hash) {
      // Kept for reading only when nothing else is wrong with it, so no secret is written out.
      if (!problems.length && /^[\w.-]+$/.test(job)) writeFileSync(join(outDir, `pending-${job}.diff`), text);
      problems.push(`the merge job waits for its approve file for diff ${hash}`);
    }
  }

  const ok = problems.length === 0;
  appendFileSync(join(outDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), role: mine ? (mine.request === 'merge' ? 'integrator' : 'worker') : null, event: 'post-check', job, ok, bytes, diffSha: hash, paths, problems }) + '\n');
  return { ok, problems, paths, bytes, diffSha: hash };
}

/** What post-result.mjs calls: throws, so that nothing is sent, unless every check passes. */
export function assertPostAllowed({ top, job, diff, ranOn }) {
  const base = dirname(resolve(top));
  const result = checkPost({ top, job, diff, ranOn, dataDir: join('/harness/data', basename(base)), outDir: join(base, 'out') });
  if (!result.ok) throw new Error(`not sent: ${result.problems.join('; ')}`);
  console.log(`post-check ok: ${result.paths.join(', ')} (${result.bytes} bytes)`);
}
