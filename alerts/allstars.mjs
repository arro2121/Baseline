// Builds docs/allstars.json: real players for Cosmo Showdown, with ratings from their real stats.
// Sources (all free, no key): MLB Stats API, NHL stats API, ESPN's stats feed (NBA, NFL), Fantasy Premier League.
// Run from the repository root: node alerts/allstars.mjs  (keeps the previous file for any sport that fails)
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const H = { "User-Agent": "Mozilla/5.0 (compatible; CosmoSports/1.0)" };
const get = async u => { const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const OUT = "docs/allstars.json";
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { sports: {} };
const now = new Date(), year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;

// percentile ranks inside a pool, mapped onto a 60-99 scale (the best at the top, nobody in the pool is bad)
function rate(list, key, fn, lo = 60, hi = 99, invert = false) {
  const vals = list.map(fn).map(v => (Number.isFinite(v) ? v : null));
  const sorted = vals.filter(v => v != null).sort((a, b) => a - b);
  list.forEach((p, i) => {
    const v = vals[i]; if (v == null) { p.r[key] = lo + 8; return; }
    let pct = sorted.length > 1 ? sorted.findIndex(x => x >= v) / (sorted.length - 1) : .5; if (invert) pct = 1 - pct;
    p.r[key] = Math.round(lo + (hi - lo) * Math.pow(pct, .85));
  });
}
const ovr = (p, w) => { let s = 0, t = 0; for (const [k, v] of Object.entries(w)) { s += p.r[k] * v; t += v; } p.ovr = Math.round(s / t); p.cost = Math.max(1, Math.min(10, Math.round((p.ovr - 58) / 4))); return p; };
const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };
const espnStat = (a, cat, name, cats) => { const c = a.categories.find(x => x.name === cat), names = cats.find(x => x.name === cat)?.names || []; return c ? num(c.totals[names.indexOf(name)]) : null; };

