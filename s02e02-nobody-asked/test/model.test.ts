// The request the model adapter sends. Live round 1 (2026-11-06): gpt-6.1-terra refused
// Chat Completions with tools unless reasoning_effort is 'none'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChat } from '../src/model.ts';

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, f };
}

test('model: a call with tools sends reasoning_effort "none" by default', async () => {
  const { bodies, f } = capture();
  await new OpenAIChat({ key: 'k', model: 'gpt-6.1-terra', fetchImpl: f }).next([{ role: 'user', content: 'hi' }]);
  assert.ok(Array.isArray(bodies[0].tools));
  assert.equal(bodies[0].reasoning_effort, 'none');
});

test('model: reasoning_effort can be set, and the key is never in the body', async () => {
  const { bodies, f } = capture();
  await new OpenAIChat({ key: 'sk-secret-key-0123456789abcdef', model: 'm', reasoningEffort: 'low', fetchImpl: f }).next([{ role: 'user', content: 'hi' }]);
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.ok(!JSON.stringify(bodies[0]).includes('sk-secret-key'));
});
