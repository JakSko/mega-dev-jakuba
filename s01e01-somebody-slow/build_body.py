"""Build a request body for the S01E01 API from whole paragraphs of the page copy.

Paragraphs are sliced from rook-message-page-copy.txt by a script, never retyped.
The 26th paragraph (index 5) is checked by SHA-256 before and after JSON round-trip.

usage: python -I build_body.py <out.json> all
       python -I build_body.py <out.json> 0,2,4,5,8,10
"""
import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "rook-message-page-copy.txt"
P26_INDEX = 5
P26_SHA = "4623fc783fa2600b95e8e1223673dfcd53622644fa961d37a51fe5751692390c"
MAX_LEN = 700  # schema.json: properties.compactedMessage.maxLength

sha = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()

out_path, pick = sys.argv[1], sys.argv[2]
paras = SRC.read_text(encoding="utf-8").split("\n\n")
assert sha(paras[P26_INDEX]) == P26_SHA, "source 26th paragraph changed"

keep = list(range(len(paras))) if pick == "all" else [int(i) for i in pick.split(",")]
assert keep == sorted(set(keep)), "indices must be unique and in order"
assert P26_INDEX in keep, "the 26th paragraph must be kept"

message = "\n\n".join(paras[i] for i in keep)
body = {"from": "rook", "compactedMessage": message}
raw = json.dumps(body, ensure_ascii=False, indent=2)

back = json.loads(raw)["compactedMessage"]
assert back == message
assert P26_SHA in [sha(p) for p in back.split("\n\n")], "26th paragraph not intact after round-trip"
assert set(back) <= set(SRC.read_text(encoding="utf-8")), "unexpected characters"

pathlib.Path(out_path).write_text(raw, encoding="utf-8")
print(f"kept {keep}, cut {[i for i in range(len(paras)) if i not in keep]}")
print(f"compactedMessage length {len(message)} / limit {MAX_LEN}: {'FITS' if len(message) <= MAX_LEN else 'TOO LONG'}")
print("26th paragraph intact (SHA-256 match after JSON round-trip)")
for i, p in enumerate(paras):
    print(f"  p{i:02d} {len(p):4d} {'keep' if i in keep else 'CUT '}  {p[:60]}")
