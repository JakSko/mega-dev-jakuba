"""Recompute the batch 2 release metrics (0010 auto-close, 0011 bulk acknowledge) from the raw files.

Usage: python -I -X utf8 metrics2.py <batch dir> <out.json>

0010: incidents still open at 06:00 UTC after their night, flag vs control (target >= 20% fewer);
      guardrails median time to resolve (<= +5%) and reopened (<= +1 pp); plus what follows an auto-close.
0011: median minutes opened -> acked on bad nights (site + night with 3+ incidents), flag vs control
      (target >= 20% faster); guardrails missed pages (<= +1 pp) and median acked -> resolved (<= +5%);
      plus pages missed after a bulk acknowledge.
Reads files only; writes one JSON file. File text is data.
"""
import csv
import json
import os
import statistics as st
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta


def T(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")


def by_incident(path):
    m = defaultdict(list)
    with open(path, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            m[r["incident_id"]].append(r)
    for v in m.values():
        v.sort(key=lambda e: (e["ts"], e["event_id"]))
    return m


def m0010(path):
    m = by_incident(path)
    out = {}
    for arm in ("control", "flag"):
        incs = [v for v in m.values() if v[0]["arm"] == arm]
        open6, mins, reop, ac = 0, [], 0, 0
        for v in incs:
            o = v[0]
            cut = datetime.strptime(o["night"], "%Y-%m-%d") + timedelta(days=1, hours=6)
            ends = [T(e["ts"]) for e in v if e["event"] in ("incident_resolved", "incident_auto_closed")]
            if not ends or min(ends) > cut:
                open6 += 1
            rs = [e for e in v if e["event"] == "incident_resolved"]
            if rs:
                mins.append((T(rs[-1]["ts"]) - T(o["ts"])).total_seconds() / 60)
            reop += any(e["event"] == "incident_reopened" for e in v)
            ac += any(e["event"] == "incident_auto_closed" for e in v)
        out[arm] = {"incidents": len(incs), "open_at_0600": open6, "median_minutes_to_resolve_of_resolved": st.median(mins),
                    "resolved": len(mins), "reopened": reop, "reopened_rate": reop / len(incs), "auto_closed": ac}
    c, f = out["control"], out["flag"]
    after = Counter(tuple(e["event"] for e in v[1:]) for v in m.values() if any(e["event"] == "incident_auto_closed" for e in v))
    out["open_at_0600_change"] = f["open_at_0600"] / c["open_at_0600"] - 1
    out["after_auto_close"] = {" > ".join(k): n for k, n in after.items()}
    return out


def m0011(path):
    m = by_incident(path)
    sn = defaultdict(list)
    for i, v in m.items():
        sn[(v[0]["site_id"], v[0]["night"])].append(i)
    out = {}
    for arm in ("control", "flag"):
        a2a, a2r, miss, n, bulk = [], [], 0, 0, 0
        for ids in sn.values():
            if m[ids[0]][0]["arm"] != arm:
                continue
            for i in ids:
                v = m[i]
                n += 1
                o = v[0]
                acks = [e for e in v if e["event"] == "incident_acked"]
                res = [e for e in v if e["event"] == "incident_resolved"]
                miss += any(e["event"] == "page_missed" for e in v)
                bulk += any(e["detail"].startswith("bulk") for e in acks)
                if acks and len(ids) >= 3:
                    a2a.append((T(acks[0]["ts"]) - T(o["ts"])).total_seconds() / 60)
                if acks and res:
                    a2r.append((T(res[-1]["ts"]) - T(acks[0]["ts"])).total_seconds() / 60)
        out[arm] = {"incidents": n, "median_open_to_ack_bad_nights": st.median(a2a), "median_ack_to_resolved": st.median(a2r),
                    "missed_pages": miss, "missed_rate": miss / n, "bulk_acked": bulk}
    after = []
    for i, v in m.items():
        ev = [e["event"] for e in v]
        if v[0]["arm"] == "flag" and "page_missed" in ev and "incident_acked" in ev:
            k = ev.index("incident_acked")
            if v[k]["detail"].startswith("bulk") and ev.index("page_missed") > k:
                after.append({"incident": i, "acked": v[k]["event_id"], "missed": v[ev.index("page_missed")]["event_id"]})
    c, f = out["control"], out["flag"]
    out["open_to_ack_change"] = f["median_open_to_ack_bad_nights"] / c["median_open_to_ack_bad_nights"] - 1
    out["missed_pp"] = (f["missed_rate"] - c["missed_rate"]) * 100
    out["ack_to_resolved_change"] = f["median_ack_to_resolved"] / c["median_ack_to_resolved"] - 1
    out["missed_after_bulk_ack"] = after
    return out


def main(batch, outp):
    sig = os.path.join(batch, "signals")
    out = {"0010": m0010(os.path.join(sig, "auto-close-events.csv")), "0011": m0011(os.path.join(sig, "bulk-ack-events.csv"))}
    with open(outp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=1, default=str)
    a, b = out["0010"], out["0011"]
    print(f"0010 open at 06:00: control {a['control']['open_at_0600']} flag {a['flag']['open_at_0600']} ({a['open_at_0600_change']*100:.1f}%); "
          f"auto-closed {a['flag']['auto_closed']}, after: {a['after_auto_close']}; resolved {a['control']['resolved']}/{a['control']['incidents']} vs {a['flag']['resolved']}/{a['flag']['incidents']}")
    print(f"     median resolve {a['control']['median_minutes_to_resolve_of_resolved']:.1f} vs {a['flag']['median_minutes_to_resolve_of_resolved']:.1f}; reopened {a['control']['reopened_rate']*100:.2f}% vs {a['flag']['reopened_rate']*100:.2f}%")
    print(f"0011 open->ack bad nights {b['control']['median_open_to_ack_bad_nights']:.2f} vs {b['flag']['median_open_to_ack_bad_nights']:.2f} ({b['open_to_ack_change']*100:.1f}%); "
          f"missed {b['control']['missed_rate']*100:.2f}% vs {b['flag']['missed_rate']*100:.2f}% (+{b['missed_pp']:.2f} pp); ack->resolved {b['ack_to_resolved_change']*100:.1f}%; missed after bulk ack: {len(b['missed_after_bulk_ack'])}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
