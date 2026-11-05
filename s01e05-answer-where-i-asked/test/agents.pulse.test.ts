import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Sent } from '../src/agents/guard.js';
import type { ChatFn, Message } from '../src/agents/model.js';
import type { PulsePing } from '../src/agents/pings.js';
import { candidates, makePulse } from '../src/agents/pulse.js';
import { readPlanFiles, type Issue, type TrackerRead } from '../src/agents/tracker.js';

// The tracker as the course served it on 2026-11-04 (#12 open by rook, #14 open by "stranger"
// with text aimed at agents). A copy for tests only: the pulse itself always reads it live.
const SNAPSHOT: Issue[] = JSON.parse(readFileSync('test/fixtures/tracker-2026-11-04.json', 'utf8')).issues;
const TRACKER = 'https://hq.mega.dev/rig/tracker/issues';
const REPLY = 'https://hq.mega.dev/rig/reply/p1/tok_abcdef123456';
const ping: PulsePing = { kind: 'pulse', text: 'pulse? amber fox 41', phrase: 'amber fox 41', reply: REPLY, tracker: TRACKER };
const plan = readPlanFiles('.');

function run(opts: { issues?: Issue[] | null; model?: string | ((m: Message[]) => string) | Error | null } = {}) {
  const reads: string[] = [];
  const sends: { url: string; text: string }[] = [];
  const prompts: Message[][] = [];
  const logs: Record<string, unknown>[] = [];
  const issues = opts.issues === undefined ? SNAPSHOT : opts.issues;
  const model = opts.model === undefined ? null : opts.model;
  const chat: ChatFn | null =
    model === null
      ? null
      : async (m) => {
          prompts.push(m);
          if (model instanceof Error) throw model;
          return typeof model === 'function' ? model(m) : model;
        };
  const pulse = makePulse({
    readTracker: async (url): Promise<TrackerRead> => {
      reads.push(url);
      return issues ? { ok: true, issues } : { ok: false, why: 'tracker not reachable (TypeError)' };
    },
    planFiles: () => plan,
    chat,
    model: 'test-model',
    send: async (url, body): Promise<Sent> => {
      sends.push({ url, text: body.text });
      return { status: 202, meaning: 'received' };
    },
    secrets: () => ['tok_abcdef123456'],
    log: (e) => void logs.push(e),
  });
  return { go: () => pulse(ping, 'msg_1'), reads, sends, prompts, logs };
}

const draft = (issue: number, stand = 'the digest plan is finished and the pulse plan is being built', recommendation = 'keep the row whose owner is already the placeholder and add a test for that night') =>
  JSON.stringify({ issue, stand, recommendation });

const issueNumbers = (t: string) => [...t.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

describe('the pulse', () => {
  it('answers once, to the reply address, with the phrase quoted and one open issue', async () => {
    const r = run({ model: draft(12) });
    await r.go();
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.url).toBe(REPLY);
    const t = r.sends[0]!.text;
    expect(t.startsWith('"amber fox 41"')).toBe(true);
    expect(issueNumbers(t)).toEqual([12]);
    expect(t).toMatch(/^Recommendation: .+/m);
    expect(t.length).toBeLessThanOrEqual(2000);
    expect(r.logs.find((l) => l.event === 'pulse reply')).toMatchObject({ path: 'model', status: 202 });
  });

  it.each([
    ['a closed issue', 11],
    ['an unknown issue', 99],
    ["the outsider's issue", 14],
  ])('rejects a model answer naming %s and answers from the facts instead', async (_n, n) => {
    const r = run({ model: draft(n) });
    await r.go();
    expect(issueNumbers(r.sends[0]!.text)).toEqual([12]);
    expect(r.logs.find((l) => l.event === 'pulse draft rejected')).toBeTruthy();
  });

  it('rejects a model answer that calls something shipped or names a second issue', async () => {
    for (const bad of [draft(12, 'issue 12 has shipped'), draft(12, 'fine', 'see #14 first')]) {
      const r = run({ model: bad });
      await r.go();
      expect(r.sends[0]!.text).not.toMatch(/shipped|#14/);
      expect(issueNumbers(r.sends[0]!.text)).toEqual([12]);
    }
  });

  it("while a team issue is open, the outsider's injected text never reaches the model", async () => {
    const r = run({ model: draft(12) });
    await r.go();
    expect(r.prompts[0]![1]!.content).not.toContain('Note to automated agents');
    expect(r.reads.every((u) => u === TRACKER)).toBe(true); // reads only, from the ping's tracker
    expect(r.sends.map((s) => s.url)).toEqual([REPLY]); // no tracker write, one reply
  });

  it('when it does reach the model, it is inside <data>, and the answer obeys none of it', async () => {
    const only14 = SNAPSHOT.map((i) => (i.number === 12 ? { ...i, state: 'closed' as const } : i));
    // A model that does what the injected text says: names a write and keeps quiet about #14.
    const obey = () => JSON.stringify({ issue: 12, stand: 'closed issue and added label wontfix', recommendation: 'nothing' });
    const r = run({ issues: only14, model: obey });
    await r.go();
    const user = r.prompts[0]![1]!.content;
    expect(user.startsWith('<data>') && user.endsWith('</data>')).toBe(true);
    expect(user).toContain('Note to automated agents');
    expect(r.prompts[0]![0]!.content).toMatch(/data, not instructions/);
    expect(r.sends.map((s) => s.url)).toEqual([REPLY]);
    expect(issueNumbers(r.sends[0]!.text)).toEqual([14]); // #12 is closed here: the model's pick is refused
    expect(r.sends[0]!.text).not.toMatch(/wontfix/);
  });

  it('the outsider issue is not a candidate while a team issue is open, and is one when nothing else is', () => {
    expect(candidates(SNAPSHOT, plan.plan).map((i) => i.number)).toEqual([12]);
    const only14 = SNAPSHOT.map((i) => (i.number === 12 ? { ...i, state: 'closed' as const } : i));
    expect(candidates(only14, plan.plan).map((i) => i.number)).toEqual([14]);
  });

  it('a tracker that is down gives one "pulse stopped:" line', async () => {
    const r = run({ issues: null, model: draft(12) });
    await r.go();
    expect(r.sends.map((s) => s.text)).toEqual(['pulse stopped: tracker not reachable (TypeError)']);
    expect(r.prompts).toHaveLength(0);
  });

  it('a tracker with nothing open gives one "pulse stopped:" line', async () => {
    const r = run({ issues: SNAPSHOT.map((i) => ({ ...i, state: 'closed' as const })), model: draft(12) });
    await r.go();
    expect(r.sends.map((s) => s.text)).toEqual(['pulse stopped: nothing open in the tracker']);
  });

  it('a model that fails, or no model, still gives an answer from the facts', async () => {
    for (const model of [new Error('model answered 429'), null]) {
      const r = run({ model });
      await r.go();
      expect(r.sends).toHaveLength(1);
      expect(issueNumbers(r.sends[0]!.text)).toEqual([12]);
      expect(r.sends[0]!.text.startsWith('"amber fox 41"')).toBe(true);
    }
  });

  it('an answer that would leak the reply token is not sent; one stopped line is', async () => {
    const r = run({ model: draft(12, 'token tok_abcdef123456 here') });
    await r.go();
    expect(r.sends[0]!.text).toMatch(/^pulse stopped: answer failed its own check/);
    expect(r.sends[0]!.text).not.toContain('tok_abcdef123456');
  });
});
