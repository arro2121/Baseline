"""
Ratings and prediction settings for the NFL, NBA, MLB, NHL and Premier League.
Every league ends up on the same Elo-style scale (1500 = average), so the app predicts any matchup with
    P(home wins) = 1 / (1 + 10 ** (-(home + HFA - away) / 400))
* NFL: game-by-game Elo from every result since 1999 (nflverse), with margin of victory and a 1/3
  reversion to the mean between seasons.
* Premier League: game-by-game Elo from five seasons of results (openfootball), goal-difference weighted;
  draws are predicted from how evenly matched the teams are (fitted on the same data).
* MLB, NBA, NHL: current records regressed toward .500 by an amount that reflects each sport's luck
  (preseason NBA and NHL use last season's final records, regressed harder).
"""
import json, math, re, unicodedata, datetime as dt
import numpy as np, pandas as pd

def key(n):
    n = unicodedata.normalize("NFKD", str(n)).encode("ascii", "ignore").decode().lower()
    n = n.replace("&", " and ")
    n = re.sub(r"\b(fc|afc)\b", " ", n)
    return re.sub(r"[^a-z0-9]+", " ", n).strip()

NFL_NAMES = dict(ARI="Arizona Cardinals",ATL="Atlanta Falcons",BAL="Baltimore Ravens",BUF="Buffalo Bills",CAR="Carolina Panthers",CHI="Chicago Bears",
 CIN="Cincinnati Bengals",CLE="Cleveland Browns",DAL="Dallas Cowboys",DEN="Denver Broncos",DET="Detroit Lions",GB="Green Bay Packers",HOU="Houston Texans",
 IND="Indianapolis Colts",JAX="Jacksonville Jaguars",KC="Kansas City Chiefs",LA="Los Angeles Rams",LAC="Los Angeles Chargers",LV="Las Vegas Raiders",
 MIA="Miami Dolphins",MIN="Minnesota Vikings",NE="New England Patriots",NO="New Orleans Saints",NYG="New York Giants",NYJ="New York Jets",
 PHI="Philadelphia Eagles",PIT="Pittsburgh Steelers",SEA="Seattle Seahawks",SF="San Francisco 49ers",TB="Tampa Bay Buccaneers",TEN="Tennessee Titans",
 WAS="Washington Commanders")
NFL_FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA"}   # relocations keep their rating

def elo_p(d): return 1 / (1 + 10 ** (-d / 400))

# ------------------------------------------------------------------ NFL
def nfl(games_csv):
    g = pd.read_csv(games_csv, low_memory=False)
    g = g[g.game_type.isin(["REG", "WC", "DIV", "CON", "SB"])].sort_values(["season", "gameday", "gametime"])
    for c in ("home_team", "away_team"): g[c] = g[c].replace(NFL_FRANCHISE)
    R, HFA, K = {}, 48.0, 20.0
    season, rows = None, []
    for r in g.itertuples():
        if r.season != season:
            season = r.season
            for t in R: R[t] = R[t] * 2 / 3 + 1505 / 3          # between-season reversion
        h, a = R.setdefault(r.home_team, 1500.0), R.setdefault(r.away_team, 1500.0)
        neutral = str(r.location) == "Neutral"
        d = h - a + (0 if neutral else HFA)
        p = elo_p(d)
        if pd.isna(r.home_score): continue
        mov = r.home_score - r.away_score
        res = 1.0 if mov > 0 else 0.0 if mov < 0 else 0.5
        # market's view for the backtest
        mh, ma = r.home_moneyline, r.away_moneyline
        pm = None
        if not pd.isna(mh) and not pd.isna(ma):
            dec = lambda m: 1 + (m / 100 if m > 0 else 100 / -m)
            ih, ia = 1 / dec(mh), 1 / dec(ma); pm = ih / (ih + ia)
        rows.append((r.season, p, res, pm))
        mult = math.log(abs(mov) + 1) * 2.2 / ((d if res == 1 else -d) * 0.001 + 2.2) if mov else 1.0
        shift = K * mult * (res - p)
        R[r.home_team] = h + shift; R[r.away_team] = a - shift
    bt = pd.DataFrame(rows, columns=["season", "p", "res", "pm"])
    test = bt[(bt.season >= 2021) & bt.res.isin([0, 1])]
    ll = lambda p, y: float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    tm = test.dropna(subset=["pm"])
    backtest = dict(games=int(len(test)), acc=round(float(((test.p > .5) == (test.res == 1)).mean()), 3), logloss=round(ll(test.p, test.res), 4),
                    market_games=int(len(tm)), market_acc=round(float(((tm.pm > .5) == (tm.res == 1)).mean()), 3), market_logloss=round(ll(tm.pm, tm.res), 4),
                    model_logloss_same_games=round(ll(tm.p, tm.res), 4), seasons="2021–2025 + 2026 so far")
    last = g[g.season == g.season.max()]; last = last[last.home_score.notna() & (last.game_type == "REG")]
    rec = {t: [0, 0, 0] for t in NFL_NAMES}
    for r in last.itertuples():
        m = r.home_score - r.away_score
        for t, s_ in ((r.home_team, m), (r.away_team, -m)):
            if t in rec: rec[t][0 if s_ > 0 else 1 if s_ < 0 else 2] += 1
    teams = [dict(name=NFL_NAMES[t], abbr=t, rating=round(v, 1), w=rec[t][0], l=rec[t][1], t=rec[t][2] or None) for t, v in R.items() if t in NFL_NAMES]
    return teams, dict(hfa=HFA, spread_per_point=25, backtest=backtest,
                       method="Game-by-game Elo from every NFL result since 1999, weighted by margin of victory; ratings pull 1/3 of the way back to average each offseason.")

