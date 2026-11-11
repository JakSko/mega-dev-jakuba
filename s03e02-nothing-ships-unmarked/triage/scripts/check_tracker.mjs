#!/usr/bin/env node
// Deterministic checker for a sched-prod tracker in Markdown (spec R11). Node 18+, no dependencies.
//
//   node check_tracker.mjs --issues <doc/issues dir> --api <dir with run*/ API replies> --specs <specs dir>
//   node check_tracker.mjs --self-test
//
// Checks the format and the bookkeeping, never the judgment (agent-ready vs needs-human is a person's review):
//   coverage  every request id from the saved channel replies sits in exactly one issue's sources; no unknown ids;
//             every backlog key has its file
//   shape     frontmatter parses (the collector's shape: title JSON-quoted, inline [a, b] lists); key = file name;
//             status open | done | closed
//   marks     every open issue has exactly one of agent-ready / needs-human; from:<origin> for each source's origin
//   closed    reason is duplicate | obsolete | contradicts-spec | not-planned; duplicate has duplicate-of;
//             the body cites an id that exists
//   bodies    agent-ready: ## Intent, ## Acceptance (a checkable line, a must-not line), ## Boundaries, Allowed by AUT-1
//             needs-human: ## Question, ## Options (2+ numbered), ## Recommendation, ## Why with an existing id
//   ids       every cited AUT-/DES-/PRD-/ADR-/SCHED-/IN- id exists; blocked-by and duplicate-of targets exist;
//             no blocked-by cycle
// Prints one line per failure and `result: ok` or `result: FAIL (n)`. Reads files only; writes and sends nothing.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const MARKS = ['agent-ready', 'needs-human'];
const REASONS = ['duplicate', 'obsolete', 'contradicts-spec', 'not-planned'];
const ID_RE = /\b(AUT-\d+|DES-\d+|PRD-\d+|ADR-\d{4}|SCHED-\d+|IN-\d+)\b/g;

