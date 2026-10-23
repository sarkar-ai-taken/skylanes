"""Hourly ground population: who is where at hour h, weekday and weekend, as shares of census residents and LODES jobs.

The tiles hold residents (Census 2020 blocks) and jobs (LODES WAC) per cell. This script derives, per clock hour, the
share of residents at home and the share of jobs whose holder is at the workplace, plus the share of people out
(shops, restaurants, other homes, outdoors) and in transit, from public microdata, then nudges the weekday shape to
Puget Sound commuting with ACS. Output: app/data/diurnal.json (a few KB).

Inputs (all free, no key):
  BLS American Time Use Survey microdata, activity + respondent files (atusact-YYYY.zip, atusresp-YYYY.zip).
    Every diary episode has a start, a stop and TEWHERE (home, workplace, other places, travel mode). www.bls.gov
    answers scripted clients with 403, so if the download fails the script asks for the zips to be saved by hand into
    data/raw/diurnal/ (same names) and uses those; their sha256 goes into the JSON.
  Census ACS 5-year table-based summary files (www2.census.gov, no key; api.census.gov now wants a key even for small
    queries): B08302 time leaving home, B08303 travel time, B08301 means of transport (worked from home). Only the
    US, Washington and the four county rows are kept in data/raw/diurnal/acs-<table>.psv.

    python diurnal.py            # ATUS 2023+2024 pooled, ACS 2020-2024
"""
import base64, hashlib, io, json, re, sys, time, urllib.error, urllib.request, zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "data" / "raw" / "diurnal", ROOT / "app" / "data" / "diurnal.json"
UA = {"User-Agent": "corridor-pipeline/0.1 (route safety-case prototype)"}
ATUS_YEARS = [2023, 2024]
ACS_YEAR = 2024
ATUS = "https://www.bls.gov/tus/datafiles/{f}-{y}.zip"
ACS = f"https://www2.census.gov/programs-surveys/acs/summary_file/{ACS_YEAR}/table-based-SF/data/5YRData/acsdt5y{ACS_YEAR}-{{t}}.dat"
ACS_META = f"https://api.census.gov/data/{ACS_YEAR}/acs/acs5/groups/{{T}}.json"
COUNTIES = {"53033": "King", "53053": "Pierce", "53061": "Snohomish", "53035": "Kitsap"}
GEOS = {"0100000US", "0400000US53", *(f"0500000US{c}" for c in COUNTIES)}

# TEWHERE codes. Blank (-1) is where BLS does not ask: sleeping, grooming, personal activities (tier-1 code 01), taken
# as home. Other blanks, don't know and refused stay "unknown".
HOME, WORK, OUT_, TRAVEL, UNK = range(5)
WHERE = {1: HOME, 2: WORK, **{k: OUT_ for k in (3, 4, 5, 6, 7, 8, 9, 10, 11, 30, 31, 32)}, **{k: TRAVEL for k in range(12, 22)}}
CATS = ["home", "work", "out", "travel", "unknown"]
WEEKDAY, WEEKEND = {2, 3, 4, 5, 6}, {1, 7}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError:
            raise
        except OSError as e:  # api.census.gov resets connections now and then
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} after {e}")
            time.sleep(5 * 2 ** i)


def atus_zip(f, y):
    p = RAW / f"{f}-{y}.zip"
    if not p.exists():
        try:
            p.write_bytes(get(ATUS.format(f=f, y=y)))
        except Exception as e:  # noqa: BLE001
            sys.exit(f"{ATUS.format(f=f, y=y)}: {e}. BLS blocks scripted downloads; save it in a browser as {p} and rerun.")
    if zipfile.ZipFile(p).testzip() is not None:
        sys.exit(f"{p} is corrupt")
    return p


def rows(p, name):
    with zipfile.ZipFile(p) as z, z.open(name) as f:
        it = io.TextIOWrapper(f, encoding="ascii")
        head = next(it).strip().split(",")
        for line in it:
            yield dict(zip(head, line.strip().split(",")))