# ------------------------------------------------------------------ Premier League
def epl(files):
    ms = []
    for f in files:
        for m in json.load(open(f))["matches"]:
            s = m.get("score") or {}
            if isinstance(s, dict) and s.get("ft"): ms.append((m["date"], m["team1"], m["team2"], *s["ft"]))
    ms.sort()
    R, HFA, K = {}, 55.0, 22.0
    season_of = lambda d: int(d[:4]) if int(d[5:7]) >= 7 else int(d[:4]) - 1
    cur, rows = None, []
    for date, t1, t2, g1, g2 in ms:
        s = season_of(date)
        if s != cur:
            cur = s
            for t in R: R[t] = R[t] * 0.8 + 1500 * 0.2
        h, a = R.setdefault(t1, 1450.0), R.setdefault(t2, 1450.0)    # promoted sides start below average
        E = elo_p(h - a + HFA)
        res = 1.0 if g1 > g2 else 0.0 if g1 < g2 else 0.5
        rows.append((s, E, res))
        gd = abs(g1 - g2); mult = 1 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
        R[t1] = h + K * mult * (res - E); R[t2] = a - K * mult * (res - E)
    bt = pd.DataFrame(rows, columns=["season", "E", "res"])
    # draw model fitted on the first seasons: P(draw) = c0 * (1 - |2E-1|^c1)
    fit = bt[bt.season < 2025]
    best = None
    for c0 in np.arange(.20, .36, .005):
        for c1 in np.arange(.6, 2.6, .05):
            pd_ = np.clip(c0 * (1 - np.abs(2 * fit.E - 1) ** c1), .05, .6)
            ph = np.clip(fit.E - pd_ / 2, .01, .98); pa = np.clip(1 - ph - pd_, .01, .98)
            l = -np.log(np.where(fit.res == 1, ph, np.where(fit.res == 0, pa, pd_))).mean()
            if best is None or l < best[0]: best = (l, round(float(c0), 3), round(float(c1), 2))
    _, c0, c1 = best
    test = bt[bt.season >= 2025]
    pd_ = np.clip(c0 * (1 - np.abs(2 * test.E - 1) ** c1), .05, .6); ph = np.clip(test.E - pd_ / 2, .01, .98); pa = np.clip(1 - ph - pd_, .01, .98)
    probs = np.vstack([ph, pd_, pa]).T; actual = np.where(test.res == 1, 0, np.where(test.res == .5, 1, 2))
    backtest = dict(games=int(len(test)), acc=round(float((probs.argmax(1) == actual).mean()), 3),
                    logloss=round(float(-np.log(probs[np.arange(len(actual)), actual]).mean()), 4),
                    baseline_logloss=round(float(-np.log(np.array([.44, .26, .30])[actual]).mean()), 4), seasons="2025–26 and 2026–27 so far")
    cur_ms = [m for m in ms if season_of(m[0]) == season_of(ms[-1][0])]
    current = {t for _, t1, t2, *_ in cur_ms for t in (t1, t2)}
    table = {t: dict(w=0, d=0, l=0, gf=0, ga=0) for t in current}
    for _, t1, t2, g1, g2 in cur_ms:
        for t, f, a in ((t1, g1, g2), (t2, g2, g1)):
            r = table[t]; r["gf"] += f; r["ga"] += a
            r["w" if f > a else "l" if f < a else "d"] += 1
    teams = [dict(name=re.sub(r"^AFC |\s+FC$", "", t).strip(), rating=round(v, 1), **table[t], pts=3 * table[t]["w"] + table[t]["d"]) for t, v in R.items() if t in current]
    return teams, dict(hfa=HFA, draw=[c0, c1], backtest=backtest,
                       method="Game-by-game Elo from five Premier League seasons, weighted by goal difference; draw chances fitted to how evenly matched the teams are.")