export function parseIssue(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { error: 'no frontmatter' };
  const fm = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!kv) return { error: `bad frontmatter line: ${raw}` };
    let v = kv[2].trim();
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) return { error: `list not closed: ${kv[1]}` };
      v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { return { error: `bad quoted value: ${kv[1]}` }; }
    }
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function section(body, name) {
  const m = body.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

/** files: {name: text}; known: {intents: Map<id, from>, backlog: Set<key>}; specIds: Set<id>. Returns failure lines. */
export function checkTracker(files, known, specIds) {
  const fail = [];
  const issues = new Map();
  for (const [name, text] of Object.entries(files)) {
    const p = parseIssue(text);
    if (p.error) { fail.push(`${name}: ${p.error}`); continue; }
    const key = p.fm.key;
    if (!key) { fail.push(`${name}: no key`); continue; }
    if (`${key}.md` !== name) fail.push(`${name}: key ${key} does not match the file name`);
    if (issues.has(key)) fail.push(`${name}: key ${key} used twice`);
    issues.set(key, { name, ...p });
  }
  const exists = (id) => specIds.has(id) || issues.has(id) || known.intents.has(id) || known.backlog.has(id);

  for (const k of known.backlog) if (!issues.has(k)) fail.push(`backlog ${k}: no file`);
  const seen = new Map();
  for (const [key, { name, fm, body }] of issues) {
    const labels = list(fm.labels);
    const sources = list(fm.sources);
    if (!fm.title) fail.push(`${name}: no title`);
    if (!['open', 'done', 'closed'].includes(fm.status)) fail.push(`${name}: status "${fm.status}" not open | done | closed`);
    for (const s of sources) {
      if (!known.intents.has(s)) fail.push(`${name}: source ${s} is not a request from the API`);
      seen.set(s, [...(seen.get(s) ?? []), key]);
    }
    for (const s of sources) {
      const from = known.intents.get(s);
      if (from && !labels.includes(`from:${from}`)) fail.push(`${name}: source ${s} came from ${from}, label from:${from} missing`);
    }
    const marks = labels.filter((l) => MARKS.includes(l));
    if (fm.status === 'open' && marks.length !== 1) fail.push(`${name}: open issue needs exactly one of ${MARKS.join(' / ')}, has ${marks.length}`);
    for (const t of list(fm['blocked-by'])) if (!issues.has(t)) fail.push(`${name}: blocked-by ${t} is not an issue in the tracker`);
    if (fm['duplicate-of'] && !issues.has(fm['duplicate-of'])) fail.push(`${name}: duplicate-of ${fm['duplicate-of']} is not an issue in the tracker`);
    if (fm['duplicate-of'] === key) fail.push(`${name}: duplicate of itself`);
    if (fm.status === 'closed') {
      if (!REASONS.includes(fm.reason)) fail.push(`${name}: closed needs reason ${REASONS.join(' | ')}, has "${fm.reason ?? ''}"`);
      if (fm.reason === 'duplicate' && !fm['duplicate-of']) fail.push(`${name}: reason duplicate needs duplicate-of`);
      const cited = [...body.matchAll(ID_RE)].map((x) => x[1]).filter((id) => id !== key);
      if (!cited.some(exists)) fail.push(`${name}: closed issue cites no existing id in its body`);
    } else if (fm.reason) fail.push(`${name}: reason set on a ${fm.status} issue`);
    for (const [, id] of body.matchAll(ID_RE)) if (!exists(id)) fail.push(`${name}: cites ${id}, which does not exist`);

    if (fm.status === 'open' && marks[0] === 'agent-ready') {
      for (const h of ['Intent', 'Acceptance', 'Boundaries']) if (section(body, h) === null) fail.push(`${name}: agent-ready without ## ${h}`);
      const acc = section(body, 'Acceptance') ?? '';
      const lines = acc.split(/\r?\n/).filter((l) => /^\s*-\s*(\[ \]\s*)?\S/.test(l));
      if (!lines.some((l) => /given\b.*\bwhen\b.*\bthen\b/i.test(l) || /^\s*-\s*\[ \]/.test(l))) fail.push(`${name}: Acceptance has no Given/When/Then or - [ ] line`);
      if (!lines.some((l) => /\b(not|never|no|without)\b/i.test(l))) fail.push(`${name}: Acceptance has no must-not case`);
      const bnd = section(body, 'Boundaries') ?? '';
      if (!/^\s*-\s*Must not\b/im.test(bnd)) fail.push(`${name}: Boundaries has no "- Must not ..." line`);
      if (!/^Allowed by AUT-1\b/m.test(body)) fail.push(`${name}: no "Allowed by AUT-1" line`);
    }
    if (fm.status === 'open' && marks[0] === 'needs-human') {
      for (const h of ['Question', 'Options', 'Recommendation', 'Why']) if (section(body, h) === null) fail.push(`${name}: needs-human without ## ${h}`);
      const opts = (section(body, 'Options') ?? '').split(/\r?\n/).filter((l) => /^\s*\d+\.\s+\S/.test(l));
      if (opts.length < 2) fail.push(`${name}: Options has ${opts.length} numbered option(s), needs 2+`);
      const rec = section(body, 'Recommendation') ?? '';
      if (!/\boption\s*\d+\b/i.test(rec)) fail.push(`${name}: Recommendation names no option number`);
      const why = [...(section(body, 'Why') ?? '').matchAll(ID_RE)].map((x) => x[1]);
      if (!why.some(exists)) fail.push(`${name}: Why cites no existing id`);
    }
  }
  for (const id of known.intents.keys()) {
    const at = seen.get(id) ?? [];
    if (at.length === 0) fail.push(`request ${id}: in no issue's sources`);
    if (at.length > 1) fail.push(`request ${id}: in the sources of ${at.length} issues (${at.join(', ')})`);
  }
  // blocked-by cycles
  const state = new Map();
  const visit = (k, path) => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'open') { fail.push(`blocked-by cycle: ${[...path, k].join(' -> ')}`); return; }
    state.set(k, 'open');
    for (const t of list(issues.get(k)?.fm['blocked-by'])) if (issues.has(t)) visit(t, [...path, k]);
    state.set(k, 'done');
  };
  for (const k of issues.keys()) visit(k, []);
  return fail;
}

