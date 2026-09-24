import worker, { normScoreboard, normGame, normTennis } from "../worker.js";
const ok = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok  ", m); };
// --- football summary shaped exactly like ESPN's (drives > plays), from the real feed checked earlier
const nflSummary = { header: { id: "401777353", competitions: [{ status: { type: { state: "in", detail: "1st Quarter - 0:46", shortDetail: "0:46 - 1st" }, displayClock: "0:46", period: 1 },
  competitors: [{ homeAway: "home", score: "7", team: { id: "194", displayName: "Ohio State Buckeyes", abbreviation: "OSU", color: "ba0c2f", logos: [{ href: "x.png" }] } },
                { homeAway: "away", score: "3", team: { id: "84", displayName: "Indiana Hoosiers", abbreviation: "IU", color: "970310" } }] }] },
  drives: { previous: [
    { description: "6 plays, 12 yards, 2:06", plays: [
      { id: "1", sequenceNumber: "15", type: { text: "Rush" }, text: "(08:57) Shotgun #8 K.Black rush middle for 1 yard gain", awayScore: 0, homeScore: 0, period: { number: 1 }, clock: { displayValue: "8:51" }, scoringPlay: false, start: { downDistanceText: "1st & 10 at OSU 23", team: { id: "84" } }, isTurnover: false },
      { id: "2", sequenceNumber: "20", type: { text: "Field Goal Good" }, text: "#15 N.Radicic field goal attempt from 29 yards GOOD", awayScore: 3, homeScore: 0, period: { number: 1 }, clock: { displayValue: "6:51" }, scoringPlay: true, start: { downDistanceText: "4th & 10 at OSU 11", team: { id: "84" } } }] },
    { description: "3 plays, 25 yards, 0:55", plays: [
      { id: "3", sequenceNumber: "32", type: { text: "Pass Interception Return" }, text: "F.Mendoza pass intercepted by #1 D.Igbinosun", awayScore: 3, homeScore: 0, period: { number: 1 }, clock: { displayValue: "1:41" }, scoringPlay: false, isTurnover: true },
      { id: "4", sequenceNumber: "37", type: { text: "Passing Touchdown" }, text: "J. Sayin pass to C. Tate for 9 yds, for a TD (J. Fielding KICK)", awayScore: 3, homeScore: 7, period: { number: 1 }, clock: { displayValue: "0:46" }, scoringPlay: true }] }],
    current: { description: "1 play, 0 yards", plays: [{ id: "5", sequenceNumber: "39", type: { text: "Kickoff" }, text: "(00:46) #38 J.Fielding kickoff 65 yards to the IND00, Touchback", awayScore: 3, homeScore: 7, period: { number: 1 }, clock: { displayValue: "0:46" } }] } },
  winprobability: [{ homeWinPercentage: 0.61 }, { homeWinPercentage: 0.66 }] };
let g = normGame(nflSummary, "nfl");
ok(g.plays.length === 5 && g.plays[0].id === "5", "football: all plays from every drive, newest first");
ok(g.plays.find(p => p.id === "4").scoring && g.plays.find(p => p.id === "3").turnover, "football: touchdowns and turnovers flagged");
ok(g.plays.find(p => p.id === "1").down === "1st & 10 at OSU 23", "football: down and distance kept");
ok(g.home.name === "Ohio State Buckeyes" && g.home.score === "7" && g.away.score === "3", "football: teams and score");
ok(g.homeWinProb === 0.66 && g.status.short === "0:46 - 1st", "football: live win probability and clock");
// --- basketball / hockey / baseball: flat plays list
const nbaSummary = { header: { id: "1", competitions: [{ status: { type: { state: "in", shortDetail: "5:12 - 3rd" } }, competitors: [{ homeAway: "home", score: "78", team: { id: "13", displayName: "Los Angeles Lakers" } }, { homeAway: "away", score: "74", team: { id: "2", displayName: "Boston Celtics" } }] }] },
  plays: [{ id: "a", sequenceNumber: "400", text: "LeBron James makes 24-foot three point jumper", period: { number: 3, displayValue: "3rd Quarter" }, clock: { displayValue: "5:12" }, scoringPlay: true, homeScore: 78, awayScore: 74, team: { id: "13" } },
          { id: "b", sequenceNumber: "399", text: "Jayson Tatum misses driving layup", period: { number: 3 }, clock: { displayValue: "5:30" }, scoringPlay: false, homeScore: 75, awayScore: 74, team: { id: "2" } }] };
g = normGame(nbaSummary, "nba");
ok(g.plays[0].text.includes("three point") && g.plays[0].home === 78 && g.plays[0].scoring && g.plays[0].team === "13", "basketball: plays with score and team");
// --- soccer: commentary stream
const eplSummary = { header: { id: "2", competitions: [{ status: { type: { state: "in", shortDetail: "67'" } }, competitors: [{ homeAway: "home", score: "1", team: { displayName: "Arsenal" } }, { homeAway: "away", score: "0", team: { displayName: "Chelsea" } }] }] },
  commentary: [{ sequence: 1, time: { displayValue: "12'" }, text: "Attempt saved. Bukayo Saka (Arsenal) left footed shot." }, { sequence: 2, time: { displayValue: "34'" }, text: "Goal! Arsenal 1, Chelsea 0. Martin Ødegaard (Arsenal) right footed shot." }] };
