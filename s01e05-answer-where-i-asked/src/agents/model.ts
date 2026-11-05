import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// One OpenAI-compatible chat call (any vendor: base URL, key and model come from the host's
// variables), with a daily budget shared by every agent on the host (one key, README).
export type Message = { role: 'system' | 'user'; content: string };
export type ChatFn = (messages: Message[], opts: { model: string; maxTokens: number }) => Promise<string>;

export class Budget {
  constructor(
    private perDay: number,
    private file: string | null = 'var/model-calls.json',
    private today = () => new Date().toISOString().slice(0, 10),
  ) {}

  private read(): { day: string; used: number } {
    if (!this.file) return this.mem;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return { day: this.today(), used: 0 };
    }
  }
  private mem = { day: '', used: 0 };

  // Takes one call from today's budget; false when none is left.
  take(): boolean {
    const s = this.read();
    const day = this.today();
    const used = s.day === day ? s.used : 0;
    if (used >= this.perDay) return false;
    const next = { day, used: used + 1 };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(next));
    } else this.mem = next;
    return true;
  }

  left(): number {
    const s = this.read();
    return this.perDay - (s.day === this.today() ? s.used : 0);
  }
}

export function openAiChat(cfg: { baseUrl: string; key: string; budget: Budget; reasoning?: string; fetch?: typeof fetch }): ChatFn {
  const f = cfg.fetch ?? fetch;
  return async (messages, opts) => {
    if (!cfg.key) throw new Error('no model key on this host');
    if (!opts.model) throw new Error('no model set on this host');
    if (!cfg.budget.take()) throw new Error('daily model budget used up');
    const res = await f(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      // max_completion_tokens counts reasoning tokens too, so callers leave room for them.
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_completion_tokens: opts.maxTokens,
        ...(cfg.reasoning ? { reasoning_effort: cfg.reasoning } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`model answered ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('model sent no text');
    return text;
  };
}