# ------------------------------------------------------------------ MLB / NBA / NHL from records
def records(rows, k, home_win, games=None, prior=None):
    """Team strength from a record: win% regressed toward a prior (last rating, or .500) with k phantom games,
    then put on the Elo scale. NHL overtime/shootout losses count as half a win: they were tied after 60 minutes."""
    prior = prior or {}
    teams = []
    for row in rows:
        name, w, l = row[:3]
        otl = row[3] if len(row) > 3 and row[3] is not None else (max(0, games - w - l) if games else 0)
        n = w + l + otl
        pp = elo_p(prior[key(name)] - 1500) if key(name) in prior else .5
        p = (w + .5 * otl + k * pp) / (n + k)
        teams.append(dict(name=name, rating=round(1500 + 400 * math.log10(p / (1 - p)), 1), w=w, l=l, otl=otl or None))
    hfa = 400 * math.log10(home_win / (1 - home_win))
    return teams, round(hfa, 1)

def espn_standings(lg):
    """Current records from ESPN (used by the hosted version's nightly job)."""
    import urllib.request
    path = {"mlb": "baseball/mlb", "nba": "basketball/nba", "nhl": "hockey/nhl"}[lg]
    d = json.load(urllib.request.urlopen(f"https://site.api.espn.com/apis/v2/sports/{path}/standings", timeout=30))
    rows, stack = [], [d]
    while stack:
        node = stack.pop()
        for e in (node.get("standings") or {}).get("entries", []):
            st = {x.get("name") or x.get("type"): x.get("value") for x in e.get("stats", [])}
            otl = next((st[k] for k in ("overtimeLosses", "otLosses", "OTLosses") if st.get(k) is not None), None)
            rows.append([e["team"]["displayName"], int(st.get("wins") or 0), int(st.get("losses") or 0), int(otl) if otl is not None else None])
        stack += node.get("children", [])
    return rows

ESPN_PATHS = {"nfl": "football/nfl", "nba": "basketball/nba", "mlb": "baseball/mlb", "nhl": "hockey/nhl", "epl": "soccer/eng.1"}

def espn_logos(lg):
    """Team logos from ESPN's team list, keyed by the team's full name and then by its other names."""
    import urllib.request
    d = json.load(urllib.request.urlopen(f"https://site.api.espn.com/apis/site/v2/sports/{ESPN_PATHS[lg]}/teams", timeout=30))
    teams = [t["team"] for t in d["sports"][0]["leagues"][0]["teams"]]
    out = {}
    for fields in (("displayName",), ("shortDisplayName", "location", "name", "nickname")):
        for t in teams:
            logos = t.get("logos") or []
            logo = next((l["href"] for l in logos if "default" in l.get("rel", [])), None) or (logos[0]["href"] if logos else None)
            for f in fields:
                if logo and t.get(f): out.setdefault(key(t[f]), (logo, str(t.get("id", ""))))
    return out

