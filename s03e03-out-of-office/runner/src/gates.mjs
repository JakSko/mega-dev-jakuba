// Deterministic gates and the git steps around a change. Everything here is code, no model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ALLOWED = [/^src\//, /^test\//, /^contract\/api\.md$/, /^PRIMITIVES\.md$/];
const FORBIDDEN_IN_DIFF = [
  [/PROD_ADMIN_TOKEN/, 'the change names PROD_ADMIN_TOKEN'],
  [/prod_admin_[0-9a-f]+/, 'the change holds an admin token'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'the change holds a key'],
  [/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i, 'the change sends a write request; this API only reads'],
];

// On the host, git and the tests in the working copy run as a separate user with a bare
// environment: code the model wrote never sees the runner's tokens.
const ISO = process.env.RUN_UID
  ? { uid: Number(process.env.RUN_UID), gid: Number(process.env.RUN_GID), env: { PATH: process.env.PATH, HOME: process.env.RUN_HOME ?? '/home/coder', LANG: 'C.UTF-8' } }
  : {};

function run(cmd, args, cwd, timeout = 180000) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, shell: false, ...ISO });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function makeGit(work) {
  const git = (...args) => {
    const r = run('git', args, work);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(0, 400)}`);
    return r.out.replace(/\s+$/, '');   // keep leading spaces: `git status --porcelain` needs them
  };
  return {
    head: () => git('rev-parse', 'HEAD'),
    reset: (ref) => { git('reset', '-q', '--hard', ref); git('clean', '-fdq'); },
    changed: () => git('status', '--porcelain', '-uall').split('\n').filter(Boolean)
      .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')),
    diff: () => { git('add', '-A'); return git('diff', '--cached'); },
    // Only src/: a test may name the admin token or send a POST to prove the API refuses it.
    codeDiff: () => { git('add', '-A'); return git('diff', '--cached', '--', 'src'); },
    docStat: () => { git('add', '-A'); return git('diff', '--cached', '--numstat', '--', 'contract/api.md', 'PRIMITIVES.md'); },
    commit: (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); },
    revert: () => { git('revert', '--no-edit', 'HEAD'); return git('rev-parse', 'HEAD'); },
    push: () => { try { git('push', '-q', 'origin', 'HEAD'); return true; } catch { return false; } },
    show: (ref, file) => git('show', `${ref}:${file}`),
  };
}

/**
 * Gates before any deploy. `allowContract` is true only when the owner accepted a record for
 * this issue: then the old contract tests may change, because the answer is meant to change.
 */
export function runGates(work, { base, allowContract = false }) {
  const git = makeGit(work);
  const files = git.changed();
  if (!files.length) return { ok: false, why: 'no file changed', output: '' };

  const outside = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
  if (outside.length) return { ok: false, why: `files outside src/, test/, contract/api.md, PRIMITIVES.md: ${outside.join(', ')}`, output: '' };

  const plus = (d) => d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const addedAll = plus(git.diff());
  const addedCode = plus(git.codeDiff());
  // Token values may appear nowhere. The token's name and write requests may not appear in code
  // or tests (the contract document itself names them, so the docs are not held to that).
  for (const [re, why] of FORBIDDEN_IN_DIFF.slice(1, 3)) if (re.test(addedAll)) return { ok: false, why, output: '' };
  for (const [re, why] of [FORBIDDEN_IN_DIFF[0], FORBIDDEN_IN_DIFF[3]]) if (re.test(addedCode)) return { ok: false, why: `${why} (in src/)`, output: '' };

  if (!allowContract) {
    // Without the owner's answer the documents only grow: no existing line of the contract or
    // the primitives may be changed or removed.
    const cut = git.docStat().split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, del]) => Number(del) > 0);
    if (cut.length) return { ok: false, why: `existing lines were changed or removed in ${cut.map((c) => c[2]).join(', ')}; keep every existing line exactly as it is and only add new lines at the end of a section`, output: '' };
  }

  if (!files.some((f) => /^test\//.test(f))) return { ok: false, why: 'no test was added or changed for this change', output: '' };

  const t = run(process.execPath, ['--test'], work);
  if (t.code !== 0) return { ok: false, why: 'npm test failed', output: tail(t.out) };

  if (!allowContract) {
    // The contract tests as they were before the change must still pass on the new code.
    const tmp = path.join(work, 'test', 'zz-baseline.tmp.test.js');
    try {
      fs.writeFileSync(tmp, git.show(base, 'test/contract.test.js'));
      const b = run(process.execPath, ['--test', tmp], work);
      if (b.code !== 0) return { ok: false, why: 'the change breaks an existing answer (baseline contract tests fail); that needs the owner', output: tail(b.out) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return { ok: true, why: 'all gates passed', output: '' };
}

const tail = (s) => s.split('\n').filter((l) => /✖|not ok|Error|expected|actual|assert/i.test(l)).slice(0, 40).join('\n') || s.slice(-3000);
