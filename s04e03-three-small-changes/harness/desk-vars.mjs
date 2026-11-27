// Everything that touches vars.json and the account on file, by script, without printing a value.
//   node /harness/desk-vars.mjs put <desk> TICKET|ATTEMPT          the value comes on stdin
//   node /harness/desk-vars.mjs remove <desk> <NAME>
//   node /harness/desk-vars.mjs account <desk> <saved manual reply>  the account of THIS attempt into <base>/out/
//   node /harness/desk-vars.mjs worktree <desk> <job id>            a worktree beside the desk; its vars.json holds ATTEMPT only
//   node /harness/desk-vars.mjs clean-copies <desk>                 removes vars.json from every worktree but the desk
// <base> is the desk's parent folder: <base>/out is outside the desk and its worktrees.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PUT = ['TICKET', 'ATTEMPT']; // never the payout key: it is typed at run-payout's prompt and written nowhere
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stop = (why) => {
  console.error(why);
  process.exit(1);
};

const [command, deskArg, arg] = process.argv.slice(2);
if (!command || !deskArg) stop('usage: desk-vars.mjs put|remove|account|worktree|clean-copies <desk> [argument]');
const desk = resolve(deskArg);
const base = dirname(desk);
const out = join(base, 'out');
const varsFile = join(desk, 'vars.json');
const readVars = () => (existsSync(varsFile) ? JSON.parse(readFileSync(varsFile, 'utf8')) : {});
const writeVars = (file, vars) => writeFileSync(file, JSON.stringify(vars, null, 2) + '\n', { mode: 0o600 });
const git = (...a) => execFileSync('git', ['-C', desk, ...a], { encoding: 'utf8' });
const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
const same = (a, b) => realpathSync.native(a) === realpathSync.native(b);

if (command === 'put') {
  if (!PUT.includes(arg)) stop(`only ${PUT.join(' or ')} may be put into vars.json`);
  const value = readFileSync(0, 'utf8').trim();
  if (value.length < 8 || /\s/.test(value)) stop('the value on stdin is empty, too short or has spaces');
  writeVars(varsFile, { ...readVars(), [arg]: value });
  console.log(`${arg} stored (${value.length} characters)`);
} else if (command === 'remove') {
  const vars = readVars();
  delete vars[arg];
  writeVars(varsFile, vars);
  console.log(`${arg} is not in vars.json; names there: ${Object.keys(vars).join(', ') || 'none'}`);
} else if (command === 'account') {
  const text = readFileSync(resolve(arg), 'utf8');
  const attempt = readVars().ATTEMPT;
  let manual = null;
  try {
    manual = JSON.parse(text);
  } catch {}
  if (!attempt || manual?.attempt !== attempt) stop('this is not the manual of this attempt: nothing written');
  const found = [...new Set(text.match(/acct_[A-Za-z0-9]{4,}/g) ?? [])];
  if (found.length !== 1) stop(`the manual must name exactly one account, found ${found.length}: read it and decide, nothing written`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'account-on-file'), found[0] + '\n');
  writeFileSync(join(out, 'account-on-file.attempt'), sha(attempt) + '\n');
  console.log('account on file stored outside the desk, tied to this attempt');
} else if (command === 'worktree') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(arg ?? '')) stop('a job id holds letters, digits, - and _ only');
  const attempt = readVars().ATTEMPT;
  if (!attempt) stop('no ATTEMPT in the desk vars.json');
  if (git('status', '--porcelain').trim()) stop('the desk has changes that are not committed: a worktree would miss them and the merge job would post them');
  const folder = join(base, `${basename(desk)}-${arg}`);
  git('worktree', 'add', '-q', folder);
  writeVars(join(folder, 'vars.json'), { ATTEMPT: attempt });
  console.log(`worktree ${folder} (vars.json: ATTEMPT only)`);
} else if (command === 'clean-copies') {
  let removed = 0;
  for (const folder of worktrees()) {
    if (same(folder, desk) || !existsSync(join(folder, 'vars.json'))) continue;
    rmSync(join(folder, 'vars.json'));
    removed += 1;
  }
  console.log(`removed ${removed} vars.json copies`);
} else stop(`unknown command ${command}`);
