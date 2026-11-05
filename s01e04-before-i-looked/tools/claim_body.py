"""Build the S01E04 claim-challenge arguments from their sources, never retyped.

Sources:
  - private/start-challenge-reply.json: challengeId (-> uuid) and submit.answer (its keys are the answer's keys)
  - out/issues/created.json: the repo (owner/name, from the issue URLs gh returned)
  - log.md: the preview link from `railway domain` (the line with "domain": "https://...up.railway.app")
Receipts: none were handed for this Challenge (start-challenge gave one proof, laneMarker, whose
goesTo is .env and the page, not the claim), so receipts is {}.

Writes out/claim-body.json and prints it.
"""
import json
import re
from pathlib import Path

CH = Path(__file__).resolve().parent.parent
reply = json.loads((CH / "private" / "start-challenge-reply.json").read_text(encoding="utf-8"))
created = json.loads((CH / "out" / "issues" / "created.json").read_text(encoding="utf-8"))
log = (CH / "log.md").read_text(encoding="utf-8")

repos = {re.match(r"https://github\.com/([^/]+/[^/]+)/issues/\d+$", c["url"]).group(1) for c in created}
assert len(repos) == 1, repos
domains = set(re.findall(r'"domain": "(https://[a-z0-9-]+\.up\.railway\.app)"', log))
assert len(domains) == 1, domains

answer_keys = list(reply["submit"]["answer"].keys())
assert answer_keys == ["repo", "preview"], answer_keys
values = {"repo": repos.pop(), "preview": domains.pop()}
assert all(not k.startswith("ticket") for k in reply), "a ticket appeared in the reply; receipts must be revisited"

body = {"uuid": reply["challengeId"], "receipts": {}, "answer": {k: values[k] for k in answer_keys}}
out = CH / "out" / "claim-body.json"
out.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps(body, indent=2))