def add_logos(out, prev_lg, use_espn):
    """Give every team its logo, keeping the last known one when ESPN can't be reached."""
    for lg, L in out["leagues"].items():
        old = {key(t["name"]): (t.get("logo"), t.get("espn_id")) for t in prev_lg.get(lg, {}).get("teams", [])}
        logos = {}
        if use_espn:
            try: logos = espn_logos(lg)
            except Exception as e: print(f"ESPN logos for {lg} unavailable ({e}); keeping the saved ones")
        for t in L["teams"]:
            logo, espn_id = logos.get(key(t["name"])) or old.get(key(t["name"])) or (None, None)
            if logo: t["logo"] = logo
            if espn_id: t["espn_id"] = espn_id              # opens the team's page in the app

def build(feed_path="standings_feed.json", nfl_csv="nfl.dat", epl_files=(), previous=None, use_espn=False):
    feed = json.load(open(feed_path))
    prev_lg = (previous or {}).get("leagues", {})
    if use_espn:
        for lg in ("mlb", "nba", "nhl"):
            try:
                rows = espn_standings(lg)
                if len(rows) >= 28: feed[lg] = rows; feed["meta"][lg] = {"season": "current", "final": False}
            except Exception as e:
                print(f"ESPN standings for {lg} unavailable ({e}); keeping the saved records")
    out = {"built": dt.date.today().isoformat(), "leagues": {}}
    t, meta = nfl(nfl_csv)
    out["leagues"]["nfl"] = dict(name="NFL", teams=t, **meta, season="2026", sport="football")
    t, meta = epl(epl_files)
    out["leagues"]["epl"] = dict(name="Premier League", teams=t, **meta, season="2026–27", sport="soccer")
    for lg, k, hw, games, note in (("mlb", 70, .535, None, "this season's record"), ("nba", 22, .565, 82, "this season's record (before games start: last season's)"),
                                   ("nhl", 34, .535, 82, "this season's record (before games start: last season's)")):
        rows = feed[lg]
        n_now = sum(r[1] + r[2] + ((r[3] or 0) if len(r) > 3 else 0) for r in rows) / max(1, len(rows))
        old = prev_lg.get(lg, {})
        n_old = sum((t.get("w") or 0) + (t.get("l") or 0) + (t.get("otl") or 0) for t in old.get("teams", [])) / max(1, len(old.get("teams", [])) or 1)
        season_prior = old.get("prior")
        if old.get("teams") and n_now < 0.5 * n_old:           # a new season has started: last season's final ratings become the starting point
            season_prior = {key(t["name"]): t["rating"] for t in old["teams"]}
        t, hfa = records(rows, k, hw, games if feed["meta"][lg].get("final") else None, season_prior)
        out["leagues"][lg] = dict(name=lg.upper(), teams=t, hfa=hfa, prior=season_prior, season=feed["meta"][lg]["season"], sport={"mlb": "baseball", "nba": "basketball", "nhl": "hockey"}[lg],
                                  method=f"Team strength from {note}, pulled toward average to account for luck ({k} games' worth), plus home advantage ({hw:.1%} home win rate).")
    for lg in out["leagues"].values():
        lg["teams"].sort(key=lambda x: -x["rating"])
    add_logos(out, prev_lg, use_espn)
    return out

def attach_models(s, models):
    """ratings from the models' game-by-game Elo (records stay from the standings), plus a summary for the app"""
    for lg, M in models.items():
        L = s["leagues"].get(lg); st = {key(n): v for n, v in M["state"].items()}
        if not L: continue
        for t in L["teams"]:
            v = st.get(key(t["name"])) or next((x for k, x in st.items() if k.endswith(" " + key(t["name"]).split(" ")[-1]) and len(key(t["name"]).split()) == 1), None)
            if v: t["rating"] = round(v["elo"], 1)
        L["teams"].sort(key=lambda x: -x["rating"])
        m = M["model"]; L["hfa"] = m["hfa_elo"]
        full = m["backtest"].get("Full model (all factors)", {})
        L["model_summary"] = dict(games=m["games"], seasons=m["seasons"], test_games=m["test_games"], acc=full.get("acc"), factors=len(m["feats"]))
        names = [m["labels"][k].split(" (")[0].lower() for k in m["feats"]] + ["home advantage"]
        L["method"] = f"A {len(names)}-factor model ({', '.join(names[:-1])} and {names[-1]}) built from {m['games']:,} games ({m['seasons']}) and tested on seasons it never saw."

