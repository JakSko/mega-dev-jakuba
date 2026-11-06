// Model adapter: OpenAI Chat Completions with one tool. The key is used only in the
// Authorization header here; it is never part of any message the model sees.

export type ToolCall = { id: string; name: string; arguments: string };
export type ModelTurn = { content?: string; toolCalls?: ToolCall[]; raw?: unknown };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Model {
  next(messages: ChatMessage[], opts?: { allowTools?: boolean }): Promise<ModelTurn>;
}

export const FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_page',
    description:
      'Read a public web page (http or https) and return its text, up to 40,000 characters per call. A long page says "more text: call fetch_page again with offset=N"; call again with that offset to read the next part (no new download).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full http(s) URL to read.' },
        offset: { type: 'integer', description: 'Character offset to start from; 0 or omitted for the start of the page.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
} as const;

export class OpenAIChat implements Model {
  key: string;
  model: string;
  base: string;
  fetchImpl: typeof fetch;
  reasoningEffort: string;

  // reasoning_effort 'none': gpt-6.1-terra refuses function tools in Chat Completions otherwise
  // (live 400, 2026-11-06: "set reasoning_effort to 'none'").
  constructor(opts: { key: string; model: string; base?: string; fetchImpl?: typeof fetch; reasoningEffort?: string }) {
    this.key = opts.key;
    this.model = opts.model;
    this.base = opts.base ?? 'https://api.openai.com/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.reasoningEffort = opts.reasoningEffort ?? 'none';
  }

  async next(messages: ChatMessage[], opts: { allowTools?: boolean } = {}): Promise<ModelTurn> {
    const body: Record<string, unknown> = { model: this.model, messages, max_completion_tokens: 2000, reasoning_effort: this.reasoningEffort };
    if (opts.allowTools !== false) body.tools = [FETCH_TOOL];
    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`model -> ${res.status}: ${text.slice(0, 300)}`);
    const msg = JSON.parse(text).choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    return { content: msg.content ?? undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
