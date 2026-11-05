import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sent, TestReply } from '../src/agents/guard.js';
import { cleanEnv, safeSrcPath } from '../src/agents/runner.js';
import { makeTestWriter, parseTest } from '../src/agents/testwriter.js';
import type { TestPing } from '../src/agents/pings.js';

// These run the real runner: a temp copy, a child process, vitest. Only the model is a stub.
const REPLY = 'https://hq.mega.dev/rig/reply/t1/tok_testwriter_123';
const base = Object.fromEntries(['src/digest/read.ts', 'src/digest/owner.ts', 'src/digest/types.ts'].map((p) => [p, readFileSync(p, 'utf8')]));
const ping: TestPing = { kind: 'test', issue: 12, reply: REPLY, files: base };

const answer = (name: string, body: string) => `name: ${name}\n\`\`\`ts\n${body}\n\`\`\``;
const RED = answer(
  'digest-owner-dash',
  `import { describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';

describe('#12', () => {
  it('keeps the 04:04 job whose owner already is the dash', () => {
    const night = readNight('runs', '2026-10-04')!;
    expect(night.rows.map((r) => r.job)).toContain('7f3a');
  });
});`,
);
const GREEN = answer('always-green', `import { expect, it } from 'vitest';\nit('passes', () => expect(1).toBe(1));`);
const ENV = answer(
  'env-peek',
  `import { expect, it } from 'vitest';
it('sees the env', () => {
  expect(Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|OWNER|MODEL/i.test(k))).toEqual(['should-fail']);
});`,
);

function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

function setup(answers: string[]) {
  const sends: TestReply[] = [];
  const logs: Record<string, unknown>[] = [];
  let calls = 0;
  const writer = makeTestWriter({
    repoDir: '.',
    chat: async () => answers[Math.min(calls++, answers.length - 1)]!,
    model: 'stub',
    readIssue: async () => ({ number: 12, title: 'Digest prints null instead of — for a missing owner', state: 'open', labels: [], by: 'rook', body: 'b', comments: [] }),
    send: async (_u, b): Promise<Sent> => {
      sends.push(b);
      return { status: 202, meaning: 'received' };
    },
    secrets: () => ['tok_testwriter_123', 'whsec_FAKEFAKEFAKEFAKEFAKEFAKE'],
    log: (e) => void logs.push(e),
  });
  return { go: (p: TestPing = ping) => writer(p, 'msg_t'), sends, logs, calls: () => calls };
}

describe('test writer', () => {
  it('sends a test that is red on the base, with its real failure line', async () => {
    const s = setup([RED]);
    await s.go();
    expect(s.sends).toHaveLength(1);
    expect(s.sends[0]!.path).toBe('test/digest-owner-dash.test.ts');
    expect(s.sends[0]!.red).toMatch(/keeps the 04:04 job.*expected .* to include '7f3a'/);
  }, 120_000);

  it('does not send a test that passes on the base, after two tries', async () => {
    const s = setup([GREEN, GREEN]);
    await s.go();
    expect(s.sends).toHaveLength(0);
    expect(s.calls()).toBe(2);
    expect(s.logs.at(-1)).toMatchObject({ event: 'test writer stopped' });
  }, 120_000);

  it('a test that reads process.env sees no secret', async () => {
    process.env.PING_KEY = 'whsec_FAKEFAKEFAKEFAKEFAKEFAKE';
    process.env.MODEL_KEY = 'sk-fake-model-key-for-the-test';
    try {
      const s = setup([ENV]);
      await s.go();
      expect(s.sends).toHaveLength(1);
      expect(s.sends[0]!.red).toMatch(/expected \[\] to deeply equal/);
      expect(JSON.stringify(s.sends[0])).not.toMatch(/FAKEFAKE|sk-fake|PING_KEY|MODEL_KEY/);
    } finally {
      delete process.env.PING_KEY;
      delete process.env.MODEL_KEY;
    }
  }, 120_000);

  it('writes nothing in the repo: src, runs and test are the same after a run', async () => {
    const before = ['src', 'runs', 'test'].map(hashTree);
    const s = setup([RED]);
    await s.go({ ...ping, files: { ...base, '../escape.ts': 'x', 'runs/2026-10-04.jsonl': 'x' } });
    expect(['src', 'runs', 'test'].map(hashTree)).toEqual(before);
    expect(s.logs.filter((l) => l.event === 'test writer skipped a carried path')).toHaveLength(2);
  }, 120_000);
});

describe('runner pieces', () => {
  it('keeps only src/ paths', () => {
    expect(safeSrcPath('src/digest/read.ts')).toBe('src/digest/read.ts');
    for (const p of ['../x.ts', '/etc/x.ts', 'C:/x.ts', 'src/../../x.ts', 'runs/a.jsonl', 'test/a.test.ts']) expect(safeSrcPath(p)).toBeNull();
  });

  it('the child env has no key, token or owner code', () => {
    const env = cleanEnv({ PATH: '/bin', PING_KEY: 'k', MODEL_KEY: 'k', OWNER_CODE: 'o', GITHUB_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['CI', 'FORCE_COLOR', 'NODE_ENV', 'NO_COLOR', 'PATH']);
  });

  it('reads the asked answer shape', () => {
    expect(parseTest(RED)?.name).toBe('digest-owner-dash');
    expect(parseTest('no code here')).toBeNull();
  });
});
