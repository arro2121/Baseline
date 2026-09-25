"""
Prediction models for the NFL, NBA, MLB, NHL and Premier League, built the same way as the tennis model (engine.py):
walk through every game in date order, record what was known about both teams *before* the game, then fit a model on
older seasons and test it on seasons it never saw.

What the models know about each team before a game
* Elo: a rating that moves after every game, by more for upsets and big wins; it drifts back toward average between seasons.
* Scoring margin: a running, opponent-adjusted point (run, goal) differential; recent games count most.
* Offense and defense: running points scored and allowed, which also drive the projected score.
* Form: wins in the last 10 games.
* Rest: days since the last game, and back-to-backs in the NBA and NHL; byes in the NFL.
* Sport-specific:
  - MLB: each starting pitcher's runs allowed in his recent starts.
  - NHL: shot share (a team's share of all shots in its games).
  - Premier League: shots-on-target share, a strong sign of chances created and allowed.
  - NBA: shooting (field-goal percentage) for and against.

Win chances come from a logistic model (Premier League: a Poisson model of each side's goals, which gives win, draw
and loss chances and the likeliest scores). A separate linear model projects each side's score, giving a fair
spread and total. Each factor's value to the model is measured by dropping it and seeing how much worse the
predictions get on the test seasons.
"""
import math, datetime as dt
from collections import defaultdict, deque
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression, LinearRegression, PoissonRegressor
from sklearn.metrics import log_loss, brier_score_loss

def elo_p(d): return 1 / (1 + 10 ** (-d / 400))

# settings per league (K, home edge and offseason pull tuned on a validation season before the test seasons): Elo K and home edge, the offseason pull toward average, how fast running stats forget,
# the cap on rest days that still matter, and the per-sport margin multiplier for Elo
CFG = {
    "nfl": dict(K=16, HFA=48, revert=1 / 3, half=6, rest_cap=14, unit="points", mov=lambda m, d: math.log(abs(m) + 1) * 2.2 / (d * .001 + 2.2)),
    "nba": dict(K=18, HFA=60, revert=.2, half=12, rest_cap=4, unit="points", mov=lambda m, d: ((abs(m) + 3) ** .8) / (7.5 + .006 * d)),
    "mlb": dict(K=2.5, HFA=16, revert=1 / 3, half=25, rest_cap=3, unit="runs", mov=lambda m, d: math.log(abs(m) + 1) * 1.1),
    "nhl": dict(K=4, HFA=30, revert=.2, half=18, rest_cap=4, unit="goals", mov=lambda m, d: math.log(abs(m) + 1) * 1.5),
    "epl": dict(K=28, HFA=70, revert=.2, half=10, rest_cap=10, unit="goals", mov=lambda m, d: 1 if abs(m) <= 1 else 1.5 if abs(m) == 2 else (11 + abs(m)) / 8),
}
LABELS = {
    "home": "Home advantage", "elo_d": "Elo rating", "mov_d": "Scoring margin (opponent-adjusted)", "form_d": "Form (last 10)",
    "rest_d": "Rest", "b2b_h": "Home team on a back-to-back", "b2b_a": "Away team on a back-to-back",
    "sp_d": "Starting pitchers", "qb_d": "Starting quarterback", "shots_d": "Shot share", "sot_d": "Shots-on-target share", "fg_d": "Shooting",
}

class Team:
    __slots__ = ("elo", "mov", "pf", "pa", "res", "last", "n", "sn", "x", "hist", "log", "hw", "hl", "aw", "al", "streak")
    def __init__(self, elo=1500.0):
        self.elo, self.mov, self.pf, self.pa = elo, 0.0, None, None
        self.res, self.last, self.n, self.sn = deque(maxlen=10), None, 0, 0
        self.x = {}; self.hist = []; self.log = deque(maxlen=12); self.hw = self.hl = self.aw = self.al = 0; self.streak = 0

def season_of(lg, d):
    """the season a date belongs to (the year it started)"""
    if lg == "mlb": return d.year
    if lg == "nfl": return d.year if d.month >= 8 else d.year - 1
    return d.year if d.month >= (7 if lg == "epl" else 9) else d.year - 1

