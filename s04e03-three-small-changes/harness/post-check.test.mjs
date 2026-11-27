// Tests for post-check.mjs. They make small git repos in a temp folder. Run in course-box: node --test post-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkPost } from './post-check.mjs';

const ATTEMPT = 'attempt-value-1234567890';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A desk with one commit, and a plan with a worker job (a.js, new.js) and the merge job (m.js). */
function setup({ plan } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pc-'));
  const top = join(base, 'host-desk');
  const dataDir = join(base, 'data');
  const outDir = join(base, 'out');
  mkdirSync(top);
  mkdirSync(dataDir);
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.invalid');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  put(top, '.gitignore', 'vars.json\n');
  put(top, 'vars.json', JSON.stringify({ ATTEMPT }));
  for (const f of ['a.js', 'b.js', 'm.js']) put(top, f, `// ${f}\n`);
  git('add', '-A');
  git('commit', '-qm', 'setup');
  const jobs = plan ?? [
    { id: 'w-1', request: 'r1', files: ['a.js', 'new.js'] },
    { id: 'merge-1', request: 'merge', files: ['m.js'] },
  ];
  writeFileSync(join(dataDir, 'plan.json'), JSON.stringify({ setupCommit: git('rev-parse', 'HEAD').trim(), jobs }));
  const diff = () => {
    git('add', '-N', '--', '.');
    return git('diff', 'HEAD');
  };
  const check = (over = {}) => checkPost({ top, job: 'w-1', diff: over.diff ?? diff(), ranOn: 'openai/x', dataDir, outDir, ...over });
  return { base, top, dataDir, outDir, git, diff, check };
}

test('clean change inside the job files passes, new file too, and is logged', () => {
  const s = setup();
  put(s.top, 'a.js', 'changed\n');
  put(s.top, 'new.js', 'new\n');
  assert.deepEqual(s.check().problems, []);
  const log = readFileSync(join(s.outDir, 'events.jsonl'), 'utf8');
  assert.match(log, /"event":"post-check","job":"w-1","ok":true/);
});

test('a path outside the job files is refused', () => {
  const s = setup();
  put(s.top, 'a.js', 'changed\n');
  put(s.top, 'b.js', 'changed\n');
  assert.match(s.check().problems.join(), /outside the job's files: b\.js/);
});

test('a rename is checked on both names', () => {
  const s = setup();
  s.git('mv', 'b.js', 'new.js');
  assert.match(s.check({ diff: s.git('diff', '--cached', '-M', 'HEAD') }).problems.join(), /outside the job's files: b\.js/);
});

test('a diff over 32 KB is refused', () => {
  const s = setup();
  put(s.top, 'a.js', 'x'.repeat(33 * 1024) + '\n');
  assert.match(s.check().problems.join(), /over 32768 bytes/);
});

test('a value from vars.json in the diff is refused, and is not repeated in the answer or the log', () => {
  const s = setup();
  put(s.top, 'a.js', `const t = '${ATTEMPT}';\n`);
  const r = s.check();
  assert.match(r.problems.join(), /value of ATTEMPT/);
  assert.ok(!JSON.stringify(r).includes(ATTEMPT));
  assert.ok(!readFileSync(join(s.outDir, 'events.jsonl'), 'utf8').includes(ATTEMPT));
});

test('the account on file and key shapes are refused', () => {
  const s = setup();
  mkdirSync(s.outDir, { recursive: true });
  writeFileSync(join(s.outDir, 'account-on-file'), 'acct_9f9f9f9f9f\n');
  put(s.top, 'a.js', `// acct_9f9f9f9f9f sk-${'A1'.repeat(15)}\n`);
  const text = s.check().problems.join();
  assert.match(text, /account on file/);
  assert.match(text, /looks like a key/);
});

test('journal, out and secret file paths are refused even when the plan lists them', () => {
  for (const f of ['journal/solve.jsonl', 'roles/reviewer/out/x.json', '.env.local', 'night/a']) {
    const s = setup({ plan: [{ id: 'w-1', request: 'r1', files: [f] }] });
    put(s.top, f, 'x\n');
    assert.match(s.check().problems.join(), /journal, output or secret path/, f);
  }
});

test('no plan, an unknown job, an empty diff, an unreadable header, no vars.json: refused', () => {
  const s = setup();
  put(s.top, 'a.js', 'changed\n');
  const good = s.diff();
  assert.match(s.check({ dataDir: join(s.base, 'none') }).problems.join(), /plan\.json/);
  assert.match(s.check({ job: 'w-9' }).problems.join(), /not in the plan/);
  assert.match(s.check({ diff: '' }).problems.join(), /empty/);
  assert.match(s.check({ diff: good.replace('diff --git a/a.js b/a.js', 'diff --git "a/\\303.js" "b/\\303.js"') }).problems.join(), /header/);
  assert.match(s.check({ diff: 'some text\n' + good }).problems.join(), /does not start/);
  put(s.top, 'vars.json', 'not json');
  assert.match(s.check({ diff: good }).problems.join(), /vars\.json/);
});

test('a commit titled merge <job> may hold only that job files; any other merge title is refused', () => {
  const s = setup();
  put(s.top, 'a.js', 'from w-1\n');
  s.git('commit', '-qam', 'merge w-1');
  put(s.top, 'm.js', 'integrator work\n');
  const own = () => s.git('diff', 'HEAD');
  const first = s.check({ job: 'merge-1', diff: own() });
  assert.deepEqual(first.problems.filter((p) => !/approve/.test(p)), []);
  put(s.top, 'b.js', 'hidden\n');
  s.git('commit', '-qm', 'merge w-1', '--', 'b.js');
  assert.match(s.check({ job: 'merge-1', diff: own() }).problems.join(), /merge commit/);
  const t = setup();
  put(t.top, 'a.js', 'x\n');
  t.git('commit', '-qam', 'merge sneaky');
  put(t.top, 'a.js', 'y\n');
  assert.match(t.check().problems.join(), /merge commit/);
});

test('the merge job needs an approve file that names the hash of this exact diff', () => {
  const s = setup();
  put(s.top, 'm.js', 'integrator work\n');
  const diff = s.diff();
  const first = s.check({ job: 'merge-1', diff });
  assert.match(first.problems.join(), new RegExp(`approve.*${sha(diff)}`));
  assert.equal(readFileSync(join(s.outDir, 'pending-merge-1.diff'), 'utf8'), diff);
  writeFileSync(join(s.dataDir, 'approve-merge-1.sha256'), sha(diff) + '\n');
  assert.deepEqual(s.check({ job: 'merge-1', diff }).problems, []);
  put(s.top, 'm.js', 'changed after the approval\n');
  assert.match(s.check({ job: 'merge-1', diff: s.diff() }).problems.join(), /approve/);
});

test('a secret in ranOn is refused', () => {
  const s = setup();
  put(s.top, 'a.js', 'changed\n');
  assert.match(s.check({ ranOn: `m ${ATTEMPT}` }).problems.join(), /ranOn/);
});

test('the post-check line names the role that posts', () => {
  const s = setup();
  put(s.top, 'a.js', 'changed\n');
  s.check();
  put(s.top, 'm.js', 'changed\n');
  s.check({ job: 'merge-1' });
  const roles = readFileSync(join(s.outDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).role);
  assert.deepEqual(roles, ['worker', 'integrator']);
});
