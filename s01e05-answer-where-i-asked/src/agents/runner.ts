import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';

// Runs a test the model wrote, away from the agent (R27): a temp copy of the repo with the
// carried files as the base, a child process with a clean environment (no keys, no token)
// and a time limit. The test can read only what is in that copy.
const COPY = ['package.json', 'tsconfig.json', 'rig.json', 'src', 'test', 'runs'];
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];

export function cleanEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const k of ENV_KEEP) if (from[k]) env[k] = from[k];
  return env;
}

// A carried path must stay inside src/ (test-writer.md: the files of src/ the issue is about).
export function safeSrcPath(p: string): string | null {
  const n = normalize(p).split(sep).join('/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) return null;
  return n.startsWith('src/') && /\.(ts|tsx)$/.test(n) ? n : null;
}

export type Workspace = { dir: string; drop: () => void };

export function makeWorkspace(repoDir: string, base: Record<string, string>): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'rig-test-writer-'));
  for (const item of COPY) {
    const from = join(repoDir, item);
    if (existsSync(from)) cpSync(from, join(dir, item), { recursive: true, filter: (s) => !/[\\/]test[\\/]agents\./.test(s) });
  }
  symlinkSync(resolve(repoDir, 'node_modules'), join(dir, 'node_modules'), 'junction');
  for (const [p, text] of Object.entries(base)) {
    const safe = safeSrcPath(p);
    if (!safe) continue;
    mkdirSync(dirname(join(dir, safe)), { recursive: true });
    writeFileSync(join(dir, safe), text);
  }
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

export type RunResult = { code: number | null; timedOut: boolean; stdout: string; stderr: string };

export function runNode(cwd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, timedOut, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000) });
    });
  });
}

// "Red" means: the file loaded, at least one test ran, and an assertion failed (test-writer.md
// "This repo"). An import error, a syntax error or a timeout is not red.
export type Verdict =
  | { red: true; line: string }
  | { red: false; why: string; detail: string };

type JsonReport = {
  testResults?: { status?: string; message?: string; assertionResults?: { status?: string; failureMessages?: string[]; fullName?: string }[] }[];
};

const firstLine = (s: string) =>
  s
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';

export async function runTest(dir: string, testPath: string, timeoutMs = 90_000): Promise<Verdict> {
  const out = join(dir, 'var', 'vitest-report.json');
  mkdirSync(dirname(out), { recursive: true });
  const r = await runNode(dir, ['node_modules/vitest/vitest.mjs', 'run', testPath, '--reporter=json', `--outputFile=${out}`], timeoutMs);
  if (r.timedOut) return { red: false, why: 'the test run timed out', detail: '' };
  let rep: JsonReport;
  try {
    rep = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    return { red: false, why: 'no test report (the file did not load)', detail: firstLine(r.stderr) };
  }
  const files = rep.testResults ?? [];
  const asserts = files.flatMap((f) => f.assertionResults ?? []);
  if (asserts.length === 0) return { red: false, why: 'no test ran (the file did not load)', detail: firstLine(files[0]?.message ?? r.stderr) };
  const failed = asserts.find((a) => a.status === 'failed');
  if (!failed) return { red: false, why: 'the test passes on the base', detail: `${asserts.length} passed` };
  const msg = firstLine(failed.failureMessages?.[0] ?? '');
  if (/SyntaxError|Cannot find module|Failed to load|is not a function|ReferenceError/.test(msg)) {
    return { red: false, why: 'it fails, but not on an assertion', detail: msg };
  }
  return { red: true, line: `${failed.fullName ?? 'test'}: ${msg}`.slice(0, 300) };
}

export async function typecheck(dir: string, timeoutMs = 90_000): Promise<{ ok: boolean; detail: string }> {
  const r = await runNode(dir, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'], timeoutMs);
  return { ok: r.code === 0 && !r.timedOut, detail: firstLine(r.stdout || r.stderr) };
}
