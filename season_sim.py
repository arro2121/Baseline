"""
Season simulations: every team's playoff, division and title chances, from the same models that predict each game.

The rest of each league's season is played out 10,000 times. Every game is decided by the model's win chance (docs/models.json),
and each simulated season gives every team a random shift in strength, so the uncertainty about how good a team really is grows
with the games still to play. The real playoff formats are then played out: NFL (7 per conference, top seed gets a bye), MLB (6 per
league, best-of-3/5/7/7), NHL (top 3 per division plus 2 wildcards, best-of-7), NBA (play-in for seeds 7-10, best-of-7), and for the
Premier League the title, the top four and relegation.

Also worked out for each team: luck (wins above what its points scored and allowed usually bring), the strength of the schedule
still to play, and what its next game is worth. For each league, the week's games that swing the most playoff chances.

Writes docs/sim.json and keeps a daily history in data/sim_history/ for the odds-over-time charts.
Run after sports_engine.py (which rebuilds docs/models.json): python season_sim.py [nfl mlb ...]
"""
import json, math, os, sys, datetime as dt
from collections import defaultdict
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
N, CHUNK = 10000, 2500
SIGMA = {"nfl": .32, "nba": .28, "mlb": .14, "nhl": .16, "epl": .16}           # spread of true strength around the rating (log-odds)
PYTH = {"nfl": 2.37, "nba": 14.0, "mlb": 1.83, "nhl": 2.05}
OT_SHARE = .23                                                                 # NHL games that reach overtime (the loser still gets a point)

# ------------------------------------------------------------------ league structure (current alignment)
NFL = {"AFC": {"East": "BUF MIA NE NYJ", "North": "BAL CIN CLE PIT", "South": "HOU IND JAX TEN", "West": "DEN KC LV LAC"},
       "NFC": {"East": "DAL NYG PHI WAS", "North": "CHI DET GB MIN", "South": "ATL CAR NO TB", "West": "ARI LA SF SEA"}}
MLB = {"AL": {"East": ["Baltimore Orioles", "Boston Red Sox", "New York Yankees", "Tampa Bay Rays", "Toronto Blue Jays"],
              "Central": ["Chicago White Sox", "Cleveland Guardians", "Detroit Tigers", "Kansas City Royals", "Minnesota Twins"],
              "West": ["Athletics", "Houston Astros", "Los Angeles Angels", "Seattle Mariners", "Texas Rangers"]},
       "NL": {"East": ["Atlanta Braves", "Miami Marlins", "New York Mets", "Philadelphia Phillies", "Washington Nationals"],
              "Central": ["Chicago Cubs", "Cincinnati Reds", "Milwaukee Brewers", "Pittsburgh Pirates", "St. Louis Cardinals"],
              "West": ["Arizona Diamondbacks", "Colorado Rockies", "Los Angeles Dodgers", "San Diego Padres", "San Francisco Giants"]}}
NHL = {"East": {"Atlantic": ["Boston Bruins", "Buffalo Sabres", "Detroit Red Wings", "Florida Panthers", "Montréal Canadiens", "Ottawa Senators", "Tampa Bay Lightning", "Toronto Maple Leafs"],
                "Metropolitan": ["Carolina Hurricanes", "Columbus Blue Jackets", "New Jersey Devils", "New York Islanders", "New York Rangers", "Philadelphia Flyers", "Pittsburgh Penguins", "Washington Capitals"]},
       "West": {"Central": ["Chicago Blackhawks", "Colorado Avalanche", "Dallas Stars", "Minnesota Wild", "Nashville Predators", "St. Louis Blues", "Utah Mammoth", "Winnipeg Jets"],
                "Pacific": ["Anaheim Ducks", "Calgary Flames", "Edmonton Oilers", "Los Angeles Kings", "San Jose Sharks", "Seattle Kraken", "Vancouver Canucks", "Vegas Golden Knights"]}}
NBA = {"East": {"Atlantic": ["Boston Celtics", "Brooklyn Nets", "New York Knicks", "Philadelphia 76ers", "Toronto Raptors"],
                "Central": ["Chicago Bulls", "Cleveland Cavaliers", "Detroit Pistons", "Indiana Pacers", "Milwaukee Bucks"],
                "Southeast": ["Atlanta Hawks", "Charlotte Hornets", "Miami Heat", "Orlando Magic", "Washington Wizards"]},
       "West": {"Northwest": ["Denver Nuggets", "Minnesota Timberwolves", "Oklahoma City Thunder", "Portland Trail Blazers", "Utah Jazz"],
                "Pacific": ["Golden State Warriors", "LA Clippers", "Los Angeles Lakers", "Phoenix Suns", "Sacramento Kings"],
                "Southwest": ["Dallas Mavericks", "Houston Rockets", "Memphis Grizzlies", "New Orleans Pelicans", "San Antonio Spurs"]}}

