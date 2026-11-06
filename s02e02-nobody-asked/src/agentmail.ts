// AgentMail REST client with the built-in fetch. Contract: https://docs.agentmail.to/openapi.json
// (read 2026-11-06, see the Challenge's KEEP.md). Auth: `Authorization: Bearer <key>`.

export type AuthVerdict = 'pass' | 'fail' | 'none' | 'neutral' | 'softfail' | 'temperror' | 'permerror';
export type AuthResults = {
  spf?: AuthVerdict;
  dkim?: AuthVerdict;
  dmarc?: AuthVerdict;
  spf_domain?: string;
  dkim_domain?: string;
  dmarc_domain?: string;
  arc_sealer?: string;
};

export type MessageItem = {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  in_reply_to?: string;
};

export type Message = MessageItem & {
  reply_to?: string[];
  text?: string;
  html?: string;
  extracted_text?: string;
  references?: string[];
  headers?: Record<string, string>;
  authentication_results?: AuthResults;
  size: number;
  updated_at: string;
  created_at: string;
};

export type Thread = { thread_id: string; messages: Message[] };

export interface MailApi {
  listMessages(opts?: { limit?: number }): Promise<MessageItem[]>;
  getMessage(id: string): Promise<Message>;
  getThread(id: string): Promise<Thread>;
  // Recipients are always passed by the caller (code), never left to the provider's defaults.
  reply(messageId: string, body: { text: string; to: string[] }): Promise<{ message_id: string; thread_id: string }>;
  addLabels(messageId: string, labels: string[]): Promise<void>;
}

export class AgentMail implements MailApi {
  key: string;
  inbox: string;
  base: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;

  constructor(opts: { key: string; inboxId: string; base?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.key = opts.key;
    this.inbox = encodeURIComponent(opts.inboxId);
    this.base = opts.base ?? 'https://api.agentmail.to';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/v0/inboxes/${this.inbox}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AgentMail ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listMessages(opts: { limit?: number } = {}): Promise<MessageItem[]> {
    const r = await this.call<{ messages: MessageItem[] }>('GET', `/messages?limit=${opts.limit ?? 30}`);
    return r.messages ?? [];
  }

  getMessage(id: string): Promise<Message> {
    return this.call('GET', `/messages/${encodeURIComponent(id)}`);
  }

  getThread(id: string): Promise<Thread> {
    return this.call('GET', `/threads/${encodeURIComponent(id)}`);
  }

  reply(messageId: string, body: { text: string; to: string[] }) {
    return this.call<{ message_id: string; thread_id: string }>('POST', `/messages/${encodeURIComponent(messageId)}/reply`, { text: body.text, to: body.to });
  }

  async addLabels(messageId: string, labels: string[]): Promise<void> {
    await this.call('PATCH', `/messages/${encodeURIComponent(messageId)}`, { add_labels: labels });
  }
}
