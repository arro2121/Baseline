"""
Tennis prediction engine (v2)
-----------------------------
* Overall + surface Elo from tour-level, Challenger / WTA 125, ITF (W25+) and qualifying matches
  (lower levels count a little less), 2012 onward.
* Rolling 52-week serve/return stats.
* Logistic model trained and backtested on tour-level main-draw matches only, walk-forward.
* Detailed per-player profiles for every official top-200 player plus the top 200 by rating.

Data: Jeff Sackmann's tennis_atp / tennis_wta datasets (CC BY-NC-SA 4.0) via the archival mirror
github.com/Aneeshers/tennis-sackmann-archive, plus newer results placed in data/extra/*.csv.

Usage:  python engine.py   -> snapshot.json
"""
import json, os, re, math, bisect, urllib.request
from collections import defaultdict, deque
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, brier_score_loss

MIRROR = "https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main"
YEARS = range(2012, 2027)
WARMUP_END, TRAIN_END = 20150101, 20240101
DATA_DIR = "data"
ROUND_ORDER = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3, "ER": 4, "RR": 5, "R128": 6, "R64": 7,
               "R32": 8, "R16": 9, "QF": 10, "SF": 11, "BR": 12, "F": 13}
SURFACES = ["Hard", "Clay", "Grass"]
PRIOR_PTS = 400
LOWER_K = 0.8            # lower-level matches move ratings 80% as much
TOP_N = 200
STAT_COLS = ["ace", "df", "svpt", "1stIn", "1stWon", "2ndWon", "SvGms", "bpSaved", "bpFaced"]


def fetch(path, url):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return path


def load(tour):
    frames = []
    for y in YEARS:
        m = pd.read_csv(fetch(f"{DATA_DIR}/{tour}_{y}.csv", f"{MIRROR}/{tour}/{tour}_matches_{y}.csv"), low_memory=False)
        m["main"] = True; frames.append(m)
        low_name = f"{tour}_chall_{y}.csv" if tour == "atp" else f"{tour}_itf_{y}.csv"
        low_url = f"{MIRROR}/{tour}/{tour}_matches_qual_{'chall' if tour == 'atp' else 'itf'}_{y}.csv"
        try:
            l = pd.read_csv(fetch(f"{DATA_DIR}/{low_name}", low_url), low_memory=False)
        except Exception:
            continue
        if tour == "wta":
            lv = l["tourney_level"].astype(str)
            numlv = pd.to_numeric(lv, errors="coerce")
            l = l[(numlv >= 25) | lv.isin(["C"]) | l["round"].astype(str).str.match(r"^Q\d")]
        l = l.copy(); l["main"] = False; frames.append(l)
    extra = os.path.join(DATA_DIR, "extra")
    if os.path.isdir(extra):
        for fn in sorted(os.listdir(extra)):
            if fn.startswith(tour) and fn.endswith(".csv"):
                e = pd.read_csv(os.path.join(extra, fn), low_memory=False)
                e["main"] = e["main"].astype(str).str.lower().isin(["true", "1"]) if "main" in e.columns else True
                frames.append(e)
    df = pd.concat(frames, ignore_index=True)
    df = df[~df["score"].astype(str).str.contains("W/O|DEF|Walkover|unfinished", case=False, na=False)]
    df = df.dropna(subset=["winner_id", "loser_id", "tourney_date"])
    df["tourney_date"] = df["tourney_date"].astype(int)
    df["ro"] = df["round"].map(ROUND_ORDER).fillna(5)
    df = df.sort_values(["tourney_date", "tourney_id", "ro", "match_num"]).reset_index(drop=True)
    df["surface"] = df["surface"].where(df["surface"].isin(SURFACES), "Hard")
    for c in ("winner_id", "loser_id"):
        df[c] = df[c].astype(str).str.replace(r"\.0$", "", regex=True)
    return df


def is_qual(rnd): return bool(re.match(r"^Q\d", str(rnd)))


def to_days(d):
    s = str(int(d)); return (pd.Timestamp(int(s[:4]), int(s[4:6]), int(s[6:8])) - pd.Timestamp(2000, 1, 1)).days


def k_factor(n, level, main):
    k = 250 / ((n + 5) ** 0.4)
    if level == "G": k *= 1.1
    return k if main else k * LOWER_K


def expect(ra, rb): return 1 / (1 + 10 ** ((rb - ra) / 400))


