// Which free sources give real player stats and headshots? Saves a small sample of each.
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(".github/diag/p", { recursive: true });
const H = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
const tries = {
  mlb_hit: "https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&season=2026&sportId=1&limit=5&sortStat=onBasePlusSlugging&playerPool=QUALIFIED&hydrate=team",
  mlb_pitch: "https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=2026&sportId=1&limit=5&sortStat=strikeouts&playerPool=QUALIFIED&hydrate=team",
  nhl_sk: "https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22points%22,%22direction%22:%22DESC%22%7D%5D&start=0&limit=5&cayenneExp=seasonId=20252026%20and%20gameTypeId=2",
  nhl_g: "https://api.nhle.com/stats/rest/en/goalie/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22wins%22,%22direction%22:%22DESC%22%7D%5D&start=0&limit=5&cayenneExp=seasonId=20252026%20and%20gameTypeId=2",
  nhl_leaders: "https://api-web.nhle.com/v1/skater-stats-leaders/20252026/2?categories=goals&limit=5",
  nba: "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=5&sort=offensive.avgPoints:desc&season=2026&seasontype=2",
  nfl_pass: "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=5&sort=passing.passingYards:desc&season=2025&seasontype=2",
  nfl_rec: "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=5&sort=receiving.receivingYards:desc&season=2025&seasontype=2",
  nfl_kick: "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=5&sort=kicking.fieldGoalsMade:desc&season=2025&seasontype=2",
  epl: "https://site.web.api.espn.com/apis/common/v3/sports/soccer/eng.1/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=5&sort=offensive.totalGoals:desc&season=2025&seasontype=1",
  epl2: "https://site.web.api.espn.com/apis/common/v3/sports/soccer/eng.1/statistics/byathlete?region=us&lang=en&contentorigin=espn&page=1&limit=5&season=2025",
  epl_stats: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/statistics?season=2025",
  epl_roster: "https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/359/roster",
  fpl: "https://fantasy.premierleague.com/api/bootstrap-static/",
  nba_img: "https://a.espncdn.com/i/headshots/nba/players/full/3945274.png",
  mlb_img: "https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_auto:best/v1/people/592450/headshot/67/current",
};
for (const [k, u] of Object.entries(tries)) {
  try { const r = await fetch(u, { headers: H }); const ct = r.headers.get("content-type") || ""; const b = Buffer.from(await r.arrayBuffer());
    console.log(k, r.status, ct, b.length);
    if (ct.includes("json")) writeFileSync(`.github/diag/p/${k}.json`, b.toString().slice(0, 60000));
  } catch (e) { console.log(k, "ERR", e.message); }
}
