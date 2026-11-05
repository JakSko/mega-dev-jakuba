import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkReply, replyToken, secretsOf, sendReply, LIMITS } from '../src/agents/guard.js';
import { Budget, openAiChat } from '../src/agents/model.js';

const PING_KEY = `whsec_${randomBytes(32).toString('base64')}`;
const MODEL_KEY = `sk-test-${randomBytes(18).toString('hex')}`;
const REPLY = 'https://hq.mega.dev/rig/reply/p1/tok_abcdef123456';
const secrets = secretsOf({ pingKeys: [PING_KEY], modelKey: MODEL_KEY }, REPLY);

function stubFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe('reply guard', () => {
  it('takes the reply token from the end of the reply address', () => {
    expect(replyToken(REPLY)).toBe('tok_abcdef123456');
  });

  it('holds the size limits', () => {
    expect(checkReply('pulse', { text: 'x'.repeat(LIMITS.pulse) }, secrets).ok).toBe(true);
    expect(checkReply('pulse', { text: 'x'.repeat(LIMITS.pulse + 1) }, secrets).ok).toBe(false);
    const big = { path: 'test/a.test.ts', test: 'x'.repeat(LIMITS.test), red: 'r' };
    expect(checkReply('test', big, secrets).ok).toBe(false);
    expect(checkReply('test', { path: 'src/a.ts', test: 't', red: 'r' }, secrets).ok).toBe(false);
  });

  it.each([
    ['the ping key', PING_KEY],
    ['the raw ping key', PING_KEY.slice(6)],
    ['the model key', MODEL_KEY],
    ['the reply token', 'tok_abcdef123456'],
    ['a key-shaped string', 'sk-ABCDEFGHIJKLMNOPQRSTUV'],
  ])('blocks a body holding %s', (_n, s) => {
    expect(checkReply('pulse', { text: `fine words ${s} more` }, secrets)).toEqual({ ok: false, why: expect.stringMatching(/secret|key/) });
    expect(checkReply('test', { path: 'test/a.test.ts', test: `// ${s}`, red: 'r' }, secrets).ok).toBe(false);
  });

  it("keeps the course's answer for the log, with the reply token masked", async () => {
    const sent = await sendReply(REPLY, { text: 'x' }, { fetch: stubFetch(202, { note: 'seen at tok_abcdef123456' }) });
    expect(sent.text).toBe('{"note":"seen at <reply token>"}');
  });

  it('reads the reply statuses from docs/course-api.md', async () => {
    for (const [status, meaning] of [
      [202, 'received'],
      [409, 'already answered'],
      [404, 'unknown reply address'],
      [410, 'too late'],
    ] as const) {
      expect(await sendReply(REPLY, { text: 'x' }, { fetch: stubFetch(status, {}) })).toMatchObject({ status, meaning });
    }
  });
});

describe('model client', () => {
  it('sends one chat call to the OpenAI-compatible endpoint and returns the text', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const chat = openAiChat({
      baseUrl: 'https://model.example/v1/',
      key: MODEL_KEY,
      budget: new Budget(5, null),
      fetch: stubFetch(200, { choices: [{ message: { content: 'hello' } }] }, seen),
    });
    expect(await chat([{ role: 'user', content: 'hi' }], { model: 'm', maxTokens: 50 })).toBe('hello');
    expect(seen[0]!.url).toBe('https://model.example/v1/chat/completions');
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 50 });
  });

  it('refuses a call over the daily budget without calling the model', async () => {
    const seen: { url?: string }[] = [];
    const chat = openAiChat({ baseUrl: 'https://m/v1', key: MODEL_KEY, budget: new Budget(1, null), fetch: stubFetch(200, { choices: [{ message: { content: 'a' } }] }, seen) });
    await chat([{ role: 'user', content: 'x' }], { model: 'm', maxTokens: 5 });
    await expect(chat([{ role: 'user', content: 'x' }], { model: 'm', maxTokens: 5 })).rejects.toThrow('daily model budget used up');
    expect(seen).toHaveLength(1);
  });

  it('a new day gives a new budget', () => {
    let day = '2026-11-04';
    const b = new Budget(1, null, () => day);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    day = '2026-11-05';
    expect(b.take()).toBe(true);
  });

  it('a model error is an error, not an empty answer', async () => {
    const chat = openAiChat({ baseUrl: 'https://m/v1', key: MODEL_KEY, budget: new Budget(5, null), fetch: stubFetch(429, {}) });
    await expect(chat([{ role: 'user', content: 'x' }], { model: 'm', maxTokens: 5 })).rejects.toThrow('model answered 429');
  });
});
