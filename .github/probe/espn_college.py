import json, urllib.request
for u in ["https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20240907&groups=80&limit=1000",
          "https://cdn.espn.com/core/college-football/scoreboard?xhr=1&dates=20240907",
          "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events?dates=20240907&limit=5",
          "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=20250201&groups=50",
          "https://www.espn.com/college-football/scoreboard",
          "https://baseline-alerts.baseline-arro2121-3091.workers.dev/sports/nfl/scoreboard",
          "https://api.collegefootballdata.com/games?year=2024",
          "https://ncaa-api.henrygd.me/scoreboard/football/fbs/2024/01/all-conf",
          "https://data.ncaa.com/casablanca/scoreboard/basketball-men/d1/2025/02/01/scoreboard.json"]:
    for ua in ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": ua}), timeout=30) as r: b = r.read(); print("OK", r.status, len(b), u, b[:160])
        except Exception as e: print("ERR", e, u)
