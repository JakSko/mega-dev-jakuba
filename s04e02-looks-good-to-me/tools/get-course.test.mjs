import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCourse } from './get-course.mjs';
import { checkFindings } from '../lib/findings.mjs';

const NEW = 'brandnewattempt-000000000000';
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'get '));
  const varsFile = join(dir, 'vars.json');
  writeFileSync(varsFile, JSON.stringify({ TICKET: 'ticket-value-123456', PAYOUT_KEY: 'payout-value-654321' }));
  return { dir, varsFile };
}
const base = (s) => ({ url: 'https://course.example/m', auth: 'TICKET', name: 'manual', outdir: s.dir, varsFile: s.varsFile });

test('a new attempt is stored in vars first, other vars stay, and it is masked everywhere but the raw copy', async () => {
  const s = setup();
  const r = await getCourse({ ...base(s), fetchImpl: async () => new Response(JSON.stringify({ attempt: NEW, manual: `use ${NEW} and ticket-value-123456` })) });
  assert.equal(JSON.parse(readFileSync(s.varsFile, 'utf8')).ATTEMPT, NEW);
  assert.equal(JSON.parse(readFileSync(s.varsFile, 'utf8')).PAYOUT_KEY, 'payout-value-654321');
  assert.ok(!r.masked.includes(NEW) && !r.masked.includes('ticket-value-123456'));
  assert.ok(readFileSync(join(s.dir, 'manual.raw'), 'utf8').includes(NEW));
});

test('a text reply to the TICKET has its long strings masked; a saved reply is not overwritten', async () => {
  const s = setup();
  const r = await getCourse({ ...base(s), fetchImpl: async () => new Response('Your attempt: abcdefghijabcdefghijabcdefghij1234 end') });
  assert.ok(r.masked.includes('<masked-long>'));
  await assert.rejects(getCourse({ ...base(s), fetchImpl: async () => new Response('x') }), /exists/);
});

test('another host is refused before anything is sent', async () => {
  const s = setup();
  let sent = false;
  await assert.rejects(getCourse({ ...base(s), url: 'https://evil.example/m', fetchImpl: async () => { sent = true; } }), /refused/);
  assert.equal(sent, false);
});

test('findings: one per served hunk, nothing else', () => {
  const ok = { findings: [{ hunk: 'a', verdict: 'flag', reason: 'r' }, { hunk: 'b', verdict: 'pass', reason: 'r' }] };
  assert.deepEqual(checkFindings(ok, ['a', 'b']), []);
  assert.ok(checkFindings(ok, ['a', 'b', 'c']).some((p) => p.includes('no finding for hunk c')));
  assert.ok(checkFindings(ok, ['a']).some((p) => p.includes('not served')));
  assert.ok(checkFindings({ findings: [ok.findings[0], ok.findings[0]] }, ['a']).some((p) => p.includes('two findings')));
  assert.ok(checkFindings({ findings: [{ hunk: 'a', verdict: 'maybe', reason: '' }] }, ['a']).length >= 2);
  assert.ok(checkFindings({ ...ok, approved: true }, ['a', 'b']).length === 1);
  assert.ok(checkFindings(ok, []).length === 1);
});
