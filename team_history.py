"""
Game-by-game history for the team leagues, the raw material for the prediction models in sports_engine.py.
Each league's seasons are saved as small CSV files in data/history/. A finished season is downloaded once and kept;
the current season is refreshed every night.

* MLB: every regular-season game from MLB's Stats API, with both starting pitchers.
* NHL: every regular-season game from the NHL's stats API, with each team's shots.
* NBA: every game from ESPN's scoreboard, with each team's shooting and rebounding.
* Premier League: every match from football-data.co.uk, with shots, shots on target, corners and closing odds.
* NFL: nflverse's games file (scores, rest, divisions, quarterbacks, betting lines) is read directly by sports_engine.py.
"""
import csv, datetime as dt, json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = os.path.join(HERE, "data", "history")
UA = {"User-Agent": "Mozilla/5.0 (Cosmo Sports nightly build)"}

def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 + 3 * i)

def jget(url): return json.loads(get(url))

def save(path, head, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(head); w.writerows(rows)
    return len(rows)

# ------------------------------------------------------------------ MLB
MLB_HEAD = ["date", "id", "home", "away", "hs", "as", "hsp", "hsp_name", "asp", "asp_name", "dh", "venue"]
def mlb(season):
    f = ("dates,date,games,gamePk,officialDate,status,codedGameState,teams,away,home,team,name,score,probablePitcher,id,fullName,"
         "doubleHeader,gameNumber,venue")
    d = jget(f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&season={season}&gameType=R&hydrate=probablePitcher&fields={f}")
    rows = []
    for day in d.get("dates", []):
        for g in day.get("games", []):
            if (g.get("status") or {}).get("codedGameState") != "F": continue
            h, a = g["teams"]["home"], g["teams"]["away"]
            if h.get("score") is None or a.get("score") is None: continue
            hp, ap = h.get("probablePitcher") or {}, a.get("probablePitcher") or {}
            rows.append([g.get("officialDate") or day["date"], g["gamePk"], h["team"]["name"], a["team"]["name"], h["score"], a["score"],
                         hp.get("id", ""), hp.get("fullName", ""), ap.get("id", ""), ap.get("fullName", ""), g.get("gameNumber", 1), (g.get("venue") or {}).get("id", "")])
    return rows

# ------------------------------------------------------------------ NHL
NHL_HEAD = ["date", "id", "home", "away", "hs", "as", "ot", "hsog", "asog", "hpp", "app"]
def nhl(season):
    sid = f"{season}{season + 1}"
    teams = {t["id"]: t["fullName"] for t in jget("https://api.nhle.com/stats/rest/en/team")["data"]}
    games = jget(f"https://api.nhle.com/stats/rest/en/game?cayenneExp=season={sid}%20and%20gameType=2")["data"]
    stats = {}
    start = 0
    while True:                                   # every team's shots and power plays, game by game
        page = jget("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=true&start=%d&limit=1000"
                    "&cayenneExp=seasonId=%s%%20and%%20gameTypeId=2" % (start, sid))
        data = page.get("data", [])
        for r in data: stats[(r["gameId"], r["teamId"])] = r
        start += len(data)
        if not data or start >= page.get("total", 0): break
    rows = []
    for g in games:
        if g.get("gameStateId") not in (7, None) and g.get("homeScore") is None: continue
        if g.get("homeScore") is None or g.get("visitingScore") is None: continue
        h, a = stats.get((g["id"], g["homeTeamId"]), {}), stats.get((g["id"], g["visitingTeamId"]), {})
        sog = lambda r: r.get("shotsForPerGame") if r.get("shotsForPerGame") is not None else ""
        pp = lambda r: r.get("powerPlayGoalsFor", "")
        rows.append([g["gameDate"][:10], g["id"], teams.get(g["homeTeamId"], g["homeTeamId"]), teams.get(g["visitingTeamId"], g["visitingTeamId"]),
                     g["homeScore"], g["visitingScore"], 1 if (g.get("period") or 3) > 3 else 0, sog(h), sog(a), pp(h), pp(a)])
    rows.sort()
    return rows

# ------------------------------------------------------------------ NBA
NBA_HEAD = ["date", "id", "home", "away", "hs", "as", "type", "hfg", "afg", "h3", "a3", "hreb", "areb", "hto", "ato", "spread", "total", "hml", "aml"]
def alerts_url():
    try: return json.load(open(os.path.join(HERE, "site_config.json"))).get("alerts_url", "").rstrip("/")
    except Exception: return ""
def nba(season):
    """season = the year it starts (2024 means 2024-25). ESPN's scoreboard a week at a time; if ESPN turns this computer
    away, our alerts service (which reads the same scoreboard) a day at a time."""
    try:
        return nba_espn(season)
    except urllib.error.HTTPError as e:
        if e.code != 403 or not alerts_url(): raise
    return nba_alerts(season)
def nba_alerts(season):
    base, rows, seen = alerts_url(), [], set()
    d, end = dt.date(season, 10, 18), min(dt.date(season + 1, 6, 25), dt.date.today() - dt.timedelta(days=1))
    while d <= end:
        try: js = jget(f"{base}/sports/nba/scoreboard?dates={d:%Y%m%d}")
        except Exception as ex: print("  nba day", d, ex); d += dt.timedelta(days=1); continue
        for g in js.get("games", []):
            if g["id"] in seen or (g.get("status") or {}).get("state") != "post": continue
            h, a = g["home"], g["away"]
            if h.get("score") in (None, "") or a.get("score") in (None, ""): continue
            o = g.get("odds") or {}; seen.add(g["id"])
            rows.append([(g.get("date") or str(d))[:10], g["id"], h["name"], a["name"], h["score"], a["score"], "", "", "", "", "", "", "", "", "",
                         "", o.get("overUnder") or "", o.get("homeML") or "", o.get("awayML") or ""])
        d += dt.timedelta(days=1); time.sleep(.15)
    # preseason and exhibition teams drop out: keep teams that play a full schedule
    from collections import Counter
    n = Counter([r[2] for r in rows] + [r[3] for r in rows])
    rows = [r for r in rows if n[r[2]] >= 40 and n[r[3]] >= 40]
    rows.sort()
    return rows
def nba_espn(season):
    start, end = dt.date(season, 10, 1), dt.date(season + 1, 6, 30)
    rows, seen = [], set()
    d = start
    while d <= end and d <= dt.date.today():
        e = min(end, d + dt.timedelta(days=6))
        try: js = jget(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={d:%Y%m%d}-{e:%Y%m%d}&limit=300")
        except urllib.error.HTTPError as ex:
            if ex.code == 403: raise
            print("  nba week", d, ex); d = e + dt.timedelta(days=1); continue
        except Exception as ex: print("  nba week", d, ex); d = e + dt.timedelta(days=1); continue
        for ev in js.get("events", []):
            if ev["id"] in seen: continue
            comp = ev["competitions"][0]
            if not comp.get("status", {}).get("type", {}).get("completed"): continue
            typ = (ev.get("season") or {}).get("type", 2)
            if typ not in (2, 3): continue
            side = {c["homeAway"]: c for c in comp["competitors"]}
            if "home" not in side or "away" not in side: continue
            st = lambda c, k: next((s.get("displayValue") for s in c.get("statistics", []) if s.get("name") == k), "")
            odds = (comp.get("odds") or [{}])[0]
            seen.add(ev["id"])
            rows.append([ev["date"][:10], ev["id"], side["home"]["team"]["displayName"], side["away"]["team"]["displayName"], side["home"].get("score"), side["away"].get("score"), typ,
                         st(side["home"], "fieldGoalPct"), st(side["away"], "fieldGoalPct"), st(side["home"], "threePointFieldGoalPct"), st(side["away"], "threePointFieldGoalPct"),
                         st(side["home"], "rebounds"), st(side["away"], "rebounds"), st(side["home"], "turnovers"), st(side["away"], "turnovers"),
                         odds.get("spread", ""), odds.get("overUnder", ""), (odds.get("homeTeamOdds") or {}).get("moneyLine", ""), (odds.get("awayTeamOdds") or {}).get("moneyLine", "")])
        d = e + dt.timedelta(days=1); time.sleep(.3)
    rows.sort()
    return rows

# ------------------------------------------------------------------ Premier League
EPL_COLS = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "HS", "AS", "HST", "AST", "HC", "AC", "HY", "AY", "HR", "AR",
            "B365H", "B365D", "B365A", "PSCH", "PSCD", "PSCA", "AvgCH", "AvgCD", "AvgCA", "AvgH", "AvgD", "AvgA", "B365>2.5", "B365<2.5", "AvgC>2.5", "AvgC<2.5"]
EPL_HEAD = ["date", "home", "away", "hg", "ag", "hs", "as_", "hst", "ast", "hc", "ac", "hy", "ay", "hr", "ar", "odds_h", "odds_d", "odds_a", "o25", "u25"]
def epl(season):
    yy = f"{season % 100:02d}{(season + 1) % 100:02d}"
    raw = get(f"https://www.football-data.co.uk/mmz4281/{yy}/E0.csv").decode("utf-8-sig", "replace").splitlines()
    rows = []
    for r in csv.DictReader(raw):
        if not r.get("HomeTeam") or r.get("FTHG") in (None, ""): continue
        dd, mm, y = r["Date"].split("/"); y = ("20" + y) if len(y) == 2 else y
        # closing odds from the first bookmaker with all three prices: Pinnacle, then the market average, then Bet365
        oh, od, oa = next(((r[h], r[d_], r[a]) for h, d_, a in (("PSCH", "PSCD", "PSCA"), ("AvgCH", "AvgCD", "AvgCA"), ("B365H", "B365D", "B365A"))
                           if r.get(h) and r.get(d_) and r.get(a)), ("", "", ""))
        rows.append([f"{y}-{mm}-{dd}", r["HomeTeam"], r["AwayTeam"], r["FTHG"], r["FTAG"], r.get("HS", ""), r.get("AS", ""), r.get("HST", ""), r.get("AST", ""),
                     r.get("HC", ""), r.get("AC", ""), r.get("HY", ""), r.get("AY", ""), r.get("HR", ""), r.get("AR", ""), oh, od, oa,
                     r.get("AvgC>2.5") or r.get("B365>2.5") or "", r.get("AvgC<2.5") or r.get("B365<2.5") or ""])
    rows.sort()
    return rows

LEAGUES = {"mlb": (mlb, MLB_HEAD), "nhl": (nhl, NHL_HEAD), "nba": (nba, NBA_HEAD), "epl": (epl, EPL_HEAD)}

def current_season(lg, today=None):
    t = today or dt.date.today()
    if lg == "mlb": return t.year
    return t.year if t.month >= (8 if lg == "epl" else 9) else t.year - 1        # the season that started most recently

def update(leagues=("mlb", "nhl", "nba", "epl"), back=None, folder=FOLDER, today=None):
    """Download missing seasons and refresh the current one. Returns {league: [csv paths]}."""
    back = back or {"mlb": 5, "nhl": 5, "nba": 5, "epl": 9}
    out = {}
    for lg in leagues:
        fn, head = LEAGUES[lg]; cur = current_season(lg, today); paths = []
        for season in range(cur - back[lg], cur + 1):
            path = os.path.join(folder, f"{lg}_{season}.csv")
            if os.path.exists(path) and season < cur and os.path.getsize(path) > 2000: paths.append(path); continue
            try:
                n = save(path, head, fn(season)); print(f"  {lg} {season}: {n} games")
                if n: paths.append(path)
                elif os.path.exists(path): os.remove(path)
            except Exception as e:
                print(f"  {lg} {season}: unavailable ({e})" + ("; keeping the saved copy" if os.path.exists(path) else ""))
                if os.path.exists(path): paths.append(path)
        out[lg] = paths
    return out

if __name__ == "__main__":
    folder = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else FOLDER
    lgs = [a for a in sys.argv[1:] if a in LEAGUES] or list(LEAGUES)
    print(json.dumps(update(lgs, folder=folder), indent=1))
