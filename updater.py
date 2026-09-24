"""
Baseline updater: pulls data from API-Tennis (https://api-tennis.com) and writes it where the site and
rating engine read it.

  python updater.py live       -> docs/live.json          (live, today's finished and upcoming singles matches)
  python updater.py results    -> data/extra/api_results.csv (finished matches since the last run, for the ratings)
  python updater.py rankings   -> data/rankings_live.json (full current ATP and WTA rankings)

Needs the environment variable API_TENNIS_KEY. Set BASELINE_MOCK=tests to run against the sample files in
tests/ instead of the network (used for testing).
"""
import csv, datetime as dt, json, os, re, sys, unicodedata, urllib.parse, urllib.request

API = "https://api.api-tennis.com/tennis/"
KEY = os.environ.get("API_TENNIS_KEY", "")
MOCK = os.environ.get("BASELINE_MOCK")
TYPES = {  # API event type -> (tour, is tour-level main draw)
    "Atp Singles": ("atp", True), "Wta Singles": ("wta", True),
    "Challenger Men Singles": ("atp", False), "Challenger Women Singles": ("wta", False),
}
SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")
MASTERS = ("indian wells", "miami", "monte carlo", "madrid", "rome", "canada", "montreal", "toronto", "cincinnati",
           "shanghai", "paris", "beijing", "wuhan", "doha", "dubai")
SURFACE = {  # tournament name keywords -> surface; anything unknown is treated as hard court
    "Clay": ("roland garros", "french open", "monte carlo", "madrid", "rome", "barcelona", "hamburg", "munich", "geneva",
             "lyon", "estoril", "houston", "marrakech", "bucharest", "buenos aires", "santiago", "rio", "cordoba",
             "umag", "kitzbuhel", "gstaad", "bastad", "stuttgart wta", "charleston", "rabat", "strasbourg", "bogota",
             "parma", "palermo", "iasi", "prague", "genoa", "tolentino", "sassuolo", "florence", "cagliari", "turin"),
    "Grass": ("wimbledon", "halle", "queen", "london", "s-hertogenbosch", "hertogenbosch", "mallorca", "eastbourne",
              "newport", "berlin", "bad homburg", "nottingham", "birmingham", "ilkley", "surbiton"),
}
ROUNDS = [("1/64", "R128"), ("1/32", "R64"), ("1/16", "R32"), ("1/8", "R16"), ("1/4", "QF"), ("quarter", "QF"),
          ("1/2", "SF"), ("semi", "SF"), ("final", "F")]


def norm(s):
    return re.sub(r"[^a-z ]", " ", unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()).split()


def call(method, **params):
    if MOCK:
        with open(os.path.join(MOCK, f"{method}.json")) as fh:
            data = json.load(fh)
    else:
        if not KEY:
            sys.exit("API_TENNIS_KEY is not set. Add it as a repository secret (see README).")
        q = urllib.parse.urlencode({"method": method, "APIkey": KEY, **params})
        with urllib.request.urlopen(API + "?" + q, timeout=40) as r:
            data = json.load(r)
    if not data.get("success"):
        raise RuntimeError(f"API-Tennis {method} failed: {str(data)[:300]}")
    return data.get("result") or []


def surface_of(name, tour=None):
    n = f' {" ".join(norm(name))} '
    if " stuttgart " in n:
        return "Grass" if tour == "atp" else "Clay"
    for surf, keys in SURFACE.items():
        if any(f' {" ".join(norm(k))} ' in n for k in keys):   # whole words only ("challenger" must not match "halle")
            return surf
    return "Hard"


class Players:
    """Resolves API names like 'J. Sinner' to the full names and ids used by the ratings."""
    def __init__(self):
        self.rated = {"atp": [], "wta": []}
        if os.path.exists("snapshot.json"):
            snap = json.load(open("snapshot.json"))
            for t in ("atp", "wta"):
                self.rated[t] = [(p["id"], p["name"]) for p in snap[t]["players"]]
        self.db = {"atp": [], "wta": []}
        for t in ("atp", "wta"):
            path = f"data/{t}_players.csv"
            if os.path.exists(path):
                with open(path, newline="", encoding="utf-8") as fh:
                    for r in csv.DictReader(fh):
                        self.db[t].append((r["player_id"], f'{r.get("name_first","")} {r.get("name_last","")}'.strip(),
                                           r.get("hand", ""), r.get("ioc", ""), r.get("height", ""), r.get("dob", "")))

    @staticmethod
    def _split(api_name):
        m = re.match(r"^\s*([A-Za-z]+)\.\s*(.+)$", api_name)
        return (norm(m.group(1))[0][0], norm(m.group(2))) if m else ("", norm(api_name))

    def _find(self, api_name, rows):
        ini, sur = self._split(api_name)
        hits = []
        for row in rows:
            toks = norm(row[1])
            for cut in range(1, len(toks)):
                if toks[cut:] == sur and (not ini or toks[0].startswith(ini)):
                    hits.append(row); break
        return hits

    def resolve(self, api_name, tour):
        """-> (id or None, display name, extra fields)"""
        h = self._find(api_name, self.rated[tour])
        if len(h) == 1:
            full = next((r for r in self.db[tour] if r[0] == h[0][0]), None)
            return h[0][0], h[0][1], full
        h = self._find(api_name, self.db[tour])
        if len(h) == 1:
            return h[0][0], h[0][1], h[0]
        return None, api_name, None


