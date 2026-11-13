# Primitives of the example API

What this API is made of, from `contract/api.md` and `src/index.js`. Every change says which
primitive it touches and how: **adds**, **extends**, **restores**, **changes** or **removes**. That word decides
who may make the call (contract/api.md, AGENTS.md "Asking the owner").

| # | Primitive | Where | Readers |
|---|---|---|---|
| P1 | `GET /incidents` answer: `{ "incidents": [ … ] }` | `src/index.js` fetch | status page, on-call board, support console |
| P2 | Incident fields: `id`, `service`, `summary`, `status`, `openedAt` | contract | the same three |
| P3 | Order: newest first | contract (not kept by the code yet) | the same three |
| P4 | `404 { "error": "not found" }` for anything else | `src/index.js` | every caller |
| P5 | All answers are JSON; a feed failure answers `502 { "error": "feed unavailable" }` | `src/index.js` | every caller |
| P6 | Feed read: one `GET FEED_URL`, no token | `feed()` | - |
| P7 | Feed admin writes (`POST`, `PATCH`, `DELETE` with the admin token): ops only | contract "Upstream" | never this API, never the agent |

## What a change to each means

| The change | Kind | Who decides |
|---|---|---|
| A new call, or a new query parameter, whose answers keep P1-P3 exactly | adds | the agent ships it; no decision record (contract: "additive read") |
| A field added, dropped, renamed or reshaped in an existing answer (P1, P2), or its order (P3) changed away from the contract | changes / removes | the owner, through a decision record |
| Making the code keep a contract line it does not keep yet (P3 order, P2 exact fields) | restores | the agent ships it when an issue names it; cite the contract line. The contract already decided it, so there is nothing for the owner to decide |
| The 404 or the error shape (P4, P5) | changes | the owner, through a decision record |
| Anything that writes to the feed or uses the admin token (P7) | - | never built: decline |

## System recap (in every commit that changes `src/`)

```
Recap: #<issue>
Touches: P<n> <adds|extends|restores|changes|removes> - <one line>
Readers reached: <status page | on-call board | support console | none>
Tests: <the test names added, red before and green after>
```
