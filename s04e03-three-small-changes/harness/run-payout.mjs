// Runs the payout script with the practice key, which is typed here, passed only to that process and written nowhere.
// The owner starts it in their own terminal, after every file it runs was read:
//   docker exec -it course-run node /harness/run-payout.mjs /work/<attempt folder>/host-desk practice|run|parked|parked-finish
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MODES = ['practice', 'run', 'parked', 'parked-finish'];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stop = (why) => {
  console.error(`not started: ${why}`);
  process.exit(1);
};

const [deskArg, mode] = process.argv.slice(2);
if (!deskArg || !MODES.includes(mode)) stop(`usage: run-payout.mjs <desk> ${MODES.join('|')}`);
const desk = resolve(deskArg);
const out = join(dirname(desk), 'out');
const vars = JSON.parse(readFileSync(join(desk, 'vars.json'), 'utf8'));
if (!vars.ATTEMPT) stop('no ATTEMPT in vars.json');
if (vars.PAYOUT_KEY) stop('vars.json holds PAYOUT_KEY: the key is never kept in a file. Remove it');
const read = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').trim() : '');
const account = read('account-on-file');
if (!account) stop('no account on file yet (desk-vars.mjs account)');
if (read('account-on-file.attempt') !== sha(vars.ATTEMPT)) stop('the account on file belongs to another attempt');
const copies = execFileSync('git', ['-C', desk, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice(9))
  .filter((w) => realpathSync.native(w) !== realpathSync.native(desk) && existsSync(join(w, 'vars.json')));
if (copies.length) stop(`a worktree still has vars.json (desk-vars.mjs clean-copies): ${copies.join(', ')}`);
const script = join(desk, 'roles', 'payout-runner', 'scripts', 'solve.mjs');
const scriptHash = sha(readFileSync(script));
const test = process.env.RUN_PAYOUT_TEST === '1';
if (!process.stdin.isTTY && !test) stop('run it in your own terminal (docker exec -it ...): the key is typed there');

function readKey() {
  if (!process.stdin.isTTY) return Promise.resolve(readFileSync(0, 'utf8').split('\n')[0].trim());
  return new Promise((done) => {
    process.stdout.write('Practice payout key (hidden), then Enter: ');
    let key = '';
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return done(key.trim());
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') key = key.slice(0, -1);
        else key += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

const key = await readKey();
if (key.length < 8 || /\s/.test(key)) stop('the key is empty, too short or has spaces');

const KEEP = /^(PATH|HOME|TZ|LANG|HTTPS?_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)$/i;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k))), ATTEMPT: vars.ATTEMPT, PAYOUT_KEY: key, ACCOUNT_ON_FILE: account };
mkdirSync(out, { recursive: true });
const mask = (s) => [key, vars.ATTEMPT, account].reduce((t, v) => t.split(v).join('<masked>'), s);
const event = (e) => appendFileSync(join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), role: 'payout', job: mode, ...e }) + '\n');
event({ event: 'payout-start', scriptHash });
let text = '';
const child = spawn(process.execPath, [script, mode, '--live'], { cwd: dirname(script), env, stdio: ['ignore', 'pipe', 'pipe'] });
const take = (to) => (d) => {
  const safe = mask(String(d));
  text += safe;
  to.write(safe);
};
child.stdout.on('data', take(process.stdout));
child.stderr.on('data', take(process.stderr));
child.on('close', (code) => {
  const file = join(out, `payout-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  writeFileSync(file, text);
  event({ event: 'payout-end', exit: code });
  console.log(`saved (masked): ${file}`);
  process.exit(code ?? 1);
});
