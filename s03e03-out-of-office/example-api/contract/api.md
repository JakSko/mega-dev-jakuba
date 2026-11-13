# Example API - contract

A stand-in written for this folder, so the runner, its gates and its tests have a contract to hold.

- An additive read needs no decision record: a new call or a new query parameter whose answers keep
  every existing field exactly as it is.
- A change to what an existing answer carries (a field added, dropped, renamed or reshaped) changes
  what every reader sees: it needs a decision record and the owner's answer.

All answers are JSON.

## `GET /incidents`

`{ "incidents": [ { "id", "service", "summary", "status", "openedAt" } ] }`, newest first, read from
the upstream feed (`FEED_URL`) with one GET.

## Upstream

The feed is read only. Writes to it need an admin token (`PROD_ADMIN_TOKEN`) and belong to ops:
this API and the agent never send them.

## Anything else

`404` with `{ "error": "not found" }`.
