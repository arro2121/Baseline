/**
 * Baseline alerts: a Cloudflare Worker that
 *   - every 2 minutes checks live scores on API-Tennis,
 *   - notices when a match starts, a set ends, or a match finishes,
 *   - sends a push notification to every device watching one of those players (even with the app closed),
 *   - serves the latest scores to the site at /live.json.
 *
 * Push notifications use the Web Push standard (RFC 8030/8291/8292) directly, with no third-party service.
 * Storage: one KV namespace (binding "KV"). Keys: "subs" (all subscriptions), "live" (last scores).
 */

const API = "https://api.api-tennis.com/tennis/";
const TYPES = { "Atp Singles": ["atp", true], "Wta Singles": ["wta", true],
  "Challenger Men Singles": ["atp", false], "Challenger Women Singles": ["wta", false] };

/* ---------------- small helpers ---------------- */
const enc = new TextEncoder();
export const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)),
};
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
export const norm = s => String(s || "").normalize("NFKD").replace(/[^A-Za-z ]/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });

/* ---------------- Web Push: VAPID signature (RFC 8292) ---------------- */
export async function vapidAuth(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:alerts@example.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/* ---------------- Web Push: payload encryption, aes128gcm (RFC 8291 / 8188) ---------------- */
async function hkdf(salt, ikm, info, bits) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bits));
}
export async function encryptPayload(sub, text) {
  const uaPublic = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
export async function sendPush(sub, message, env, fetchImpl = fetch) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  return fetchImpl(sub.endpoint, { method: "POST", body, headers: {
    Authorization: await vapidAuth(sub.endpoint, env), "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high", Topic: (message.tag || "baseline").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } });
}

/* ---------------- scores ---------------- */
function surfaceOf(name, tour) {
  const n = ` ${norm(name).join(" ")} `;
  if (n.includes(" stuttgart ")) return tour === "atp" ? "Grass" : "Clay";
  const has = list => list.some(k => n.includes(` ${k} `));
  if (has(["roland garros", "french open", "monte carlo", "madrid", "rome", "barcelona", "hamburg", "munich", "geneva", "lyon", "estoril", "houston",
    "marrakech", "bucharest", "buenos aires", "santiago", "rio", "cordoba", "umag", "kitzbuhel", "gstaad", "bastad", "charleston", "rabat", "strasbourg",
    "bogota", "parma", "palermo", "iasi", "prague", "genoa", "tolentino", "sassuolo", "florence", "cagliari", "turin"])) return "Clay";
  if (has(["wimbledon", "halle", "queen", "queens", "london", "s hertogenbosch", "hertogenbosch", "mallorca", "eastbourne", "newport", "berlin",
    "bad homburg", "nottingham", "birmingham", "ilkley", "surbiton"])) return "Grass";
  return "Hard";
}
export function resolver(players) {
  return (apiName, tour) => {
    const m = /^\s*([A-Za-z]+)\.\s*(.+)$/.exec(apiName || ""); const ini = m ? norm(m[1])[0][0] : "", sur = norm(m ? m[2] : apiName).join(" ");
    const hits = players.filter(p => p.tour === tour && (() => { const t = norm(p.name); for (let c = 1; c < t.length; c++) if (t.slice(c).join(" ") === sur && (!ini || t[0].startsWith(ini))) return true; return false; })());
    return hits.length === 1 ? hits[0].name : apiName;
  };
}
const setsOf = e => (e.scores || []).slice().sort((a, b) => +a.score_set - +b.score_set)
  .map(s => [parseInt(String(s.score_first).split(".")[0]) || 0, parseInt(String(s.score_second).split(".")[0]) || 0]);