def key(n):
    import re, unicodedata
    n = unicodedata.normalize("NFKD", str(n)).encode("ascii", "ignore").decode().lower().replace("&", " and ")
    n = re.sub(r"\b(fc|afc)\b", " ", n)
    return re.sub(r"[^a-z0-9]+", " ", n).strip()

def resolver(names):
    """Match a feed's team name to the model's."""
    by = {key(n): n for n in names}
    def f(n):
        k = key(n)
        if k in by: return by[k]
        for kk, v in by.items():
            if kk.endswith(" " + k) or k.endswith(" " + kk) or kk.startswith(k + " ") or k.startswith(kk + " "): return v
        return None
    return f

# ------------------------------------------------------------------ the game model (mirrors the app's modelPredict, at full rest)
SHRINK = {"nfl": 4, "nba": 10, "mlb": 20, "nhl": 10, "epl": 6}                  # games' worth of league-average scoring added to each team's rate
def logit_matrix(M, names, lg=None, gp=None):
    """Home team i vs away team j: log-odds of a home win (logistic leagues) or both teams' expected goals (Poisson).
    Over a whole season, a few games' scoring rates are pulled toward the league average (a team that scored once in five
    matches won't keep scoring 0.07 a game)."""
    m, st = M["model"], M["state"]
    if lg and gp is not None:
        k, avg0 = SHRINK[lg], m["lg_avg"]; st = dict(st)
        for n in names:
            g = gp.get(n, 0); s0 = dict(st[n])
            for f in ("pf", "pa"):
                if s0.get(f) is not None: s0[f] = (s0[f] * g + avg0 * k) / (g + k)
            st[n] = s0
    avg = m["lg_avg"]; mean = lambda a: sum(a) / len(a) if a else .5
    share = lambda s, k: (s.get("x") or {}).get(k) if (s.get("x") or {}).get(k) is not None else .5
    T = len(names); L = np.zeros((T, T)); LN = np.zeros((T, T)); LH = np.zeros((T, T)); LA = np.zeros((T, T))
    def x_of(H, A, home):
        return dict(home=home, elo_d=H["elo"] - A["elo"], mov_d=H["mov"] - A["mov"], form_d=mean(H.get("form")) - mean(A.get("form")), rest_d=0,
                    b2b_h=0, b2b_a=0, sp_d=0, qb_d=0, shots_d=share(H, "shots_share") - share(A, "shots_share"), sot_d=share(H, "sot_share") - share(A, "sot_share"),
                    fg_d=share(H, "fg_share") - share(A, "fg_share"), pf_h=avg if H.get("pf") is None else H["pf"], pa_h=avg if H.get("pa") is None else H["pa"],
                    pf_a=avg if A.get("pf") is None else A["pf"], pa_a=avg if A.get("pa") is None else A["pa"])
    z = lambda x, k: (x[k] - m["mean"][k]) / m["sd"][k]
    for i, h in enumerate(names):
        for j, a in enumerate(names):
            if i == j: continue
            H, A = st[h], st[a]
            for home, out in ((1, L), (0, LN)):
                x = x_of(H, A, home)
                if m["kind"] == "poisson":
                    def lam(P, sign, pf, pa): return math.exp(P["intercept"] + sum(c * v for c, v in zip(P["coef"], [z(x, k) * sign for k in m["feats"]] + [math.log(max(.14, pf)), math.log(max(.14, pa))])))
                    lh, la = lam(m["home_goals"], 1, x["pf_h"], x["pa_a"]), lam(m["away_goals"], -1, x["pf_a"], x["pa_h"])
                    if home: LH[i, j], LA[i, j] = lh, la
                    out[i, j] = math.log(lh / la)
                else:
                    out[i, j] = m["coef"]["home"] * x["home"] + sum(m["coef"][k] * z(x, k) for k in m["feats"])
    return L, LN, LH, LA

sig = lambda v: 1 / (1 + np.exp(-v))
def series(p, n):
    """Chance of winning a best-of-n series with game chance p."""
    need = n // 2 + 1; out = np.zeros_like(p)
    for k in range(need): out += math.comb(need - 1 + k, k) * p ** need * (1 - p) ** k
    return out

# ------------------------------------------------------------------ schedules: games played and still to play
def get_json(url):
    import urllib.request
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Cosmo Sports nightly build)"}), timeout=90) as r:
        return json.loads(r.read())