def atus_minutes():
    """Per respondent: day of week, weight, employed, and a 1440-minute location code (index 0 = 04:00, diary start)."""
    people, sha = {}, {}
    for y in ATUS_YEARS:
        rp, ap = atus_zip("atusresp", y), atus_zip("atusact", y)
        sha.update({rp.name: hashlib.sha256(rp.read_bytes()).hexdigest(), ap.name: hashlib.sha256(ap.read_bytes()).hexdigest()})
        for r in rows(rp, f"atusresp_{y}.dat"):
            # weights of each year sum to that year's person-days; halve so the pooled years count equally
            people[r["TUCASEID"]] = [int(r["TUDIARYDAY"]), float(r["TUFINLWGT"]) / len(ATUS_YEARS), r["TELFS"] in ("1", "2"),
                                     r["TRHOLIDAY"] == "1", np.full(1440, UNK, np.int8)]
        for a in rows(ap, f"atusact_{y}.dat"):
            p = people[a["TUCASEID"]]
            stop = min(int(a["TUCUMDUR24"]), 1440)
            w = int(a["TEWHERE"])
            p[4][stop - int(a["TUACTDUR24"]):stop] = WHERE.get(w, HOME if w == -1 and a["TUTIER1CODE"] == "01" else UNK)
    return [p for p in people.values() if p[1] > 0], sha


def shares(people, days):
    """Weighted minute-by-minute share of persons in each place, (5, 1440) indexed by clock minute; same for the employed."""
    sel = [p for p in people if p[0] in days and not p[3]]
    W = np.array([p[1] for p in sel])
    M = np.stack([p[4] for p in sel])
    clock = lambda S: np.roll(S, 240, axis=1)  # diary minute 0 is 04:00
    allp = clock(np.stack([(W[:, None] * (M == c)).sum(0) for c in range(5)]) / W.sum())
    emp = np.array([p[2] for p in sel])
    We, Me = W[emp], M[emp]
    empp = clock(np.stack([(We[:, None] * (Me == c)).sum(0) for c in range(5)]) / We.sum())
    return allp, empp, len(sel), float(We.sum() / W.sum())


def acs(t):
    p = RAW / f"acs-{t}.psv"
    if not p.exists():
        keep = []
        with urllib.request.urlopen(urllib.request.Request(ACS.format(t=t), headers=UA), timeout=600) as r:
            for i, line in enumerate(io.TextIOWrapper(r, encoding="utf-8")):
                if i == 0 or line.split("|", 1)[0] in GEOS:
                    keep.append(line)
        p.write_text("".join(keep))
    m = RAW / f"acs-{t}-meta.json"
    if not m.exists():
        m.write_bytes(get(ACS_META.format(T=t.upper())))
    lines = p.read_text().splitlines()
    head = lines[0].split("|")
    data = {l.split("|")[0]: dict(zip(head, l.split("|"))) for l in lines[1:]}
    labels = {k[:-1].replace("_", "_E"): v["label"] for k, v in json.loads(m.read_text())["variables"].items() if re.fullmatch(r"B\d+_\d{3}E", k)}
    return data, labels


def clock_min(s):
    h, m, ap = re.fullmatch(r"(\d+):(\d+) ([ap])\.m\.", s).groups()
    return (int(h) % 12 + (12 if ap == "p" else 0)) * 60 + int(m)


def bins_depart(labels, T):
    """B08302 bins as (column, start minute, end minute) parsed from the Census labels, not hard-coded."""
    out = []
    for k, lab in sorted(labels.items()):
        if k.startswith(T) and k != f"{T}_E001":
            a, b = lab.split("!!")[-1].split(" to ")
            out.append((k, clock_min(a), clock_min(b) + 1))
    return out


def bins_travel(labels, T):
    out = []
    for k, lab in sorted(labels.items()):
        if k.startswith(T) and k != f"{T}_E001":
            s = lab.split("!!")[-1]
            n = [int(x) for x in re.findall(r"\d+", s)]
            out.append((k, 0, 5) if s.startswith("Less") else (k, n[0], 120) if "more" in s else (k, n[0], n[1] + 1))
    return out


def mean_of(row, bins):
    tot = sum(float(row[k]) for k, _, _ in bins)
    return sum(float(row[k]) * (a + b) / 2 for k, a, b in bins) / tot


def hourly(S):
    return S.reshape(S.shape[0], 24, 60).mean(2)