def level_label(tour, lvl, rnd):
    lvl = str(lvl); q = is_qual(rnd)
    if lvl == "G": base = "Grand Slam"
    elif lvl in ("M", "PM"): base = "1000"
    elif lvl == "P": base = "500"
    elif lvl in ("A", "I"): base = "Tour" if tour == "atp" else "250"
    elif lvl == "F": base = "Finals"
    elif lvl == "D": base = "Team event"
    elif lvl == "C": base = "Challenger" if tour == "atp" else "WTA 125"
    elif lvl.isdigit(): base = f"ITF W{lvl}"
    else: base = lvl
    return f"{base} qualifying" if q else base


def num(v):
    try:
        f = float(v); return None if np.isnan(f) else f
    except (TypeError, ValueError):
        return None


def infer_hosts(df):
    """Host country of each event = most common nationality among its wildcard entrants
    (wildcards go overwhelmingly to home players). Falls back to the same event name in other years."""
    rows = []
    for side in ("winner", "loser"):
        sub = df[df[f"{side}_entry"].astype(str).str.upper() == "WC"][["tourney_id", "tourney_name", f"{side}_ioc", f"{side}_id"]]
        sub.columns = ["tourney_id", "tourney_name", "ioc", "pid"]; rows.append(sub)
    wc = pd.concat(rows).drop_duplicates(["tourney_id", "pid"]).dropna(subset=["ioc"])
    by_id = wc.groupby("tourney_id")["ioc"].agg(lambda x: x.value_counts().index[0] if x.value_counts().iloc[0] >= 2 else None).dropna().to_dict()
    by_name = wc.groupby("tourney_name")["ioc"].agg(lambda x: x.value_counts().index[0]).to_dict()
    return {tid: by_id.get(tid) or by_name.get(nm) for tid, nm in df[["tourney_id", "tourney_name"]].drop_duplicates().itertuples(index=False)}