def walk(lg, games, extras=()):
    """games: DataFrame sorted by date with date (Timestamp), home, away, hs, as_ (NaN for unplayed), neutral, and any extra columns.
    Returns (feature rows for played games, team states, pitcher states, head-to-head log)."""
    C = CFG[lg]; T = defaultdict(Team); a = .5 ** (1 / C["half"])
    lg_pts = [None]                                         # running league scoring average (points per team per game)
    SP = defaultdict(lambda: [None, 0])                     # MLB: pitcher -> [runs allowed in his starts this season (running), starts]
    FIP = games.attrs.get("fip", {})                        # MLB: (pitcher, season) -> that season's FIP, regressed by innings
    def sp_val(pid, season):
        """a starter's expected runs allowed per game: last season's FIP, moving toward this season's starts as they add up"""
        prior = FIP.get((pid, season - 1), 4.45); v, n = SP[pid] if pid else (None, 0)
        return prior if v is None else (prior * 8 + v * n) / (8 + n)
    h2h = defaultdict(lambda: deque(maxlen=6))
    rows, cur = [], None
    for r in games.itertuples(index=False):
        d = r.date; s = season_of(lg, d)
        if s != cur:                                        # new season: pull ratings back toward average, forget some of last season
            if cur is not None:
                SP.clear()
                for t in T.values():
                    t.elo = t.elo * (1 - C["revert"]) + 1505 * C["revert"]; t.mov *= .5; t.sn = 0; t.res.clear(); t.hw = t.hl = t.aw = t.al = 0; t.streak = 0
                    for k in t.x:
                        if t.x[k] is not None: t.x[k] = .5 * t.x[k] + .25          # shares drift halfway back to 50%
            cur = s
        H, A = T[r.home], T[r.away]
        played = not (pd.isna(r.hs) or pd.isna(r.as_))
        rest = lambda t: min(C["rest_cap"], (d - t.last).days) if t.last is not None else C["rest_cap"]
        avg = lg_pts[0] if lg_pts[0] is not None else (4.4 if lg == "mlb" else 1.4 if lg == "epl" else 3.0 if lg == "nhl" else 110 if lg == "nba" else 22)
        pf = lambda t: t.pf if t.pf is not None else avg
        pa = lambda t: t.pa if t.pa is not None else avg
        f = dict(date=d, season=s, home_team=r.home, away_team=r.away, home=0 if getattr(r, "neutral", 0) else 1,
                 elo_d=H.elo - A.elo, mov_d=H.mov - A.mov,
                 form_d=(np.mean(H.res) if H.res else .5) - (np.mean(A.res) if A.res else .5),
                 rest_d=rest(H) - rest(A), b2b_h=1 if H.last is not None and (d - H.last).days <= 1 else 0, b2b_a=1 if A.last is not None and (d - A.last).days <= 1 else 0,
                 pf_h=pf(H), pa_h=pa(H), pf_a=pf(A), pa_a=pa(A), lg_avg=avg, n_min=min(H.n, A.n), sn_min=min(H.sn, A.sn),
                 p_elo=elo_p(H.elo - A.elo + (0 if getattr(r, "neutral", 0) else C["HFA"])))
        if lg == "mlb":
            hp, ap = getattr(r, "hsp", None), getattr(r, "asp", None)
            f["sp_d"] = sp_val(ap, s) - sp_val(hp, s); f["hsp"] = hp; f["asp"] = ap
        if lg in ("nhl", "epl", "nba"):
            key = {"nhl": "shots_share", "epl": "sot_share", "nba": "fg_share"}[lg]
            f[{"nhl": "shots_d", "epl": "sot_d", "nba": "fg_d"}[lg]] = (H.x.get(key) if H.x.get(key) is not None else .5) - (A.x.get(key) if A.x.get(key) is not None else .5)
            if lg == "epl": f["shots_d"] = (H.x.get("shots_share") or .5) - (A.x.get("shots_share") or .5)
        for c in extras: f[c] = getattr(r, c, None)
        if not played: continue
        hs, as_ = float(r.hs), float(r.as_); m = hs - as_
        f.update(hs=hs, as_=as_, margin=m, total=hs + as_, y=1 if m > 0 else 0 if m < 0 else .5)
        rows.append(f)
        # ---- update the teams with the result
        home_elo = 0 if getattr(r, "neutral", 0) else C["HFA"]
        E = elo_p(H.elo - A.elo + home_elo); res = f["y"]
        d_ = (H.elo + home_elo - A.elo) if res == 1 else (A.elo - H.elo - home_elo)
        mult = C["mov"](m, d_) if m else 1.0
        k = C["K"] * mult * (res - E); H.elo += k; A.elo -= k
        hadv = 0 if getattr(r, "neutral", 0) else {"nfl": 1.8, "nba": 2.5, "mlb": .15, "nhl": .15, "epl": .3}[lg]
        adj_h, adj_a = (m - hadv) + A.mov, (-m + hadv) + H.mov                    # margin against an average opponent
        H.mov = a * H.mov + (1 - a) * adj_h; A.mov = a * A.mov + (1 - a) * adj_a
        H.pf = hs if H.pf is None else a * H.pf + (1 - a) * hs; H.pa = as_ if H.pa is None else a * H.pa + (1 - a) * as_
        A.pf = as_ if A.pf is None else a * A.pf + (1 - a) * as_; A.pa = hs if A.pa is None else a * A.pa + (1 - a) * hs
        lg_pts[0] = (hs + as_) / 2 if lg_pts[0] is None else .995 * lg_pts[0] + .005 * (hs + as_) / 2
        for t, won, opp, us, them, home in ((H, res == 1, r.away, hs, as_, True), (A, res == 0, r.home, as_, hs, False)):
            t.res.append(1 if won else 0 if res != .5 else .5); t.last = d; t.n += 1; t.sn += 1
            if res != .5:
                if home: t.hw += won; t.hl += not won
                else: t.aw += won; t.al += not won
                t.streak = (t.streak + 1 if t.streak > 0 else 1) if won else (t.streak - 1 if t.streak < 0 else -1)
            t.log.append((d.strftime("%Y%m%d"), opp, int(us), int(them), "H" if home else "A"))
            t.hist.append((d.strftime("%Y%m%d"), round(t.elo, 1)))
        h2h[tuple(sorted((r.home, r.away)))].append((d.strftime("%Y%m%d"), r.home, r.away, int(hs), int(as_)))
        if lg == "mlb":
            for pid, ra in ((getattr(r, "hsp", None), as_), (getattr(r, "asp", None), hs)):
                if pid:
                    v, n = SP[pid]; SP[pid] = [ra if v is None else .9 * v + .1 * ra, n + 1]
        def share(t, key, us, them):
            if us is None or them is None or pd.isna(us) or pd.isna(them) or (us + them) <= 0: return
            v = us / (us + them); t.x[key] = v if t.x.get(key) is None else a * t.x[key] + (1 - a) * v
        if lg == "nhl": share(H, "shots_share", r.hsog, r.asog); share(A, "shots_share", r.asog, r.hsog)
        if lg == "epl":
            share(H, "sot_share", r.hst, r.ast); share(A, "sot_share", r.ast, r.hst)
            share(H, "shots_share", r.hsh, r.ash); share(A, "shots_share", r.ash, r.hsh)
        if lg == "nba": share(H, "fg_share", r.hfg, r.afg); share(A, "fg_share", r.afg, r.hfg)
    return pd.DataFrame(rows), T, (SP, FIP, cur), h2h