export function toLive(events, resolve) {
  const out = [], seen = new Set();
  for (const e of events) {
    const t = TYPES[e.event_type_type]; if (!t || seen.has(String(e.event_key))) continue; seen.add(String(e.event_key));
    const [tour, main] = t, st = String(e.event_status || "").toLowerCase();
    const status = String(e.event_live) === "1" ? "live" : (st === "finished" || st === "retired") ? "final" : (st === "" || st === "not started") ? "scheduled" : null;
    if (!status) continue;
    let name = String(e.tournament_name || "").trim();
    if (!main) { name = name.replace(/\s*(challenger|wta 125k?|125k?)\s*/ig, " ").replace(/\s+(men|women)\s*$/i, "").trim(); name = tour === "atp" ? `ATP Challenger ${name}` : `WTA 125 ${name}`; }
    else name = `${tour.toUpperCase()} ${name}`;
    const m = { id: String(e.event_key), tour, event: name, surface: surfaceOf(e.tournament_name, tour), status,
      a: resolve(e.event_first_player, tour), b: resolve(e.event_second_player, tour), sets: setsOf(e), start: e.event_time || "" };
    if (!m.sets.length) m.sets = [[0, 0]];
    if (status === "live") {
      const gr = String(e.event_game_result || "").replace(/\s/g, ""); if (/^\w+-\w+$/.test(gr)) m.pts = gr;
      m.srv = { "First Player": "a", "Second Player": "b" }[e.event_serve] || undefined;
    }
    if (status === "final") m.winner = e.event_winner === "Second Player" ? "b" : "a";
    out.push(m);
  }
  const order = { live: 0, final: 1, scheduled: 2 };
  out.sort((x, y) => order[x.status] - order[y.status]);
  return [...out.filter(m => m.status !== "scheduled").slice(0, 60), ...out.filter(m => m.status === "scheduled").slice(0, 12)];
}

/* ---------------- what changed since last time ---------------- */
const setDone = s => (s[0] >= 6 && s[0] - s[1] >= 2) || (s[1] >= 6 && s[1] - s[0] >= 2) || s[0] === 7 || s[1] === 7;
const last = n => norm(n).slice(-1)[0] ? String(n).trim().split(/\s+/).slice(-1)[0] : n;
export function diffEvents(prev, now) {
  const before = new Map((prev || []).map(m => [m.id, m])), events = [];
  for (const m of now) {
    const p = before.get(m.id); if (!p) continue;            // first sighting: no alert (avoids a burst on start-up)
    const score = side => m.sets.map(s => side === "a" ? `${s[0]}-${s[1]}` : `${s[1]}-${s[0]}`).join(" ");
    for (const side of ["a", "b"]) {
      const me = m[side], op = m[side === "a" ? "b" : "a"];
      if (p.status === "scheduled" && m.status === "live") events.push({ player: me, tour: m.tour, tag: `start-${m.id}`, title: `${last(me)} is on court`, body: `vs ${op}, ${m.event}` });
      else if (p.status === "live" && m.status === "final") { const won = m.winner === side;
        events.push({ player: me, tour: m.tour, tag: `end-${m.id}`, title: `${last(me)} ${won ? "won" : "lost"}`, body: `${won ? "Beat" : "Lost to"} ${op}, ${score(side)}` }); }
      else if (m.status === "live") {
        const doneNow = m.sets.filter(setDone).length, doneBefore = p.sets.filter(setDone).length;
        if (doneNow > doneBefore) { const s = m.sets.filter(setDone)[doneNow - 1], mine = side === "a" ? s[0] > s[1] : s[1] > s[0];
          const doneScore = m.sets.filter(setDone).map(x => side === "a" ? `${x[0]}-${x[1]}` : `${x[1]}-${x[0]}`).join(" ");
          events.push({ player: me, tour: m.tour, tag: `set-${m.id}-${doneNow}`, title: `Set ${mine ? "to" : "against"} ${last(me)}`, body: `${doneScore} vs ${op}` }); }
      }
    }
  }
  return events;
}

