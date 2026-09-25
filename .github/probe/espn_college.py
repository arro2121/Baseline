import json, urllib.request, time
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60) as r: return json.loads(r.read())
    except Exception as e: return {"_err": str(e)}
S = "https://site.web.api.espn.com/apis/site/v2/sports/"
def board(path, q):
    d = get(f"{S}{path}/scoreboard?{q}"); ev = d.get("events", [])
    print(f"-- {path} {q}: {len(ev)} events err={d.get('_err')}")
    if ev:
        e = ev[0]; c = e["competitions"][0]
        print("   event keys", sorted(e.keys())); print("   comp keys", sorted(c.keys()))
        print("   neutral", c.get("neutralSite"), "conf", c.get("conferenceCompetition"), "season", e.get("season"), "week", e.get("week"))
        for t in c["competitors"]:
            print("   team", t["homeAway"], t["team"].get("displayName"), t["team"].get("id"), t["team"].get("abbreviation"), t["team"].get("conferenceId"), "rank", t.get("curatedRank"), "score", t.get("score"), "stats", [s.get("name") for s in t.get("statistics", [])][:12])
        print("   odds", json.dumps((c.get("odds") or [{}])[0])[:300])
        print("   status", json.dumps(c.get("status"))[:200])
    return d
board("football/college-football", "dates=20240907")
board("football/college-football", "dates=20240907&groups=80&limit=1000")
board("football/college-football", "dates=20240907&groups=81&limit=1000")
board("football/college-football", "dates=20240901-20240915&groups=80&limit=1000")
board("football/college-football", "dates=2024&seasontype=2&week=2&groups=80&limit=1000")
board("football/college-football", "dates=20241230-20250121&groups=80&limit=1000")
board("basketball/mens-college-basketball", "dates=20250201")
board("basketball/mens-college-basketball", "dates=20250201&groups=50&limit=1000")
board("basketball/mens-college-basketball", "dates=20250201-20250207&groups=50&limit=1000")
board("basketball/mens-college-basketball", "dates=20250320-20250325&groups=50&limit=1000")
board("basketball/mens-college-basketball", "groups=50&limit=1000")
board("football/college-football", "groups=80&limit=1000")
for path in ("football/college-football", "basketball/mens-college-basketball"):
    d = get(f"https://site.web.api.espn.com/apis/v2/sports/{path}/standings"); print("-- standings", path, d.get("_err"), [c.get("name") for c in d.get("children", [])][:40])
    ch = d.get("children", [{}])[0]; ent = (ch.get("standings") or {}).get("entries", [])
    print("   first child entries", len(ent), ent and ent[0]["team"].get("displayName"), ent and [(s.get("name"), s.get("displayValue")) for s in ent[0].get("stats", [])][:20])
    if not ent and ch.get("children"): print("   nested", [c.get("name") for c in ch["children"]])
    d = get(f"{S}{path}/rankings"); print("-- rankings", d.get("_err"), [(r.get("name"), len(r.get("ranks", []))) for r in d.get("rankings", [])])
    r0 = (d.get("rankings") or [{}])[0].get("ranks", [])[:3]; print("   ", [(x.get("current"), x["team"].get("location"), x["team"].get("name"), x["team"].get("id")) for x in r0])
    d = get(f"{S}{path}/teams?limit=1000"); T = d.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []); print("-- teams", len(T), T and {k: T[0]["team"].get(k) for k in ("id", "displayName", "shortDisplayName", "abbreviation", "location", "name", "color")})
    d = get(f"{S}{path}/teams?limit=1000&groups={80 if 'football' in path else 50}"); T = d.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []); print("-- teams grouped", len(T))
    d = get(f"{S}{path}/news?limit=5"); print("-- news", d.get("_err"), len(d.get("articles", [])))
    d = get(f"{S}{path}/injuries"); print("-- injuries", d.get("_err"), len(d.get("injuries", [])))
d = get(f"{S}football/college-football/scoreboard?dates=20240907&groups=80&limit=1000"); eid = d["events"][0]["id"]
g = get(f"{S}football/college-football/summary?event={eid}"); print("-- cfb summary keys", sorted(g.keys()), "drives" in g, len((g.get("drives") or {}).get("previous", [])))
d = get(f"{S}basketball/mens-college-basketball/scoreboard?dates=20250201&groups=50&limit=1000"); eid = d["events"][0]["id"]
g = get(f"{S}basketball/mens-college-basketball/summary?event={eid}"); print("-- cbb summary keys", sorted(g.keys()), len(g.get("plays", [])), "periods", sorted({p.get("period", {}).get("number") for p in g.get("plays", [])}))
bs = g.get("boxscore", {}).get("players", [{}])[0].get("statistics", [{}])[0]; print("   box labels", bs.get("labels"))
# a full cfb season count, to size the download
n = 0
for w in range(1, 17):
    d = get(f"{S}football/college-football/scoreboard?dates=2024&seasontype=2&week={w}&groups=80&limit=1000"); n += len(d.get("events", []))
print("-- cfb 2024 regular weeks 1-16 events", n)
d = get(f"{S}football/college-football/scoreboard?dates=2024&seasontype=3&week=1&groups=80&limit=1000"); print("-- cfb 2024 postseason", len(d.get("events", [])))
