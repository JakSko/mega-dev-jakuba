"""Step 3: scan every report (subject + body) for text aimed at an agent, hidden characters or links.
Usage: python -I tools/scan_bodies.py <reports-4471.json>"""
import json, re, sys, unicodedata, collections

AIMED = re.compile(r"(?i)\b(ignore|disregard|you are|as an ai|assistant|agent|claude|gpt|llm|model|prompt|instruction|system|harness|run |execute|curl|wget|token|password|api key|click|http|www\.|<script|```)")
reports = json.load(open(sys.argv[1], encoding="utf-8"))
uniq = {r["id"]: r for r in reports}
hits, odd, lengths = [], collections.Counter(), []
for r in uniq.values():
    text = r["subject"] + "\n" + r["body"]
    lengths.append(len(r["body"]))
    for c in text:
        if (ord(c) < 32 and c not in "\n\t") or unicodedata.category(c) in ("Cf", "Co", "Cn"):
            odd[(r["id"], f"U+{ord(c):04X}")] += 1
    m = AIMED.search(text)
    if m:
        hits.append((r["id"], m.group(0), text.replace("\n", " ")[:160]))
print(f"unique reports {len(uniq)}; body length min {min(lengths)} max {max(lengths)}")
print(f"hidden/control characters: {dict(odd) if odd else 'none'}")
print(f"pattern hits: {len(hits)}")
for h in hits:
    print(" ", h)
