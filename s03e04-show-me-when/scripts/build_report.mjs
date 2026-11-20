#!/usr/bin/env node
// Builds a step report from a sections file, the saved console log, git and the repo URL, and checks it (A5).
//
//   node scripts/build_report.mjs --sections <sections.md> --out <report.md> --repo <board repo dir>
//        --sha <full sha> --repo-url https://github.com/<owner>/<repo> --video <https url>
//        [--flow ack-incident --console <console.log> --id <incident id> --at mm:ss]      (step 1)
//        [--expected <incident id meant>]  (ack-race: adds expected and got = --id to the evidence)
//        [--step 2 --run-url <https url>]                                               (step 2)
//
// {{path:line}} in the sections becomes [path:line](<repo-url>/blob/<sha>/path#Lline) after a check that
// the file exists at that sha and has that line. Step 1: the receipt comes from the one console line
// "ack <id> <ackedAt> <receipt>" for --id, never typed. Writes the report exactly (receipt in clear) and
// prints it with the receipt masked. Exit 0 only when every check passes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const problems = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) problems.push(msg);
};

const step = Number(arg('--step') || 1);
const [sectionsFile, out, repo, sha, repoUrl, video] = ['--sections', '--out', '--repo', '--sha', '--repo-url', '--video'].map(arg);
if (!sectionsFile || !out || !repo || !sha || !repoUrl || !video) {
  console.error('missing arguments, see the header of this file');
  process.exit(2);
}
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

// The build
check(/^[0-9a-f]{40}$/.test(sha), `sha is a full sha: ${sha}`);
let onMain = false;
try {
  onMain = git('branch', '-r', '--contains', sha).split('\n').map((s) => s.trim()).includes('origin/main');
} catch {}
check(onMain, 'the sha is on origin/main of the public repo');
check(/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl), `repo URL: ${repoUrl}`);
check(/^https:\/\//.test(video), `videoLink is https: ${video}`);

// Sections with {{path:line}}
let text = fs.readFileSync(sectionsFile, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n';
const refs = [...text.matchAll(/\{\{([^}:]+):(\d+)\}\}/g)];
for (const [token, path, line] of refs) {
  let lines = 0;
  try {
    lines = execFileSync('git', ['-C', repo, 'show', `${sha}:${path}`], { encoding: 'utf8' }).split('\n').length;
  } catch {}
  check(lines >= Number(line), `${path}:${line} exists at ${sha.slice(0, 7)} (${lines ? lines - 1 : 0} lines)`);
  text = text.replace(token, `[${path}:${line}](${repoUrl}/blob/${sha}/${path}#L${line})`);
}
check(!/\{\{|\}\}/.test(text), 'no token left in the sections');

const wanted = step === 1 ? ['What you checked', 'When', 'Where', 'Options for product'] : ['System Diff'];
const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const inOrder = wanted.every((h, i) => heads.indexOf(h) >= 0 && (i === 0 || heads.indexOf(h) > heads.indexOf(wanted[i - 1])));
check(inOrder, `sections in order: ${wanted.join(', ')} (found: ${heads.join(', ')})`);
check(!/```/.test(text), 'no code fence in the sections (the evidence block is added here)');

// Evidence
let evidence;
let receipt = '';
if (step === 1) {
  const [flow, consoleFile, id, at] = ['--flow', '--console', '--id', '--at'].map(arg);
  check(['open-board', 'ack-incident', 'watch-board'].includes(flow), `flow: ${flow}`);
  check(/^\d\d:\d\d$/.test(at || ''), `at is mm:ss: ${at}`);
  const acks = fs
    .readFileSync(consoleFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/\back (\S+) (\d{4}-\d\d-\d\dT[\d:.]+Z) (\S+)\s*$/))
    .filter(Boolean);
  const mine = acks.filter((m) => m[1] === id);
  check(mine.length === 1, `exactly one console ack line for ${id} (found ${mine.length}; all ack lines: ${acks.length})`);
  receipt = mine[0]?.[3] || '';
  check(receipt.length > 20, `receipt read from the console log (${receipt.length} chars)`);
  check(text.includes(id), `the report names ${id}`);
  evidence = { flow, at, receipt, sha, videoLink: video };
  // ack-race: the row meant (expected) and the incident the ack went to (got = the console line's id)
  const expected = arg('--expected');
  if (expected !== undefined) {
    check(/^INC-\d+$/.test(expected), `expected is an incident id: ${expected}`);
    check(expected !== id, `expected (${expected}) differs from got (${id})`);
    check(text.includes(expected), `the report names ${expected}`);
    evidence = { flow, at, expected, got: id, receipt, sha, videoLink: video };
  }
} else {
  const runUrl = arg('--run-url');
  check(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl || ''), `runUrl: ${runUrl}`);
  evidence = { sha, videoLink: video, runUrl };
}
const report = `${text}\n\`\`\`evidence\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`;
const back = JSON.parse(report.match(/```evidence\n([\s\S]*?)\n```/)[1]);
check(JSON.stringify(back) === JSON.stringify(evidence), 'the evidence block parses back to the same values');
check((report.match(/```evidence/g) || []).length === 1, 'exactly one evidence block');
const bytes = Buffer.byteLength(report, 'utf8');
check(bytes < 64 * 1024, `size ${bytes} bytes < 64 KB`);

if (problems.length) {
  console.log(`REFUSED: ${problems.length} check(s) failed; nothing written`);
  process.exit(1);
}
fs.writeFileSync(out, report);
console.log(`written ${out} (${bytes} bytes, sha256 ${createHash('sha256').update(report).digest('hex')})`);
console.log('----- report (receipt masked) -----');
console.log(receipt ? report.split(receipt).join(`<receipt: ${receipt.length} chars, from the console log>`) : report);