# ------------------------------------------------------------------ fitting and testing
def rep(y, p):
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4); y = np.asarray(y)
    return dict(acc=round(float(((p > .5) == (y == 1)).mean()), 4), logloss=round(float(log_loss(y, p, labels=[0, 1])), 4), brier=round(float(brier_score_loss(y, p)), 4), n=int(len(y)))

def calib(y, p, lo_n=40):
    p = np.asarray(p); y = np.asarray(y); fav = np.where(p >= .5, p, 1 - p); won = np.where(p >= .5, y, 1 - y); out = []
    for lo in np.arange(.5, 1, .05):
        m = (fav >= lo) & (fav < lo + .05)
        if m.sum() >= lo_n: out.append(dict(bucket=f"{int(round(lo * 100))}–{int(round(lo * 100)) + 5}%", predicted=round(float(fav[m].mean()), 3), actual=round(float(won[m].mean()), 3), n=int(m.sum())))
    return out

def fit_binary(lg, F, feats, test_seasons, market=None):
    """Logistic win model with an explicit home term (no intercept), plus ablation and a backtest."""
    D = F[(F.y != .5) & (F.n_min >= 5)].copy()
    train, test = ~D.season.isin(test_seasons), D.season.isin(test_seasons)
    cand = list(feats)
    mu, sd = D.loc[train, cand].mean(), D.loc[train, cand].std().replace(0, 1)
    def X(df, c): return np.column_stack([df["home"].to_numpy()] + [((df[k] - mu[k]) / sd[k]).to_numpy() for k in c])
    def fit(c, tr=None, te=None):
        tr = train if tr is None else tr; te = test if te is None else te
        m = LogisticRegression(fit_intercept=False, C=1.0, max_iter=3000).fit(X(D[tr], c), D.y[tr])
        return m, m.predict_proba(X(D[te], c))[:, 1]
    # choose the factors on a validation season (the last training season), never on the test seasons
    vs = sorted(D.loc[train, "season"].unique())[-2:]; tr2, va = train & (D.season < vs[0]), train & D.season.isin(vs)   # the last two training seasons
    vll = lambda c: log_loss(D.y[va], fit(c, tr2, va)[1])
    feats = ["elo_d"]; cur = vll(feats); tried = {}
    for k in sorted(cand[1:], key=lambda k: vll(["elo_d", k])):
        v = vll(feats + [k]); tried[k] = round(float(cur - v), 5)
        if v < cur - 5e-5: feats.append(k); cur = v
    cols = ["home"] + feats
    model, p = fit(feats)
    val = cur                                                          # the chosen factors' validation log loss (for tuning settings)
    base_elo = LogisticRegression(fit_intercept=False, max_iter=2000).fit(np.column_stack([D.home[train], D.elo_d[train] / 100]), D.y[train])
    p_elo = base_elo.predict_proba(np.column_stack([D.home[test], D.elo_d[test] / 100]))[:, 1]
    full = log_loss(D.y[test], p)
    ablation = {}
    for k in feats:
        _, pk = fit([c for c in feats if c != k]); ablation[k] = round(float(log_loss(D.y[test], pk) - full), 5)
    bt = {"Elo only": rep(D.y[test], p_elo), "Full model (all factors)": rep(D.y[test], p)}
    if market is not None:
        mk = D[test][market].to_numpy(); ok = ~np.isnan(mk)
        if ok.sum() > 50:
            bt["Betting market (same games)"] = rep(D.y[test].to_numpy()[ok], mk[ok])
            bt["Full model (same games)"] = rep(D.y[test].to_numpy()[ok], p[ok])
    coef = dict(zip(cols, [round(float(c), 5) for c in model.coef_[0]]))
    return dict(kind="logistic", feats=feats, coef=coef, mean={k: round(float(mu[k]), 5) for k in feats}, sd={k: round(float(sd[k]), 5) for k in feats},
                backtest=bt, calibration=calib(D.y[test], p), ablation=ablation, tried=tried, dropped=[k for k in cand if k not in feats], train_games=int(train.sum()), test_games=int(test.sum()),
                test_seasons=[int(s) for s in test_seasons], _val=val), (D[test], p)