def build(tour):
    df = load(tour)
    host = infer_hosts(df)
    pf = pd.read_csv(fetch(f"{DATA_DIR}/{tour}_players.csv", f"{MIRROR}/{tour}/{tour}_players.csv"), low_memory=False)
    pf["player_id"] = pf["player_id"].astype(str); pinfo = pf.set_index("player_id")
    rk = pd.read_csv(fetch(f"{DATA_DIR}/{tour}_rankings_current.csv", f"{MIRROR}/{tour}/{tour}_rankings_current.csv"))
    rank_date = int(rk.ranking_date.max())
    cur = rk[rk.ranking_date == rank_date].copy(); cur["player"] = cur["player"].astype(str)
    cur_rank = dict(zip(cur.player, cur["rank"])); cur_pts = dict(zip(cur.player, cur.points))
    r20 = pd.read_csv(fetch(f"{DATA_DIR}/{tour}_rankings_20s.csv", f"{MIRROR}/{tour}/{tour}_rankings_20s.csv"))
    r20["player"] = r20["player"].astype(str); best_rank = r20.groupby("player")["rank"].min().to_dict()

    elo = defaultdict(lambda: 1500.0); selo = {s: defaultdict(lambda: 1500.0) for s in SURFACES}
    n = defaultdict(int); nmain = defaultdict(int); sn = {s: defaultdict(int) for s in SURFACES}
    roll = defaultdict(deque); recent = defaultdict(lambda: deque(maxlen=10))
    names, hist, log, peak, meta = {}, defaultdict(list), defaultdict(list), {}, {}
    h2h = defaultdict(int)                     # (a, b) -> wins of a over b
    recent_days = defaultdict(deque)           # recent match days
    lastday = {}
    retday = {}                                # last time a player retired mid-match
    prevmatch = {}                             # pid -> (tourney_id, minutes of last match)
    hday, helo = defaultdict(list), defaultdict(list)   # rating history for momentum

    sv = df[df.main][["w_1stWon", "w_2ndWon", "w_svpt", "l_1stWon", "l_2ndWon", "l_svpt"]].dropna()
    tour_sv = (sv.w_1stWon.sum() + sv.w_2ndWon.sum() + sv.l_1stWon.sum() + sv.l_2ndWon.sum()) / (sv.w_svpt.sum() + sv.l_svpt.sum())

    def rolling(pid, day):
        q = roll[pid]
        while q and q[0][0] < day - 365: q.popleft()
        a = np.array(q) if q else np.zeros((0, 5))
        svw, svp, rtw, rtp = (a[:, 1:].sum(0) if len(a) else (0, 0, 0, 0))
        return (svw + PRIOR_PTS * tour_sv) / (svp + PRIOR_PTS), (rtw + PRIOR_PTS * (1 - tour_sv)) / (rtp + PRIOR_PTS), svp

    def elo_ago(pid, day, back=90):
        ds = hday[pid]
        if not ds: return elo[pid]
        i = bisect.bisect_right(ds, day - back) - 1
        return helo[pid][i] if i >= 0 else 1500.0
    def fnum(v):
        v = num(v); return v

    def context(w, l, day, r):
        for pid in (w, l):
            q = recent_days[pid]
            while q and q[0] < day - 14: q.popleft()
        hw, hl = h2h[(w, l)], h2h[(l, w)]
        wa, la = fnum(r.winner_age), fnum(r.loser_age)
        wh, lh = fnum(r.winner_ht), fnum(r.loser_ht)
        lay = lambda p: 1 if (p in lastday and day - lastday[p] > 60) else 0
        hc = host.get(r.tourney_id)
        home = lambda ioc: 1 if (hc and isinstance(ioc, str) and ioc == hc) else 0
        rec_ret = lambda p: 1 if (p in retday and day - retday[p] <= 30) else 0
        def pmin(p):
            t = prevmatch.get(p)
            return (t[1] or 0) / 60 if (t and t[0] == r.tourney_id) else 0.0
        rw, rl = fnum(r.winner_rank), fnum(r.loser_rank)
        return dict(home_d=home(r.winner_ioc) - home(r.loser_ioc),
                    ret_d=rec_ret(w) - rec_ret(l),
                    prevmin_d=pmin(w) - pmin(l),
                    rank_d=math.log(rl or 1500) - math.log(rw or 1500),
                    sexp_d=math.log1p(sn[r.surface][w]) - math.log1p(sn[r.surface][l]),
                    big_d=((elo[w] - elo[l]) + (selo[r.surface][w] - selo[r.surface][l])) / 2 * (1 if r.tourney_level == "G" else 0),
                    h2h_d=(hw - hl) / (hw + hl + 3),
                    lefty_d=(1 if r.winner_hand == "L" else 0) - (1 if r.loser_hand == "L" else 0),
                    age_d=(wa - la) / 5 if (wa and la) else 0.0,
                    trend_d=((elo[w] - elo_ago(w, day)) - (elo[l] - elo_ago(l, day))) / 100,
                    layoff_d=lay(w) - lay(l),
                    load_d=len(recent_days[w]) - len(recent_days[l]),
                    exp_d=math.log1p(nmain[w]) - math.log1p(nmain[l]),
                    ht_d=(wh - lh) / 10 if (wh and lh) else 0.0)

    rows = []
    for r in df.itertuples(index=False):
        w, l, s, day, main = r.winner_id, r.loser_id, r.surface, to_days(r.tourney_date), bool(r.main)
        names[w], names[l] = r.winner_name, r.loser_name
        tour_main = main and not is_qual(r.round)
        if tour_main:
            ws, wr, _ = rolling(w, day); ls, lr, _ = rolling(l, day)
            rows.append(dict(date=r.tourney_date, elo_d=elo[w] - elo[l], selo_d=selo[s][w] - selo[s][l],
                             sv_d=(ws - ls) * 100, rt_d=(wr - lr) * 100,
                             form_d=(np.mean(recent[w]) if recent[w] else .5) - (np.mean(recent[l]) if recent[l] else .5),
                             bo5=1 if r.best_of == 5 else 0, min_n=min(n[w], n[l]), p_elo=expect(elo[w], elo[l]),
                             p_selo=expect(selo[s][w], selo[s][l]), p_blend=expect((elo[w] + selo[s][w]) / 2, (elo[l] + selo[s][l]) / 2),
                             **context(w, l, day, r)))
        e = expect(elo[w], elo[l])
        elo[w] += k_factor(n[w], r.tourney_level, main) * (1 - e); elo[l] -= k_factor(n[l], r.tourney_level, main) * (1 - e)
        es = expect(selo[s][w], selo[s][l])
        selo[s][w] += k_factor(sn[s][w], r.tourney_level, main) * (1 - es); selo[s][l] -= k_factor(sn[s][l], r.tourney_level, main) * (1 - es)
        n[w] += 1; n[l] += 1; sn[s][w] += 1; sn[s][l] += 1
        if tour_main: nmain[w] += 1; nmain[l] += 1
        recent[w].append(1); recent[l].append(0)
        h2h[(w, l)] += 1
        if isinstance(r.score, str) and "RET" in r.score.upper(): retday[l] = day
        mins = num(getattr(r, "minutes", None))
        prevmatch[w] = (r.tourney_id, mins); prevmatch[l] = (r.tourney_id, mins)
        for pid in (w, l):
            recent_days[pid].append(day); lastday[pid] = day
            hday[pid].append(day); helo[pid].append(elo[pid])

        wst = [num(getattr(r, "w_" + c)) for c in STAT_COLS]; lst = [num(getattr(r, "l_" + c)) for c in STAT_COLS]
        has = all(v is not None for v in wst + lst) and wst[2] > 0 and lst[2] > 0
        if has:
            w_sw, l_sw = wst[4] + wst[5], lst[4] + lst[5]
            roll[w].append((day, w_sw, wst[2], lst[2] - l_sw, lst[2])); roll[l].append((day, l_sw, lst[2], wst[2] - w_sw, wst[2]))
        lbl = level_label(tour, r.tourney_level, r.round)
        score = r.score if isinstance(r.score, str) else ""
        for pid, opp, won, mine, theirs, orank in ((w, l, 1, wst, lst, num(r.loser_rank)), (l, w, 0, lst, wst, num(r.winner_rank))):
            log[pid].append((int(r.tourney_date), r.tourney_name, lbl, s, r.round, opp, won, score, tour_main, orank,
                             (mine, theirs) if has else None, str(r.tourney_level)))
            hist[pid].append((int(r.tourney_date), round(elo[pid])))
            if elo[pid] > peak.get(pid, (0, 0))[0]: peak[pid] = (round(elo[pid]), int(r.tourney_date))
        for pid, age, hand, ioc, ht in ((w, r.winner_age, r.winner_hand, r.winner_ioc, r.winner_ht), (l, r.loser_age, r.loser_hand, r.loser_ioc, r.loser_ht)):
            prev = meta.get(pid, {})
            meta[pid] = dict(hand=hand if isinstance(hand, str) and hand in ("R", "L") else prev.get("hand", ""),
                             ioc=ioc if isinstance(ioc, str) else prev.get("ioc", ""),
                             ht=int(num(ht)) if num(ht) else prev.get("ht"))

    # ---------------------------------------------------------------- model (tour-level main draw only)
    feats = pd.DataFrame(rows)
    BASE = ["elo_d", "selo_d", "sv_d", "rt_d", "form_d", "elo_bo5"]
    PREV = BASE + ["h2h_d", "lefty_d", "age_d", "trend_d", "layoff_d", "load_d", "exp_d", "ht_d"]
    CANDIDATES = ["home_d", "ret_d", "prevmin_d", "rank_d", "sexp_d", "big_d"]
    feats["elo_bo5"] = (feats.elo_d + feats.selo_d) / 2 * feats.bo5
    scored = feats[(feats.date >= WARMUP_END) & (feats.min_n >= 5)].copy()
    rng = np.random.default_rng(7); flip = rng.random(len(scored)) < 0.5
    sgn = np.where(flip, -1, 1)[:, None]; yy = np.where(flip, 0, 1)
    tr_, te_ = (scored.date < TRAIN_END).to_numpy(), (scored.date >= TRAIN_END).to_numpy()
    def fit_ll(cols):
        Xc = scored[cols].to_numpy() * sgn
        mdl = LogisticRegression(fit_intercept=False, max_iter=2000).fit(Xc[tr_], yy[tr_])
        return log_loss(yy[te_], mdl.predict_proba(Xc[te_])[:, 1])
    base_ll = fit_ll(PREV); ablation = {}
    for c in CANDIDATES:
        ablation[c] = round(base_ll - fit_ll(PREV + [c]), 5)
    keep = [c for c in CANDIDATES if ablation[c] > 0.00005]
    X_COLS = PREV + keep
    # confirm the combined set still beats the previous model; drop the weakest until it does
    while keep and fit_ll(X_COLS) >= base_ll:
        keep.remove(min(keep, key=lambda c: ablation[c])); X_COLS = PREV + keep
    X = scored[X_COLS].to_numpy() * np.where(flip, -1, 1)[:, None]; y = np.where(flip, 0, 1)
    train, test = (scored.date < TRAIN_END).to_numpy(), (scored.date >= TRAIN_END).to_numpy()
    model = LogisticRegression(fit_intercept=False, max_iter=2000).fit(X[train], y[train])
    pm = model.predict_proba(X)[:, 1]
    Xb = X[:, :len(BASE)]
    base_model = LogisticRegression(fit_intercept=False, max_iter=2000).fit(Xb[train], y[train])
    pb = base_model.predict_proba(Xb)[:, 1]
    def rep(p, m):
        return dict(acc=round(float(((p[m] > .5) == y[m]).mean()), 4), logloss=round(float(log_loss(y[m], p[m])), 4),
                    brier=round(float(brier_score_loss(y[m], p[m])), 4), n=int(m.sum()))
    fl = lambda c: np.where(flip, 1 - scored[c].to_numpy(), scored[c].to_numpy())
    backtest = {"Overall Elo only": rep(fl("p_elo"), test), "Surface Elo only": rep(fl("p_selo"), test),
                "Blended Elo (50/50)": rep(fl("p_blend"), test), "Elo + serve/return + form": rep(pb, test),
                "Full model (all factors)": rep(pm, test)}
    pt, yt = pm[test], y[test]; ps = np.where(pt >= .5, pt, 1 - pt); ys = np.where(pt >= .5, yt, 1 - yt); cal = []
    for lo in np.arange(.5, 1, .05):
        m = (ps >= lo) & (ps < lo + .05)
        if m.sum() >= 30:
            cal.append(dict(bucket=f"{int(lo*100)}–{int(lo*100)+5}%", predicted=round(float(ps[m].mean()), 3),
                            actual=round(float(ys[m].mean()), 3), n=int(m.sum())))

    # ---------------------------------------------------------------- players + profiles
    end_date = int(df.tourney_date.max()); end_day = to_days(end_date); season = end_date // 10000
    active = {p for p in n if log[p] and log[p][-1][0] >= end_date - 10000}
    by_elo = sorted([p for p in active if n[p] >= 10], key=lambda p: -elo[p])[:TOP_N]
    official = sorted([p for p, rnk in cur_rank.items() if rnk <= TOP_N], key=lambda p: cur_rank[p])
    chosen = list(dict.fromkeys(official + by_elo))

    def wl(ms): return [sum(m[6] for m in ms), sum(1 - m[6] for m in ms)]

    def summarize(pid):
        L = log[pid]
        yr = [m for m in L if m[0] // 10000 == season]
        yr_main = [m for m in yr if m[8]]
        last52 = [m for m in L if to_days(m[0]) >= end_day - 365]
        titles = [m[1] for m in yr if m[4] == "F" and m[6] == 1 and m[11] != "D"]
        tour_titles = [m[1] for m in yr_main if m[4] == "F" and m[6] == 1 and m[11] != "D"]
        slams = {}
        for m in yr_main:
            if m[11] == "G":
                rd = {"R128": "R1", "R64": "R2", "R32": "R3", "R16": "R4"}.get(m[4], m[4])
                slams[m[1]] = "W" if (m[4] == "F" and m[6]) else rd
        agg = np.zeros((2, len(STAT_COLS))); k = 0
        for m in last52:
            if m[10]: agg += np.array(m[10], dtype=float); k += 1
        st = None
        if k >= 3:
            me, th = agg
            pc = lambda a, b: round(float(a / b * 100), 1) if b > 0 else None
            st = dict(spw=pc(me[4] + me[5], me[2]), ace=pc(me[0], me[2]), df=pc(me[1], me[2]), fsin=pc(me[3], me[2]),
                      fsw=pc(me[4], me[3]), ssw=pc(me[5], me[2] - me[3]), bps=pc(me[7], me[8]),
                      hold=pc(me[6] - (me[8] - me[7]), me[6]), rpw=pc(th[2] - th[4] - th[5], th[2]),
                      bpc=pc(th[8] - th[7], th[8]), brk=pc(th[8] - th[7], th[6]), matches=k)
        rec = [[m[0], m[1], m[2], m[3], m[4], names.get(m[5], "?"), m[6], m[7], m[5]] for m in L[-15:]][::-1]
        return dict(season=wl(yr), season_main=wl(yr_main), all52=wl(last52),
                    s52={s: wl([m for m in last52 if m[3] == s]) for s in SURFACES},
                    top10=wl([m for m in last52 if m[9] is not None and m[9] <= 10]),
                    top50=wl([m for m in last52 if m[9] is not None and m[9] <= 50]),
                    titles=titles, tour_titles=tour_titles, slams=slams, st=st, recent=rec)

    empty = dict(season=[0, 0], season_main=[0, 0], all52=[0, 0], s52={s: [0, 0] for s in SURFACES}, top10=[0, 0], top50=[0, 0],
                 titles=[], tour_titles=[], slams={}, st=None, recent=[])
    out = []
    for p in chosen:
        info = pinfo.loc[p] if p in pinfo.index else None
        if isinstance(info, pd.DataFrame): info = info.iloc[0]
        nm = names.get(p) or (f"{info.name_first} {info.name_last}" if info is not None else p)
        m = dict(meta.get(p, {}))
        age = None
        if info is not None:
            if not m.get("ioc") and isinstance(info.ioc, str): m["ioc"] = info.ioc
            if not m.get("hand") and isinstance(info.hand, str) and info.hand in ("R", "L"): m["hand"] = info.hand
            if not m.get("ht") and num(info.height): m["ht"] = int(info.height)
            if num(info.dob):
                age = round((pd.Timestamp(str(end_date)) - pd.Timestamp(str(int(info.dob)))).days / 365.25, 2)
        spw, rpw, pts = rolling(p, end_day)
        hmon = {}
        for d, e in hist[p]: hmon[d // 100] = e
        months = sorted(hmon)
        spark = [hmon[k] for k in months if k >= (end_date // 100) - 300][-36:]
        long = [[k, hmon[k]] for k in months if k >= (end_date // 100) - 500]
        prof = summarize(p) if log[p] else empty
        out.append(dict(id=p, name=nm, ioc=m.get("ioc", ""), hand=m.get("hand", ""), ht=m.get("ht"), age=age, age_date=end_date,
                        elo=round(elo[p], 1), selo={s: round(selo[s][p], 1) for s in SURFACES}, n=n[p], nm=nmain[p],
                        sn={s: sn[s][p] for s in SURFACES}, sv=round(spw * 100, 2), rt=round(rpw * 100, 2), stat_pts=int(pts),
                        form=list(recent[p]), last=log[p][-1][0] if log[p] else None, spark=spark, hist=long,
                        peak=list(peak.get(p, (1500, None))), rank=cur_rank.get(p), pts=cur_pts.get(p), best=best_rank.get(p), **prof))
    out.sort(key=lambda x: -x["elo"])
    ids = set(chosen); pairs = {}
    for (a, b) in list(h2h.keys()):
        if a in ids and b in ids:
            x, z = (a, b) if a < b else (b, a)
            pairs[f"{x}|{z}"] = [h2h.get((x, z), 0), h2h.get((z, x), 0)]
    for p in out:
        p["trend"] = round(elo[p["id"]] - elo_ago(p["id"], end_day), 1)
    return dict(tour=tour.upper(), data_through=end_date, rank_date=rank_date, matches=int(df.main.sum()), all_matches=int(len(df)),
                tour_sv=round(tour_sv * 100, 2), coef=dict(zip(X_COLS, [round(float(c), 6) for c in model.coef_[0]])),
                backtest=backtest, calibration=cal, players=out, h2h=pairs, ablation=ablation, kept=keep)


if __name__ == "__main__":
    out = {t: build(t) for t in ("atp", "wta")}
    out["built"] = pd.Timestamp.now().strftime("%Y%m%d")
    with open("snapshot.json", "w") as fh:
        json.dump(out, fh, separators=(",", ":"), default=lambda o: o.item() if hasattr(o, "item") else str(o))
    for t in ("atp", "wta"):
        d = out[t]
        print(f"\n== {d['tour']}: {d['matches']:,} tour-level / {d['all_matches']:,} total, through {d['data_through']}, rankings {d['rank_date']}")
        print("   players:", len(d["players"]), " official top-200 included:", sum(1 for p in d["players"] if p["rank"] and p["rank"] <= TOP_N))
        print("   ablation (log-loss gain per candidate):", d["ablation"], " kept:", d["kept"])
        print("   coef:", d["coef"])
        for k, v in d["backtest"].items(): print(f"   {k:34s} acc {v['acc']:.3f}  logloss {v['logloss']:.4f}  brier {v['brier']:.4f}")
        print("   top 8:", [(p["name"], round(p["elo"]), p["rank"]) for p in d["players"][:8]])