g = normGame(eplSummary, "epl");
ok(g.plays[0].scoring && g.plays[0].clock === "34'" && g.plays.length === 2, "soccer: commentary with goals flagged");
// --- scoreboard with odds and situations
const sb = { events: [
  { id: "10", date: "2026-09-27T17:00Z", shortName: "BUF @ MIA", status: { type: { state: "pre", shortDetail: "9/27 - 1:00 PM EDT" } },
    competitions: [{ competitors: [{ homeAway: "home", score: "0", team: { abbreviation: "MIA", displayName: "Miami Dolphins", color: "008e97" }, records: [{ summary: "0-2" }] }, { homeAway: "away", score: "0", team: { abbreviation: "BUF", displayName: "Buffalo Bills" }, records: [{ summary: "2-0" }] }],
      odds: [{ details: "BUF -6.5", overUnder: 47.5, homeTeamOdds: { moneyLine: 230 }, awayTeamOdds: { moneyLine: -280 } }] }] },
  { id: "11", date: "2026-09-27T16:00Z", shortName: "KC @ DEN", status: { type: { state: "in", shortDetail: "Q2 3:10" } },
    competitions: [{ competitors: [{ homeAway: "home", score: "10", team: { abbreviation: "DEN", displayName: "Denver Broncos" } }, { homeAway: "away", score: "14", team: { abbreviation: "KC", displayName: "Kansas City Chiefs" } }],
      situation: { downDistanceText: "3rd & 4 at DEN 32", possession: "12", isRedZone: false, lastPlay: { text: "P.Mahomes pass short right to T.Kelce for 6 yards" } } }] }] };
const s = normScoreboard(sb, "nfl");
ok(s.games[0].id === "11" && s.games[0].situation.text === "3rd & 4 at DEN 32", "scoreboard: live games first, with down and distance");
ok(s.games[1].odds.details === "BUF -6.5" && s.games[1].odds.homeML === 230 && s.games[1].away.record === "2-0", "scoreboard: betting line and records");
const mlb = normScoreboard({ events: [{ id: "20", status: { type: { state: "in", shortDetail: "Bot 7th" } }, competitions: [{ competitors: [{ homeAway: "home", team: { displayName: "Milwaukee Brewers" } }, { homeAway: "away", team: { displayName: "Chicago Cubs" } }],
  situation: { balls: 2, strikes: 1, outs: 2, onFirst: true, onSecond: false, onThird: true, batter: { athlete: { shortName: "C. Yelich" } } } }] }] }, "mlb");
ok(JSON.stringify(mlb.games[0].situation.bases) === "[true,false,true]" && mlb.games[0].situation.outs === 2 && mlb.games[0].situation.batter === "C. Yelich", "baseball: count, outs, runners and batter");
// --- tennis point by point
const t = normTennis({ event_key: "99", event_live: "1", event_status: "Set 1", event_first_player: "J. Sinner", event_second_player: "C. Alcaraz", event_final_result: "0 - 0", event_game_result: "30 - 15", event_serve: "First Player",
  pointbypoint: [{ set_number: "Set 1", number_game: "1", player_served: "First Player", serve_winner: "First Player", serve_lost: null, score: "1 - 0", points: [{ number_point: "1", score: "15 - 0" }, { number_point: "2", score: "30 - 0" }, { number_point: "3", score: "40 - 0" }, { number_point: "4", score: "40 - 15", break_point: null }] },
                 { set_number: "Set 1", number_game: "2", player_served: "Second Player", serve_winner: "First Player", serve_lost: "Second Player", score: "2 - 0", points: [{ number_point: "1", score: "0 - 15" }, { number_point: "2", score: "15 - 40", break_point: "First Player" }] }] }, n => ({ "J. Sinner": "Jannik Sinner", "C. Alcaraz": "Carlos Alcaraz" }[n] || n));
ok(t.plays[0].text.includes("Sinner, breaking serve") && t.plays[0].scoring && t.plays.some(p => p.text.includes("break point")), "tennis: games, breaks and break points");
ok(t.home.name === "Jannik Sinner" && t.serving === "a" && t.game === "30 - 15", "tennis: names, server and current game score");
// --- the web routes, with ESPN stood in
globalThis.caches = undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = async u => { u = String(u); if (u.includes("/scoreboard")) return new Response(JSON.stringify(sb)); if (u.includes("summary?event=401777353")) return new Response(JSON.stringify(nflSummary)); return new Response("{}", { status: 404 }); };
const call = async p => (await worker.fetch(new Request("https://x" + p), {}, { waitUntil() {} }));
let r = await call("/sports/nfl/scoreboard"); ok(r.status === 200 && (await r.json()).games.length === 2 && r.headers.get("access-control-allow-origin") === "*", "route: /sports/nfl/scoreboard");
r = await call("/sports/nfl/game/401777353"); ok((await r.json()).plays.length === 5, "route: /sports/nfl/game/:id");
r = await call("/sports/nba/game/123"); ok(r.status === 502, "route: ESPN errors come back as a clear error, not a crash");
globalThis.fetch = realFetch;