def fit_scores(F, test_seasons):
    """Projected score for each side from both teams' offense and defense, plus the spread of outcomes."""
    D = F[F.n_min >= 5]; tr = ~D.season.isin(test_seasons)
    Xh = np.column_stack([D.pf_h, D.pa_a, D.home]); Xa = np.column_stack([D.pf_a, D.pa_h, D.home])
    mh = LinearRegression().fit(Xh[tr], D.hs[tr]); ma = LinearRegression().fit(Xa[tr], D.as_[tr])
    te = ~tr; res_m = (D.hs[te] - D.as_[te]) - (mh.predict(Xh[te]) - ma.predict(Xa[te]))
    res_t = (D.hs[te] + D.as_[te]) - (mh.predict(Xh[te]) + ma.predict(Xa[te]))
    pack = lambda m: [round(float(m.intercept_), 4)] + [round(float(c), 4) for c in m.coef_]
    return dict(home=pack(mh), away=pack(ma), margin_sd=round(float(res_m.std()), 3), total_sd=round(float(res_t.std()), 3),
                margin_mae=round(float(np.abs(res_m).mean()), 3), total_mae=round(float(np.abs(res_t).mean()), 3))

def pois3(lh, la, rho=0.0, maxg=10):
    """win / draw / loss chances and the score grid from two expected-goal numbers (Dixon-Coles low-score tweak)"""
    g = np.arange(maxg + 1); fh = np.exp(-lh) * lh ** g / np.array([math.factorial(i) for i in g]); fa = np.exp(-la) * la ** g / np.array([math.factorial(i) for i in g])
    M = np.outer(fh, fa)
    if rho:
        M[0, 0] *= 1 - lh * la * rho; M[0, 1] *= 1 + lh * rho; M[1, 0] *= 1 + la * rho; M[1, 1] *= 1 - rho
    M /= M.sum()
    return float(np.tril(M, -1).sum()), float(np.trace(M)), float(np.triu(M, 1).sum()), M

