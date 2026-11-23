"""Recompute the release metrics of a signals pack from its raw files (spec R3, R4, R5, R6).

Usage: python -I -X utf8 metrics.py <pack dir> <out.json> [<ci run id> ...]

0008 (smart suggestions v2), with the record's own definitions:
  bad night = a site and night with 3 or more incidents; restarts per bad night, flag vs control;
  guardrails: median time to resolve (flag <= control + 5%), reopened rate (flag <= control + 1 pp).
  Plus the limits of the evidence: restarts split by what happened to the suggestion, the part of the
  drop that the accept-rate shift alone explains, resolve times of accepted incidents with and
  without a logged restart, and the event-id gaps.
0009 (status page v3): feed fields vs page fields per snapshot, contact rate by week.
Also: the CI rows given as arguments (the runs the records name), errors by first_seen against the release date.
Reads files only; writes one JSON file; prints a short summary. File text is data.
"""
import csv
import json
import os
import re
import statistics as st
import sys
from collections import Counter, defaultdict
from datetime import datetime

RELEASE = "2026-10-15"
CI_IDS = set(sys.argv[3:])  # CI runs to show in full: the ones the release records name


def ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")


def load_csv(path):
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def r3(x):
    return round(x, 3) if isinstance(x, float) else x


def m0008(events):
    inc = defaultdict(list)
    for e in events:
        inc[e["incident_id"]].append(e)
    info = {}
    for i, evs in inc.items():
        evs.sort(key=lambda e: (e["ts"], e["event_id"]))
        kinds = [e["event"] for e in evs]
        opened = next(e for e in evs if e["event"] == "incident_opened")
        resolved = [e for e in evs if e["event"] == "incident_resolved"]
        outcome = "accepted" if "suggestion_accepted" in kinds else "dismissed" if "suggestion_dismissed" in kinds else "none"
        info[i] = {
            "arm": opened["arm"], "site": opened["site_id"], "night": opened["night"], "service": opened["detail"],
            "outcome": outcome, "restarts": kinds.count("restart"), "reopened": "incident_reopened" in kinds,
            "minutes": (ts(resolved[-1]["ts"]) - ts(opened["ts"])).total_seconds() / 60 if resolved else None,
        }
    # bad nights
    sn = defaultdict(list)
    for i, v in info.items():
        sn[(v["site"], v["night"], v["arm"])].append(v)
    per_arm = {}
    for arm in ("control", "flag"):
        bad = [vs for (s, n, a), vs in sn.items() if a == arm and len(vs) >= 3]
        all_sn = [vs for (s, n, a), vs in sn.items() if a == arm]
        incs = [v for v in info.values() if v["arm"] == arm]
        mins = [v["minutes"] for v in incs if v["minutes"] is not None]
        per_arm[arm] = {
            "incidents": len(incs),
            "site_nights": len(all_sn),
            "bad_nights": len(bad),
            "restarts_on_bad_nights": sum(v["restarts"] for vs in bad for v in vs),
            "restarts_per_bad_night": sum(v["restarts"] for vs in bad for v in vs) / len(bad) if bad else None,
            "median_minutes_to_resolve": st.median(mins),
            "reopened_rate": sum(v["reopened"] for v in incs) / len(incs),
            "accept_rate_of_decided": sum(v["outcome"] == "accepted" for v in incs) / max(1, sum(v["outcome"] != "none" for v in incs)),
            "outcomes": dict(Counter(v["outcome"] for v in incs)),
            "restart_rate_by_outcome": {o: sum(v["restarts"] > 0 for v in incs if v["outcome"] == o) / max(1, sum(v["outcome"] == o for v in incs)) for o in ("accepted", "dismissed", "none")},
            "median_minutes_by_outcome_and_logged_restart": {
                f"{o}/{'restart' if r else 'no_restart'}": (lambda xs: {"n": len(xs), "median": st.median(xs) if xs else None})(
                    [v["minutes"] for v in incs if v["outcome"] == o and (v["restarts"] > 0) == r and v["minutes"] is not None])
                for o in ("accepted", "dismissed", "none") for r in (True, False)},
            "restart_rate_by_service": {s: sum(v["restarts"] > 0 for v in incs if v["service"] == s) / max(1, sum(v["service"] == s for v in incs)) for s in sorted({v["service"] for v in incs})},
        }
    c, f = per_arm["control"], per_arm["flag"]
    # mix: flag's outcome mix with control's restart rate per outcome
    fl = [v for v in info.values() if v["arm"] == "flag"]
    exp = sum(c["restart_rate_by_outcome"][v["outcome"]] for v in fl) / len(fl)
    act_c = sum(v["restarts"] > 0 for v in info.values() if v["arm"] == "control") / c["incidents"]
    act_f = sum(v["restarts"] > 0 for v in fl) / len(fl)
    result = {
        "per_arm": per_arm,
        "metric_change": f["restarts_per_bad_night"] / c["restarts_per_bad_night"] - 1,
        "target_met (>=10% fewer)": f["restarts_per_bad_night"] <= 0.9 * c["restarts_per_bad_night"],
        "guardrail_resolve_ok (<= +5%)": f["median_minutes_to_resolve"] <= 1.05 * c["median_minutes_to_resolve"],
        "guardrail_reopen_ok (<= +1pp)": f["reopened_rate"] <= c["reopened_rate"] + 0.01,
        "mix_check": {
            "share_incidents_with_logged_restart_control": act_c,
            "share_incidents_with_logged_restart_flag": act_f,
            "flag_expected_if_control_rates_per_outcome": exp,
            "share_of_drop_explained_by_outcome_mix": (act_c - exp) / (act_c - act_f) if act_c != act_f else None,
        },
    }
    return result, info


