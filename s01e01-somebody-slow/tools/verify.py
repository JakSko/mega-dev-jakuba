"""Check the local page copy against the SHA-256 hashes the page itself computed, then diff with the mail copy."""
import difflib
import hashlib
import sys

PAGE_SHA = [
    "5d3c50cf2d4a06fc68cdf0da63f077dbbc4de9ee9477989fca7c2da27a85bcd4",
    "bb9aab24564316bd9f75611c7587e2b84e65dfed7e674f25c39ad49c3a1b0a1a",
    "fa00bdb8c21ebefeb4570e873742033b2be8d1598886a4fa8cde2b9c18a5f040",
    "16978d4dd8b3fd14cb8affd56fca261524d1ed090eeeac4f6636081663196063",
    "2fc9fa5f572bda004632099ab0e0b54806fc8e03b7ffce71333ae3277ce1331c",
    "4623fc783fa2600b95e8e1223673dfcd53622644fa961d37a51fe5751692390c",
    "ca51dbf0f33dc2df1b0b2f221748b98ead6ef1719eb41563bbe9bba1fd23e0b2",
    "27ea6b5ddb1483a785edf3323c74d17ed62f28c1fb60c65538c414a87d1ac31d",
    "38288c0cb5090265b0af61f9b28aa1d7b2bdfbd75e9146acb2b5ff3089264392",
    "673a476fca0e9c6e84708ef3973ba1c4ea21dce302df5513d1189b0658fc0f74",
    "2c2b76080bad0b14e742ca55683d0548b451e61cc9f18bec94992346d48249bf",
]
JOINED_SHA = "cee4bf069e120d2cf6d28b81740d05d4cb0b22f49462ba1fc1a3e38038920184"

page_path, mail_path = sys.argv[1], sys.argv[2]
raw = open(page_path, "rb").read()
text = raw.decode("utf-8")
paras = text.split("\n\n")
sha = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()

ok = len(paras) == len(PAGE_SHA)
for i, p in enumerate(paras):
    match = i < len(PAGE_SHA) and sha(p) == PAGE_SHA[i]
    ok &= match
    print(f"p{i:02d} len={len(p):4d} {'OK' if match else 'MISMATCH'}")
print("joined", len(text), "OK" if sha(text) == JOINED_SHA else "MISMATCH")
print("ALL MATCH" if ok and sha(text) == JOINED_SHA else "NOT VERIFIED")
print("26th paragraph sha256:", sha(paras[5]))

mail = open(mail_path, encoding="utf-8").read().rstrip("\n")
print("\nDiff mail copy -> page copy:")
for line in difflib.unified_diff(mail.split("\n"), text.split("\n"), "mail", "page", lineterm="", n=1):
    print(line)