def fit_poisson(F, feats, test_seasons, market=None):
    """Premier League: each side's goals from Poisson regressions on both teams' factors; win/draw/loss from the score grid."""
    D = F[F.n_min >= 5].copy(); tr, te = ~D.season.isin(test_seasons), D.season.isin(test_seasons)
    cand = list(feats)
    mu, sd = D.loc[tr, cand].mean(), D.loc[tr, cand].std().replace(0, 1)
    def X(df, c, sign): return np.column_stack([((df[k] - mu[k]) / sd[k]).to_numpy() * sign for k in c] + [np.log(np.maximum(.14, df.pf_h if sign > 0 else df.pf_a)), np.log(np.maximum(.14, df.pa_a if sign > 0 else df.pa_h))])
    def fit(c, a=None, b=None):
        a = tr if a is None else a; b = te if b is None else b
        mh = PoissonRegressor(alpha=1e-4, max_iter=2000).fit(X(D[a], c, 1), D.hs[a]); ma = PoissonRegressor(alpha=1e-4, max_iter=2000).fit(X(D[a], c, -1), D.as_[a])
        return mh, ma, mh.predict(X(D[b], c, 1)), ma.predict(X(D[b], c, -1))
    def ll3(lh_, la_, rho, act=None):
        act = (np.where(D.hs[te] > D.as_[te], 0, np.where(D.hs[te] == D.as_[te], 1, 2))) if act is None else act
        P = np.array([pois3(a_, b_, rho)[:3] for a_, b_ in zip(lh_, la_)]); return float(-np.log(np.clip(P[np.arange(len(act)), act], 1e-6, 1)).mean()), P
    vs = sorted(D.loc[tr, "season"].unique())[-2:]; tr2, va = tr & (D.season < vs[0]), tr & D.season.isin(vs)
    act_va = np.where(D.hs[va] > D.as_[va], 0, np.where(D.hs[va] == D.as_[va], 1, 2))
    vll = lambda c: ll3(*fit(c, tr2, va)[2:], 0.0, act_va)[0]
    feats = ["elo_d"]; cur = vll(feats); tried = {}
    for k in sorted(cand[1:], key=lambda k: vll(["elo_d", k])):
        v = vll(feats + [k]); tried[k] = round(float(cur - v), 5)
        if v < cur - 5e-5: feats.append(k); cur = v
    val = cur
    mh, ma, lh, la = fit(feats)
    actual = np.where(D.hs[te] > D.as_[te], 0, np.where(D.hs[te] == D.as_[te], 1, 2))
    # the low-score adjustment, fitted on the training seasons
    lh_tr, la_tr = mh.predict(X(D[tr], feats, 1)), ma.predict(X(D[tr], feats, -1))
    act_tr = np.where(D.hs[tr] > D.as_[tr], 0, np.where(D.hs[tr] == D.as_[tr], 1, 2))
    best = min(((float(-np.log(np.clip(np.array([pois3(a_, b_, r)[:3] for a_, b_ in zip(lh_tr, la_tr)])[np.arange(len(act_tr)), act_tr], 1e-6, 1)).mean()), r) for r in np.arange(-.2, .21, .04)))
    rho = round(float(best[1]), 3)
    full, P = ll3(lh, la, rho)
    ablation = {}
    for k in feats:
        _, _, a1, b1 = fit([c for c in feats if c != k]); ablation[k] = round(ll3(a1, b1, rho)[0] - full, 5)
    E = D.p_elo[te].to_numpy()                                       # Elo with a fitted draw curve, the old model
    pdw = np.clip(.3 * (1 - np.abs(2 * E - 1) ** 1.4), .05, .6); PE = np.column_stack([np.clip(E - pdw / 2, .01, .98), pdw, np.clip(1 - E - pdw / 2, .01, .98)])
    def r3(Pm, act):
        return dict(acc=round(float((Pm.argmax(1) == act).mean()), 4), logloss=round(float(-np.log(np.clip(Pm[np.arange(len(act)), act], 1e-6, 1)).mean()), 4),
                    brier=round(float(((Pm - np.eye(3)[act]) ** 2).sum(1).mean()), 4), n=int(len(act)))
    bt = {"Elo only (with a draw curve)": r3(PE, actual), "Full model (all factors)": r3(P, actual)}
    if market:
        o = D[te][market].to_numpy(float); ok = ~np.isnan(o).any(1) & (o > 1).all(1)
        if ok.sum() > 50:
            inv = 1 / o[ok]; M = inv / inv.sum(1, keepdims=True)
            bt["Betting market (closing odds)"] = r3(M, actual[ok]); bt["Full model (same games)"] = r3(P[ok], actual[ok])
    fav = P.max(1); won = (P.argmax(1) == actual).astype(float); cal = []
    for lo in np.arange(.35, .9, .05):
        m = (fav >= lo) & (fav < lo + .05)
        if m.sum() >= 30: cal.append(dict(bucket=f"{int(round(lo * 100))}–{int(round(lo * 100)) + 5}%", predicted=round(float(fav[m].mean()), 3), actual=round(float(won[m].mean()), 3), n=int(m.sum())))
    pack = lambda m: dict(intercept=round(float(m.intercept_), 5), coef=[round(float(c), 5) for c in m.coef_])
    return dict(kind="poisson", feats=feats, home_goals=pack(mh), away_goals=pack(ma), rho=rho, mean={k: round(float(mu[k]), 5) for k in feats}, sd={k: round(float(sd[k]), 5) for k in feats},
                backtest=bt, calibration=cal, ablation=ablation, tried=tried, dropped=[k for k in cand if k not in feats], train_games=int(tr.sum()), test_games=int(te.sum()), test_seasons=[int(s) for s in test_seasons], _val=val)