def tiles_density_check(D):
    """Cell-level people/km² by hour from the shipped tiles (no 3x3 smoothing), for the category sanity table."""
    res, job = [], []
    for f in sorted((ROOT / "app" / "data" / "tiles").glob("*.json")):
        t = json.loads(f.read_text())
        st = np.frombuffer(base64.b64decode(t["state"]), np.uint8)
        r = np.frombuffer(base64.b64decode(t["residents"]), np.uint32)[st == 0]
        j = np.frombuffer(base64.b64decode(t["jobs"]), np.uint32)[st == 0]
        res.append(r), job.append(j)
    R, J = np.concatenate(res).astype(float), np.concatenate(job).astype(float)
    k = R.sum() / J.sum()
    cat = lambda d: np.digitize(d, [50, 500, 2500, 10000]) + 1
    out = {}
    for day in ("weekday", "weekend"):
        h = D[day]
        out[day] = {}
        for hr in (3, 9, 13, 17, 21):
            d = h["resHome"][hr] * R + h["jobsAtWork"][hr] * J + (h["out"][hr] + h["travel"][hr]) * k * J
            c = np.bincount(cat(d), minlength=6)[1:]
            out[day][f"{hr:02d}"] = {"cells_by_cat": c.tolist(), "cat5_cells": int(c[4]), "p99_per_km2": round(float(np.percentile(d, 99)))}
    night = np.bincount(cat(R), minlength=6)[1:]
    return k, out, night.tolist(), len(R)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    people, sha = atus_minutes()
    nat = {}
    for name, days in (("weekday", WEEKDAY), ("weekend", WEEKEND)):
        nat[name] = shares(people, days)

    acsd = {t: acs(t) for t in ("b08302", "b08303", "b08301")}
    dep, dl = acsd["b08302"]
    trv, tl = acsd["b08303"]
    mot, ml = acsd["b08301"]
    bd, bt = bins_depart(dl, "B08302"), bins_travel(tl, "B08303")
    wfh_col = next(k for k, v in ml.items() if k.startswith("B08301") and v.endswith("Worked from home"))
    local = [f"0500000US{c}" for c in COUNTIES]
    sumrow = lambda data, ks: {k: sum(float(data[g][k]) for g in ks) for k in data[ks[0]] if k != "GEO_ID"}
    loc_dep, loc_trv, loc_mot = sumrow(dep, local), sumrow(trv, local), sumrow(mot, local)
    us_dep, us_trv, us_mot = dep["0100000US"], trv["0100000US"], mot["0100000US"]
    arr_loc, arr_us = mean_of(loc_dep, bd) + mean_of(loc_trv, bt), mean_of(us_dep, bd) + mean_of(us_trv, bt)
    shift = round(arr_loc - arr_us)  # minutes later (+) that Puget Sound commuters reach work than the US mean
    wfh_loc = loc_mot[wfh_col] / loc_mot["B08301_E001"]
    wfh_us = float(us_mot[wfh_col]) / float(us_mot["B08301_E001"])
    kw = (1 - wfh_loc) / (1 - wfh_us)  # commuters per worker, local over national

    out = {}
    for name in ("weekday", "weekend"):
        allp, empp, n, emp_share = nat[name]
        if name == "weekday" and shift:
            allp, empp = np.roll(allp, shift, axis=1), np.roll(empp, shift, axis=1)
        H, He = hourly(allp), hourly(empp)
        jobs_at_work = He[WORK] * kw
        moved = (He[WORK] - jobs_at_work) * emp_share  # employed who work from home here instead of the workplace
        r4 = lambda a: [round(float(x), 4) for x in a]
        out[name] = {"n_diaries": n, "employed_share_15plus": round(emp_share, 4),
                     "resHome": r4(H[HOME] + moved), "jobsAtWork": r4(jobs_at_work), "out": r4(H[OUT_]), "travel": r4(H[TRAVEL]),
                     "unknown": r4(H[UNK]), "atWorkAllPersons": r4(H[WORK] - moved),
                     "national": {"resHome": r4(H[HOME]), "jobsAtWork": r4(He[WORK])}}

    D = {"built": __import__("datetime").date.today().isoformat(),
         "hours": "clock hour h = mean over h:00-h:59 local time; index 0..23",
         "weekday": out["weekday"], "weekend": out["weekend"],
         "local": {"counties": COUNTIES, "acs": f"ACS {ACS_YEAR - 4}-{ACS_YEAR} 5-year",
                   "mean_depart_local_min": round(mean_of(loc_dep, bd)), "mean_depart_us_min": round(mean_of(us_dep, bd)),
                   "mean_travel_local_min": round(mean_of(loc_trv, bt), 1), "mean_travel_us_min": round(mean_of(us_trv, bt), 1),
                   "weekday_shift_min": shift, "wfh_local": round(wfh_loc, 4), "wfh_us": round(wfh_us, 4), "commuter_factor": round(kw, 4),
                   "workers_local": round(loc_mot["B08301_E001"])},
         "spread": {"rule": "out and travel people are placed in proportion to jobs, scaled by k = residents_total / jobs_total "
                            "(job cells stand in for shops, restaurants, schools and the roads between them)"},
         "method": [
             f"BLS ATUS {'+'.join(map(str, ATUS_YEARS))} microdata: every diary episode (TUCUMDUR24 - TUACTDUR24 .. TUCUMDUR24, minutes from 04:00) "
             "is assigned a place from TEWHERE: 1 home, 2 workplace, 3-11 and 30-32 out (someone else's home, restaurant, worship, store, school, "
             "outdoors, library, bank, gym, post office), 12-21 travel (car, walk, bus, train, bike, ferry, taxi, plane). TEWHERE is not asked for "
             "sleeping, grooming and personal activities (tier 01): those count as home. Other blanks and refusals are 'unknown' (<1%).",
             "Shares are weighted by TUFINLWGT (each year halved), per clock minute, then averaged within each clock hour. Weekday = Mon-Fri diaries "
             "excluding holidays (TRHOLIDAY), weekend = Sat+Sun. Population = civilian non-institutional persons 15+, US-wide.",
             "resHome[h] = share of persons 15+ at home; applied to all census residents, including children under 15 (who on school days are "
             "mostly at school: resHome overstates homes and understates schools on weekday daytimes).",
             "jobsAtWork[h] = share of employed persons (TELFS 1-2, incl. those absent from work that day) at their workplace; applied to LODES jobs. "
             "LODES counts jobs, not workers (second jobs count twice), and places a job at the employer's establishment address.",
             f"Puget Sound adjustment (weekday): ACS B08302 departure + B08303 travel time give mean arrival at work (bin midpoints, 90+ min = 105) for the "
             f"four counties vs the US; the weekday curves are shifted by the difference ({shift:+d} min). ACS B08301 worked-from-home share "
             f"({wfh_loc:.1%} local vs {wfh_us:.1%} US) scales jobsAtWork by (1-wfh_local)/(1-wfh_us) = {kw:.3f} on both day types; the employed "
             "removed from workplaces are added back to resHome (times employed share of persons 15+).",
             "out[h] and travel[h] are shares of all persons 15+; out + travel + resHome + atWorkAllPersons + unknown = 1.",
             "Not modelled: tourists, students in dorms, overnight shift workers' sleeping place vs workplace geography, seasonal and weather effects, "
             "special events (the engine's stadium crowd stays separate). ATUS is national; only commute timing and WFH are localized.",
         ],
         "sources": {"atus": {"url": "https://www.bls.gov/tus/datafiles/", "files": sha, "license": "US public domain (BLS)",
                              "note": "www.bls.gov returns 403 to scripted clients, so the zips are saved by hand into data/raw/diurnal/ when the scripted download fails; sha256 is of the files used, each checked with zip CRC"},
                     "acs": {"url": ACS.format(t="<table>"), "tables": ["B08302", "B08303", "B08301"], "license": "US public domain (Census)"}},
         }
    k, cats, night, ncells = tiles_density_check(D)
    D["spread"]["k"] = round(k, 4)
    D["check"] = {"note": "land cells (100 m, no 3x3 smoothing) by fallback FAA category 1-5 (<50, <500, <2500, <10000, >=10000 /km2)",
                  "cells": ncells, "night_residents_only": night, "by_hour": cats}
    for name in ("weekday", "weekend"):
        x = D[name]
        tot = [x["resHome"][h] + x["atWorkAllPersons"][h] + x["out"][h] + x["travel"][h] + x["unknown"][h] for h in range(24)]
        assert all(abs(t - 1) < 2e-3 for t in tot), tot
    OUT.write_text(json.dumps(D, separators=(",", ":")))
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1024:.1f} KB; shift {shift:+d} min, wfh {wfh_loc:.3f} vs {wfh_us:.3f}")
    for name in ("weekday", "weekend"):
        x = D[name]
        print(name, x["n_diaries"], "diaries")
        for h in range(24):
            print(f"  {h:02d}  home {x['resHome'][h]:.3f}  work(jobs) {x['jobsAtWork'][h]:.3f}  out {x['out'][h]:.3f}  travel {x['travel'][h]:.3f}")


if __name__ == "__main__":
    main()
