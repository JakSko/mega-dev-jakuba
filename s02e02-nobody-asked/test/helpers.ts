// Fakes for the tests: an in-memory AgentMail inbox and a scripted model.
import type { MailApi, Message, MessageItem, Thread } from '../src/agentmail.ts';
import type { Model, ModelTurn } from '../src/model.ts';

export const OWN = 'mega-reader-test@agentmail.to';
export const ROOK = 'rook@mail.mega.dev';
export const AM_KEY = 'am_live_TESTKEY_0123456789abcdef';
export const MODEL_KEY = 'sk-proj-TESTMODELKEY0123456789abcdef';

const pass = { spf: 'pass', dkim: 'pass', dmarc: 'pass', dkim_domain: 'mail.mega.dev', dmarc_domain: 'mail.mega.dev', spf_domain: 'mail.mega.dev' };

let n = 0;
export function mail(over: Partial<Message> = {}): Message {
  n += 1;
  const id = over.message_id ?? `<m${n}@mail.mega.dev>`;
  return {
    inbox_id: OWN,
    thread_id: over.thread_id ?? `t${n}`,
    message_id: id,
    labels: ['received'],
    timestamp: new Date(2026, 10, 6, 12, n).toISOString(),
    from: `Rook <${ROOK}>`,
    to: [OWN],
    subject: 'question',
    text: 'Please read https://example.com/page and tell me its title.',
    extracted_text: 'Please read https://example.com/page and tell me its title.',
    authentication_results: pass,
    headers: {},
    size: 100,
    updated_at: '',
    created_at: '',
    ...over,
  } as Message;
}

export type Sent = { inReplyTo: string; to: string[]; text: string; cc?: unknown; reply_all?: unknown };

export class FakeMail implements MailApi {
  messages: Message[] = [];
  sent: Sent[] = [];
  labelCalls: { id: string; labels: string[] }[] = [];

  add(m: Message): Message {
    this.messages.push(m);
    return m;
  }
  async listMessages(): Promise<MessageItem[]> {
    return [...this.messages].reverse();
  }
  async getMessage(id: string): Promise<Message> {
    const m = this.messages.find((x) => x.message_id === id);
    if (!m) throw new Error('404');
    return m;
  }
  async getThread(id: string): Promise<Thread> {
    const ms = this.messages.filter((x) => x.thread_id === id);
    return { thread_id: id, messages: ms } as unknown as Thread;
  }
  async reply(messageId: string, body: { text: string; to: string[] }) {
    const orig = await this.getMessage(messageId);
    this.sent.push({ inReplyTo: messageId, ...body });
    const out: Message = mail({
      thread_id: orig.thread_id,
      from: OWN,
      to: body.to,
      labels: ['sent'],
      text: body.text,
      in_reply_to: messageId,
      authentication_results: undefined,
    });
    this.messages.push(out);
    return { message_id: out.message_id, thread_id: out.thread_id };
  }
  async addLabels(id: string, labels: string[]) {
    this.labelCalls.push({ id, labels });
    const m = await this.getMessage(id);
    m.labels = [...new Set([...m.labels, ...labels])];
  }
}

// A model that plays a fixed script of turns and records what it was shown.
export class ScriptModel implements Model {
  turns: ModelTurn[];
  seen: unknown[][] = [];
  calls = 0;
  constructor(turns: ModelTurn[]) {
    this.turns = turns;
  }
  async next(messages: unknown[]): Promise<ModelTurn> {
    this.calls += 1;
    this.seen.push(JSON.parse(JSON.stringify(messages)));
    return this.turns.shift() ?? { content: 'fallback answer' };
  }
}

export const quietLog = () => {};