# ------------------------------------------------------------------ loading each league's history
NFL_NAMES = dict(ARI="Arizona Cardinals", ATL="Atlanta Falcons", BAL="Baltimore Ravens", BUF="Buffalo Bills", CAR="Carolina Panthers", CHI="Chicago Bears",
 CIN="Cincinnati Bengals", CLE="Cleveland Browns", DAL="Dallas Cowboys", DEN="Denver Broncos", DET="Detroit Lions", GB="Green Bay Packers", HOU="Houston Texans",
 IND="Indianapolis Colts", JAX="Jacksonville Jaguars", KC="Kansas City Chiefs", LA="Los Angeles Rams", LAC="Los Angeles Chargers", LV="Las Vegas Raiders",
 MIA="Miami Dolphins", MIN="Minnesota Vikings", NE="New England Patriots", NO="New Orleans Saints", NYG="New York Giants", NYJ="New York Jets",
 PHI="Philadelphia Eagles", PIT="Pittsburgh Steelers", SEA="Seattle Seahawks", SF="San Francisco 49ers", TB="Tampa Bay Buccaneers", TEN="Tennessee Titans",
 WAS="Washington Commanders")
# football-data.co.uk's club names, as the app writes them
EPL_NAMES = {"Man City": "Manchester City", "Man United": "Manchester United", "Newcastle": "Newcastle United", "Nott'm Forest": "Nottingham Forest",
 "Tottenham": "Tottenham Hotspur", "Wolves": "Wolverhampton Wanderers", "West Ham": "West Ham United", "Brighton": "Brighton & Hove Albion",
 "Leeds": "Leeds United", "Leicester": "Leicester City", "Ipswich": "Ipswich Town", "Luton": "Luton Town", "Sheffield United": "Sheffield United",
 "West Brom": "West Bromwich Albion", "Norwich": "Norwich City", "Cardiff": "Cardiff City", "Huddersfield": "Huddersfield Town", "Stoke": "Stoke City",
 "Swansea": "Swansea City", "Hull": "Hull City", "Coventry": "Coventry City", "Sunderland": "Sunderland", "Burnley": "Burnley", "Watford": "Watford",
 "Bournemouth": "AFC Bournemouth", "Brentford": "Brentford", "Fulham": "Fulham", "Everton": "Everton", "Crystal Palace": "Crystal Palace",
 "Aston Villa": "Aston Villa", "Arsenal": "Arsenal", "Chelsea": "Chelsea", "Liverpool": "Liverpool", "Southampton": "Southampton", "Middlesbrough": "Middlesbrough"}

def _csvs(paths):
    fs = [pd.read_csv(p) for p in paths if p]
    return pd.concat(fs, ignore_index=True) if fs else pd.DataFrame()

