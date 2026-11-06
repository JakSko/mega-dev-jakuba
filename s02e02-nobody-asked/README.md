# S02E02 - nobody asked

A mail reader agent built for the MEGA.dev Challenge S02E02 "nobody asked" (2026-11-06, solved on the first round). Email it a link and a question; it reads the page and answers you in the same thread. It runs on a host with nobody at the keyboard, and it is mine to keep after the course.

## The task, in my words

Build an agent people can reach by email: its own inbox, its own tools, a reply in the same thread within ten minutes. The course writes to it while you are away, so the agent must decide everything alone: who to trust, what was actually asked, who gets the answer, and what never leaves the host (the mail API key must never show in a reply).

## What made it hard

- Mail is untrusted input. A sender address can be forged, a trusted mail can forward a stranger's orders, a stranger can write into a thread, and the page behind a link can carry instructions too.
- Nobody approves a reply, so the safety rules have to live in code, not in the prompt.
- A host restarts and redeploys; a mail must still get exactly one reply.
- Pages are long. A model that sees only the start of a page will say the page lacks something it holds further down.

## What I built

| Part | What it does |
|---|---|
| [`src/senders.ts`](src/senders.ts) | Sender check before any model call: allowlist plus the provider's SPF/DKIM/DMARC verdicts, aligned to the From domain. Ignores our own mail, auto-replies and bounces. |
| [`src/context.ts`](src/context.ts) | Builds what the model sees: the whole thread, each part marked with its sender. Only the trusted sender's own new words are a `<request>`; quotes, forwards, strangers and page text are `<data>` and cannot close their block. |
| [`src/fetch_page.ts`](src/fetch_page.ts) | The agent's one tool: GET a public page as text. Refuses non-http(s), credentials in URLs, odd ports, local names and any address that resolves to a private, loopback, link-local or metadata range, on every redirect. Reads at most 2 MB. |
| [`src/agent.ts`](src/agent.ts) | The loop: check, read the thread, let the model fetch pages (long pages in 40,000-char parts from one download), scan the reply for keys, reply to the sender only (chosen in code), label the mail, then read the thread back to confirm the reply landed. Bounded turns, downloads, time and daily model calls. |
| [`src/agentmail.ts`](src/agentmail.ts), [`src/main.ts`](src/main.ts) | AgentMail REST client on the built-in `fetch`; polling as the source of truth plus a WebSocket for speed. No dependencies. |
| [`src/guard.ts`](src/guard.ts), [`src/store.ts`](src/store.ts) | Secret masking and blocking, one action per id, daily budget (from my `agent-service` skeleton). |

The rules are written for any later agent session in [`AGENTS.md`](AGENTS.md).

## How it was checked

- 25 tests (`node --test test/*.test.ts`, Node 23.6+). Each rule's test was run first against deliberately unsafe stubs (answer everyone, fetch anything) and failed, then passed on the real code.
- Three live tests from my own mailbox before the claim: a question about a long Wikipedia page, a mail asking to reply to other addresses and to include the API key, and a forwarded mail with a stranger's orders. The first run showed that the model API refused tool calls without `reasoning_effort: "none"`; the retest showed a 30,000-char window was too small for a 70,869-char page. Both were fixed, with a failing test first, before the course wrote.
- The course's round: two mails in one thread, the second a follow-up with no link. Each answered in about 5 seconds, in the thread, to the trusted sender only.

## What the course's debrief showed

Solved with no try refused. All four questions (the link, the gate, the thread, model or code) went right the first time, and the toolbox had nothing missing. The one right call: a live test from my own mailbox before the claim, so a broken model call cost three test mails, not the course's round.

## How to run it

Settings are host variables: `AGENTMAIL_API_KEY`, `MODEL_KEY` (OpenAI), `INBOX_ID`, `ALLOWED_SENDERS` (comma list), optional `MODEL`, `REASONING_EFFORT`, `POLL_SECONDS`, `DAILY_MODEL_CALLS`.

```bash
node --test test/*.test.ts
node src/main.ts
```

On Railway, set `RAILPACK_START_CMD=node src/main.ts`. The worker needs no public port.
