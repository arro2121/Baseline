# field names of the sources, so the fetcher reads the right ones
import json, urllib.request
UA = {"User-Agent": "Mozilla/5.0"}
def j(u): return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read())
try:
    d = j("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20250110")
    c = d["events"][0]["competitions"][0]
    print("NBA competitor stats:", [s.get("name") for s in c["competitors"][0].get("statistics", [])])
    print("NBA odds:", json.dumps(c.get("odds"))[:600])
    print("NBA season:", d["events"][0].get("season"))
except Exception as e: print("nba peek", e)
try:
    d = j("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=true&start=0&limit=2&cayenneExp=seasonId=20242025%20and%20gameTypeId=2")
    print("NHL summary:", d.get("total"), json.dumps(d["data"][0])[:900])
    g = j("https://api.nhle.com/stats/rest/en/game?cayenneExp=season=20242025%20and%20gameType=2")
    print("NHL game:", len(g["data"]), json.dumps(g["data"][0])[:500])
except Exception as e: print("nhl peek", e)
try:
    d = j("https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2025-06-01&endDate=2025-06-01&hydrate=probablePitcher")
    print("MLB game:", json.dumps(d["dates"][0]["games"][0])[:700])
except Exception as e: print("mlb peek", e)
