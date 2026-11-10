# mega-dev-jakuba

My work from the MEGA.dev program (October-November 2026): a four-week course on building with AI agents (core mechanics, agents, product engineering, autonomy). Each lesson ends with a Challenge that the course checks automatically, and the course reviewer often calls what you built while you are away.

I solve every Challenge together with my coding agent (Claude Code), with a fixed process: I first write my own understanding and plan, then we write a spec, a plan with marked outgoing and waiting steps, a full request log, and a short learning note after the course's debrief. Nothing leaves my machine without my approval.

This repo holds **my own code** for each Challenge. It does not hold the course's materials, briefs, starter projects, tickets, receipts or logs.

| Challenge | What it asked | What I built | Where |
|---|---|---|---|
| S01E01 somebody slow | Pass a long message to an API under a length limit, keeping one paragraph byte for byte, then answer a form | body builder from whole paragraphs with SHA-256 checks, verify and log helpers | [s01e01-somebody-slow](s01e01-somebody-slow/) |
| S01E02 who said what | Report what an audio and a video recording say, and when, then answer from a new session | local transcription with word timestamps (faster-whisper), second-pass rechecks, pass comparison, media inspection | [s01e02-who-said-what](s01e02-who-said-what/) |
| S01E03 what it shows | Split a support ticket that merged 412 reports into its real problems, one GitHub issue each, and add a kb page | independent counts (the desk's own code and a Python check), issue bodies by script, a signed kb page | [s01e03-what-it-shows](s01e03-what-it-shows/) + [public repo](https://github.com/JakSko/mega-s01e03-what-it-shows) |
| S01E04 before i looked | Take over a team's repo, turn its plan into issues, let agents build it, send a reviewer a public preview | 7 issues built by 5 agents in parallel worktrees (35 tests), preview on Railway checked like a stranger | [s01e04-before-i-looked](s01e04-before-i-looked/) + [public repo](https://github.com/JakSko/mega-s01e04-before-i-looked) |
| S01E05 answer where i asked | Put agents on a host that answer the course's signed pings with nobody at the keyboard; one writes a failing test | two agents behind one address: signature checks, live tracker reads, least rights per agent, a test proven red in a clean child process (60 tests) | [s01e05-answer-where-i-asked](s01e05-answer-where-i-asked/) |
| S02E01 found out late | Read two teams' agent sessions (Claude Code and Codex), write the plan that holds with a cited session per row, build the store it describes | session logs to cited text, a plan checker against the raw rows, a Claude Code stop hook that re-reads live sources before the agent stops | [s02e01-found-out-late](s02e01-found-out-late/) |
| S02E02 nobody asked | Build an agent people can reach by email: its own inbox, its own tools, a reply in the same thread within ten minutes, while nobody is at the keyboard | a mail reader agent: sender check in code (SPF/DKIM/DMARC), request vs data context, an SSRF-safe page fetch with paging, one reply per mail; 25 tests, live on a host | [s02e02-nobody-asked](s02e02-nobody-asked/) |
| S02E03 schema first | Build and host a remote MCP server of my own (memo, upload, transcribe), connect my harness to it, and let a stranger sign in and call it | schema-first tools on the official Python SDK, my own OAuth 2.1 sign-in with a consent page, SSRF-safe fetch, small results and errors that name the input; 60 tests, live on a host | [s02e03-schema-first](s02e03-schema-first/) |
| S02E04 two places | Hand two jobs, each with its skill, to two workers in two places, and let the main agent only join the results | one MCP client per worker with a submit gate by sha and a privacy rule in code, a local and a cloud Claude Code worker, a way home through a private repo, a time-zone-aware join; 14 tests | [s02e04-two-places](s02e04-two-places/) |
| S02E05 while you're away | Let an agent answer signed messages while I am away: safe acts alone, risky acts only after my approval from a phone push, and a status log that matches the sender's clock | HMAC-checked HTTPS agent, policy per act in code, ntfy push, an approve page with my owner code, a key handoff, an append-only event log and a status log builder; 25 tests, ran on a host | [s02e05-while-youre-away](s02e05-while-youre-away/) |

Shared: [shared/agent-service](shared/agent-service/) - a zero-dependency skeleton for a public agent service (pluggable sender check, retry after a failed run, rights file, whole-message log, model budget; 6 tests), extracted from S01E05 for the next Challenges.

More Challenges are added after each one is solved.
