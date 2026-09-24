# Downloads real ESPN summaries for each sport so the play-by-play can be designed against real data.
import json, urllib.request, os
B = "https://site.web.api.espn.com/apis/site/v2/sports/"
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))
os.makedirs("samples", exist_ok=True)
picks = {"mlb": ("baseball/mlb", ["", "20260920"]), "nfl": ("football/nfl", ["20260921", "20260914"]), "nhl": ("hockey/nhl", ["", "20260922"]),
         "epl": ("soccer/eng.1", ["20260920", ""]), "nba": ("basketball/nba", ["20260612", "20260610", "20260605"])}
for lg, (path, dates) in picks.items():
    got = []
    for d in dates:
        sb = get(f"{B}{path}/scoreboard" + (f"?dates={d}" if d else ""))
        json.dump(sb, open(f"samples/{lg}_scoreboard{('_' + d) if d else ''}.json", "w"))
        for e in sb.get("events", []):
            st = e["status"]["type"]["state"]
            if st in ("in", "post") and st not in [g[1] for g in got]:
                got.append((e["id"], st))
        if len(got) >= 2: break
    for gid, st in got[:2]:
        s = get(f"{B}{path}/summary?event={gid}")
        json.dump(s, open(f"samples/{lg}_{st}_{gid}.json", "w"))
        print(lg, st, gid, "keys:", list(s)[:25])
