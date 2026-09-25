import json, urllib.request
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60) as r: return json.loads(r.read())
for path in ("football/college-football", "basketball/mens-college-basketball"):
    d = get(f"https://site.web.api.espn.com/apis/v2/sports/{path}/standings")
    ch = d["children"][3]; e = ch["standings"]["entries"][0]
    print("==", path, ch.get("name"), e["team"]["displayName"], "seasons", d.get("seasons", [{}])[0].get("displayName") if d.get("seasons") else None, "stand keys", list(ch["standings"].keys()))
    for s in e["stats"]: print("  ", {k: s.get(k) for k in ("name", "type", "abbreviation", "displayName", "displayValue", "summary")})
    print("  note", e.get("note"))
for q in ("", "?dates=20260926&limit=300", "?dates=20260926", "?limit=300"):
    d = get(f"https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard{q}")
    print("cfb board", q or "(none)", len(d.get("events", [])), sorted({e["date"][:10] for e in d.get("events", [])}))
for q in ("?dates=20251206&groups=50&limit=400", "?dates=20251206"):
    d = get(f"https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard{q}")
    print("cbb board", q, len(d.get("events", [])))
d = get("https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260926&limit=300")
e = d["events"][0]; c = e["competitions"][0]
print("odds", json.dumps(c.get("odds"))[:400])
print("rank", [x.get("curatedRank") for x in c["competitors"]])