function loadKnown(apiDir) {
  const intents = new Map();
  const backlog = new Set();
  for (const run of readdirSync(apiDir).filter((d) => /^run\d+$/.test(d) && statSync(join(apiDir, d)).isDirectory())) {
    for (const f of readdirSync(join(apiDir, run)).filter((f) => f.endsWith('.body.json'))) {
      const d = JSON.parse(readFileSync(join(apiDir, run, f), 'utf8'));
      if (Array.isArray(d.items)) for (const it of d.items) intents.set(it.id, it.from);
      if (Array.isArray(d.issues)) for (const b of d.issues) backlog.add(b.key);
    }
  }
  return { intents, backlog };
}

function loadSpecIds(dir) {
  const ids = new Set();
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.md')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/^#+ (AUT-\d+|DES-\d+|PRD-\d+)\b/gm)) ids.add(m[1]);
        const adr = basename(f).match(/^(\d{4})-/);
        if (adr) ids.add(`ADR-${adr[1]}`);
      }
    }
  };
  walk(dir);
  return ids;
}

function report(fail) {
  for (const f of fail) console.log(`  ${f}`);
  console.log(fail.length ? `result: FAIL (${fail.length})` : 'result: ok');
  return fail.length ? 1 : 0;
}

function selfTest() {
  const known = { intents: new Map([['IN-1', 'support'], ['IN-2', 'client'], ['IN-3', 'product']]), backlog: new Set(['SCHED-1']) };
  const spec = new Set(['AUT-1', 'AUT-2', 'AUT-3', 'DES-4', 'PRD-3', 'ADR-0001']);
  const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : k === 'title' ? JSON.stringify(v) : v}`).join('\n')}\n---\n\n`;
  const ready = '## Intent\nShow X.\n\n## Acceptance\n- Given a booking, when the page opens, then X shows\n- Given a booking, when the page opens, then no modal opens (DES-4)\n\n## Boundaries\n- Must not touch the export\n\nAllowed by AUT-1: "copy changes in the product\'s own interface"\n';
  const human = '## Question\nKeep or change?\n\n## Options\n1. Keep\n2. Change\n\n## Recommendation\nOption 1\n\n## Why\nA client relies on it (AUT-2, IN-2).\n';
  const good = {
    'SCHED-1.md': fm({ key: 'SCHED-1', title: 'old', status: 'open', labels: ['from:product', 'agent-ready'], sources: ['IN-3'] }) + ready,
    'IN-1.md': fm({ key: 'IN-1', title: 'a', status: 'open', labels: ['from:support', 'needs-human'], sources: ['IN-1'], 'blocked-by': ['SCHED-1'] }) + human,
    'IN-2.md': fm({ key: 'IN-2', title: 'b', status: 'closed', reason: 'duplicate', 'duplicate-of': 'IN-1', labels: ['from:client'], sources: ['IN-2'] }) + 'Same as IN-1.\n',
  };
  const cases = [
    ['good tracker passes', good, null],
    ['request in no sources', { ...good, 'IN-2.md': good['IN-2.md'].replace('sources: [IN-2]', 'sources: []') }, 'request IN-2: in no issue'],
    ['request twice', { ...good, 'IN-1.md': good['IN-1.md'].replace('sources: [IN-1]', 'sources: [IN-1, IN-3]').replace('labels: [from:support', 'labels: [from:product, from:support') }, 'request IN-3: in the sources of 2'],
    ['unknown source', { ...good, 'IN-1.md': good['IN-1.md'].replace('sources: [IN-1]', 'sources: [IN-1, IN-9]') }, 'source IN-9 is not a request'],
    ['open without mark', { ...good, 'IN-1.md': good['IN-1.md'].replace(', needs-human', '') }, 'needs exactly one'],
    ['open with both marks', { ...good, 'IN-1.md': good['IN-1.md'].replace('needs-human', 'needs-human, agent-ready') }, 'needs exactly one'],
    ['missing from label', { ...good, 'IN-1.md': good['IN-1.md'].replace('from:support, ', '') }, 'label from:support missing'],
    ['closed without reason', { ...good, 'IN-2.md': good['IN-2.md'].replace('reason: duplicate\n', '') }, 'closed needs reason'],
    ['duplicate without duplicate-of', { ...good, 'IN-2.md': good['IN-2.md'].replace('duplicate-of: IN-1\n', '') }, 'needs duplicate-of'],
    ['duplicate-of missing issue', { ...good, 'IN-2.md': good['IN-2.md'].replace('duplicate-of: IN-1', 'duplicate-of: IN-7') }, 'duplicate-of IN-7 is not'],
    ['closed cites nothing', { ...good, 'IN-2.md': good['IN-2.md'].replace('Same as IN-1.', 'Same as before.') }, 'cites no existing id'],
    ['agent-ready without Boundaries', { ...good, 'SCHED-1.md': good['SCHED-1.md'].replace('## Boundaries\n- Must not touch the export\n', '') }, 'without ## Boundaries'],
    ['agent-ready without must-not', { ...good, 'SCHED-1.md': good['SCHED-1.md'].replace('then no modal opens', 'then a banner shows') }, 'no must-not case'],
    ['agent-ready without Allowed by', { ...good, 'SCHED-1.md': good['SCHED-1.md'].replace('Allowed by AUT-1', 'Allowed by me') }, 'no "Allowed by AUT-1"'],
    ['needs-human with one option', { ...good, 'IN-1.md': good['IN-1.md'].replace('2. Change\n', '') }, 'needs 2+'],
    ['needs-human Why without id', { ...good, 'IN-1.md': good['IN-1.md'].replace('(AUT-2, IN-2)', '(trust)') }, 'Why cites no existing id'],
    ['cites a missing id', { ...good, 'SCHED-1.md': good['SCHED-1.md'].replace('(DES-4)', '(DES-9)') }, 'cites DES-9'],
    ['blocked-by missing issue', { ...good, 'IN-1.md': good['IN-1.md'].replace('blocked-by: [SCHED-1]', 'blocked-by: [SCHED-5]') }, 'blocked-by SCHED-5 is not'],
    ['blocked-by cycle', { ...good, 'SCHED-1.md': good['SCHED-1.md'].replace('sources: [IN-3]', 'sources: [IN-3]\nblocked-by: [IN-1]') }, 'blocked-by cycle'],
    ['backlog file missing', Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'SCHED-1.md')), 'backlog SCHED-1: no file'],
    ['key does not match file', { ...good, 'IN-1.md': good['IN-1.md'].replace('key: IN-1', 'key: IN-11') }, 'does not match the file name'],
    ['bad status', { ...good, 'IN-2.md': good['IN-2.md'].replace('status: closed', 'status: shipped') }, 'not open | done | closed'],
    ['no frontmatter', { ...good, 'IN-2.md': 'just text\n' }, 'no frontmatter'],
  ];
  let bad = 0;
  for (const [name, files, expect] of cases) {
    const fail = checkTracker(files, known, spec);
    const ok = expect === null ? fail.length === 0 : fail.some((f) => f.includes(expect));
    if (!ok) { bad++; console.log(`  self-test FAIL: ${name}: got ${JSON.stringify(fail)}`); }
  }
  console.log(bad ? `self-test: ${bad} of ${cases.length} cases failed` : `self-test ok (${cases.length} cases: 1 green, ${cases.length - 1} red)`);
  return bad ? 1 : 0;
}

function main() {
  const a = process.argv;
  if (a.includes('--self-test')) return selfTest();
  const arg = (n) => { const i = a.indexOf(`--${n}`); return i > 0 ? a[i + 1] : undefined; };
  const [issuesDir, apiDir, specsDir] = [arg('issues'), arg('api'), arg('specs')];
  if (!issuesDir || !apiDir || !specsDir || !existsSync(issuesDir)) {
    console.error('usage: node check_tracker.mjs --issues <dir> --api <dir> --specs <dir> | --self-test');
    return 2;
  }
  const files = Object.fromEntries(readdirSync(issuesDir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(issuesDir, f), 'utf8')]));
  const known = loadKnown(apiDir);
  console.log(`issues: ${Object.keys(files).length}, requests known: ${known.intents.size}, backlog keys: ${known.backlog.size}`);
  return report(checkTracker(files, known, loadSpecIds(specsDir)));
}

process.exitCode = main();