def sets_of(e):
    out = []
    for s in sorted(e.get("scores") or [], key=lambda s: int(float(s.get("score_set") or 0))):
        f = lambda v: int(float(str(v).split(".")[0] or 0)) if str(v).strip() not in ("", "-") else 0
        out.append([f(s.get("score_first")), f(s.get("score_second"))])
    return out


def event_label(e, tour, main):
    name = e.get("tournament_name", "").strip()
    if not main:
        base = re.sub(r"\s*(challenger|wta 125k?|125k?)\s*", " ", name, flags=re.I)
        base = re.sub(r"\s+(men|women)\s*$", "", base, flags=re.I).strip()
        return f"ATP Challenger {base}" if tour == "atp" else f"WTA 125 {base}"
    return f"{tour.upper()} {name}"


def cmd_live():
    P = Players()
    now = dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(dt.timezone(dt.timedelta(hours=-4))).date()
    live = call("get_livescore", timezone="America/New_York")
    fixtures = call("get_fixtures", date_start=str(today), date_stop=str(today), timezone="America/New_York")
    out, seen = [], set()
    for e in list(live) + list(fixtures):
        t = TYPES.get(e.get("event_type_type"))
        if not t or str(e.get("event_key")) in seen:
            continue
        seen.add(str(e.get("event_key")))
        tour, main = t
        st = str(e.get("event_status", "")).lower()
        status = "live" if str(e.get("event_live")) == "1" else "final" if st in ("finished", "retired") else "scheduled" if st in ("", "not started") else None
        if not status:
            continue
        _, a, _ = P.resolve(e.get("event_first_player", ""), tour)
        _, b, _ = P.resolve(e.get("event_second_player", ""), tour)
        m = dict(tour=tour, event=event_label(e, tour, main), surface=surface_of(e.get("tournament_name", ""), tour),
                 status=status, a=a, b=b, sets=sets_of(e) or [[0, 0]], start=e.get("event_time", ""))
        if status == "live":
            gr = str(e.get("event_game_result") or "")
            if re.match(r"^\s*\w+\s*-\s*\w+\s*$", gr) and gr.strip() != "-":
                m["pts"] = gr.replace(" ", "")
            m["srv"] = {"First Player": "a", "Second Player": "b"}.get(e.get("event_serve"))
        if status == "final" and e.get("event_winner") == "Second Player":   # winner first, like the rest of the app
            m["a"], m["b"] = m["b"], m["a"]; m["sets"] = [[y, x] for x, y in m["sets"]]
        out.append(m)
    order = {"live": 0, "final": 1, "scheduled": 2}
    out.sort(key=lambda m: (order[m["status"]], 0 if m["event"].startswith(("ATP C", "WTA 1")) else -1))
    live_n = sum(m["status"] == "live" for m in out)
    out = [m for m in out if m["status"] != "scheduled"][:60] + [m for m in out if m["status"] == "scheduled"][:12]
    os.makedirs("docs", exist_ok=True)
    json.dump({"asof": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "matches": out}, open("docs/live.json", "w"))
    print(f"live.json: {live_n} live, {len(out)} total")


def round_of(e):
    if str(e.get("event_qualification", "")).lower() == "true":
        return "Q1"
    r = str(e.get("tournament_round", "")).lower().split(" - ")[-1]
    for k, v in ROUNDS:
        if k in r:
            return v
    return "R32"