SOURCES = {"nfl.csv": "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"}
EPL_SEASONS = 5

def epl_urls(today=None):
    today = today or dt.date.today()
    last = today.year if today.month >= 7 else today.year - 1        # season that started most recently
    return {f"epl{y}-{str(y + 1)[2:]}.json": f"https://raw.githubusercontent.com/openfootball/football.json/master/{y}-{str(y + 1)[2:]}/en.1.json"
            for y in range(last - EPL_SEASONS + 1, last + 1)}

def download(folder):
    import os, urllib.request
    os.makedirs(folder, exist_ok=True)
    got = {}
    for name, url in {**SOURCES, **epl_urls()}.items():
        path = os.path.join(folder, name)
        try:
            urllib.request.urlretrieve(url, path); got[name] = path
        except Exception as e:
            print(f"couldn't download {name} ({e})" + ("; using the saved copy" if os.path.exists(path) else ""))
            if os.path.exists(path): got[name] = path
    return got

if __name__ == "__main__":
    import os, sys
    here = os.path.dirname(os.path.abspath(__file__))
    folder = os.path.join(here, "data", "sports")
    files = download(folder) if "--download" in sys.argv else {n: os.path.join(folder, n) for n in os.listdir(folder)} if os.path.isdir(folder) else {}
    out_path = os.path.join(here, "sports.json")
    prev = json.load(open(out_path)) if os.path.exists(out_path) else None
    epl_files = sorted(p for n, p in files.items() if n.startswith("epl"))
    s = build(feed_path=os.path.join(here, "data", "standings_feed.json"), nfl_csv=files.get("nfl.csv"), epl_files=epl_files, previous=prev, use_espn="--espn" in sys.argv)
    # the multi-factor models: game-by-game history for every league, fitted, tested and exported for the app
    try:
        import glob, team_history, team_models as tm
        hist = team_history.update() if "--download" in sys.argv else {lg: sorted(p for p in glob.glob(os.path.join(here, "data", "history", f"{lg}_*.csv")) if re.search(r"_\d{4}\.csv$", p)) for lg in ("mlb", "nhl", "nba", "epl")}
        models = {}
        for lg in ("nfl", "nba", "mlb", "nhl", "epl"):
            try:
                G = tm.load(lg, hist.get(lg), nfl_csv=files.get("nfl.csv"))
                if len(G) < 600: print(f"{lg}: not enough history for the model ({len(G)} games)"); continue
                models[lg] = tm.build_league(lg, G)
            except Exception as e:
                import traceback; traceback.print_exc(); print(f"{lg}: model skipped ({e})")
        attach_models(s, models)
        os.makedirs(os.path.join(here, "docs"), exist_ok=True)
        with open(os.path.join(here, "docs", "models.json"), "w") as fh: json.dump(models, fh, separators=(",", ":"), default=lambda o: o.item() if hasattr(o, "item") else str(o))
        for lg, M in models.items():
            m = M["model"]; print(f"  {lg} model: {m['games']} games ({m['seasons']}), factors {m['feats']}")
            for k, v in m["backtest"].items(): print(f"     {k:32s} {v}")
    except Exception as e:
        import traceback; traceback.print_exc(); print(f"Models skipped ({e}); predictions stay on Elo")
    open(out_path, "w").write(json.dumps(s, separators=(",", ":")))
    print(f"sports.json written ({len(s['leagues'])} leagues)")
    json.dump(s, open("sports.json", "w"), separators=(",", ":"))
    for k, v in s["leagues"].items():
        print(f"{v['name']:15s} {len(v['teams'])} teams | top 3: {[ (t['name'], round(t['rating'])) for t in v['teams'][:3]]}")
        if "backtest" in v: print("   backtest:", v["backtest"])