/* ---------------- one scheduled run ---------------- */
export async function tick(env, fetchImpl = fetch) {
  const call = async (method, params = {}) => {
    const q = new URLSearchParams({ method, APIkey: env.API_TENNIS_KEY, timezone: "America/New_York", ...params });
    const r = await fetchImpl(`${API}?${q}`); const d = await r.json();
    if (!d.success) throw new Error(`API-Tennis ${method}: ${JSON.stringify(d).slice(0, 200)}`);
    return Array.isArray(d.result) ? d.result : Object.values(d.result || {});
  };
  let players = [];
  try { const r = await fetchImpl(`${env.SITE_URL.replace(/\/$/, "")}/players.json`); if (r.ok) players = await r.json(); } catch {}
  const today = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
  const events = [...await call("get_livescore"), ...await call("get_fixtures", { date_start: today, date_stop: today })];
  const matches = toLive(events, resolver(players));
  const prev = JSON.parse(await env.KV.get("live") || '{"matches":[]}');
  const alerts = diffEvents(prev.matches, matches);
  const snapshot = { asof: new Date().toISOString().replace(/\.\d+Z$/, "Z"), matches };
  if (JSON.stringify(prev.matches) !== JSON.stringify(matches)) await env.KV.put("live", JSON.stringify(snapshot));
  let sent = 0;
  if (alerts.length) {
    const subs = JSON.parse(await env.KV.get("subs") || "[]"); let gone = false;
    for (const s of subs) {
      const mine = alerts.filter(a => (s.watch?.[a.tour] || []).some(n => norm(n).join(" ") === norm(a.player).join(" ")));
      for (const a of mine.slice(0, 5)) {
        const r = await sendPush(s.sub, { title: a.title, body: a.body, tag: a.tag, url: "./?tab=watch" }, env, fetchImpl);
        if (r.status === 404 || r.status === 410) { s.dead = true; gone = true; break; }
        if (r.ok) sent++;
      }
    }
    if (gone) await env.KV.put("subs", JSON.stringify(subs.filter(s => !s.dead)));
  }
  return { matches: matches.length, alerts: alerts.length, sent };
}