def load(lg, paths=None, nfl_csv=None):
    """one DataFrame of games in date order, in the shape walk() reads"""
    if lg == "nfl":
        g = pd.read_csv(nfl_csv, low_memory=False)
        g = g[g.game_type.isin(["REG", "WC", "DIV", "CON", "SB"])].copy()
        for c in ("home_team", "away_team"): g[c] = g[c].replace({"OAK": "LV", "SD": "LAC", "STL": "LA"})
        g = g.assign(date=pd.to_datetime(g.gameday)).sort_values(["date", "gametime"])
        dec = lambda m: 1 + (m / 100 if m > 0 else 100 / -m)
        def mkt(r):
            if pd.isna(r.home_moneyline) or pd.isna(r.away_moneyline): return np.nan
            x, y = 1 / dec(r.home_moneyline), 1 / dec(r.away_moneyline); return x / (x + y)
        # quarterback continuity: the share of the team's last 8 games this QB started (a backup or a new starter scores low)
        last = defaultdict(lambda: deque(maxlen=8)); qh, qa = [], []
        for r in g.itertuples():
            for team, qb, out in ((r.home_team, r.home_qb_id, qh), (r.away_team, r.away_qb_id, qa)):
                L = last[team]; out.append(np.nan if pd.isna(qb) else sum(1 for x in L if x == qb) / len(L) if len(L) else 1.0)
                if not pd.isna(qb) and not pd.isna(r.home_score): L.append(qb)
        G = pd.DataFrame(dict(date=g.date.values, home=g.home_team.values, away=g.away_team.values, hs=g.home_score.values, as_=g.away_score.values,
                              neutral=(g.location == "Neutral").astype(int).values, p_mkt=g.apply(mkt, axis=1).values,
                              qb_d=(pd.Series(qh).fillna(1) - pd.Series(qa).fillna(1)).values,
                              hqb=g.home_qb_name.values, aqb=g.away_qb_name.values, spread=g.spread_line.values, tline=g.total_line.values))
        return G
    d = _csvs(paths)
    if d.empty: return d
    d["date"] = pd.to_datetime(d["date"])
    if lg == "mlb":
        d = d.rename(columns={"as": "as_"}); d["neutral"] = 0
        d["hsp"] = d.hsp_name.where(d.hsp_name.notna(), None); d["asp"] = d.asp_name.where(d.asp_name.notna(), None)
        import glob as _g, os as _os
        fip = {}
        for f in sorted(_g.glob(_os.path.join(_os.path.dirname(paths[0]), "mlb_pitchers_*.csv"))):
            P = pd.read_csv(f)
            lgk = (13 * P.hr.sum() + 3 * P.bb.sum() - 2 * P.so.sum()) / max(1, P.ip.sum()); lgera = 9 * P.er.sum() / max(1, P.ip.sum())
            for r in P.itertuples():
                if r.ip <= 0: continue
                v = (13 * r.hr + 3 * r.bb - 2 * r.so) / r.ip - lgk + lgera            # FIP, on the league's ERA scale
                fip[(r.name, int(r.season))] = (v * r.ip + (lgera + .25) * 40) / (r.ip + 40)   # 40 innings of a below-average arm as the prior
        d = d.sort_values("date", kind="stable").reset_index(drop=True); d.attrs["fip"] = fip
        return d
    elif lg == "nhl":
        d = d.rename(columns={"as": "as_"}); d["neutral"] = 0
    elif lg == "nba":
        d = d.rename(columns={"as": "as_"}); d["neutral"] = 0
        for c in ("hfg", "afg"): d[c] = pd.to_numeric(d[c], errors="coerce")
    elif lg == "epl":
        d = d.rename(columns={"hg": "hs", "ag": "as_", "hs": "hsh", "as_": "ash"}) if "hg" in d.columns else d
        d["home"] = d.home.map(lambda n: EPL_NAMES.get(n, n)); d["away"] = d.away.map(lambda n: EPL_NAMES.get(n, n)); d["neutral"] = 0
        for c in ("odds_h", "odds_d", "odds_a"): d[c] = pd.to_numeric(d[c], errors="coerce")
    return d.sort_values("date", kind="stable").reset_index(drop=True)

FEATS = {"nfl": ["elo_d", "mov_d", "form_d", "rest_d", "qb_d"], "nba": ["elo_d", "mov_d", "form_d", "rest_d", "b2b_h", "b2b_a", "fg_d"],
         "mlb": ["elo_d", "mov_d", "form_d", "rest_d", "sp_d"], "nhl": ["elo_d", "mov_d", "form_d", "rest_d", "b2b_h", "b2b_a", "shots_d"],
         "epl": ["elo_d", "mov_d", "form_d", "rest_d", "sot_d", "shots_d"]}