const builders = {
  async mlb() {
    const season = month < 4 ? year - 1 : year;
    const hit = await get(`https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&season=${season}&sportId=1&limit=70&sortStat=onBasePlusSlugging&playerPool=QUALIFIED&hydrate=team`);
    const pit = await get(`https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${season}&sportId=1&limit=30&sortStat=strikeouts&playerPool=QUALIFIED&hydrate=team`);
    const img = id => `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/${id}/headshot/67/current`;
    const hitters = hit.stats[0].splits.map(s => ({ id: "m" + s.player.id, name: s.player.fullName, team: s.team?.abbreviation || "", pos: s.position?.abbreviation || "", img: img(s.player.id), r: {},
      line: `${s.stat.homeRuns} HR · ${s.stat.avg} AVG · ${s.stat.ops} OPS`, st: { hr: s.stat.homeRuns, pa: s.stat.plateAppearances, avg: num(s.stat.avg), k: s.stat.strikeOuts, bb: s.stat.baseOnBalls } }));
    rate(hitters, "pow", p => p.st.hr / p.st.pa); rate(hitters, "con", p => p.st.avg - p.st.k / p.st.pa * .3); rate(hitters, "eye", p => p.st.bb / p.st.pa);
    hitters.forEach(p => { ovr(p, { pow: 1.2, con: 1, eye: .6 }); delete p.st; });
    const pitchers = pit.stats[0].splits.map(s => ({ id: "m" + s.player.id, name: s.player.fullName, team: s.team?.abbreviation || "", pos: "SP", img: img(s.player.id), r: {},
      line: `${s.stat.era} ERA · ${s.stat.strikeOuts} K · ${s.stat.whip} WHIP`, st: { k9: num(s.stat.strikeoutsPer9Inn), whip: num(s.stat.whip), era: num(s.stat.era) } }));
    rate(pitchers, "stuff", p => p.st.k9); rate(pitchers, "ctrl", p => p.st.whip, 60, 99, true); rate(pitchers, "run", p => p.st.era, 60, 99, true);
    pitchers.forEach(p => { ovr(p, { stuff: 1, ctrl: .8, run: 1 }); delete p.st; });
    return { season, hitters, pitchers };
  },
  async nba() {
    const season = month < 10 ? year : year + 1;
    let d; for (const s of [season, season - 1]) { try { d = await get(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=80&sort=offensive.avgPoints:desc&season=${s}&seasontype=2`); if (d.athletes?.length > 20) { d.season = s; break; } } catch {} }
    if (!d?.athletes?.length) throw new Error("no NBA data");
    const st = (a, c, n) => espnStat(a, c, n, d.categories);
    const players = d.athletes.map(a => ({ id: "b" + a.athlete.id, name: a.athlete.displayName, team: a.athlete.teamShortName || "", pos: a.athlete.position?.abbreviation || "", img: a.athlete.headshot?.href || "", r: {},
      st: { ppg: st(a, "offensive", "avgPoints"), fg: st(a, "offensive", "fieldGoalPct"), tp: st(a, "offensive", "threePointFieldGoalPct"), tpa: st(a, "offensive", "avgThreePointFieldGoalsAttempted"), ft: st(a, "offensive", "freeThrowPct"), stl: st(a, "defensive", "avgSteals"), blk: st(a, "defensive", "avgBlocks"), reb: st(a, "general", "avgRebounds") } }));
    for (const p of players) p.line = `${p.st.ppg} PPG · ${p.st.tp}% 3PT · ${p.st.fg}% FG`;
    rate(players, "three", p => p.st.tp * Math.min(1, (p.st.tpa || 0) / 5) + (p.st.tpa || 0) * .6); rate(players, "mid", p => p.st.fg + p.st.ft * .25); rate(players, "fin", p => p.st.ppg); rate(players, "def", p => p.st.stl * 1.2 + p.st.blk + p.st.reb * .15);
    players.forEach(p => { ovr(p, { three: 1, mid: .8, fin: 1.2, def: .5 }); delete p.st; });
    return { season: d.season - 1 + "-" + String(d.season).slice(2), players };
  },
  async nfl() {
    const season = month < 9 ? year - 1 : year - 1;                 // the last full season: early-season numbers are too thin
    const q = sort => get(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&sort=${sort}:desc&season=${season}&seasontype=2`);
    const [pa, re, ki] = await Promise.all([q("passing.passingYards"), q("receiving.receivingYards"), q("kicking.fieldGoalsMade")]);
    const base = a => ({ id: "f" + a.athlete.id, name: a.athlete.displayName, team: a.athlete.teamShortName || "", pos: a.athlete.position?.abbreviation || "", img: a.athlete.headshot?.href || "", r: {} });
    const qbs = pa.athletes.slice(0, 26).map(a => { const s = (c, n) => espnStat(a, c, n, pa.categories); return { ...base(a), st: { cmp: s("passing", "completionPct"), ypa: s("passing", "yardsPerPassAttempt"), td: s("passing", "passingTouchdowns"), int: s("passing", "interceptions"), rtg: s("passing", "QBRating"), yds: s("passing", "passingYards") } }; });
    qbs.forEach(p => p.line = `${p.st.yds} YDS · ${p.st.td} TD · ${p.st.int} INT`);
    rate(qbs, "acc", p => p.st.cmp); rate(qbs, "arm", p => p.st.ypa); rate(qbs, "iq", p => p.st.td / Math.max(1, p.st.int)); qbs.forEach(p => { ovr(p, { acc: 1, arm: .8, iq: .8 }); delete p.st; });
    const wrs = re.athletes.slice(0, 44).map(a => { const s = (c, n) => espnStat(a, c, n, re.categories); return { ...base(a), st: { rec: s("receiving", "receptions"), tgt: s("receiving", "receivingTargets"), yds: s("receiving", "receivingYards"), ypr: s("receiving", "yardsPerReception"), td: s("receiving", "receivingTouchdowns"), yac: s("receiving", "receivingYardsAfterCatch") } }; });
    wrs.forEach(p => p.line = `${p.st.rec} REC · ${p.st.yds} YDS · ${p.st.td} TD`);
    rate(wrs, "hands", p => p.st.rec / Math.max(1, p.st.tgt)); rate(wrs, "speed", p => p.st.ypr); rate(wrs, "route", p => p.st.yds); wrs.forEach(p => { ovr(p, { hands: 1, speed: .9, route: 1 }); delete p.st; });
    const ks = ki.athletes.slice(0, 24).map(a => { const s = (c, n) => espnStat(a, c, n, ki.categories); return { ...base(a), st: { pct: s("kicking", "fieldGoalPct"), lng: s("kicking", "longFieldGoalMade"), m50: s("kicking", "fieldGoalsMade50") } }; });
    ks.forEach(p => p.line = `${p.st.pct}% FG · long ${p.st.lng}`);
    rate(ks, "acc", p => p.st.pct); rate(ks, "leg", p => p.st.lng + (p.st.m50 || 0) * 2); ks.forEach(p => { ovr(p, { acc: 1, leg: .8 }); delete p.st; });
    return { season: String(season), qbs, wrs, ks };
  },
  async nhl() {
    const s = month < 10 ? `${year - 1}${year}` : `${year}${year + 1}`;
    const sk = await get(`https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22points%22,%22direction%22:%22DESC%22%7D%5D&start=0&limit=70&cayenneExp=seasonId=${s}%20and%20gameTypeId=2`);
    const gl = await get(`https://api.nhle.com/stats/rest/en/goalie/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22wins%22,%22direction%22:%22DESC%22%7D%5D&start=0&limit=24&cayenneExp=seasonId=${s}%20and%20gameTypeId=2`);
    const team = t => String(t || "").split(",").pop().trim(), img = (id, t) => `https://assets.nhle.com/mugs/nhl/${s}/${team(t)}/${id}.png`;
    const skaters = sk.data.map(p => ({ id: "h" + p.playerId, name: p.skaterFullName, team: team(p.teamAbbrevs), pos: p.positionCode, img: img(p.playerId, p.teamAbbrevs), r: {}, line: `${p.goals} G · ${p.assists} A · ${p.points} PTS`, st: p }));
    rate(skaters, "shot", p => p.st.goals + p.st.shootingPct * 100); rate(skaters, "pass", p => p.st.assists); rate(skaters, "hands", p => p.st.pointsPerGame);
    skaters.forEach(p => { ovr(p, { shot: 1.1, pass: .8, hands: 1 }); delete p.st; });
    const goalies = gl.data.map(p => ({ id: "h" + p.playerId, name: p.goalieFullName, team: team(p.teamAbbrevs), pos: "G", img: img(p.playerId, p.teamAbbrevs), r: {}, line: `${(p.savePct || 0).toFixed(3)} SV% · ${p.wins} W`, st: p }));
    rate(goalies, "save", p => p.st.savePct); rate(goalies, "reflex", p => -p.st.goalsAgainstAverage); goalies.forEach(p => { ovr(p, { save: 1.2, reflex: .8 }); delete p.st; });
    return { season: s.slice(0, 4) + "-" + s.slice(6), skaters, goalies };
  },
  async epl() {
    const d = await get("https://fantasy.premierleague.com/api/bootstrap-static/");
    const teams = Object.fromEntries(d.teams.map(t => [t.id, t.short_name]));
    const img = code => `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;
    const P = d.elements.filter(e => e.status !== "u" && e.minutes >= 0);
    const mk = e => ({ id: "e" + e.code, name: e.web_name.length > 3 ? `${e.first_name.split(" ")[0]} ${e.web_name}`.replace(/^(\S+) \1$/, "$1") : `${e.first_name} ${e.second_name}`, team: teams[e.team] || "", pos: ["", "GK", "DEF", "MID", "FWD"][e.element_type], img: img(e.code), r: {},
      line: `£${(e.now_cost / 10).toFixed(1)}m · ${e.goals_scored} G · ${e.assists} A this season`, st: e });
    const attackers = P.filter(e => e.element_type >= 3).sort((a, b) => b.now_cost - a.now_cost).slice(0, 60).map(mk);
    rate(attackers, "fin", p => p.st.now_cost + (p.st.element_type === 4 ? 12 : 0)); rate(attackers, "power", p => p.st.now_cost + +p.st.threat / 40); rate(attackers, "comp", p => p.st.now_cost + +p.st.creativity / 50);
    attackers.forEach(p => { ovr(p, { fin: 1.2, power: .8, comp: .8 }); delete p.st; });
    const keepers = P.filter(e => e.element_type === 1).sort((a, b) => b.now_cost - a.now_cost).slice(0, 20).map(mk);
    rate(keepers, "reach", p => p.st.now_cost); rate(keepers, "react", p => p.st.now_cost + p.st.saves / 20); keepers.forEach(p => { ovr(p, { reach: 1, react: 1 }); delete p.st; });
    return { season: `${d.events?.[0]?.deadline_time?.slice(0, 4) || year}-${String(+(d.events?.[0]?.deadline_time?.slice(0, 4) || year) + 1).slice(2)}`, attackers, keepers };
  },
};

const out = { asof: now.toISOString(), sports: { ...prev.sports } };
for (const [lg, fn] of Object.entries(builders)) {
  try { out.sports[lg] = await fn(); const n = Object.values(out.sports[lg]).filter(Array.isArray).map(a => a.length); console.log(lg, "ok", n.join("/")); }
  catch (e) { console.log(lg, "kept previous:", e.message); }
}
writeFileSync(OUT, JSON.stringify(out));
console.log("wrote", OUT, Math.round(JSON.stringify(out).length / 1024), "KB");
if (process.env.CHECK_IMAGES) for (const lg of Object.keys(out.sports)) { const pool = Object.values(out.sports[lg]).find(Array.isArray); const u = pool?.[0]?.img; if (!u) continue; const r = await fetch(u, { headers: H }).catch(() => null); console.log("image", lg, r && r.status, r && r.headers.get("content-type"), u); }
