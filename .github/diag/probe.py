# Which ESPN addresses answer a browser (with CORS) for standings, team pages, schedules, rosters and news; saves samples.
import json, os, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
os.makedirs("samples", exist_ok=True)
def get(url, save=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Origin": "https://arro2121.github.io"})
    try:
        r = urllib.request.urlopen(req, timeout=30); body = r.read(); acao = r.headers.get("access-control-allow-origin")
        ok = body[:1] in (b"{", b"[")
        print(f"{r.status} cors={acao} {len(body)}B {'json' if ok else 'NOT JSON'} {url}")
        if save and ok: open("samples/" + save, "wb").write(body)
        return json.loads(body) if ok else None
    except Exception as e:
        print(f"ERR {e} {url}"); return None
W, S = "https://site.web.api.espn.com/apis", "https://site.api.espn.com/apis"
P = {"nfl": "football/nfl", "nba": "basketball/nba", "mlb": "baseball/mlb", "nhl": "hockey/nhl", "epl": "soccer/eng.1"}
for lg, p in P.items():
    print("\n==", lg)
    get(f"{W}/v2/sports/{p}/standings", f"{lg}_standings.json")
    get(f"{W}/site/v2/sports/{p}/news?limit=12", f"{lg}_news.json")
    teams = get(f"{W}/site/v2/sports/{p}/teams", f"{lg}_teams.json")
    tid = teams["sports"][0]["leagues"][0]["teams"][0]["team"]["id"] if teams else "1"
    get(f"{W}/site/v2/sports/{p}/teams/{tid}", f"{lg}_team.json")
    get(f"{W}/site/v2/sports/{p}/teams/{tid}/schedule", f"{lg}_schedule.json")
    get(f"{W}/site/v2/sports/{p}/teams/{tid}/roster", f"{lg}_roster.json")
    get(f"{W}/site/v2/sports/{p}/news?team={tid}&limit=6", f"{lg}_teamnews.json")
    get(f"https://cdn.espn.com/core/{'soccer' if lg == 'epl' else lg}/standings?xhr=1" + ("&league=eng.1" if lg == "epl" else ""))
