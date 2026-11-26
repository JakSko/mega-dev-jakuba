// The reviewer's only two tools. Routine work is code here; the verdicts are the model's.
//   review_case      gathers the case: the live house settings, the why/ house notes and the co-host's change, whole.
//                    Two fixed GETs with the attempt, nothing else. The tool takes no input.
//   submit_findings  checks the findings against the served hunk ids and saves them on this machine, once.
// The role has no tool that takes a URL, a file or a script, so it can write nothing to anyone. Sending the saved
// findings is a separate step after the owner's yes (tools/send-review.mjs on the Host Desk).
// Of vars.json only ATTEMPT is read, and it goes only to the hosts hosts.json names, never through a redirect.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayReach } from './hosts.mjs';
import { checkFindings } from '../../../lib/findings.mjs';

const ROLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESK = resolve(ROLE, '..', '..');
const CHALLENGE = process.env.CHALLENGE_URL ?? 'https://course.example/challenge';
const MAX_CASE = 120_000; // characters; a longer case stops the review instead of being cut
const outDir = () => process.env.REVIEW_OUT || join(ROLE, 'out');
const sha = (t) => createHash('sha256').update(t).digest('hex');

async function get(path, attempt, signal) {
  const url = `${CHALLENGE}/${path}`;
  if (!mayReach('ATTEMPT', url)) throw new Error(`hosts.json does not let the attempt reach ${new URL(url).host}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${attempt}` }, redirect: 'manual', signal });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`GET /${path} answered ${res.status}`);
  return { text, json: JSON.parse(text) };
}

/** The why/ notes, every .md file that really lies inside why/. */
export function houseNotes(dir = join(DESK, 'why')) {
  const root = realpathSync(dir);
  const notes = {};
  for (const name of readdirSync(root).filter((n) => n.endsWith('.md')).sort()) {
    const file = realpathSync(join(root, name));
    if (!file.startsWith(root + sep)) throw new Error(`a house note leads outside why/: ${name}`);
    notes[`why/${name}`] = readFileSync(file, 'utf8');
  }
  if (!Object.keys(notes).length) throw new Error('why/ holds no house note');
  return notes;
}

export async function gatherCase(attempt, signal) {
  const settings = await get('settings', attempt, signal);
  const { version, commissionPct } = settings.json;
  if (typeof version !== 'string' || typeof commissionPct !== 'number') throw new Error('the settings have no version or commissionPct');
  const patch = await get('patch', attempt, signal);
  const { files, hunks } = patch.json;
  const ids = Array.isArray(hunks) ? hunks.map((h) => h.id) : [];
  if (!files || !ids.length || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('the patch has no base files or no distinct hunk ids');
  const view = { houseSettingsNow: { version, commissionPct }, houseNotes: houseNotes(), change: { baseFiles: files, hunks } };
  const text = JSON.stringify(view, null, 2);
  if (text.length > MAX_CASE) throw new Error(`the case has ${text.length} characters, more than ${MAX_CASE}: not judged in part`);
  return { text, meta: { settingsVersion: version, commissionPct, hunkIds: ids, patchSha256: sha(patch.text), settingsSha256: sha(settings.text) } };
}

export default function (pi) {
  let meta = null;
  const say = (text, failed = false) => ({ content: [{ type: 'text', text }], details: { failed } });

  pi.registerTool({
    name: 'review_case',
    label: 'review_case',
    description: 'Returns the whole case to review: the house settings in force now, the house notes (why/), and the co-host\'s change (base files and hunks with ids). Takes no input.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_id, _p, signal) {
      try {
        const attempt = JSON.parse(readFileSync(join(DESK, 'vars.json'), 'utf8')).ATTEMPT;
        if (!attempt) return say('No ATTEMPT in vars.json. Report this and stop.', true);
        const c = await gatherCase(attempt, signal);
        meta = c.meta;
        mkdirSync(outDir(), { recursive: true });
        writeFileSync(join(outDir(), 'case-meta.json'), JSON.stringify(meta, null, 2));
        writeFileSync(join(outDir(), 'hunk-ids.json'), JSON.stringify(meta.hunkIds));
        return say(c.text);
      } catch (e) {
        meta = null;
        return say(`The case could not be gathered, so nothing is judged or submitted: ${e.message}`, true);
      }
    },
  });

  pi.registerTool({
    name: 'submit_findings',
    label: 'submit_findings',
    description: 'Saves the review: one finding for every hunk id of the case, each with verdict "flag" or "pass" and a reason. Saved once on this machine for the owner; it sends nothing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['hunk', 'verdict', 'reason'],
            properties: { hunk: { type: 'string' }, verdict: { type: 'string', enum: ['flag', 'pass'] }, reason: { type: 'string' } },
          },
        },
      },
    },
    async execute(_id, p) {
      if (!meta) return say('Call review_case first.', true);
      const body = { findings: p.findings };
      const problems = checkFindings(body, meta.hunkIds);
      if (problems.length) return say(`Not saved:\n- ${problems.join('\n- ')}`, true);
      try {
        writeFileSync(join(outDir(), 'findings.json'), JSON.stringify(body), { flag: 'wx' });
      } catch (e) {
        return say(e.code === 'EEXIST' ? 'Findings are already saved for this run. They are not replaced.' : `Not saved: ${e.message}`, true);
      }
      return say(`Saved ${body.findings.length} findings. Nothing was sent: the owner decides about sending.`);
    },
  });
}