def sched_nfl(names, season):
    from team_models import NFL_NAMES
    g = pd.read_csv(os.path.join(HERE, "data", "sports", "nfl.csv"), low_memory=False)
    g = g[(g.season == season) & (g.game_type == "REG")]
    fr = {"OAK": "LV", "SD": "LAC", "STL": "LA"}
    nm = lambda a: NFL_NAMES.get(fr.get(a, a))
    played, left = [], []
    for r in g.itertuples():
        h, a = nm(r.home_team), nm(r.away_team)
        if not h or not a: continue
        if pd.isna(r.home_score): left.append(dict(h=h, a=a, date=str(r.gameday), neutral=str(r.location) == "Neutral"))
        else: played.append(dict(h=h, a=a, hs=int(r.home_score), as_=int(r.away_score), date=str(r.gameday)))
    return played, left

def sched_mlb(names, season):
    res = resolver(names)
    d = get_json(f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&season={season}&gameType=R&fields=dates,date,games,gamePk,gameDate,officialDate,status,abstractGameState,detailedState,teams,home,away,team,name,score")
    games = {}
    for day in d.get("dates", []):
        for x in day.get("games", []):
            games.setdefault(x["gamePk"], []).append(x)
    played, left = [], []
    for pk, xs in games.items():
        done = [x for x in xs if x["status"]["abstractGameState"] == "Final" and x["teams"]["home"].get("score") is not None and "Postpon" not in x["status"].get("detailedState", "")]
        x = done[-1] if done else sorted(xs, key=lambda y: y.get("gameDate", ""))[-1]
        h, a = res(x["teams"]["home"]["team"]["name"]), res(x["teams"]["away"]["team"]["name"])
        if not h or not a: continue
        date = x.get("officialDate") or x["gameDate"][:10]
        if done: played.append(dict(h=h, a=a, hs=x["teams"]["home"]["score"], as_=x["teams"]["away"]["score"], date=date))
        elif "Cancel" not in x["status"].get("detailedState", ""): left.append(dict(h=h, a=a, date=date, neutral=False))
    return played, left

def sched_nhl(names, season):
    res = resolver(names); sid = f"{season}{season + 1}"
    teams = {t["id"]: t["fullName"] for t in get_json("https://api.nhle.com/stats/rest/en/team")["data"]}
    played, left = [], []
    for x in get_json(f"https://api.nhle.com/stats/rest/en/game?cayenneExp=season={sid}%20and%20gameType=2")["data"]:
        h, a = res(teams.get(x["homeTeamId"], "")), res(teams.get(x["visitingTeamId"], ""))
        if not h or not a: continue
        if x.get("gameStateId") == 7 and x.get("homeScore") is not None:
            played.append(dict(h=h, a=a, hs=x["homeScore"], as_=x["visitingScore"], ot=(x.get("period") or 3) > 3, date=x["gameDate"][:10]))
        else: left.append(dict(h=h, a=a, date=x["gameDate"][:10], neutral=False))
    return played, left

def sched_nba(names, season):
    """The whole regular season: ESPN's scoreboard (a month at a time), or, when ESPN turns this computer away (it does for
    GitHub's), the same scoreboard through our alerts service a day at a time. Preseason and playoff games are left out."""
    res = resolver(names)
    from team_history import alerts_url
    base = alerts_url()
    first, last = dt.date(season, 10, 1), dt.date(season + 1, 4, 30)
    games = {}
    def norm_espn(e):
        c = e["competitions"][0]; side = lambda k: next(x for x in c["competitors"] if x["homeAway"] == k)
        return dict(id=e["id"], date=e["date"], stype=(e.get("season") or {}).get("type"), neutral=c.get("neutralSite", False), state=e["status"]["type"]["state"],
                    completed=e["status"]["type"].get("completed"), home=dict(name=side("home")["team"]["displayName"], score=side("home").get("score")),
                    away=dict(name=side("away")["team"]["displayName"], score=side("away").get("score")))
    try:
        d0 = first
        while d0 <= last:
            d1 = min(last, (d0.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1))
            for e in get_json(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={d0:%Y%m%d}-{d1:%Y%m%d}&limit=1000").get("events", []):
                x = norm_espn(e); games[x["id"]] = x
            d0 = d1 + dt.timedelta(days=1)
        if len(games) < 1000: raise RuntimeError("ESPN ignored the date range")
    except Exception:
        if not base: raise
        games = {}
        from concurrent.futures import ThreadPoolExecutor
        def day(d):
            for i in range(3):
                try: return get_json(f"{base}/sports/nba/scoreboard?dates={d:%Y%m%d}").get("games", [])
                except Exception:
                    if i == 2: return None
        days = [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]
        with ThreadPoolExecutor(8) as ex:
            got = list(ex.map(day, days))
        if sum(g is None for g in got) > 10: raise RuntimeError(f"{sum(g is None for g in got)} NBA days didn't load")
        for gs in got:
            for g in gs or []:
                games[g["id"]] = dict(id=g["id"], date=g["date"], stype=g.get("stype"), neutral=g.get("neutral", False), state=g["status"]["state"],
                                      completed=g["status"].get("completed"), home=g["home"], away=g["away"])
    games = {k: x for k, x in games.items() if x["stype"] in (2, "2")}
    played, left = [], []
    for x in games.values():
        h, a = res(x["home"]["name"]), res(x["away"]["name"])
        if not h or not a: continue
        try: date = (dt.datetime.fromisoformat(str(x["date"]).replace("Z", "+00:00")) - dt.timedelta(hours=5)).date().isoformat()     # US Eastern game day
        except ValueError: date = str(x["date"])[:10]
        if x["state"] == "post" and x["completed"] and x["home"].get("score") not in (None, ""):
            played.append(dict(h=h, a=a, hs=int(float(x["home"]["score"])), as_=int(float(x["away"]["score"])), date=date))
        elif x["state"] != "post": left.append(dict(h=h, a=a, date=date, neutral=bool(x["neutral"])))
    if len(played) + len(left) < 1000: raise RuntimeError(f"only {len(played) + len(left)} NBA games found")
    return played, left

def sched_epl(names, season):
    res = resolver(names)
    f = os.path.join(HERE, "data", "sports", f"epl{season}-{str(season + 1)[2:]}.json")
    from team_models import EPL_NAMES
    played, left, seen = [], [], set()
    fd = os.path.join(HERE, "data", "history", f"epl_{season}.csv")                # results: football-data (updated every night)
    if os.path.exists(fd):
        for r in pd.read_csv(fd).itertuples():
            h, a = res(EPL_NAMES.get(r.home, r.home)), res(EPL_NAMES.get(r.away, r.away))
            if h and a and not pd.isna(r.hg): played.append(dict(h=h, a=a, hs=int(r.hg), as_=int(r.ag), date=str(r.date))); seen.add((h, a))
    for x in json.load(open(f))["matches"]:                                        # fixtures: openfootball (each pairing once at each ground)
        h, a = res(x["team1"]), res(x["team2"])
        if not h or not a or (h, a) in seen: continue
        ft = (x.get("score") or {}).get("ft") if isinstance(x.get("score"), dict) else None
        if ft: played.append(dict(h=h, a=a, hs=ft[0], as_=ft[1], date=x["date"])); seen.add((h, a))
        else: left.append(dict(h=h, a=a, date=x["date"], neutral=False))
    return played, left

def season_of(lg, today):
    if lg in ("mlb", "nfl"): return today.year if (lg == "mlb" or today.month >= 8) else today.year - 1
    return today.year if today.month >= 7 else today.year - 1

# ------------------------------------------------------------------ the simulation
def structure(lg, names):
    """(conference, division) for each team."""
    if lg == "nfl":
        from team_models import NFL_NAMES
        return {NFL_NAMES[t]: (c, f"{c} {d}") for c, ds in NFL.items() for d, ts in ds.items() for t in ts.split()}
    if lg == "epl": return {n: ("Premier League", "Premier League") for n in names}
    S = {"mlb": MLB, "nhl": NHL, "nba": NBA}[lg]
    return {t: (c, f"{c} {d}" if lg == "mlb" else d) for c, ds in S.items() for d, ts in ds.items() for t in ts}

def rank_within(score, members):
    """For each simulated season, the teams in `members` ordered best first. score: [n, T] (bigger is better, no exact ties)."""
    sub = score[:, members]
    return np.asarray(members)[np.argsort(-sub, axis=1)]

def simulate(lg, M, played, left, today, rng):
    names = sorted(M["state"]); idx = {n: i for i, n in enumerate(names)}; T = len(names)
    struct = structure(lg, names)
    names = [n for n in names if n in struct]; idx = {n: i for i, n in enumerate(names)}; T = len(names)
    played = [g for g in played if g["h"] in idx and g["a"] in idx]; left = [g for g in left if g["h"] in idx and g["a"] in idx]
    gpn = defaultdict(int)
    for g in played: gpn[g["h"]] += 1; gpn[g["a"]] += 1
    L, LN, LH, LA = logit_matrix(M, names, lg, gpn)
    soccer = lg == "epl"
    # standings so far
    W = np.zeros(T); Lo = np.zeros(T); D = np.zeros(T); OTL = np.zeros(T); PF = np.zeros(T); PA = np.zeros(T); GP = np.zeros(T)
    for g in played:
        h, a = idx[g["h"]], idx[g["a"]]; hs, as_ = g["hs"], g["as_"]
        PF[h] += hs; PA[h] += as_; PF[a] += as_; PA[a] += hs; GP[h] += 1; GP[a] += 1
        if hs > as_: W[h] += 1; Lo[a] += 1; OTL[a] += bool(g.get("ot"))
        elif as_ > hs: W[a] += 1; Lo[h] += 1; OTL[h] += bool(g.get("ot"))
        else: D[h] += 1; D[a] += 1
    Lo -= OTL                                                                # NHL: regulation losses and OT/shootout losses apart
    G = len(left)
    gh = np.array([idx[g["h"]] for g in left], dtype=int); ga = np.array([idx[g["a"]] for g in left], dtype=int)
    neutral = np.array([bool(g.get("neutral")) for g in left])
    base = np.where(neutral, LN[gh, ga], L[gh, ga]) if G else np.zeros(0)
    Hm = np.zeros((G, T)); Am = np.zeros((G, T))
    if G: Hm[np.arange(G), gh] = 1; Am[np.arange(G), ga] = 1
    frac = G / max(1, G + len(played))
    sd = SIGMA[lg] * math.sqrt(.25 + .75 * frac)                            # more games left, more room for surprises
    conf_of = {n: struct[n][0] for n in names}; div_of = {n: struct[n][1] for n in names}
    confs = sorted(set(conf_of.values())); divs = sorted(set(div_of.values()))
    cm = {c: [idx[n] for n in names if conf_of[n] == c] for c in confs}; dm = {d: [idx[n] for n in names if div_of[n] == d] for d in divs}
    acc = defaultdict(lambda: np.zeros(T)); cnt = defaultdict(float); wins_all, metric_all, next_out = [], [], []
    upcoming = sorted([i for i, g in enumerate(left) if g["date"] >= today.isoformat()], key=lambda i: left[i]["date"])
    week = [i for i in upcoming if left[i]["date"] <= (today + dt.timedelta(days=7)).isoformat()][:80]
    nxt = {}
    for i in upcoming:
        for t in (gh[i], ga[i]): nxt.setdefault(t, i)
    watch = sorted(set(week) | set(nxt.values()))
    for s0 in range(0, N, CHUNK):
        n = min(CHUNK, N - s0)
        eps = rng.normal(0, sd, (n, T))
        if soccer:
            lh = np.where(neutral, np.exp(LN[gh, ga] / 2), LH[gh, ga]) if G else np.zeros(0)
            la = np.where(neutral, np.exp(-LN[gh, ga] / 2), LA[gh, ga]) if G else np.zeros(0)
            sh = np.exp((eps[:, gh] - eps[:, ga]) / 2)
            hg = rng.poisson(lh * sh); ag = rng.poisson(la / sh)
            hw = hg > ag; aw = ag > hg; dr = ~hw & ~aw
            w = W + hw @ Hm + aw @ Am; d = D + dr @ Hm + dr @ Am
            gd = (PF - PA) + (hg - ag) @ Hm + (ag - hg) @ Am; gf = PF + hg @ Hm + ag @ Am
            pts = 3 * w + d; score = pts * 1e6 + (gd + 500) * 1e3 + gf + rng.random((n, T)) * .5
            l = (GP + Hm.sum(0) + Am.sum(0)) - w - d
            acc["w"] += w.sum(0); acc["d"] += d.sum(0); acc["l"] += l.sum(0); acc["pts"] += pts.sum(0); acc["gd"] += gd.sum(0)
            order = rank_within(score, list(range(T)))
            pos = np.empty_like(order); pos[np.arange(n)[:, None], order] = np.arange(T)[None, :]
            m_title, m_top4, m_rel = pos == 0, pos < 4, pos >= T - 3
            acc["title"] += m_title.sum(0); acc["top4"] += m_top4.sum(0); acc["rel"] += m_rel.sum(0)
            metric = {"title": m_title, "top4": m_top4, "rel": m_rel}
            outcome = np.where(hw, 1, np.where(aw, -1, 0)) if G else np.zeros((n, 0))
        else:
            p = sig(base[None, :] + eps[:, gh] - eps[:, ga]) if G else np.zeros((n, 0))
            hw = rng.random((n, G)) < p
            w = W + hw @ Hm + (~hw) @ Am
            l = Lo + (~hw) @ Hm + hw @ Am
            if lg == "nhl":
                ot = rng.random((n, G)) < OT_SHARE
                otl = OTL + (ot & ~hw) @ Hm + (ot & hw) @ Am; l = l - (otl - OTL)
                pts = 2 * w + otl; score = pts * 1e3 + w + rng.random((n, T)) * .5; acc["otl"] += otl.sum(0); acc["pts"] += pts.sum(0)
            else:
                score = (w + .5 * D) / np.maximum(1, w + l + D) * 1e3 + rng.random((n, T)) * .5
            acc["w"] += w.sum(0); acc["l"] += l.sum(0)
            res = playoffs(lg, score, eps, L, cm, dm, confs, divs, n, T, rng)
            for k, v in res.items(): acc[k] += v.sum(0)
            metric = {"playoff": res["playoff"], "title": res["title"]}
            outcome = np.where(hw, 1, -1)
        # what each watched game is worth: chances when the home side wins vs loses
        for i in watch:
            o = outcome[:, i]
            for mk, mv in metric.items():
                for side, sel in (("h", o == 1), ("a", o == -1), ("d", o == 0)):
                    acc[f"g{i}_{mk}_{side}"] += (mv[sel].sum(0) if sel.any() else 0)
                    cnt[f"g{i}_{side}"] += sel.sum() / len(metric)
    out_teams = []; lg_elo = float(np.mean([M["state"][x]["elo"] for x in names]))
    tot = lambda k: acc[k] / N
    for t, nme in enumerate(names):
        row = dict(name=nme, conf=conf_of[nme], div=div_of[nme], elo=round(M["state"][nme]["elo"], 1), gp=int(GP[t]), w=int(W[t]), l=int(Lo[t]))
        if soccer: row.update(d=int(D[t]), pts=int(3 * W[t] + D[t]), gd=int(PF[t] - PA[t]), proj_w=round(tot("w")[t], 1), proj_d=round(tot("d")[t], 1), proj_l=round(tot("l")[t], 1),
                              proj_pts=round(tot("pts")[t], 1), proj_gd=round(tot("gd")[t], 1), title=round(tot("title")[t], 4), top4=round(tot("top4")[t], 4), rel=round(tot("rel")[t], 4))
        else:
            row.update(proj_w=round(tot("w")[t], 1), proj_l=round(tot("l")[t], 1), playoff=round(tot("playoff")[t], 4), div_win=round(tot("div")[t], 4),
                       top=round(tot("top")[t], 4), final=round(tot("final")[t], 4), title=round(tot("title")[t], 4))
            if lg == "nhl": row.update(otl=int(OTL[t]), pts=int(2 * W[t] + OTL[t]), proj_otl=round(tot("otl")[t], 1), proj_pts=round(tot("pts")[t], 1))
            if lg == "nfl" and D[t]: row["t"] = int(D[t])
        # luck: wins above what the points scored and allowed usually bring
        if lg in PYTH and GP[t] >= 3 and PF[t] + PA[t] > 0:
            e = PYTH[lg]; exp_w = GP[t] * PF[t] ** e / (PF[t] ** e + PA[t] ** e)
            row["luck"] = round(W[t] + .5 * D[t] - exp_w, 1)
        opp = [(ga[i] if gh[i] == t else gh[i]) for i in range(G) if gh[i] == t or ga[i] == t]
        row["left"] = len(opp); row["sos"] = round(float(np.mean([M["state"][names[o]]["elo"] for o in opp])) - lg_elo, 1) if opp else None
        if t in nxt:
            i = nxt[t]; home = gh[i] == t; oi = ga[i] if home else gh[i]
            mk = "playoff" if not soccer else max(("title", "top4", "rel"), key=lambda k: (lambda p: p * (1 - p))(row[k]))
            side_w, side_l = ("h", "a") if home else ("a", "h")
            nw, nl = cnt[f"g{i}_{side_w}"], cnt[f"g{i}_{side_l}"]
            pw = sig(base[i]) if not soccer else None
            if nw > 50 and nl > 50:
                row["next"] = dict(opp=names[oi], home=bool(home), date=left[i]["date"], metric=mk,
                                   win=round(float(acc[f"g{i}_{mk}_{side_w}"][t] / nw), 4), loss=round(float(acc[f"g{i}_{mk}_{side_l}"][t] / nl), 4),
                                   p=round(float(pw if home else 1 - pw), 3) if pw is not None else None)
        out_teams.append(row)
    # the week's biggest games: how much the result moves everyone's chances (playoffs; the title and relegation in soccer)
    big = []
    for i in week:
        nh, na = cnt[f"g{i}_h"], cnt[f"g{i}_a"]
        if nh < 50 or na < 50: continue
        keys = ("title", "top4", "rel") if soccer else ("playoff",)
        swing = sum(float(np.abs(acc[f"g{i}_{k}_h"] / nh - acc[f"g{i}_{k}_a"] / na).sum()) for k in keys)
        mk = "playoff" if not soccer else "top4"
        big.append(dict(h=names[gh[i]], a=names[ga[i]], date=left[i]["date"], swing=round(swing, 3), p=round(float(sig(base[i])), 3) if not soccer else None,
                        h_if_win=round(float(acc[f"g{i}_{mk}_h"][gh[i]] / nh), 3), h_if_loss=round(float(acc[f"g{i}_{mk}_a"][gh[i]] / na), 3),
                        a_if_win=round(float(acc[f"g{i}_{mk}_a"][ga[i]] / na), 3), a_if_loss=round(float(acc[f"g{i}_{mk}_h"][ga[i]] / nh), 3)))
    big.sort(key=lambda b: -b["swing"])
    # for the app's "what if" simulator: standings so far and every game left with its chances, so the browser can rerun the
    # season with some results fixed (it compares against its own unfixed run, so only the change it shows matters)
    def g3(i):
        if not soccer: return [round(float(sig(base[i])), 3), None]
        lh = float(np.exp(LN[gh[i], ga[i]] / 2)) if neutral[i] else float(LH[gh[i], ga[i]]); la = float(np.exp(-LN[gh[i], ga[i]] / 2)) if neutral[i] else float(LA[gh[i], ga[i]])
        f = lambda l: [math.exp(-l) * l ** k / math.factorial(k) for k in range(11)]; fh, fa = f(lh), f(la)
        ph = sum(fh[x] * fa[y] for x in range(11) for y in range(11) if x > y); pd_ = sum(fh[x] * fa[x] for x in range(11)); tot = ph + pd_ + sum(fh[x] * fa[y] for x in range(11) for y in range(11) if y > x)
        return [round(ph / tot, 3), round(pd_ / tot, 3)]
    wif = dict(t=[[names[t], conf_of[names[t]], div_of[names[t]], int(W[t]), int(Lo[t]), int(D[t]), int(OTL[t]), int(PF[t] - PA[t])] for t in range(T)],
               g=[[int(gh[i]), int(ga[i]), *g3(i), left[i]["date"]] for i in range(G)], sd=round(sd, 3))
    return dict(teams=out_teams, big=big[:8], played=len(played), left=G, sims=N, sigma=round(sd, 3), wif=wif)

def playoffs(lg, score, eps, L, cm, dm, confs, divs, n, T, rng):
    """Play out the postseason in every simulated season. Returns boolean [n, T] arrays."""
    r = np.arange(n)
    out = {k: np.zeros((n, T), bool) for k in ("playoff", "div", "top", "final", "title")}
    def game(a, b, host=None):
        """One game between a and b (arrays of team indices); host: a, b or None (neutral). Returns the winner."""
        d = eps[r, a] - eps[r, b]
        if host is None: p = (sig(L[a, b] + d) + sig(-L[b, a] + d)) / 2
        else: p = sig(L[a, b] + d)
        return np.where(rng.random(n) < p, a, b)
    def ser(a, b, k):
        d = eps[r, a] - eps[r, b]; p = (sig(L[a, b] + d) + sig(-L[b, a] + d)) / 2
        return np.where(rng.random(n) < series(p, k), a, b)
    better = lambda a, b: np.where(score[r, a] >= score[r, b], a, b)
    worse = lambda a, b: np.where(score[r, a] >= score[r, b], b, a)
    def by_seed(a, b, seeds):                                                  # the better seed hosts
        sa, sb = np.argmax(seeds == a[:, None], 1), np.argmax(seeds == b[:, None], 1)
        return np.where(sa <= sb, a, b), np.where(sa <= sb, b, a)
    mark = lambda k, arr: out[k].__setitem__((r, arr), True)
    champs = []
    for c in confs:
        dws = [rank_within(score, [t for t in dm[d] if t in cm[c]])[:, 0] for d in divs if set(dm[d]) & set(cm[c])]
        for x in dws: mark("div", x)
        dwm = np.zeros((n, T), bool)
        for x in dws: dwm[r, x] = True
        if lg in ("nfl", "mlb"):
            k_div, k_wc = len(dws), (3 if lg == "nfl" else 3)
            S = np.stack(dws, 1); S = np.take_along_axis(S, np.argsort(-score[r[:, None], S], 1), 1)          # division winners, best first
            rest = score.copy(); rest[dwm] = -1e12; rest[:, [t for t in range(T) if t not in cm[c]]] = -1e12
            wc = np.argsort(-rest, 1)[:, :k_wc]
            seeds = np.concatenate([S, wc], 1)                                  # seeds 1..7 (NFL) or 1..6 (MLB)
            for j in range(seeds.shape[1]): mark("playoff", seeds[:, j])
            mark("top", seeds[:, 0])
            if lg == "nfl":
                s1 = seeds[:, 0]
                w27 = game(seeds[:, 1], seeds[:, 6], 1); w36 = game(seeds[:, 2], seeds[:, 5], 1); w45 = game(seeds[:, 3], seeds[:, 4], 1)
                rem = np.stack([w27, w36, w45], 1); seed_no = np.argmax(seeds[:, :, None] == rem[:, None, :], 1)   # the seed number of each survivor
                o = np.argsort(seed_no, 1); rem = np.take_along_axis(rem, o, 1)
                a1 = game(s1, rem[:, 2], 1); a2 = game(rem[:, 0], rem[:, 1], 1)
                hi, lo = by_seed(a1, a2, seeds); ch = game(hi, lo, 1)
            else:
                w36 = ser(seeds[:, 2], seeds[:, 5], 3); w45 = ser(seeds[:, 3], seeds[:, 4], 3)
                a1 = ser(seeds[:, 0], w45, 5); a2 = ser(seeds[:, 1], w36, 5)
                ch = ser(a1, a2, 7)
        elif lg == "nhl":
            tops = []
            cdiv = [d for d in divs if set(dm[d]) & set(cm[c])]
            for d in cdiv:
                o = rank_within(score, dm[d])[:, :3]; tops.append(o)
                for j in range(3): mark("playoff", o[:, j])
            taken = np.zeros((n, T), bool)
            for o in tops: taken[r[:, None], o] = True
            rest = score.copy(); rest[taken] = -1e12; rest[:, [t for t in range(T) if t not in cm[c]]] = -1e12
            wc = np.argsort(-rest, 1)[:, :2]; mark("playoff", wc[:, 0]); mark("playoff", wc[:, 1])
            d1, d2 = tops; top1 = score[r, d1[:, 0]] >= score[r, d2[:, 0]]
            mark("top", np.where(top1, d1[:, 0], d2[:, 0]))
            # the better division winner meets the second wildcard
            opp1 = np.where(top1, wc[:, 1], wc[:, 0]); opp2 = np.where(top1, wc[:, 0], wc[:, 1])
            b1 = ser(ser(d1[:, 0], opp1, 7), ser(d1[:, 1], d1[:, 2], 7), 7)
            b2 = ser(ser(d2[:, 0], opp2, 7), ser(d2[:, 1], d2[:, 2], 7), 7)
            ch = ser(b1, b2, 7)
        else:                                                                    # NBA with the play-in
            o = rank_within(score, cm[c])
            for j in range(6): mark("playoff", o[:, j])
            mark("top", o[:, 0])
            w78 = game(o[:, 6], o[:, 7], 1); l78 = np.where(w78 == o[:, 6], o[:, 7], o[:, 6])
            w910 = game(o[:, 8], o[:, 9], 1); s8 = game(l78, w910, 1)
            mark("playoff", w78); mark("playoff", s8)
            q = [ser(o[:, 0], s8, 7), ser(o[:, 3], o[:, 4], 7), ser(o[:, 2], o[:, 5], 7), ser(o[:, 1], w78, 7)]
            ch = ser(ser(q[0], q[1], 7), ser(q[2], q[3], 7), 7)
        mark("final", ch); champs.append(ch)
    a, b = champs
    title = game(a, b, None) if lg == "nfl" else ser(a, b, 7)
    mark("title", title)
    return out

# ------------------------------------------------------------------ history, output
def main(leagues):
    today = dt.date.today()
    models = json.load(open(os.path.join(HERE, "docs", "models.json")))
    out_path = os.path.join(HERE, "docs", "sim.json")
    prev = json.load(open(out_path)) if os.path.exists(out_path) else {}
    out = {"asof": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "leagues": dict(prev.get("leagues", {}))}
    hist_dir = os.path.join(HERE, "data", "sim_history"); os.makedirs(hist_dir, exist_ok=True)
    fetch = {"nfl": sched_nfl, "mlb": sched_mlb, "nhl": sched_nhl, "nba": sched_nba, "epl": sched_epl}
    rng = np.random.default_rng(int(today.strftime("%Y%m%d")))
    for lg in leagues:
        if lg not in models: continue
        try:
            season = season_of(lg, today)
            played, left = fetch[lg](sorted(models[lg]["state"]), season)
            if not played and not left: raise RuntimeError("no schedule")
            if not left:
                out["leagues"][lg] = dict(season=season, done=True, asof=today.isoformat(), teams=[], big=[], note="The regular season is over.")
                print(f"{lg}: regular season over"); continue
            r = simulate(lg, models[lg], played, left, today, rng)
            # odds over time, one point a day
            hp = os.path.join(hist_dir, f"{lg}_{season}.json"); H = json.load(open(hp)) if os.path.exists(hp) else {}
            for t in r["teams"]:
                k = "top4" if lg == "epl" else "playoff"
                pts = [p for p in H.get(t["name"], []) if p[0] != today.isoformat()] + [[today.isoformat(), t[k], t["title"]]]
                H[t["name"]] = pts[-200:]; t["hist"] = H[t["name"]][-120:]
            json.dump(H, open(hp, "w"), separators=(",", ":"))
            out["leagues"][lg] = dict(season=season, asof=today.isoformat(), **r)
            top = sorted(r["teams"], key=lambda t: -t["title"])[:3]
            print(f"{lg} {season}: {r['played']} played, {r['left']} left; title favourites " + ", ".join(f"{t['name']} {t['title']:.1%}" for t in top))
        except Exception as e:
            print(f"{lg}: kept the previous simulation ({e})")
    json.dump(out, open(out_path, "w"), separators=(",", ":"))

if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in ("nfl", "mlb", "nhl", "nba", "epl")] or ["nfl", "mlb", "nhl", "nba", "epl"])