/* ---------------- live team sports from ESPN ---------------- */
export const LEAGUES = { nfl: "football/nfl", nba: "basketball/nba", mlb: "baseball/mlb", nhl: "hockey/nhl", epl: "soccer/eng.1" };
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
function team(c = {}) {
  const t = c.team || {};
  return { id: String(t.id || ""), name: t.displayName || t.name || "", short: t.shortDisplayName || t.name || "", abbr: t.abbreviation || "",
    color: t.color ? "#" + t.color : null, logo: t.logo || t.logos?.[0]?.href || null, score: c.score != null ? String(c.score?.displayValue ?? c.score) : null,
    record: c.records?.[0]?.summary || c.record?.[0]?.displayValue || null, winner: c.winner === true };
}
function status(s = {}) {
  const t = s.type || {};
  return { state: t.state || "pre", detail: t.detail || t.description || "", short: t.shortDetail || t.detail || "", completed: !!t.completed,
    clock: s.displayClock || null, period: s.period || null };
}
function situation(sit, lg) {
  if (!sit) return null;
  if (lg === "nfl") return { text: sit.downDistanceText || sit.shortDownDistanceText || null, possession: sit.possession ? String(sit.possession) : null,
    redzone: !!sit.isRedZone, last: sit.lastPlay?.text || null };
  if (lg === "mlb") return { balls: sit.balls ?? null, strikes: sit.strikes ?? null, outs: sit.outs ?? null,
    bases: [sit.onFirst, sit.onSecond, sit.onThird].map(Boolean), batter: sit.batter?.athlete?.shortName || sit.batter?.athlete?.displayName || null,
    pitcher: sit.pitcher?.athlete?.shortName || sit.pitcher?.athlete?.displayName || null, last: sit.lastPlay?.text || null };
  return { last: sit.lastPlay?.text || null };
}
export function normScoreboard(d, lg) {
  const games = (d.events || []).map(e => {
    const c = e.competitions?.[0] || {}, cs = c.competitors || [];
    const home = cs.find(x => x.homeAway === "home") || cs[0] || {}, away = cs.find(x => x.homeAway === "away") || cs[1] || {};
    const o = (c.odds || [])[0];
    return { id: String(e.id), date: e.date, name: e.shortName || e.name, status: status(e.status || c.status), home: team(home), away: team(away),
      neutral: !!c.neutralSite, venue: c.venue?.fullName || null, tv: (c.broadcasts || []).flatMap(b => b.names || []).slice(0, 2),
      odds: o ? { details: o.details || null, overUnder: o.overUnder ?? null, homeML: o.homeTeamOdds?.moneyLine ?? o.moneyline?.home?.close?.odds ?? null,
                  awayML: o.awayTeamOdds?.moneyLine ?? o.moneyline?.away?.close?.odds ?? null } : null,
      situation: situation(c.situation, lg) };
  });
  const order = { in: 0, pre: 1, post: 2 };
  games.sort((a, b) => (order[a.status.state] ?? 3) - (order[b.status.state] ?? 3) || String(a.date).localeCompare(String(b.date)));
  return { league: lg, asof: new Date().toISOString(), games };
}
function play(p, lg) {
  return { id: String(p.id || p.sequenceNumber || Math.random()), text: p.text || p.shortText || p.type?.text || "",
    type: p.type?.text || null, period: p.period?.number ?? p.period ?? null, periodText: p.period?.displayValue || null,
    clock: p.clock?.displayValue || null, away: p.awayScore ?? null, home: p.homeScore ?? null, scoring: !!p.scoringPlay,
    team: p.team?.id ? String(p.team.id) : (p.start?.team?.id ? String(p.start.team.id) : null),
    down: p.start?.downDistanceText || null, turnover: !!p.isTurnover, seq: Number(p.sequenceNumber || 0) };
}
export function normGame(d, lg) {
  const c = d.header?.competitions?.[0] || {}, cs = c.competitors || [];
  const home = cs.find(x => x.homeAway === "home") || cs[0] || {}, away = cs.find(x => x.homeAway === "away") || cs[1] || {};
  let plays = [];
  if (d.drives) {                                   // football: plays grouped into drives
    for (const dr of [...(d.drives.previous || []), ...(d.drives.current ? [d.drives.current] : [])])
      for (const p of dr.plays || []) plays.push({ ...play(p, lg), drive: dr.description || null });
  } else if (Array.isArray(d.plays) && d.plays.length) {
    plays = d.plays.map(p => play(p, lg));
  } else if (Array.isArray(d.commentary) && d.commentary.length) {   // soccer
    plays = d.commentary.map((x, i) => ({ id: String(x.sequence ?? i), text: x.text || "", clock: x.time?.displayValue || null, period: null,
      scoring: /goal!/i.test(x.text || "") || x.play?.scoringPlay === true, type: x.play?.type?.text || null, seq: Number(x.sequence ?? i) }));
  } else if (Array.isArray(d.keyEvents)) {
    plays = d.keyEvents.map((x, i) => ({ id: String(x.id ?? i), text: x.text || x.type?.text || "", clock: x.clock?.displayValue || null,
      period: x.period?.number ?? null, scoring: !!x.scoringPlay, type: x.type?.text || null, seq: i }));
  }
  const seen = new Set(); plays = plays.filter(p => !seen.has(p.id) && seen.add(p.id));
  plays.sort((a, b) => b.seq - a.seq);
  const wp = Array.isArray(d.winprobability) && d.winprobability.length ? d.winprobability[d.winprobability.length - 1].homeWinPercentage : null;
  return { league: lg, id: String(d.header?.id || ""), asof: new Date().toISOString(), status: status(c.status), home: team(home), away: team(away),
    homeWinProb: typeof wp === "number" ? wp : null, plays: plays.slice(0, 200), count: plays.length };
}
/* ESPN's API at site.api.espn.com turns away browsers and Cloudflare, so read the copy espn.com itself uses
   (site.web.api.espn.com), then the feed behind ESPN's pages (cdn.espn.com), then the old address. The page reuses this code. */