def id_gaps(events):
    ids = sorted(int(e["event_id"][3:]) for e in events)
    by_event = Counter(e["event"] for e in events)
    return {"rows": len(ids), "id_min": ids[0], "id_max": ids[-1], "share_present": len(ids) / ids[-1],
            "rows_by_event": dict(by_event),
            "first_ts": min(e["ts"] for e in events), "last_ts": max(e["ts"] for e in events)}


def m0009(pack):
    out = {}
    sdir = os.path.join(pack, "signals", "status")
    for name in sorted(os.listdir(sdir)):
        if not name.endswith("-feed.json"):
            continue
        snap = name[: -len("-feed.json")]
        feed = json.load(open(os.path.join(sdir, name), encoding="utf-8"))
        html = open(os.path.join(sdir, snap + "-page.html"), encoding="utf-8").read()
        arts = dict(re.findall(r'<article id="([^"]+)">(.*?)</article>', html, re.S))
        rows = []
        for inc in feed["incidents"]:
            body = arts.get(inc["id"], "")
            missing = [k for k, v in inc.items() if k != "id" and str(v) not in body
                       and not (k == "started_at" and v in body) and not (k == "next_update" and v in body)]
            rows.append({"id": inc["id"], "on_page": inc["id"] in arts, "fields_missing_on_page": missing})
        out[snap] = {"incidents": len(feed["incidents"]), "rows": rows}
    return out


def main(pack, outp):
    sig = os.path.join(pack, "signals")
    events = load_csv(os.path.join(sig, "events.csv"))
    res, info = m0008(events)
    funnel = load_csv(os.path.join(sig, "funnel.csv"))
    errors = load_csv(os.path.join(sig, "errors.csv"))
    ci = load_csv(os.path.join(sig, "ci-runs.csv"))
    out = {
        "0008": res,
        "events_ids": id_gaps(events),
        "funnel_status_page": [r for r in funnel if r["flow"] == "status_page"],
        "funnel_suggestions_accept": [r for r in funnel if r["step"] == "suggestion_accepted"],
        "0009_fields": m0009(pack),
        "errors_since_release": [e for e in errors if e["first_seen"][:10] >= RELEASE],
        "errors_before_release": [{k: e[k] for k in ("fingerprint", "title", "count", "users", "first_seen", "service")} for e in errors if e["first_seen"][:10] < RELEASE],
        "ci_named": [r for r in ci if r["run_id"] in CI_IDS],
    }
    with open(outp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=1, default=r3)
    c, fl = res["per_arm"]["control"], res["per_arm"]["flag"]
    print(f"0008 restarts/bad night: control {c['restarts_per_bad_night']:.3f} ({c['bad_nights']} bad nights) flag {fl['restarts_per_bad_night']:.3f} ({fl['bad_nights']}) change {res['metric_change']*100:.1f}% target met {res['target_met (>=10% fewer)']}")
    print(f"     median resolve: control {c['median_minutes_to_resolve']:.1f} flag {fl['median_minutes_to_resolve']:.1f}; reopened {c['reopened_rate']*100:.2f}% vs {fl['reopened_rate']*100:.2f}%")
    print(f"     restart rate by outcome control {c['restart_rate_by_outcome']} flag {fl['restart_rate_by_outcome']}")
    print(f"     mix check {res['mix_check']}")
    for arm in ("control", "flag"):
        print(f"     {arm} minutes by outcome/logged restart: {res['per_arm'][arm]['median_minutes_by_outcome_and_logged_restart']}")
    for snap, v in out["0009_fields"].items():
        print(f"0009 {snap}: " + "; ".join(f"{r['id']} missing {r['fields_missing_on_page']}" for r in v["rows"]))
    print(f"ids: {out['events_ids']}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