def build_league(lg, G, today=None):
    """fit, test and export one league: the model, its report card, and every team's state today"""
    today = today or dt.date.today()
    extras = {"nfl": ("p_mkt", "qb_d"), "epl": ("odds_h", "odds_d", "odds_a")}.get(lg, ())
    F, T, (SP, FIP, last_season), H2 = walk(lg, G, extras)
    seasons = sorted(F.season.unique()); test = [s for s in seasons if s >= seasons[-1] - (1 if lg in ("nfl", "epl") else 1)]
    if lg in ("nfl", "epl"): test = seasons[-3:] if len(seasons) > 4 else seasons[-2:]
    if lg == "epl":
        m = fit_poisson(F, FEATS[lg], test, market=["odds_h", "odds_d", "odds_a"])
    else:
        m, _ = fit_binary(lg, F, FEATS[lg], test, market="p_mkt" if lg == "nfl" else None)
    m["scores"] = fit_scores(F, test)
    m["labels"] = {k: LABELS.get(k, k) for k in ["home"] + FEATS[lg]}
    m["games"] = int(len(F)); m["seasons"] = f"{int(seasons[0])}–{int(seasons[-1])}"; m["through"] = F.date.max().strftime("%Y%m%d")
    m["lg_avg"] = round(float(F.lg_avg.iloc[-1]), 3); m["rest_cap"] = CFG[lg]["rest_cap"]; m["hfa_elo"] = CFG[lg]["HFA"]
    # today's state for every team; if a new season hasn't started yet, apply the offseason pull first
    stale = season_of(lg, pd.Timestamp(today)) > F.season.max()
    C = CFG[lg]
    state = {}
    playing = {n for n, t in T.items() if t.last is not None and season_of(lg, t.last) == F.season.max()}     # this season's teams (relegated clubs drop out)
    for name, t in T.items():
        if not t.n or name not in playing: continue
        elo = t.elo * (1 - C["revert"]) + 1505 * C["revert"] if stale else t.elo
        hist = t.hist[-60:]; step = max(1, len(hist) // 24)
        state[name] = dict(elo=round(elo, 1), mov=round(t.mov * (.5 if stale else 1), 3), pf=round(t.pf, 3) if t.pf is not None else None, pa=round(t.pa, 3) if t.pa is not None else None,
                           form=[] if stale else list(t.res), last=t.last.strftime("%Y%m%d") if t.last is not None else None,
                           hist=[[d_, e] for d_, e in hist[::step]] + ([list(hist[-1])] if hist and (len(hist) - 1) % step else []), log=[list(x) for x in t.log][-6:], home=[t.hw, t.hl], away=[t.aw, t.al], streak=t.streak,
                           x={k: round(v, 4) for k, v in t.x.items() if v is not None})
    names = NFL_NAMES if lg == "nfl" else {}
    if names: state = {names.get(k, k): v for k, v in state.items() if k in names}
    out = dict(model=m, state=state, h2h={"|".join(names.get(x, x) for x in k): [list(r) for r in v][-4:] for k, v in H2.items()
                                           if all(names.get(x, x) in state for x in k) and v and pd.Timestamp(v[-1][0]) >= pd.Timestamp(today) - pd.Timedelta(days=800)})
    if names: out["h2h"] = {k: [[r[0], names.get(r[1], r[1]), names.get(r[2], r[2]), r[3], r[4]] for r in v] for k, v in out["h2h"].items()}
    if lg == "mlb":                                   # starting pitchers who pitched this season or last
        cut = pd.Timestamp(today) - pd.Timedelta(days=420); recent = set(G[G.date >= cut].hsp.dropna()) | set(G[G.date >= cut].asp.dropna())
        season_now = season_of(lg, pd.Timestamp(today)); roll = SP if last_season == season_now else {}
        out["pitchers"] = {p: [round(FIP.get((p, season_now - 1), 4.45), 3), round(roll[p][0], 3) if p in roll and roll[p][0] is not None else None, roll[p][1] if p in roll else 0]
                           for p in recent}
        out["pitchers"] = {k: v for k, v in out["pitchers"].items() if isinstance(k, str)}
    if lg == "nfl":                                   # each team's current starting quarterback
        qb = {}
        for r in G[G.hs.notna()].itertuples():
            if isinstance(r.hqb, str): qb[names.get(r.home, r.home)] = r.hqb
            if isinstance(r.aqb, str): qb[names.get(r.away, r.away)] = r.aqb
        out["qbs"] = qb
    return out
