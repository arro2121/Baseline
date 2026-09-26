// Builds docs/rosters.json: every player on every NFL, NBA, NHL, MLB and Premier League roster, for the Cosmic player cards.
// Sources (free, no key): ESPN (NFL, NBA, Premier League, with the league's own site for Premier League photos; through our alerts service if ESPN turns this computer away), the NHL's API and
// MLB's Stats API (40-man rosters). Keeps the previous list for any league that fails. Run from the repo root: node alerts/rosters.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const H = { "User-Agent": "Mozilla/5.0 (compatible; CosmoSports/1.0)" };
const get = async (u, tries = 3) => { for (let i = 0; ; i++) { try { const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(`${r.status} ${u}`); return await r.json(); } catch (e) { if (i >= tries - 1) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); } } };
const OUT = "docs/rosters.json", prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { leagues: {} };
let ALERTS = ""; try { ALERTS = JSON.parse(readFileSync("site_config.json", "utf8")).alerts_url || ""; } catch {}
const ESPN = "https://site.web.api.espn.com/apis/site/v2/sports/", PATH = { nfl: "football/nfl", nba: "basketball/nba", epl: "soccer/eng.1" };
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
async function espnLeague(lg) {
  const teams = (await get(`${ESPN}${PATH[lg]}/teams`)).sports[0].leagues[0].teams.map(t => t.team);
  const rows = await pool(teams, 6, async t => {
    let athletes = [];
    try { const d = await get(`${ESPN}${PATH[lg]}/teams/${t.id}/roster`); athletes = (d.athletes || []).flatMap(g => g.items ? g.items : [g]); }
    catch (e) { if (!ALERTS) throw e; const d = await get(`${ALERTS}/sports/${lg}/team/${t.id}`); athletes = (d.roster || []).map(p => ({ id: p.id, fullName: p.name, jersey: p.num, position: { abbreviation: p.pos }, headshot: { href: p.img } })); }
    // rookies (RC): ESPN's years of experience is 0 in a player's first season (NFL and NBA; soccer rosters don't carry it)
    return athletes.map(a => ({ id: String(a.id), name: a.fullName || a.displayName, team: t.displayName, pos: a.position?.abbreviation || "", num: a.jersey || "", img: a.headshot?.href || "",
      ...(lg !== "epl" && a.experience && a.experience.years === 0 ? { rc: 1 } : {}) }));
  });
  return rows.flat().filter(p => p.id && p.name);
}
// the Premier League's own player list (its opta ids name the photo files)
const normName = n => String(n || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const lastFirst = n => { const w = normName(n).split(" "); return w.length > 1 ? w[0][0] + " " + w[w.length - 1] : w[0]; };
async function plPhotos() {
  const PH = { ...H, Origin: "https://www.premierleague.com", Referer: "https://www.premierleague.com/" };
  const pl = async u => { const r = await fetch(u, { headers: PH }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
  let cs = 777; try { const d = await pl("https://footballapi.pulselive.com/football/competitions/1/compseasons?page=0&pageSize=1"); cs = d.content?.[0]?.id || cs; } catch {}
  const map = new Map();
  for (const season of [...new Set([cs, 777])]) for (let page = 0; page < 20; page++) {
    const d = await pl(`https://footballapi.pulselive.com/football/players?pageSize=100&compSeasons=${season}&altIds=true&page=${page}&type=player`);
    for (const p of d.content || []) { const opta = String(p.altIds?.opta || "").replace(/^p/, ""); if (!opta) continue;
      for (const k of [normName(p.name?.display), lastFirst(p.name?.display), normName(`${p.name?.first || ""} ${p.name?.last || ""}`)]) {
        if (!k) continue; if (map.has(k) && map.get(k) !== opta) map.set(k, null); else if (!map.has(k)) map.set(k, opta); } }     // two players, one key: use neither
    if (page + 1 >= (d.pageInfo?.numPages || 0)) break;
  }
  if (map.size < 200) throw new Error(`only ${map.size} photos`);
  return map;
}
const builders = {
  nfl: () => espnLeague("nfl"),
  nba: () => espnLeague("nba"),
  async epl() {                                  // ESPN has few Premier League photos, so match players to the league's own photos by name
    const list = await espnLeague("epl");
    try { const photos = await plPhotos(), miss = [];
      for (const p of list) { const k = normName(p.name), id = photos.get(k) || photos.get(lastFirst(p.name)); if (id) p.img = `https://resources.premierleague.com/premierleague25/photos/players/110x140/${id}.png`; else if (!p.img) miss.push(p.name); }
      // not every player has a photo on the league's site: keep only the ones that exist
      await pool(list.filter(p => p.img.includes("premierleague.com")), 12, async p => { try { const r = await fetch(p.img, { method: "HEAD", headers: H }); if (!r.ok) p.img = ""; } catch { p.img = ""; } });
      console.log("epl photos matched", list.length - miss.length, "of", list.length, "; available", list.filter(p => p.img).length); }
    catch (e) { console.log("epl photos skipped:", e.message); }
    return list;
  },
  async nhl() {
    const st = (await get("https://api-web.nhle.com/v1/standings/now")).standings || [];
    const teams = st.map(s => ({ abbr: s.teamAbbrev?.default, name: s.teamName?.default })).filter(t => t.abbr);
    const rows = await pool(teams, 6, async t => { const d = await get(`https://api-web.nhle.com/v1/roster/${t.abbr}/current`);
      return [...(d.forwards || []), ...(d.defensemen || []), ...(d.goalies || [])].map(p => ({ id: String(p.id), name: `${p.firstName?.default || ""} ${p.lastName?.default || ""}`.trim(), team: t.name, pos: p.positionCode || "", num: String(p.sweaterNumber ?? ""), img: p.headshot || "" })); });
    // rookies (RC): the NHL's stats site flags each season's rookies; before the first games it has none, so last season's list isn't reused
    try { const y = new Date().getUTCFullYear(), m = new Date().getUTCMonth() + 1, s = m >= 9 ? `${y}${y + 1}` : `${y - 1}${y}`, ids = new Set();
      for (const kind of ["skater", "goalie"]) { const d = await get(`https://api.nhle.com/stats/rest/en/${kind}/summary?isAggregate=false&isGame=false&start=0&limit=200&cayenneExp=seasonId=${s}%20and%20gameTypeId=2%20and%20isRookie=%221%22`, 1);
        for (const r of d.data || []) ids.add(String(r.playerId)); }
      if (ids.size && ids.size < 250) for (const p of rows.flat()) if (ids.has(p.id)) p.rc = 1;
      console.log("nhl rookies", ids.size); } catch (e) { console.log("nhl rookies skipped:", e.message); }
    return rows.flat();
  },
  async mlb() {
    const teams = (await get("https://statsapi.mlb.com/api/v1/teams?sportId=1")).teams.filter(t => t.active !== false);
    // rookies (RC): debuted in the majors this season, or late last season (August on, the September call-ups who keep rookie status)
    const yr = new Date().getUTCFullYear(), rookie = d => !!d && (+d.slice(0, 4) === yr || (+d.slice(0, 4) === yr - 1 && +d.slice(5, 7) >= 8));
    const rows = await pool(teams, 6, async t => { const d = await get(`https://statsapi.mlb.com/api/v1/teams/${t.id}/roster?rosterType=40Man&hydrate=person`);
      return (d.roster || []).map(r => ({ id: String(r.person.id), name: r.person.fullName, team: t.name, pos: r.position?.abbreviation || "", num: r.jerseyNumber || "", ...(rookie(r.person.mlbDebutDate) ? { rc: 1 } : {}),
        img: `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/${r.person.id}/headshot/67/current` })); });
    return rows.flat();
  },
};
const out = { asof: new Date().toISOString(), leagues: { ...prev.leagues } };
for (const [lg, fn] of Object.entries(builders)) {
  try { const list = await fn(), seen = new Set(), uniq = list.filter(p => !seen.has(p.id) && seen.add(p.id));
    if (uniq.length < (lg === "epl" ? 150 : 200)) throw new Error(`only ${uniq.length} players`);
    out.leagues[lg] = uniq; console.log(lg, "ok", uniq.length, "players,", new Set(uniq.map(p => p.team)).size, "teams,", uniq.filter(p => p.rc).length, "rookies"); }
  catch (e) { console.log(lg, "kept previous:", e.message); }
}
writeFileSync(OUT, JSON.stringify(out));
console.log("wrote", OUT, Math.round(JSON.stringify(out).length / 1024), "KB");
