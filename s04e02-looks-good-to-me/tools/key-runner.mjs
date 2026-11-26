// The owner starts this once in their own terminal, where OPENAI_API_KEY is set. It runs only the jobs listed below,
// asked for by a file in journal/queue/, so the harness can start a run without ever holding the key.
// It counts the paid runs and stops at the cap. Ctrl+C ends it.
//
// Request file journal/queue/<name>.job.json: { "job": "rehearsal" | "first" | "lab", "patch": "...", "settings": "..." }
// The output goes to <name>.log, the exit code to <name>.done.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE = join(DESK, 'journal', 'queue');
const COUNT = join(DESK, 'journal', 'paid-runs.json');
const CAP = 20;
const ALLOWED = [join(DESK, 'lab'), join(DESK, 'private')];
const JOBS = {
  rehearsal: { paid: false, args: ['first', '--rehearse'] },
  first: { paid: true, args: ['first'] },
  lab: { paid: true, args: ['lab'] },
};

if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set in this terminal.'); process.exit(1); }
mkdirSync(QUEUE, { recursive: true });
// Requests left from before this start are not run.
for (const f of readdirSync(QUEUE)) if (f.endsWith('.job.json')) renameSync(join(QUEUE, f), join(QUEUE, `${f}.stale`));
const used = () => (existsSync(COUNT) ? JSON.parse(readFileSync(COUNT, 'utf8')).used : 0);
console.log(`key-runner ready. Paid runs used: ${used()} of ${CAP}. Jobs: ${Object.keys(JOBS).join(', ')}. Ctrl+C ends it.`);

let busy = false;
setInterval(() => {
  if (busy) return;
  const file = readdirSync(QUEUE).filter((f) => f.endsWith('.job.json')).sort()[0];
  if (!file) return;
  busy = true;
  const name = file.slice(0, -'.job.json'.length);
  const log = join(QUEUE, `${name}.log`);
  const say = (t) => { process.stdout.write(t); appendFileSync(log, t); };
  const end = (code) => { writeFileSync(join(QUEUE, `${name}.done`), String(code)); busy = false; };
  renameSync(join(QUEUE, file), join(QUEUE, `${name}.taken`));
  try {
    const req = JSON.parse(readFileSync(join(QUEUE, `${name}.taken`), 'utf8'));
    const job = JOBS[req.job];
    if (!job) throw new Error(`unknown job: ${req.job}`);
    const args = [join(DESK, 'tools', 'run-reviewer.mjs'), ...job.args];
    for (const key of ['patch', 'settings']) {
      if (!req[key]) continue;
      const path = resolve(DESK, req[key]);
      if (!ALLOWED.some((root) => path.startsWith(root + sep))) throw new Error(`${key} is outside the allowed folders`);
      args.push(`--${key}`, path);
    }
    if (job.paid) {
      if (used() >= CAP) throw new Error(`the cap of ${CAP} paid runs is reached`);
      writeFileSync(COUNT, JSON.stringify({ used: used() + 1 }));
    }
    say(`\n== job ${name}: ${req.job}${job.paid ? ` (paid run ${used()} of ${CAP})` : ' (no model call)'}\n`);
    const child = spawn(process.execPath, args, { cwd: DESK, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => say(String(d)));
    child.stderr.on('data', (d) => say(String(d)));
    child.on('close', (code) => { say(`== job ${name} ended: exit ${code}\n`); end(code); });
  } catch (e) {
    say(`== job ${name} refused: ${e.message}\n`);
    end('refused');
  }
}, 1000);