def cmd_results(days=10):
    P = Players()
    path = "data/extra/api_results.csv"
    rows, keys = [], set()
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh)); keys = {r["match_num"] for r in rows}
    ranks = {}
    if os.path.exists("data/rankings_live.json"):
        rl = json.load(open("data/rankings_live.json"))
        for t in ("atp", "wta"):
            for r in rl.get(t, []):
                ranks[(t, " ".join(norm(r["name"])))] = r["rank"]
    stop = dt.date.today() - dt.timedelta(days=1)
    since = dt.date.fromisoformat(open("data/results_since.txt").read().strip()) if os.path.exists("data/results_since.txt") else stop - dt.timedelta(days=days)
    start = max(since, stop - dt.timedelta(days=150))
    events, d0 = [], start
    while d0 <= stop:                      # weekly batches keep each response small
        d1 = min(stop, d0 + dt.timedelta(days=6))
        events += call("get_fixtures", date_start=str(d0), date_stop=str(d1))
        d0 = d1 + dt.timedelta(days=1)
    added = 0
    for e in events:
        t = TYPES.get(e.get("event_type_type"))
        if not t or str(e.get("event_key")) in keys:
            continue
        status = str(e.get("event_status", "")).lower()
        if status not in ("finished", "retired") or e.get("event_winner") not in ("First Player", "Second Player"):
            continue
        tour, main = t
        sets = sets_of(e)
        if not sets:
            continue   # walkovers and matches without a score don't count
        first_won = e["event_winner"] == "First Player"
        w_api, l_api = (e["event_first_player"], e["event_second_player"]) if first_won else (e["event_second_player"], e["event_first_player"])
        wid, wname, wx = P.resolve(w_api, tour)
        lid, lname, lx = P.resolve(l_api, tour)
        wid = wid or f"api-{e['first_player_key' if first_won else 'second_player_key']}"
        lid = lid or f"api-{e['second_player_key' if first_won else 'first_player_key']}"
        score = " ".join(f"{a}-{b}" if first_won else f"{b}-{a}" for a, b in sets) + (" RET" if status == "retired" else "")
        tname = e.get("tournament_name", "")
        low = tname.lower()
        level = "G" if any(s in low for s in SLAMS) and main else ("M" if tour == "atp" else "PM") if main and any(s in low for s in MASTERS) \
            else ("A" if tour == "atp" else "I") if main else "C"
        rnd = round_of(e)
        date = e.get("event_date", str(stop)).replace("-", "")
        def extra(x, i): return (x[i] if x and len(x) > i else "")
        rows.append(dict(
            tourney_id=f"api-{e.get('tournament_key')}-{e.get('tournament_season')}", tourney_name=tname, surface=surface_of(tname, tour),
            draw_size="", tourney_level=level, tourney_date=date, match_num=str(e.get("event_key")),
            winner_id=wid, winner_name=wname, winner_hand=extra(wx, 2), winner_ioc=extra(wx, 3), winner_ht=extra(wx, 4),
            loser_id=lid, loser_name=lname, loser_hand=extra(lx, 2), loser_ioc=extra(lx, 3), loser_ht=extra(lx, 4),
            score=score, best_of=5 if (level == "G" and tour == "atp") else 3, round=rnd,
            winner_rank=ranks.get((tour, " ".join(norm(wname))), ""), loser_rank=ranks.get((tour, " ".join(norm(lname))), ""),
            main=str(main and rnd != "Q1"), tour=tour))
        keys.add(str(e.get("event_key"))); added += 1
    os.makedirs("data/extra", exist_ok=True)
    for t in ("atp", "wta"):   # the engine reads data/extra/<tour>_*.csv
        sub = [r for r in rows if r.get("tour") == t]
        if not sub:
            continue
        with open(f"data/extra/{t}_api_results.csv", "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(sub[0].keys())); w.writeheader(); w.writerows(sub)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        if rows:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(f"results: +{added} matches, {len(rows)} stored")


def cmd_rankings():
    out = {"date": dt.date.today().strftime("%Y%m%d")}
    for t in ("ATP", "WTA"):
        out[t.lower()] = [{"rank": int(r["place"]), "name": r["player"], "points": int(float(r.get("points") or 0))}
                          for r in call("get_standings", event_type=t)
                          if str(r.get("place", "")).isdigit() and str(r.get("league", t)).upper() == t]
    os.makedirs("data", exist_ok=True)
    json.dump(out, open("data/rankings_live.json", "w"))
    print(f"rankings: {len(out['atp'])} ATP, {len(out['wta'])} WTA")


if __name__ == "__main__":
    {"live": cmd_live, "results": cmd_results, "rankings": cmd_rankings}[sys.argv[1] if len(sys.argv) > 1 else "live"]()