const ESPN_WEB = "https://site.web.api.espn.com/apis/site/v2/sports/", CDN = "https://cdn.espn.com/core/";
const CDN_PAGE = { scoreboard: "scoreboard", game: "game", playbyplay: "playbyplay" }, CDN_SOCCER = { scoreboard: "scoreboard", game: "match", playbyplay: "commentary" };
const cdnUrl = (lg, kind, q = "") => lg === "epl" ? `${CDN}soccer/${CDN_SOCCER[kind]}?xhr=1&league=eng.1${q}` : `${CDN}${lg}/${CDN_PAGE[kind]}?xhr=1${q}`;
async function getJSON(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}
async function firstOf(tries) {                     // the first source that answers wins
  let err;
  for (const t of tries) { try { const v = await t(); if (v) return v; } catch (e) { err = e; } }
  throw err || new Error("ESPN unavailable");
}
export async function espnScoreboard(lg, fetchImpl = fetch) {
  return normScoreboard(await firstOf([
    () => getJSON(`${ESPN_WEB}${LEAGUES[lg]}/scoreboard`, fetchImpl),
    async () => { const sb = (await getJSON(cdnUrl(lg, "scoreboard"), fetchImpl)).content?.sbData; return Array.isArray(sb?.events) ? sb : null; },
    () => getJSON(`${ESPN}${LEAGUES[lg]}/scoreboard`, fetchImpl),
  ]), lg);
}
export async function espnGame(lg, id, fetchImpl = fetch) {
  const hasPlays = g => !!(g && (g.drives || g.plays?.length || g.commentary?.length || g.keyEvents?.length));
  return normGame(await firstOf([
    () => getJSON(`${ESPN_WEB}${LEAGUES[lg]}/summary?event=${id}`, fetchImpl),
    async () => {
      let g = (await getJSON(cdnUrl(lg, "game", `&gameId=${id}`), fetchImpl)).gamepackageJSON;
      if (g?.header && !hasPlays(g)) {               // some sports keep the plays on the play-by-play page
        try { const p = (await getJSON(cdnUrl(lg, "playbyplay", `&gameId=${id}`), fetchImpl)).gamepackageJSON;
          if (hasPlays(p)) g = { ...g, ...p, header: g.header, winprobability: g.winprobability?.length ? g.winprobability : p.winprobability }; } catch {}
      }
      return g?.header ? g : null;
    },
    () => getJSON(`${ESPN}${LEAGUES[lg]}/summary?event=${id}`, fetchImpl),
  ]), lg);
}
async function cached(req, ctx, ttl, make) {
  const cache = typeof caches !== "undefined" ? caches.default : null, k = new Request(req.url, { method: "GET" });
  if (cache) { const hit = await cache.match(k); if (hit) return hit; }
  const body = JSON.stringify(await make());
  const res = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}`, ...cors } });
  if (cache && ctx) ctx.waitUntil(cache.put(k, res.clone()));
  return res;
}
/* tennis point by point from API-Tennis */
export function normTennis(e, resolve = n => n) {
  const games = (e.pointbypoint || []).map(g => ({ set: g.set_number, game: g.number_game, server: { "First Player": "a", "Second Player": "b" }[g.player_served] || null,
    winner: { "First Player": "a", "Second Player": "b" }[g.serve_winner] || null, broken: !!g.serve_lost, score: g.score,
    points: (g.points || []).map(p => ({ n: p.number_point, score: p.score, bp: !!p.break_point, sp: !!p.set_point, mp: !!p.match_point })) }));
  const plays = [], last = n => String(n || "").trim().split(/\s+/).slice(-1)[0];
  const nameA = last(resolve(e.event_first_player)), nameB = last(resolve(e.event_second_player));
  games.forEach((g, gi) => {
    g.points.forEach((p, pi) => plays.push({ id: `${gi}-${pi}`, seq: gi * 100 + pi, text: `${p.score}${p.mp ? " · match point" : p.sp ? " · set point" : p.bp ? " · break point" : ""}`,
      period: g.set, clock: `Game ${g.game}`, scoring: false }));
    const who = g.winner === "a" ? nameA : g.winner === "b" ? nameB : "";
    plays.push({ id: `${gi}-g`, seq: gi * 100 + 99, text: `Game ${who}${g.broken ? ", breaking serve" : ""}. ${g.score} in the set`,
      period: g.set, clock: `Game ${g.game}`, scoring: true, broken: g.broken, gameWinner: g.winner });
  });
  plays.sort((a, b) => b.seq - a.seq);
  return { league: "tennis", id: String(e.event_key || ""), status: { state: String(e.event_live) === "1" ? "in" : String(e.event_status || "").toLowerCase() === "finished" ? "post" : "pre",
    detail: e.event_status || "", short: e.event_status || "" }, home: { name: resolve(e.event_first_player), score: e.event_final_result?.split("-")[0]?.trim() },
    away: { name: resolve(e.event_second_player), score: e.event_final_result?.split("-")[1]?.trim() }, game: e.event_game_result || null,
    serving: { "First Player": "a", "Second Player": "b" }[e.event_serve] || null, plays: plays.slice(0, 300), count: plays.length };
}

/* ---------------- web requests from the site ---------------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    let m;
    try {
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/scoreboard$/)))
        return await cached(req, ctx, 20, async () => espnScoreboard(m[1]));
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/game\/(\d+)$/)))
        return await cached(req, ctx, 10, async () => espnGame(m[1], m[2]));
      if ((m = url.pathname.match(/^\/tennis\/game\/(\d+)$/)))
        return await cached(req, ctx, 10, async () => {
          const q = new URLSearchParams({ method: "get_livescore", APIkey: env.API_TENNIS_KEY, match_key: m[1], timezone: "America/New_York" });
          let d = await (await fetch(`${API}?${q}`)).json(), e = (d.result || []).find(x => String(x.event_key) === m[1]);
          if (!e) { const q2 = new URLSearchParams({ method: "get_fixtures", APIkey: env.API_TENNIS_KEY, match_key: m[1] });
            d = await (await fetch(`${API}?${q2}`)).json(); e = (d.result || []).find(x => String(x.event_key) === m[1]); }
          if (!e) return { error: "not found", plays: [] };
          let players = []; try { const r = await fetch(`${env.SITE_URL.replace(/\/$/, "")}/players.json`); if (r.ok) players = await r.json(); } catch {}
          const t = TYPES[e.event_type_type]?.[0] || "atp";
          return normTennis(e, n => resolver(players)(n, t));
        });
    } catch (err) { return json({ error: String(err.message || err) }, 502); }
    if (url.pathname === "/live.json") return new Response(await env.KV.get("live") || '{"asof":"1970-01-01T00:00:00Z","matches":[]}',
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
    if (url.pathname === "/vapid") return json({ key: env.VAPID_PUBLIC_KEY });
    if (url.pathname === "/subscribe" && req.method === "POST") {
      const d = await req.json().catch(() => null);
      if (!d?.sub?.endpoint || !d.sub.keys?.p256dh || !d.sub.keys?.auth) return json({ error: "bad subscription" }, 400);
      const watch = { atp: (d.watch?.atp || []).slice(0, 50).map(String), wta: (d.watch?.wta || []).slice(0, 50).map(String) };
      const subs = JSON.parse(await env.KV.get("subs") || "[]").filter(s => s.sub.endpoint !== d.sub.endpoint);
      if (watch.atp.length + watch.wta.length) subs.push({ sub: d.sub, watch, at: Date.now() });
      await env.KV.put("subs", JSON.stringify(subs.slice(-2000)));
      return json({ ok: true, watching: watch.atp.length + watch.wta.length });
    }
    if (url.pathname === "/unsubscribe" && req.method === "POST") {
      const d = await req.json().catch(() => ({}));
      const subs = JSON.parse(await env.KV.get("subs") || "[]").filter(s => s.sub.endpoint !== d.endpoint);
      await env.KV.put("subs", JSON.stringify(subs));
      return json({ ok: true });
    }
    if (url.pathname === "/test" && req.method === "POST") {           // "Send test notification" button
      const d = await req.json().catch(() => ({}));
      const s = JSON.parse(await env.KV.get("subs") || "[]").find(x => x.sub.endpoint === d.endpoint);
      if (!s) return json({ error: "not subscribed" }, 404);
      const r = await sendPush(s.sub, { title: "Baseline alerts are on", body: "You'll hear from us when your players are on court.", tag: "test", url: "./?tab=watch" }, env);
      return json({ ok: r.ok, status: r.status });
    }
    return json({ service: "Baseline alerts", ok: true });
  },
  async scheduled(_evt, env, ctx) { ctx.waitUntil(tick(env).then(r => console.log(JSON.stringify(r)))); },
};
