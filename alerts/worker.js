/**
 * Cosmo Sports live service (formerly Baseline alerts): a Cloudflare Worker that
 *   - every 2 minutes checks live scores on API-Tennis,
 *   - notices when a match starts, a set ends, or a match finishes,
 *   - sends a push notification to every device watching one of those players (even with the app closed),
 *   - serves the latest scores to the site at /live.json.
 *
 * Push notifications use the Web Push standard (RFC 8030/8291/8292) directly, with no third-party service.
 * Storage: one KV namespace (binding "KV"). Keys: "subs" (all subscriptions), "live" (last scores).
 */

import Anthropic from "@anthropic-ai/sdk";
import { TEAM_COLORS } from "./colors.js";

const API = "https://api.api-tennis.com/tennis/";
const TYPES = { "Atp Singles": ["atp", true], "Wta Singles": ["wta", true],
  "Challenger Men Singles": ["atp", false], "Challenger Women Singles": ["wta", false] };

/* ---------------- small helpers ---------------- */
// one of the site's own files (players, models). A new custom domain can take a while to get its HTTPS certificate (or may
// not be set up yet), so if it fails, try it over plain http, then the site's github.io address.
async function siteGet(env, path, fetchImpl = fetch) {
  const base = String(env.SITE_URL || "").replace(/\/$/, ""), tries = [base];
  if (/^https:/.test(base)) tries.push(base.replace(/^https:/, "http:"));
  if (env.SITE_FALLBACK && env.SITE_FALLBACK.replace(/\/$/, "") !== base) tries.push(env.SITE_FALLBACK.replace(/\/$/, ""));   // the github.io address
  let last = null, err = null;
  for (const b of tries) { try { const r = await fetchImpl(b + path); if (r.ok) return r; last = r; } catch (e) { err = e; } }
  if (last) return last; throw err || new Error("site unreachable");
}
const enc = new TextEncoder();
export const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)),
};
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
export const norm = s => String(s || "").normalize("NFKD").replace(/[^A-Za-z ]/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-No-Passkeys, X-Owner-Key" };
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

/* ---------------- storage ----------------
   Subscriptions and the little state the cron keeps live in a Durable Object (free plan: 100,000 writes a day, one
   record per subscription so two phones signing up at once can't overwrite each other). Setups without it fall back
   to KV, which only allows about 1,000 writes a day. */
const subId = async endpoint => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)))].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
export class Store {
  constructor(state, env) { this.state = state; this.env = env; }
  async migrate() {
    const st = this.state.storage; if (await st.get("migrated")) return;
    let old = []; try { old = JSON.parse(await this.env.KV.get("subs") || "[]"); } catch {}
    for (const s of old) if (s?.sub?.endpoint) await st.put("sub:" + await subId(s.sub.endpoint), s);
    for (const k of ["sports", "brief", "live"]) { try { const v = await this.env.KV.get(k); if (v != null && (await st.get(k)) == null) await st.put(k, v); } catch {} }
    await st.put("migrated", 1);
  }
  async fetch(req) {
    const st = this.state.storage, d = await req.json(); let v = null;
    await this.migrate();
    if (d.op === "get") v = (await st.get(d.k)) ?? null;
    else if (d.op === "put") { await st.put(d.k, d.v); v = true; }
    else if (d.op === "many") v = Object.fromEntries(await st.get((d.ks || []).slice(0, 128)));
    else if (d.op === "cz") v = d.a.act === "settle" ? await czSettleTx(st, d.a) : await czTx(st, d.a);
    else if (d.op === "subs") v = [...(await st.list({ prefix: "sub:" })).values()];
    else if (d.op === "subGet") v = (await st.get("sub:" + await subId(d.e))) ?? null;
    else if (d.op === "subPut") { await st.put("sub:" + await subId(d.rec.sub.endpoint), d.rec); v = true; }
    else if (d.op === "subDel") { await st.delete("sub:" + await subId(d.e)); v = true; }
    return new Response(JSON.stringify({ v }), { headers: { "Content-Type": "application/json" } });
  }
}
export function store(env) {
  if (env.STORE) {
    const stub = env.STORE.get(env.STORE.idFromName("main"));
    const call = async (op, a = {}) => { const r = await stub.fetch("https://store/", { method: "POST", body: JSON.stringify({ op, ...a }) }); if (!r.ok) throw new Error("store " + r.status); return (await r.json()).v; };
    return { durable: true, get: k => call("get", { k }), put: (k, v) => call("put", { k, v }), many: ks => call("many", { ks }), subs: () => call("subs"), subGet: e => call("subGet", { e }), subPut: rec => call("subPut", { rec }), subDel: e => call("subDel", { e }) };
  }
  const all = async () => JSON.parse(await env.KV.get("subs") || "[]");
  return { durable: false, get: k => env.KV.get(k), put: (k, v) => env.KV.put(k, v), subs: all,
    many: async ks => Object.fromEntries(await Promise.all(ks.map(async k => [k, await env.KV.get(k)]))),
    subGet: async e => (await all()).find(s => s.sub.endpoint === e) || null,
    subPut: async rec => env.KV.put("subs", JSON.stringify([...(await all()).filter(s => s.sub.endpoint !== rec.sub.endpoint), rec].slice(-2000))),
    subDel: async e => env.KV.put("subs", JSON.stringify((await all()).filter(s => s.sub.endpoint !== e))) };
}

/* ---------------- Comets: articles from the site's owner, for everyone ----------------
   Anyone can read. Writing needs the owner's key (the COMETS_KEY secret, set from the GitHub secret of the same name).
   Each article is its own record ("cm:<id>"), with a small index ("comets") of titles for the list. */
const COMETS_FAIL = new Map();
async function cometsAuthed(req, env) {
  const key = env.COMETS_KEY, got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key || !got) return false;
  const enc = new TextEncoder(), [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(key)), crypto.subtle.digest("SHA-256", enc.encode(got))]);
  const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];     // same time whatever matches
  return diff === 0;
}
function cometsTooManyFails(ip) { const now = Date.now(), l = (COMETS_FAIL.get(ip) || []).filter(t => now - t < 900e3); COMETS_FAIL.set(ip, l); return l.length >= 8; }
function cometsFail(ip) { const l = COMETS_FAIL.get(ip) || []; l.push(Date.now()); COMETS_FAIL.set(ip, l); if (COMETS_FAIL.size > 5000) COMETS_FAIL.clear(); }
export function cometClean(d, old = {}) {
  const s = (v, n) => String(v ?? "").replace(/\r\n?/g, "\n").slice(0, n);
  const title = s(d.title ?? old.title, 160).trim(), body = s(d.body ?? old.body, 60000).trim();
  if (title.length < 2 || body.length < 2) return null;
  const tag = s(d.tag ?? old.tag ?? "", 30).trim(), cover = /^https:\/\/[^\s"'<>]+$/.test(String(d.cover ?? old.cover ?? "")) ? String(d.cover ?? old.cover).slice(0, 500) : "";
  return { title, body, tag, cover };
}
const cometIndexRow = p => ({ id: p.id, title: p.title, tag: p.tag, cover: p.cover, at: p.at, updated: p.updated || null,
  excerpt: p.body.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[#*_>`\[\]]/g, "").replace(/\(https?:[^)]*\)/g, "").replace(/\s+/g, " ").trim().slice(0, 220),
  words: p.body.split(/\s+/).filter(Boolean).length });
async function cometsIndex(db) { const v = await db.get("comets"); return (typeof v === "string" ? JSON.parse(v) : v) || []; }
async function cometsRoute(req, env, ctx, url, db) {
  const ip = req.headers.get("CF-Connecting-IP") || "anon", m = url.pathname.match(/^\/comets(?:\/([\w-]{3,60}))?(?:\/(auth))?$/);
  if (!m) return null;
  const [, id] = m;
  if (url.pathname === "/comets/auth" && req.method === "POST") {
    if (cometsTooManyFails(ip)) return json({ ok: false, error: "Too many tries. Wait 15 minutes." }, 429);
    const ok = await cometsAuthed(req, env); if (!ok) cometsFail(ip);
    return json({ ok, configured: !!env.COMETS_KEY }, ok ? 200 : 401);
  }
  if (req.method === "GET") {
    if (!id) return json({ posts: await cometsIndex(db) }, 200, { "Cache-Control": "public, max-age=30" });
    const v = await db.get("cm:" + id); if (!v) return json({ error: "not found" }, 404);
    return json(typeof v === "string" ? JSON.parse(v) : v, 200, { "Cache-Control": "public, max-age=30" });
  }
  // everything else writes
  if (cometsTooManyFails(ip)) return json({ error: "Too many tries. Wait 15 minutes." }, 429);
  if (!(await cometsAuthed(req, env))) { cometsFail(ip); return json({ error: env.COMETS_KEY ? "Wrong writer key" : "Posting isn't set up yet: add the COMETS_KEY secret" }, 401); }
  const d = await req.json().catch(() => ({}));
  let list = await cometsIndex(db);
  if (req.method === "DELETE" && id) {
    await db.put("cm:" + id, ""); list = list.filter(p => p.id !== id); await db.put("comets", JSON.stringify(list));
    return json({ ok: true });
  }
  const isNew = req.method === "POST" && !id;
  if (!isNew && !(req.method === "PUT" && id)) return json({ error: "bad request" }, 400);
  const oldRaw = id ? await db.get("cm:" + id) : null, old = oldRaw ? (typeof oldRaw === "string" ? JSON.parse(oldRaw) : oldRaw) : null;
  if (!isNew && !old) return json({ error: "not found" }, 404);
  const c = cometClean(d, old || {}); if (!c) return json({ error: "An article needs a title and some text." }, 400);
  const now = new Date().toISOString(), slug = c.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "post";
  const post = isNew ? { id: `${slug}-${Date.now().toString(36)}`, ...c, at: now } : { ...old, ...c, updated: now };
  await db.put("cm:" + post.id, JSON.stringify(post));
  list = [cometIndexRow(post), ...list.filter(p => p.id !== post.id)].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  await db.put("comets", JSON.stringify(list));
  let notified = 0;
  if (isNew && d.notify) {                           // tell everyone with alerts on (unless they turned Comets off)
    ctx.waitUntil((async () => {
      const subs = await db.subs().catch(() => []);
      for (const s of subs.slice(0, 5000)) {
        if (s.prefs && s.prefs.comets === false) continue;
        await sendPush(s.sub, { title: "☄️ New on Comets", body: post.title, tag: "comet-" + post.id, url: `./#comet=${post.id}` }, env).catch(() => null);
      }
    })());
    notified = 1;
  }
  return json({ ok: true, post, notified });
}

/* ---------------- one scheduled run ---------------- */
export async function tick(env, fetchImpl = fetch) {
  if (!env.API_TENNIS_KEY) return { tennis: "off" };
  const db = store(env);
  const call = async (method, params = {}) => {
    const q = new URLSearchParams({ method, APIkey: env.API_TENNIS_KEY, timezone: "America/New_York", ...params });
    const r = await fetchImpl(`${API}?${q}`); const d = await r.json();
    if (!d.success) throw new Error(`API-Tennis ${method}: ${JSON.stringify(d).slice(0, 200)}`);
    return Array.isArray(d.result) ? d.result : Object.values(d.result || {});
  };
  let players = [];
  try { const r = await siteGet(env, "/players.json", fetchImpl); if (r.ok) players = await r.json(); } catch {}
  const today = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
  const events = [...await call("get_livescore"), ...await call("get_fixtures", { date_start: today, date_stop: today })];
  const matches = toLive(events, resolver(players));
  const prev = JSON.parse(await db.get("live") || '{"matches":[]}');
  const alerts = diffEvents(prev.matches, matches);
  const snapshot = { asof: new Date().toISOString().replace(/\.\d+Z$/, "Z"), matches };
  if (JSON.stringify(prev.matches) !== JSON.stringify(matches)) await db.put("live", JSON.stringify(snapshot)).catch(e => console.log("save live:", e.message));
  let sent = 0;
  if (alerts.length) {
    const subs = await db.subs();
    for (const s of subs) {
      const mine = alerts.filter(a => (s.watch?.[a.tour] || []).some(n => norm(n).join(" ") === norm(a.player).join(" ")));
      for (const a of mine.slice(0, 5)) {
        const r = await sendPush(s.sub, { title: a.title, body: a.body, tag: a.tag, url: "./?tab=watch" }, env, fetchImpl);
        if (r.status === 404 || r.status === 410) { await db.subDel(s.sub.endpoint).catch(() => {}); break; }
        if (r.ok) sent++;
      }
    }
  }
  return { matches: matches.length, alerts: alerts.length, sent };
}

/* ---------------- team-sport alerts: starts, scores, close finishes and finals for the teams and games people follow ---------------- */
const START_WORD = { nfl: "Kickoff", nba: "Tip-off", mlb: "First pitch", nhl: "Puck drop", epl: "Kick-off" };
const tkey = n => norm(n).join(" ");
const minsLeft = c => { const m = /^(\d+):(\d+)/.exec(String(c || "")); if (m) return +m[1] + m[2] / 60; const x = parseFloat(c); return isNaN(x) ? 99 : x / 60; };
export function crunch(lg, g) {                     // late in the game and still close
  const s = g.status || {}, per = +s.period || 0, m = Math.abs((+g.home?.score || 0) - (+g.away?.score || 0));
  if (s.state !== "in") return false;
  if (lg === "nfl") return per >= 4 && minsLeft(s.clock) <= 5 && m <= 8;
  if (lg === "nba") return per >= 4 && minsLeft(s.clock) <= 3 && m <= 5;
  if (lg === "nhl") return per >= 3 && minsLeft(s.clock) <= 5 && m <= 1;
  if (lg === "mlb") return per >= 8 && m <= 1;
  if (lg === "epl") return (parseFloat(String(s.clock || "").replace(/[^\d.]/g, " ")) || 0) >= 80 && m <= 1;
  return false;
}
const scoreLine = g => `${g.away.short || g.away.name} ${g.away.score ?? 0}, ${g.home.short || g.home.name} ${g.home.score ?? 0}`;
function scoredWhat(lg, pts) {
  if (lg === "nfl") return pts >= 6 ? "Touchdown" : pts === 3 ? "Field goal" : pts === 2 ? "Safety" : "Score";
  if (lg === "mlb") return pts > 1 ? `${pts} runs score` : "Run scores";
  return lg === "nba" ? "Score" : "Goal";
}
// compare one league's scoreboard with the last one we saw and describe what happened
export function sportEvents(lg, prev, games) {
  const out = [];
  for (const g of games) {
    const p = prev[g.id], st = g.status?.state, a = +g.away.score || 0, h = +g.home.score || 0;
    if (!p) continue;                                // first sighting: nothing to report yet
    const base = { lg, id: g.id, teams: [tkey(g.home.name), tkey(g.away.name)], url: `./#game=${lg}/${g.id}` };
    const vs = `${g.away.short} at ${g.home.short}`;
    if (p.s === "pre" && st === "in") out.push({ ...base, type: "start", tag: `start-${g.id}`, title: `${START_WORD[lg]}: ${g.away.short} at ${g.home.short}`, body: g.tv?.length ? `On ${g.tv[0]}` : "The game has started" });
    if (st === "in" && p.a != null && (a !== p.a || h !== p.h) && lg !== "nba") {
      const side = h - p.h > a - p.a ? g.home : g.away, pts = Math.max(h - p.h, a - p.a);
      out.push({ ...base, type: "score", tag: `score-${g.id}`, title: `${scoredWhat(lg, pts)}, ${side.short}`, body: `${scoreLine(g)} · ${g.status.short || ""}`, safe: null });
    }
    if (st === "in" && lg === "nba" && p.p && +g.status.period > p.p && p.p <= 4)
      out.push({ ...base, type: "score", tag: `score-${g.id}`, title: p.p === 2 ? "Halftime" : `End of the ${["", "1st", "2nd", "3rd", "4th"][p.p]} quarter`, body: scoreLine(g), safe: null });
    if (crunch(lg, g) && !p.c) out.push({ ...base, type: "close", tag: `close-${g.id}`, title: `Close finish: ${scoreLine(g)}`, body: `${g.status.short || ""} · tap to follow it live`,
      safe: { title: `Close finish: ${vs}`, body: `It's tight late. Tap to watch it live` } });
    if (p.s === "in" && st === "post") { const w = h > a ? g.home : a > h ? g.away : null;
      out.push({ ...base, type: "final", tag: `final-${g.id}`, title: `Final: ${scoreLine(g)}`, body: w ? `${w.short} win${/s$/.test(w.short || "") ? "" : "s"}` : "It ends level",
        safe: { title: `Final: ${vs}`, body: "It's over. Tap when you're ready to see how it ended" } }); }
  }
  return out;
}
const DEFAULT_PREFS = { start: true, score: true, close: true, final: true, anyClose: false, daily: true, noSpoilers: false, comets: true };
function wants(sub, e) {
  const pr = { ...DEFAULT_PREFS, ...(sub.prefs || {}) };
  const mine = (sub.games || []).includes(`${e.lg}/${e.id}`) || (sub.teams?.[e.lg] || []).some(t => e.teams.includes(t));
  if (pr.noSpoilers && e.safe === null) return false;              // scoring alerts would give the score away
  if (mine) return !!pr[e.type];
  return e.type === "close" && pr.anyClose;
}
export async function sportsTick(env, fetchImpl = fetch) {
  const db = store(env);
  const subs = (await db.subs()).filter(s => s.teams || s.games || s.prefs);
  if (!subs.length) return { sports: 0 };
  const any = subs.some(s => s.prefs?.anyClose), want = new Set();
  for (const s of subs) { for (const [lg, list] of Object.entries(s.teams || {})) if (list.length) want.add(lg); for (const k of s.games || []) want.add(k.split("/")[0]); }
  const leagues = Object.keys(LEAGUES).filter(lg => any || want.has(lg));
  const followed = new Set(subs.flatMap(s => [...Object.entries(s.teams || {}).flatMap(([lg, l]) => l.map(t => lg + ":" + t)), ...(s.games || [])]));
  const prevAll = JSON.parse(await db.get("sports") || "{}"), next = {}, events = [];
  for (const lg of leagues) {
    let d; try { d = await espnScoreboard(lg, fetchImpl); } catch { next[lg] = prevAll[lg] || {}; continue; }
    const games = d.games || [], prev = prevAll[lg] || {};
    events.push(...sportEvents(lg, prev, games));
    next[lg] = {};
    for (const g of games) {
      const track = followed.has(`${lg}/${g.id}`) || followed.has(`${lg}:${tkey(g.home.name)}`) || followed.has(`${lg}:${tkey(g.away.name)}`);
      next[lg][g.id] = { s: g.status.state, p: +g.status.period || 0, c: crunch(lg, g) || !!prev[g.id]?.c,
        ...(track ? { a: +g.away.score || 0, h: +g.home.score || 0 } : {}) };
      if (!track) next[lg][g.id].p = 0;               // only followed games need the period (NBA quarter alerts)
    }
  }
  for (const lg of Object.keys(prevAll)) if (!(lg in next)) next[lg] = prevAll[lg];
  let sent = 0, budget = 40;
  for (const e of events) for (const s of subs) {
    if (budget <= 0 || s.dead || !wants(s, e)) continue;
    budget--;
    const safe = s.prefs?.noSpoilers && e.safe ? e.safe : e;
    const r = await sendPush(s.sub, { title: safe.title, body: safe.body, tag: e.tag, url: e.url }, env, fetchImpl).catch(() => null);
    if (r && (r.status === 404 || r.status === 410)) { s.dead = true; await db.subDel(s.sub.endpoint).catch(() => {}); } else if (r && r.ok) sent++;
  }
  // save the new state after sending, and only when something changed, so a storage hiccup can never block an alert
  if (JSON.stringify(next) !== JSON.stringify(prevAll)) await db.put("sports", JSON.stringify(next)).catch(e => console.log("save state:", e.message));
  // a game someone asked about has finished: forget it
  const done = new Set(events.filter(e => e.type === "final").map(e => `${e.lg}/${e.id}`));
  let pruned = false;
  if (done.size) for (const s of subs) if (!s.dead && (s.games || []).some(k => done.has(k))) { s.games = s.games.filter(k => !done.has(k)); await db.subPut(s).catch(() => {}); pruned = true; }
  const brief = await morningBrief(env, subs.filter(s => !s.dead), fetchImpl).catch(e => String(e));
  return { leagues: leagues.length, events: events.length, sent, brief };
}
// once a day around 9 AM US Eastern: how your teams did yesterday and who plays today
const etParts = d => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
export async function morningBrief(env, subs, fetchImpl = fetch, now = new Date()) {
  const et = etParts(now), today = `${et.year}${et.month}${et.day}`;
  if (+et.hour !== 9) return "not time";
  const db = store(env);
  if (await db.get("brief") === today) return "sent";
  const hasTeams = s => Object.values(s.teams || {}).some(l => l.length);
  const who = subs.filter(s => s.prefs?.daily !== false);
  if (!who.length) return "nobody";
  await db.put("brief", today);                      // at most once a day, even if a send below fails
  const y = etParts(new Date(now - 864e5)), yday = `${y.year}${y.month}${y.day}`;
  const leagues = who.some(s => !hasTeams(s)) ? Object.keys(LEAGUES) : [...new Set(who.flatMap(s => Object.keys(s.teams || {}).filter(lg => s.teams[lg].length)))];
  const boards = {};
  for (const lg of leagues) {
    boards[lg] = { y: [], t: [] };
    try { boards[lg].y = (await espnScoreboard(lg, fetchImpl, yday)).games || []; } catch {}
    try { boards[lg].t = (await espnScoreboard(lg, fetchImpl)).games || []; } catch {}
  }
  const time = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  // for people who don't follow a team yet: the day's headline games, national TV first
  const headline = Object.entries(boards).flatMap(([lg, b]) => b.t.filter(g => g.status?.state === "pre").map(g => ({ lg, g })))
    .sort((a, b) => (b.g.tv?.length ? 1 : 0) - (a.g.tv?.length ? 1 : 0) || new Date(a.g.date) - new Date(b.g.date)).slice(0, 3)
    .map(({ lg, g }) => `${g.away.short} at ${g.home.short} ${time(g.date)} (${lg.toUpperCase()})`);
  let sent = 0;
  for (const s of who.slice(0, 200)) {
    const lines = [];
    if (!hasTeams(s)) lines.push(...headline);
    for (const [lg, list] of Object.entries(s.teams || {})) for (const t of list) {
      const mine = g => [tkey(g.home.name), tkey(g.away.name)].includes(t);
      const done = boards[lg]?.y.find(g => mine(g) && g.status?.state === "post"), next = boards[lg]?.t.find(g => mine(g) && g.status?.state === "pre");
      if (done) { const home = tkey(done.home.name) === t, me = home ? done.home : done.away, op = home ? done.away : done.home, a = +me.score, b = +op.score;
        lines.push(s.prefs?.noSpoilers ? `${me.short} played ${op.short}` : `${me.short} ${a > b ? "beat" : a < b ? "lost to" : "drew with"} ${op.short} ${a}-${b}`); }
      if (next) { const home = tkey(next.home.name) === t; lines.push(`${(home ? next.home : next.away).short} ${home ? "host" : "at"} ${(home ? next.away : next.home).short}, ${time(next.date)}`); }
    }
    if (!lines.length) continue;
    const r = await sendPush(s.sub, { title: "Your Cosmo morning", body: lines.slice(0, 4).join(" · "), tag: "brief-" + today, url: "./" }, env, fetchImpl).catch(() => null);
    if (r && r.ok) sent++;
  }
  return { sent };
}

/* ---------------- live team sports from ESPN ---------------- */
export const LEAGUES = { nfl: "football/nfl", nba: "basketball/nba", mlb: "baseball/mlb", nhl: "hockey/nhl", epl: "soccer/eng.1" };
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
function team(c = {}) {
  const t = c.team || {};
  return { id: String(t.id || ""), name: t.displayName || t.name || "", short: t.shortDisplayName || t.name || "", abbr: t.abbreviation || "",
    color: t.color ? "#" + t.color : null, alt: t.alternateColor ? "#" + t.alternateColor : null, logo: t.logo || t.logos?.[0]?.href || null, score: c.score != null ? String(c.score?.displayValue ?? c.score) : null,
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
                  awayML: o.awayTeamOdds?.moneyLine ?? o.moneyline?.away?.close?.odds ?? null, drawML: o.drawOdds?.moneyLine ?? o.moneyline?.draw?.close?.odds ?? null,
                  provider: o.provider?.name || null } : null,
      situation: situation(c.situation, lg), stype: e.season?.type ?? null };
  });
  const order = { in: 0, pre: 1, post: 2 };
  games.sort((a, b) => (order[a.status.state] ?? 3) - (order[b.status.state] ?? 3) || String(a.date).localeCompare(String(b.date)));
  return { league: lg, asof: new Date().toISOString(), games };
}
const ORD = n => n + ([, "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || "th");
// the heading a play sits under: "Top 3rd", "2nd Quarter", "1st Period", "Second half"
function periodHead(p, lg) {
  const n = p.period?.number ?? null;
  if (n == null) return null;
  if (lg === "mlb") return `${/^bot/i.test(p.period?.type || "") ? "Bottom" : "Top"} ${ORD(n)}`;
  if (lg === "epl") return ["First half", "Second half"][n - 1] || "Extra time";
  if (lg === "nhl") return n <= 3 ? `${ORD(n)} Period` : n === 4 ? "Overtime" : "Shootout";
  return n <= 4 ? `${ORD(n)} Quarter` : n === 5 ? "Overtime" : `${ORD(n - 4)} Overtime`;
}
// what kind of moment a play is, for icons, the key-plays filter and the animations
function kindOf(p, lg) {
  const t = (p.type?.text || "").toLowerCase(), x = (p.text || "").toLowerCase();
  if (lg === "nfl") {
    if (/touchdown/.test(t) || (p.scoringPlay && /touchdown/.test(x))) return "td";
    if (/field goal good/.test(t)) return "fg";
    if (/field goal missed|blocked field goal/.test(t)) return "fgmiss";
    if (/interception/.test(t)) return "int";
    if (/fumble recovery \(opponent\)/.test(t) || p.isTurnover) return "fumble";
    if (/safety/.test(t)) return "safety";
    if (/sack/.test(t)) return "sack";
    if (/punt/.test(t)) return "punt";
    if (/kickoff/.test(t)) return "kick";
    if (/penalty/.test(t) || p.isPenalty) return "penalty";
    if (/pass reception/.test(t)) return "pass";
    if (/pass incompletion/.test(t)) return "incomplete";
    if (/rush/.test(t)) return "rush";
    if (/timeout|end period|end of half|end of game|two-minute|end quarter/.test(t)) return "break";
    return "play";
  }
  if (lg === "nba") {
    if (/free throw/.test(t)) return p.scoringPlay ? "ft" : "ftmiss";
    if (p.shootingPlay) return p.scoringPlay ? (p.scoreValue === 3 ? "made3" : "made") : "miss";
    if (/turnover/.test(t)) return "to";
    if (/rebound/.test(t)) return "reb";
    if (/foul/.test(t)) return "foul";
    if (/substitution|timeout|end period|end game|jumpball|review|challenge/.test(t)) return "break";
    return "play";
  }
  if (lg === "nhl") {
    if (t === "goal") return "goal";
    if (t === "shot") return "shot";
    if (t === "missed" || t === "blocked") return "miss";
    if (/face ?off|stoppage|period start|period end|end of game|shootout/.test(t)) return "break";
    if (/hit|giveaway|takeaway/.test(t)) return "play";
    return "penalty";                                // tripping, holding, fighting…
  }
  if (lg === "epl") {
    const k = p.type?.type || "";
    if (k === "goal" || /^goal!/i.test(p.text || "")) return "goal";
    if (/red-card/.test(k)) return "red";
    if (/yellow-card/.test(k)) return "yellow";
    if (/shot/.test(k)) return k === "shot-on-target" ? "save" : "shot";
    if (/corner/.test(k)) return "corner";
    if (/substitution|halftime|delay|offside|foul|handball|take-on/.test(k) || !k) return "break";
    return "play";
  }
  return "play";
}
const MINOR = new Set(["break", "reb", "foul", "incomplete"]);
function play(p, lg) {
  const kind = kindOf(p, lg), c = p.coordinate, okXY = c && Math.abs(c.x) < 1000 && Math.abs(c.y) < 1000;
  return { id: String(p.id || p.sequenceNumber || Math.random()), text: p.text || p.shortText || p.type?.text || "",
    type: p.type?.text || null, period: p.period?.number ?? p.period ?? null, periodText: p.period?.displayValue || null, head: periodHead(p, lg),
    clock: p.clock?.displayValue || null, away: p.awayScore ?? null, home: p.homeScore ?? null, scoring: !!p.scoringPlay,
    team: p.team?.id ? String(p.team.id) : (p.start?.team?.id ? String(p.start.team.id) : null),
    down: p.start?.downDistanceText || null, turnover: !!p.isTurnover || kind === "int" || kind === "fumble", seq: Number(p.sequenceNumber || 0),
    whoId: p.participants?.[0]?.athlete?.id ? String(p.participants[0].athlete.id) : null, whoName: p.participants?.[0]?.athlete?.displayName || null,
    whoPhoto: p.participants?.[0]?.athlete?.headshot?.href || null,
    kind, minor: MINOR.has(kind) || (lg === "nhl" && kind === "play"), points: p.scoreValue || null, x: okXY ? c.x : null, y: okXY ? c.y : null,
    yards: p.start?.yardsToEndzone != null ? { from: 100 - p.start.yardsToEndzone, to: p.end?.yardsToEndzone != null ? 100 - p.end.yardsToEndzone : null, gain: p.statYardage ?? null,
      down: p.end?.down ?? null, dist: p.end?.distance ?? null, team: p.start?.team?.id ? String(p.start.team.id) : null } : null };
}
// baseball: ESPN sends every pitch, numbered afresh for each batter; fold them into one line per at-bat
function mlbPlays(list, homeId, awayId) {
  const out = []; let ab = null;
  const batting = p => /^bot/i.test(p.period?.type || "") ? homeId : awayId;
  const base = (p, extra) => ({ id: String(p.id), type: p.type?.text || null, period: p.period?.number ?? null, periodText: p.period?.displayValue || null,
    head: periodHead(p, "mlb"), clock: null, away: p.awayScore ?? null, home: p.homeScore ?? null, team: batting(p), seq: 0, minor: false, ...extra });
  const evt = p => /stole|caught stealing|picked off/i.test(p.text || "") ? "steal" : "play";
  list.forEach((p, i) => {
    const st = p.summaryType, t = p.type?.text || "", prev = list[i - 1], next = list[i + 1];
    // a stolen base or wild pitch during an at-bat comes as an event row plus a "Play Result" with the same text
    const echo = (st === "N" || st === "S") && prev && !prev.summaryType && prev.text === p.text;
    if (echo) {
      out.push(base(p, { text: p.text, kind: evt(p), scoring: !!p.scoringPlay || st === "S" }));
    } else if (st === "A") {                                                     // "Valdez pitches to Wood": a new at-bat
      const m = /^(.*?) pitches to (.*)$/.exec(p.text || "");
      const who = t => (p.participants || []).find(x => x.type === t)?.athlete?.id;
      ab = { start: p, pitcher: m?.[1] || null, batter: m?.[2] || null, batterId: who("batter") || null, pitches: [], hit: null, outs: p.outs ?? null };
    } else if (st === "P" && ab) {
      const k = /ball in play/i.test(p.text || "") ? "x" : /^ball/i.test(t) || /hit by pitch/i.test(t) ? "b" : /foul/i.test(t) ? "f" : "s";
      ab.pitches.push({ k, speed: p.pitchVelocity || null, pitch: p.pitchType?.text || null });
      if (p.hitCoordinate) ab.hit = p.hitCoordinate;
    } else if ((st === "N" || st === "S") && !ab) {                    // "Callahan hit for Peck": a lineup change
      out.push(base(p, { text: p.text || "", kind: "change", minor: true }));
    } else if (st === "N" || st === "S") {                                // the at-bat's result
      const x = (p.text || "").toLowerCase();
      const kind = /homered|home run/.test(x) ? "hr" : /tripled/.test(x) ? "hit3" : /doubled/.test(x) ? "hit2" : /singled|reached on/.test(x) ? "hit1"
        : /struck out/.test(x) ? "k" : /walked|hit by pitch/.test(x) ? "walk" : "out";
      const hit = p.hitCoordinate || ab?.hit || null;
      out.push(base(p, { text: p.text || "", kind, scoring: !!p.scoringPlay || st === "S", batter: ab?.batter || null, pitcher: ab?.pitcher || null, whoId: ab?.batterId || null,
        pitches: (ab?.pitches || []).map(q => q.k), outs: p.outs ?? null, x: hit ? hit.x : null, y: hit ? hit.y : null, trajectory: p.trajectory || null }));
      ab = null;
    } else if (st === "C") {                                              // pitching change
      out.push(base(p, { text: p.text || "", kind: "change", minor: true, team: batting(p) === homeId ? awayId : homeId }));
    } else if (t && !/batter\/pitcher|inning/i.test(t) && p.text && !(next?.text === p.text && /^[NS]$/.test(next.summaryType || ""))) {
      out.push(base(p, { text: p.text, kind: evt(p), scoring: !!p.scoringPlay }));   // stolen bases, wild pitches…
    }
  });
  if (ab && ab.batter) out.push({ ...base(ab.start, { text: `${ab.batter} batting against ${ab.pitcher}`, kind: "atbat", batter: ab.batter, pitcher: ab.pitcher, whoId: ab.batterId,
    pitches: ab.pitches.map(q => q.k), live: true }), id: String(ab.start.id) + "-now" });
  return out;
}
// team details by ESPN id, so each play can show its team's logo and color
function teamsOf(cs) {
  const m = {};
  for (const c of cs) { const t = team(c); if (t.id) m[t.id] = { name: t.name, short: t.short, abbr: t.abbr, color: t.color, alt: t.alt, logo: t.logo, side: c.homeAway || null }; }
  return m;
}
export function normGame(d, lg) {
  const c = d.header?.competitions?.[0] || {}, cs = c.competitors || [];
  const home = cs.find(x => x.homeAway === "home") || cs[0] || {}, away = cs.find(x => x.homeAway === "away") || cs[1] || {};
  const H = team(home), A = team(away), byName = {};
  for (const t of [H, A]) { byName[t.name] = t.id; byName[t.short] = t.id; }
  let plays = [];
  if (d.drives) {                                   // football: plays grouped into drives
    for (const dr of [...(d.drives.previous || []), ...(d.drives.current ? [d.drives.current] : [])])
      for (const p of dr.plays || []) plays.push({ ...play(p, lg), drive: dr.description || null, driveTeam: dr.team?.id ? String(dr.team.id) : null });
  } else if (lg === "mlb" && Array.isArray(d.plays) && d.plays.length) {
    plays = mlbPlays(d.plays, H.id, A.id);
  } else if (Array.isArray(d.plays) && d.plays.length) {
    plays = d.plays.map(p => play(p, lg));
  } else if (Array.isArray(d.commentary) && d.commentary.length) {   // soccer
    let sc = [0, 0];                                // running score, read from "Goal! Bournemouth 0, Liverpool 1."
    plays = d.commentary.map((x, i) => { const q = { ...(x.play || {}), text: x.text, period: x.play?.period || (x.period ? { number: x.period } : null) };
      const kind = kindOf(q, "epl"), g = /^goal!\s*(.+?) (\d+), (.+?) (\d+)\./i.exec(x.text || "");
      if (g) { const first = byName[g[1]] === H.id || H.name.includes(g[1]) || H.short === g[1]; sc = first ? [+g[4], +g[2]] : [+g[2], +g[4]]; }
      return { id: String(x.sequence ?? i), text: x.text || "", clock: x.time?.displayValue || null, period: q.period?.number ?? null, head: periodHead(q, "epl"),
        away: sc[0], home: sc[1],
        scoring: kind === "goal" || x.play?.scoringPlay === true, type: x.play?.type?.text || null, seq: Number(x.sequence ?? i),
        team: x.play?.team?.id ? String(x.play.team.id) : byName[x.play?.team?.displayName] || null, kind, minor: MINOR.has(kind),
        whoName: x.play?.participants?.[0]?.athlete?.displayName || null }; });
  } else if (Array.isArray(d.keyEvents)) {
    plays = d.keyEvents.map((x, i) => { const kind = kindOf(x, "epl");
      return { id: String(x.id ?? i), text: x.text || x.type?.text || "", clock: x.clock?.displayValue || null, period: x.period?.number ?? null, head: periodHead(x, "epl"),
        scoring: !!x.scoringPlay, type: x.type?.text || null, seq: i, team: x.team?.id ? String(x.team.id) : null, kind, minor: MINOR.has(kind) }; });
  }
  const seen = new Set(); plays = plays.filter(p => !seen.has(p.id) && seen.add(p.id));

  // baseball's sequence numbers restart with every batter, so it keeps ESPN's list order; the others sort by sequence
  if (lg !== "mlb" && plays.every(p => p.seq > 0)) plays.sort((a, b) => a.seq - b.seq);
  plays.forEach((p, i) => { p.ord = i; });
  const roster = attachPlayers(plays, d, lg);
  const videos = gameVideos(d);
  linkVideos(plays, videos, roster);
  plays.reverse();                                  // newest first
  const wp = Array.isArray(d.winprobability) && d.winprobability.length ? d.winprobability[d.winprobability.length - 1].homeWinPercentage : null;
  // where things stand right now, for the animated field
  let situation = null;
  const sit = d.situation;
  if (lg === "mlb" && sit) situation = { balls: sit.balls ?? 0, strikes: sit.strikes ?? 0, outs: sit.outs ?? 0, bases: [!!sit.onFirst, !!sit.onSecond, !!sit.onThird] };
  if (lg === "nfl") { const last = plays.find(p => p.yards); if (last) situation = { team: last.yards.team, spot: last.yards.to ?? last.yards.from, down: last.yards.down, dist: last.yards.dist }; }
  return { league: lg, id: String(d.header?.id || ""), asof: new Date().toISOString(), status: status(c.status), home: H, away: A, teams: teamsOf(cs),
    homeWinProb: typeof wp === "number" ? wp : null, wpSeries: wpSeries(d), leaders: leadersOf(d, lg, H, A), box: boxOf(d, lg), info: infoOf(d, lg), lines: linesOf(c, H, A), date: c.date || null, neutral: !!c.neutralSite,
    tv: (c.broadcasts || []).map(b => b.media?.shortName || b.names?.[0]).filter(Boolean)[0] || null, situation, videos, plays: plays.slice(0, 300), count: plays.length,
    swings: swingsOf(d, plays, lg) };
}
// the game's turning points: the plays that moved win probability most, or (without it) the goals and runs that changed who led
const NOISE = /timeout|foul|substitution|enters the game|end of|jump ?ball|review|challenge|delay of game|injury/i;
function swingsOf(d, plays, lg) {
  const w = (Array.isArray(d.winprobability) ? d.winprobability : []).filter(x => typeof x.homeWinPercentage === "number");
  const out = [];
  if (w.length > 2) {
    const raw = new Map();
    for (const p of d.plays || []) raw.set(String(p.id), p);
    for (const dr of [...(d.drives?.previous || []), ...(d.drives?.current ? [d.drives.current] : [])]) for (const p of dr.plays || []) raw.set(String(p.id), p);
    const ids = new Set(plays.map(p => p.id)), cand = [];
    for (let i = 1; i < w.length; i++) {
      const dl = w[i].homeWinPercentage - w[i - 1].homeWinPercentage, p = raw.get(String(w[i].playId));
      if (p && Math.abs(dl) >= .07 && String(p.text || "").trim() && !NOISE.test(p.text) && !NOISE.test(p.type?.text || "")) cand.push({ i, dl, p });
    }
    cand.sort((a, b) => Math.abs(b.dl) - Math.abs(a.dl));
    for (const c of cand.slice(0, 3).sort((a, b) => a.i - b.i))
      out.push({ text: String(c.p.text).trim(), side: c.dl > 0 ? "home" : "away", delta: Math.round(Math.abs(c.dl) * 100), wp: Math.round(w[c.i].homeWinPercentage * 1000) / 1000,
        at: Math.round(c.i / (w.length - 1) * 1000) / 1000, when: [periodHead(c.p, lg), c.p.clock?.displayValue].filter(Boolean).join(" · "), pid: ids.has(String(c.p.id)) ? String(c.p.id) : null });
    return out;
  }
  const chron = [...plays].reverse().filter(p => p.scoring && p.home != null && p.away != null), n = plays.length || 1;
  let lead = 0; const ev = [];
  for (const p of chron) { const now = Math.sign(p.home - p.away); if (now !== lead) ev.push({ p, now, was: lead }); lead = now; }
  for (const e of ev.slice(-3))
    out.push({ text: e.p.text, side: e.now > 0 ? "home" : e.now < 0 ? "away" : e.was > 0 ? "away" : "home", label: e.now === 0 ? "Tied it" : e.was === 0 ? "Went ahead" : "Flipped the lead",
      score: `${e.p.away}-${e.p.home}`, at: Math.round((n - 1 - plays.indexOf(e.p)) / Math.max(1, n - 1) * 1000) / 1000, when: [typeof e.p.head === "string" ? e.p.head : null, e.p.clock].filter(Boolean).join(" · "), pid: e.p.id });
  return out;
}
// ESPN's win probability through the game, thinned to at most 90 points for a small chart
function wpSeries(d) {
  const w = (d.winprobability || []).map(x => x.homeWinPercentage).filter(x => typeof x === "number");
  if (w.length < 2) return null;
  const n = Math.min(90, w.length);
  return Array.from({ length: n }, (_, i) => Math.round(w[Math.round(i * (w.length - 1) / (n - 1))] * 1000) / 1000);
}
// each team's standout players with a photo: ESPN's leaders, or the best hitters from the box score for baseball
function leadersOf(d, lg, H, A) {
  const photo = (a, id) => a?.headshot?.href || (id ? `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${id}.png` : null);
  const out = [];
  if (Array.isArray(d.leaders) && d.leaders.length) {
    for (const t of d.leaders) {
      const items = [];
      for (const c of t.leaders || []) { const x = (c.leaders || [])[0]; if (!x || !x.athlete) continue;
        items.push({ cat: c.displayName || c.name || "", value: x.displayValue || "", name: x.athlete.displayName || "", photo: photo(x.athlete, x.athlete.id) }); }
      if (items.length) out.push({ team: String(t.team?.id || ""), items: items.slice(0, 4) });
    }
  } else if (lg === "mlb" && d.boxscore?.players) {
    for (const tm of d.boxscore.players) {
      const st = (tm.statistics || [])[0]; if (!st) continue;
      const ix = n => (st.names || st.labels || []).indexOf(n);
      const hitters = (st.athletes || []).map(x => { const v = n => +(x.stats || [])[ix(n)] || 0;
        const line = [`${(x.stats || [])[ix("H-AB")] || ""}`, v("HR") ? `${v("HR") > 1 ? v("HR") + " " : ""}HR` : "", v("RBI") ? `${v("RBI")} RBI` : "", v("R") ? `${v("R")} R` : ""].filter(Boolean).join(", ");
        return { cat: "Batting", value: line, name: x.athlete?.displayName || "", photo: photo(x.athlete, x.athlete?.id), score: v("H") + 3 * v("HR") + 1.5 * v("RBI") + v("R") + .5 * v("BB") }; })
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      if (hitters.length) out.push({ team: String(tm.team?.id || ""), items: hitters.map(({ score, ...x }) => x) });
    }
  }
  return out;
}
// every player ESPN lists for the game, with a photo, so plays can show who made them
const HEADSHOT = { mlb: "mlb", nfl: "nfl", nba: "nba", nhl: "nhl", epl: "soccer" };
function playersOf(d, lg) {
  const byId = {}, add = a => { if (!a || !a.id) return; const id = String(a.id);
    byId[id] = byId[id] || { id, name: a.displayName || a.fullName || "", short: a.shortName || "", photo: a.headshot?.href || `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${id}.png` }; };
  for (const tm of d.boxscore?.players || []) for (const st of tm.statistics || []) for (const x of st.athletes || []) add(x.athlete);
  for (const r of d.rosters || []) for (const x of r.roster || []) add(x.athlete);
  return byId;
}
const nameKey = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function attachPlayers(plays, d, lg) {
  const byId = playersOf(d, lg), list = Object.values(byId), byName = {};
  for (const a of list) byName[nameKey(a.name)] = a;
  // football text names players like "M.Stafford" or "K.Williams"
  const nfl = lg === "nfl" ? list.map(a => { const parts = a.name.split(" "); return { a, key: nameKey(`${parts[0][0]}.${parts.slice(1).join(" ")}`) }; }).filter(x => x.key.length > 3) : [];
  for (const p of plays) {
    let a = (p.whoId && byId[p.whoId]) || (p.whoName && byName[nameKey(p.whoName)]) || null;
    if (!a && p.whoId) a = { id: p.whoId, name: p.whoName || p.batter || "", photo: p.whoPhoto || `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${p.whoId}.png` };
    if (!a && nfl.length && p.text) {
      const t = nameKey(p.text); let best = null;
      for (const x of nfl) { const i = t.indexOf(x.key); if (i >= 0 && (!best || i < best.i)) best = { i, a: x.a }; }
      a = best && best.a;
    }
    if (a) p.who = { id: a.id, name: a.name || p.whoName || p.batter || "", photo: p.whoPhoto || a.photo };
    delete p.whoId; delete p.whoName; delete p.whoPhoto;
  }
  return list;
}
// ESPN's highlight clips for the game
function gameVideos(d) {
  return (d.videos || []).map(v => ({ id: String(v.id), title: v.headline || "", thumb: v.thumbnail || null, dur: v.duration || null,
    mp4: v.links?.source?.HD?.href || v.links?.source?.href || null, web: v.links?.web?.href || null,
    geo: v.geoRestrictions?.type === "whitelist" ? v.geoRestrictions.countries || null : null })).filter(v => v.mp4).slice(0, 20);
}
// match a clip to the play it shows: players named in the headline, the kind of play, and "2nd"/"4th" when a player did it more than once
const CLIP_WORDS = { hr: /home run|homer|\bhr\b|smash|crush|blast/, hit1: /single|rbi/, hit2: /double|rbi/, hit3: /triple|rbi/,
  td: /\btd\b|touchdown|end zone|on the board|grab|catch/, int: /pick|\bint\b|intercept/, fumble: /fumble/, fg: /field goal|\bfg\b/, sack: /sack/,
  goal: /goal|scores|nets|winner|equali/, made3: /three|3-pointer/, made: /dunk|layup|jumper|bucket|slam/, save: /save|stop/ };
const GAME_CLIP = /highlights|reflects|pokes fun|recap|press|injur|shaken up|\b\d+ (tds|touchdowns|goals|home runs|homers|hrs)\b/;
const words = s => " " + nameKey(s).replace(/[^a-z0-9]+/g, " ").trim() + " ";
function linkVideos(plays, videos, roster = []) {
  const people = [...roster.map(a => a.name), ...plays.filter(p => p.who).map(p => p.who.name)];
  const used = new Set(), surnames = [...new Set(people.map(n => words(n).trim().split(" ").pop()).filter(x => x.length >= 3))];
  for (const [vi, v] of videos.entries()) {
    const h = words(v.title);
    if (GAME_CLIP.test(h)) continue;
    const named = surnames.filter(x => h.includes(" " + x + " "));
    if (!named.length) continue;
    const cands = [];
    for (const p of plays) {                                   // plays are still in game order here
      if (used.has(p.id) || !p.who) continue;
      const t = words(p.text + " " + p.who.name), hits = named.filter(x => t.includes(" " + x + " ")).length;
      const kindOk = !!(CLIP_WORDS[p.kind] && CLIP_WORDS[p.kind].test(h));
      if (!hits || (!kindOk && !p.scoring && !p.turnover)) continue;
      cands.push({ p, score: hits * 2 + (kindOk ? 2 : 0) + (p.scoring || p.turnover ? 1 : 0) });
    }
    if (!cands.length) continue;
    const top = Math.max(...cands.map(c => c.score)), best = cands.filter(c => c.score === top);
    const nth = /\b(\d+)(st|nd|rd|th)\b/.exec(h);
    const pick = nth ? best[Math.min(best.length, +nth[1]) - 1] : best[0];
    pick.p.video = vi; used.add(pick.p.id);
  }
}
/* ESPN's API at site.api.espn.com turns away browsers and Cloudflare, so read the copy espn.com itself uses
   (site.web.api.espn.com), then the feed behind ESPN's pages (cdn.espn.com), then the old address. The page reuses this code. */
const ESPN_WEB = "https://site.web.api.espn.com/apis/site/v2/sports/", CDN = "https://cdn.espn.com/core/";
const CDN_PAGE = { scoreboard: "scoreboard", game: "game", playbyplay: "playbyplay" }, CDN_SOCCER = { scoreboard: "scoreboard", game: "match", playbyplay: "commentary" };
const cdnUrl = (lg, kind, q = "") => lg === "epl" ? `${CDN}soccer/${CDN_SOCCER[kind]}?xhr=1&league=eng.1${q}` : `${CDN}${lg}/${CDN_PAGE[kind]}?xhr=1${q}`;
async function getJSON(url, fetchImpl, ms = 10000) {  // a source that hangs (a blocked or slow network) gives up so the next one gets a turn
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac && setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetchImpl(url, ac ? { signal: ac.signal } : undefined);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    return await r.json();
  } finally { if (timer) clearTimeout(timer); }
}
async function firstOf(tries) {                     // the first source that answers wins
  let err;
  for (const t of tries) { try { const v = await t(); if (v) return v; } catch (e) { err = e; } }
  throw err || new Error("ESPN unavailable");
}
export async function espnScoreboard(lg, fetchImpl = fetch, dates = null) {
  if (lg === "mlb" && !/-/.test(dates || "")) try { return await mlbScoreboard(dates, fetchImpl); } catch {}          // MLB's own API first
  try { return await espnBoard(lg, fetchImpl, dates); }
  catch (e) { if (lg === "nhl") return nhlScoreboard(dates, fetchImpl); throw e; }          // the NHL's API if ESPN is down
}
async function espnBoard(lg, fetchImpl, dates) {
  const q = /^\d{8}$/.test(dates || "") ? `?dates=${dates}` : /^\d{8}-\d{8}$/.test(dates || "") ? `?dates=${dates}&limit=1000` : "";   // YYYYMMDD, a range (the season simulations), or today
  return normScoreboard(await firstOf([
    () => getJSON(`${ESPN_WEB}${LEAGUES[lg]}/scoreboard${q}`, fetchImpl),
    async () => { const sb = (await getJSON(cdnUrl(lg, "scoreboard", q.replace("?", "&")), fetchImpl)).content?.sbData; return Array.isArray(sb?.events) ? sb : null; },
    () => getJSON(`${ESPN}${LEAGUES[lg]}/scoreboard${q}`, fetchImpl),
  ]), lg);
}
export async function espnGame(lg, id, fetchImpl = fetch) {
  if (/^m\d+$/.test(id)) return mlbGame(id, fetchImpl);
  if (/^h\d+$/.test(id)) return nhlGame(id, fetchImpl);
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
/* ---- official league APIs: MLB's Stats API (statsapi.mlb.com) and the NHL's (api-web.nhle.com). Free, no key, run by the leagues.
   MLB's has everything ESPN has (every pitch, hit locations, win probability, box score, video), so it is the main source for
   baseball; the NHL's is the backup for hockey. Their game ids carry a letter ("m…", "h…") so every game loads from its own source. */
const MLB_API = "https://statsapi.mlb.com/api/", NHL_API = "https://api-web.nhle.com/v1/";
const tcolors = (lg, name) => { try { return ((typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[lg]) || {})[name] || null; } catch { return null; } };
const onPage = typeof window !== "undefined";
const kickoff = iso => { const d = new Date(iso); return onPage ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"; };
const hms = s => { const p = String(s || "").split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null; };
/* ---------- MLB ---------- */
function mlbTeamObj(t, score, rec, winner) {
  const c = tcolors("mlb", t.name) || [];
  return { id: String(t.id), name: t.name || "", short: t.teamName || t.clubName || t.name || "", abbr: t.abbreviation || c[2] || "", color: c[0] || null, alt: c[1] || null,
    logo: `https://www.mlbstatic.com/team-logos/${t.id}.svg`, score: score == null ? null : String(score), record: rec ? `${rec.wins}-${rec.losses}` : null, winner: !!winner };
}
function mlbStatus(st, ls, date) {
  const a = st?.abstractGameState, det = st?.detailedState || "";
  const state = a === "Live" ? "in" : a === "Final" || /postponed|cancel|suspended/i.test(det) ? "post" : "pre";
  const half = ls?.inningState ? ({ Middle: "Mid", Bottom: "Bot" }[ls.inningState] || ls.inningState) : "";
  const short = state === "in" ? `${half} ${ls?.currentInningOrdinal || ""}`.trim() : state === "post" ? (/postponed|cancel|suspended/i.test(det) ? det : (ls?.currentInning || 9) > 9 ? `Final/${ls.currentInning}` : "Final") : kickoff(date);
  return { state, detail: state === "in" ? `${ls?.inningState || ""} of the ${ls?.currentInningOrdinal || ""}`.trim() : det, short, completed: state === "post", clock: null, period: ls?.currentInning ?? null };
}
const mlbSit = ls => ls ? { balls: ls.balls ?? 0, strikes: ls.strikes ?? 0, outs: ls.outs ?? 0, bases: [!!ls.offense?.first, !!ls.offense?.second, !!ls.offense?.third],
  batter: ls.offense?.batter?.fullName || null, pitcher: ls.defense?.pitcher?.fullName || null, last: null } : null;
export function normMlbSchedule(d) {
  const games = (d.dates || []).flatMap(x => x.games || []).map(g => {
    const ls = g.linescore, st = mlbStatus(g.status, ls, g.gameDate), H = g.teams.home, A = g.teams.away, pre = st.state === "pre";
    const tv = (g.broadcasts || []).filter(b => b.type === "TV"), nat = tv.filter(b => b.isNational);
    return { id: "m" + g.gamePk, date: g.gameDate, name: `${A.team.abbreviation} @ ${H.team.abbreviation}`, status: st,
      home: mlbTeamObj(H.team, pre ? null : H.score ?? 0, H.leagueRecord, H.isWinner), away: mlbTeamObj(A.team, pre ? null : A.score ?? 0, A.leagueRecord, A.isWinner),
      neutral: false, venue: g.venue?.name || null, tv: [...new Set((nat.length ? nat : tv).map(b => b.name))].slice(0, 2), odds: null,
      situation: st.state === "in" ? mlbSit(ls) : null,
      probables: (H.probablePitcher || A.probablePitcher) ? [A.probablePitcher?.fullName || null, H.probablePitcher?.fullName || null] : null,
      stype: g.gameType === "R" ? 2 : /^[FDLW]$/.test(g.gameType || "") ? 3 : 1 };
  });
  return { league: "mlb", asof: new Date().toISOString(), games };
}
const MLB_KIND = { home_run: "hr", single: "hit1", double: "hit2", triple: "hit3", strikeout: "k", strikeout_double_play: "k", strikeout_triple_play: "k",
  walk: "walk", intent_walk: "walk", hit_by_pitch: "walk", field_error: "hit1", fielders_choice: "out" };
const MLB_TRAJ = { ground_ball: "G", fly_ball: "F", line_drive: "L", popup: "P", bunt_grounder: "G", bunt_popup: "P", bunt_line_drive: "L" };
const mlbPhoto = id => id ? `https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_auto:best/v1/people/${id}/headshot/67/current` : null;
const pitchKind = e => { const c = e.details?.call?.code || e.details?.code || ""; return /^(B|\*B|V|P|I|H)$/.test(c) ? "b" : /^(F|T|L|R)$/.test(c) ? "f" : /^(X|D|E)$/.test(c) ? "x" : "s"; };
export function normMlbGame(feed, wp, content) {
  const gd = feed.gameData || {}, ld = feed.liveData || {}, ls = ld.linescore || {}, bx = ld.boxscore || {};
  const st = mlbStatus(gd.status, ls, gd.datetime?.dateTime), pre = st.state === "pre";
  const H = mlbTeamObj(gd.teams.home, pre ? null : ls.teams?.home?.runs ?? 0, gd.teams.home.record, st.state === "post" && (ls.teams?.home?.runs ?? 0) > (ls.teams?.away?.runs ?? 0));
  const A = mlbTeamObj(gd.teams.away, pre ? null : ls.teams?.away?.runs ?? 0, gd.teams.away.record, st.state === "post" && (ls.teams?.away?.runs ?? 0) > (ls.teams?.home?.runs ?? 0));
  const teams = { [H.id]: { name: H.name, short: H.short, abbr: H.abbr, color: H.color, alt: H.alt, logo: H.logo, side: "home" }, [A.id]: { name: A.name, short: A.short, abbr: A.abbr, color: A.color, alt: A.alt, logo: A.logo, side: "away" } };
  const plays = [];
  for (const ab of ld.plays?.allPlays || []) {
    const top = ab.about?.isTopInning, bat = top ? A.id : H.id, field = top ? H.id : A.id, inn = ab.about?.inning;
    const base = { period: inn, periodText: `${top ? "Top" : "Bottom"} ${ORD(inn)}`, head: `${top ? "Top" : "Bottom"} ${ORD(inn)}`, clock: null, seq: 0, minor: false };
    // runners moving between pitches: steals, wild pitches, pickoffs, and pitching changes
    for (const e of ab.playEvents || []) {
      if (e.type !== "action" || !e.details?.description) continue;
      const t = e.details.description, ev = e.details.eventType || "";
      if (/substitution|switch|umpire|mound_visit|no_pitch|batter_timeout|game_advisory/.test(ev) && !/pitching_substitution/.test(ev)) continue;
      const change = /pitching_substitution/.test(ev);
      plays.push({ ...base, id: `ab${ab.about.atBatIndex}e${e.index}`, text: t, type: e.details.event || null, kind: change ? "change" : /stolen|caught_stealing|pickoff/.test(ev) ? "steal" : "play",
        minor: change, scoring: !!e.details.isScoringPlay, team: change ? field : bat, away: e.details.awayScore ?? null, home: e.details.homeScore ?? null });
    }
    const pitches = (ab.playEvents || []).filter(e => e.isPitch), hit = pitches.map(e => e.hitData).filter(Boolean).pop();
    const who = ab.matchup?.batter, done = ab.about?.isComplete;
    if (!done && st.state === "in") {
      plays.push({ ...base, id: `ab${ab.about.atBatIndex}-now`, text: `${who?.fullName || ""} batting against ${ab.matchup?.pitcher?.fullName || ""}`, kind: "atbat", live: true,
        batter: who?.fullName || null, pitcher: ab.matchup?.pitcher?.fullName || null, pitches: pitches.map(pitchKind), team: bat, away: ab.result?.awayScore ?? null, home: ab.result?.homeScore ?? null,
        who: who ? { id: String(who.id), name: who.fullName, photo: mlbPhoto(who.id) } : undefined });
      continue;
    }
    if (!ab.result?.description) continue;
    const ev = ab.result.eventType || "", kind = MLB_KIND[ev] || (ab.result.isOut ? "out" : "play");
    plays.push({ ...base, id: `ab${ab.about.atBatIndex}`, text: ab.result.description, type: ab.result.event || null, kind, scoring: !!ab.about?.isScoringPlay, team: bat,
      away: ab.result.awayScore ?? null, home: ab.result.homeScore ?? null, batter: who?.fullName || null, pitcher: ab.matchup?.pitcher?.fullName || null,
      pitches: pitches.map(pitchKind), outs: ab.count?.outs ?? null, x: hit?.coordinates?.coordX ?? null, y: hit?.coordinates?.coordY ?? null,
      trajectory: MLB_TRAJ[hit?.trajectory] || null, who: who ? { id: String(who.id), name: who.fullName, photo: mlbPhoto(who.id) } : undefined });
  }
  plays.forEach((p, i) => { p.ord = i; });
  // box score
  const row = (side) => bx.teams?.[side] || {};
  const TEAM = [["batting", "hits", "Hits"], ["batting", "homeRuns", "Home runs"], ["batting", "rbi", "RBI"], ["batting", "baseOnBalls", "Walks"], ["batting", "strikeOuts", "Strikeouts"],
    ["batting", "stolenBases", "Stolen bases"], ["batting", "leftOnBase", "Left on base"], ["pitching", "strikeOuts", "Pitchers' strikeouts"], ["pitching", "baseOnBalls", "Walks allowed"], ["fielding", "errors", "Errors"]];
  const boxTeams = ["away", "home"].map(side => ({ id: side === "home" ? H.id : A.id, side, stats: TEAM.map(([g, k, l]) => { const v = row(side).teamStats?.[g]?.[k]; return v == null ? null : [l, String(v)]; }).filter(Boolean) }));
  const person = (side, id) => row(side).players?.["ID" + id] || {};
  const boxPlayers = ["away", "home"].map(side => {
    const bat = (row(side).batters || []).map(id => person(side, id)).filter(p => p.stats?.batting && Object.keys(p.stats.batting).length);
    const pit = (row(side).pitchers || []).map(id => person(side, id)).filter(p => p.stats?.pitching && Object.keys(p.stats.pitching).length);
    const B = ["atBats", "runs", "hits", "rbi", "baseOnBalls", "strikeOuts", "homeRuns"], P = ["inningsPitched", "hits", "runs", "earnedRuns", "baseOnBalls", "strikeOuts", "homeRuns", "numberOfPitches"];
    const r = (p, keys, g) => ({ id: String(p.person?.id || ""), name: p.person?.fullName || "", short: p.person?.fullName || "", photo: mlbPhoto(p.person?.id), pos: p.position?.abbreviation || "",
      starter: g === "batting" ? !!p.battingOrder && String(p.battingOrder).endsWith("00") : false, dnp: false, stats: [...keys.map(k => String(p.stats[g][k] ?? "")), ...(g === "batting" ? [p.seasonStats?.batting?.avg || ""] : [])] });
    const bt = row(side).teamStats?.batting || {}, pt = row(side).teamStats?.pitching || {};
    return { team: side === "home" ? H.id : A.id, groups: [
      { name: "Batting", labels: ["AB", "R", "H", "RBI", "BB", "K", "HR", "AVG"], rows: bat.map(p => r(p, B, "batting")), totals: [...B.map(k => String(bt[k] ?? "")), ""] },
      { name: "Pitching", labels: ["IP", "H", "R", "ER", "BB", "K", "HR", "PC"], rows: pit.map(p => r(p, P, "pitching")), totals: P.map(k => String(pt[k] ?? "")) }] };
  });
  // standout hitters
  const leaders = ["away", "home"].map(side => {
    const hitters = (row(side).batters || []).map(id => person(side, id)).filter(p => p.stats?.batting?.atBats != null).map(p => { const b = p.stats.batting;
      const line = [`${b.hits}-${b.atBats}`, b.homeRuns ? `${b.homeRuns > 1 ? b.homeRuns + " " : ""}HR` : "", b.rbi ? `${b.rbi} RBI` : "", b.runs ? `${b.runs} R` : ""].filter(Boolean).join(", ");
      return { cat: "Batting", value: line, name: p.person?.fullName || "", photo: mlbPhoto(p.person?.id), score: b.hits + 3 * b.homeRuns + 1.5 * b.rbi + b.runs + .5 * b.baseOnBalls }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(({ score, ...x }) => x);
    return hitters.length ? { team: side === "home" ? H.id : A.id, items: hitters } : null;
  }).filter(Boolean);
  // win probability through the game and the swings that mattered
  const W = (Array.isArray(wp) ? wp : []).filter(x => typeof x.homeTeamWinProbability === "number");
  const series = W.map(x => x.homeTeamWinProbability / 100), n = Math.min(90, series.length);
  const wpSeries = n >= 2 ? Array.from({ length: n }, (_, i) => Math.round(series[Math.round(i * (series.length - 1) / (n - 1))] * 1000) / 1000) : null;
  const swings = W.map((x, i) => ({ x, i, d: (x.homeTeamWinProbabilityAdded || 0) / 100 })).filter(s => Math.abs(s.d) >= .07 && s.x.result?.description)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3).sort((a, b) => a.i - b.i)
    .map(s => ({ text: s.x.result.description, side: s.d > 0 ? "home" : "away", delta: Math.round(Math.abs(s.d) * 100), wp: Math.round(s.x.homeTeamWinProbability * 10) / 1000,
      at: Math.round(s.i / Math.max(1, W.length - 1) * 1000) / 1000, when: `${s.x.about?.isTopInning ? "Top" : "Bottom"} ${ORD(s.x.about?.inning)}`, pid: `ab${s.x.about?.atBatIndex}` }));
  // video: MLB's own clips, matched to the plays they show
  const videos = ((content?.highlights?.highlights?.items) || []).map(v => {
    const mp4 = (v.playbacks || []).find(p => p.name === "mp4Avc") || (v.playbacks || []).find(p => /\.mp4/.test(p.url || ""));
    const cut = (v.image?.cuts || []).find(c => c.width <= 800) || (v.image?.cuts || [])[0];
    return { id: String(v.guid || v.slug || v.id || v.headline), title: v.headline || "", thumb: cut?.src || null, dur: hms(v.duration), mp4: mp4?.url || null, web: null, geo: null };
  }).filter(v => v.mp4).slice(0, 20);
  const roster = Object.values({ ...(row("home").players || {}), ...(row("away").players || {}) }).map(p => ({ name: p.person?.fullName || "" }));
  linkVideos(plays, videos, roster);
  plays.reverse();
  const off = (bx.officials || []).map(o => [o.officialType || "", o.official?.fullName || ""]).filter(o => o[1]);
  const w = gd.weather || {}, v = gd.venue || {};
  const info = { venue: v.name || null, city: [v.location?.city, v.location?.stateAbbrev].filter(Boolean).join(", ") || null, capacity: v.fieldInfo?.capacity || null,
    attendance: (bx.info || []).find(x => x.label === "Att")?.value?.replace(/\.$/, "") || null, grass: v.fieldInfo?.turfType || null,
    weather: w.temp ? { temp: +w.temp, text: [w.condition, w.wind ? "wind " + w.wind : ""].filter(Boolean).join(", ") } : null, officials: off.slice(0, 6), odds: null, injuries: [], form: [], news: [],
    probables: gd.probablePitchers ? ["away", "home"].map(s => gd.probablePitchers[s]?.fullName || null) : null,
    decisions: ld.decisions ? { win: ld.decisions.winner?.fullName || null, loss: ld.decisions.loser?.fullName || null, save: ld.decisions.save?.fullName || null } : null };
  const inn = ls.innings || [];
  const lines = inn.length ? { n: inn.length, away: inn.map(x => x.away?.runs == null ? "" : String(x.away.runs)), home: inn.map(x => x.home?.runs == null ? "" : String(x.home.runs)),
    extra: { away: [ls.teams?.away?.hits ?? "", ls.teams?.away?.errors ?? ""], home: [ls.teams?.home?.hits ?? "", ls.teams?.home?.errors ?? ""] } } : null;
  const last = [...plays].find(p => p.kind === "atbat") || null;
  return { league: "mlb", id: "m" + (gd.game?.pk || feed.gamePk), asof: new Date().toISOString(), status: st, home: H, away: A, teams,
    homeWinProb: series.length ? series[series.length - 1] : null, wpSeries, leaders, box: { teams: boxTeams, players: boxPlayers }, info, lines,
    date: gd.datetime?.dateTime || null, neutral: false, tv: null, situation: st.state === "in" ? mlbSit(ls) : null, videos, plays: plays.slice(0, 300), count: plays.length, swings };
}
/* ---------- NHL ---------- */
const nm = x => (x && (x.default || x)) || "";
function nhlTeamObj(t, pre, winner) {
  const full = [nm(t.placeName), nm(t.commonName || t.name)].filter(Boolean).join(" ");
  const name = Object.keys((typeof TEAM_COLORS !== "undefined" && TEAM_COLORS.nhl) || {}).find(k => k.endsWith(nm(t.commonName || t.name))) || full || nm(t.name);
  const c = tcolors("nhl", name) || [];
  return { id: String(t.id), name, short: nm(t.commonName || t.name), abbr: t.abbrev || "", color: c[0] || null, alt: c[1] || null, logo: t.logo || null,
    score: pre ? null : String(t.score ?? 0), record: t.record || null, winner: !!winner };
}
function nhlStatus(g) {
  const s = g.gameState, state = s === "LIVE" || s === "CRIT" ? "in" : s === "FINAL" || s === "OFF" ? "post" : "pre", per = g.periodDescriptor?.number ?? g.period ?? null;
  const pt = g.periodDescriptor?.periodType, clock = g.clock?.timeRemaining || null, perTxt = pt === "OT" ? "OT" : pt === "SO" ? "SO" : per ? ORD(per) : "";
  const short = state === "in" ? (g.clock?.inIntermission ? `End ${perTxt}` : `${clock || ""} - ${perTxt}`) : state === "post" ? (pt && pt !== "REG" ? `Final/${pt}` : "Final") : kickoff(g.startTimeUTC);
  return { state, detail: short, short, completed: state === "post", clock, period: per };
}
export function normNhlScore(d) {
  const games = (d.games || []).map(g => { const st = nhlStatus(g), pre = st.state === "pre", post = st.state === "post";
    return { id: "h" + g.id, date: g.startTimeUTC, name: `${g.awayTeam.abbrev} @ ${g.homeTeam.abbrev}`, status: st,
      home: nhlTeamObj(g.homeTeam, pre, post && g.homeTeam.score > g.awayTeam.score), away: nhlTeamObj(g.awayTeam, pre, post && g.awayTeam.score > g.homeTeam.score),
      neutral: !!g.neutralSite, venue: nm(g.venue) || null, tv: (g.tvBroadcasts || []).map(b => b.network).slice(0, 2), odds: null, situation: null, stype: g.gameType ?? null }; });
  return { league: "nhl", asof: new Date().toISOString(), games };
}
const NHL_KIND = { goal: "goal", "shot-on-goal": "shot", "missed-shot": "miss", "blocked-shot": "miss", hit: "play", giveaway: "play", takeaway: "play", faceoff: "break",
  stoppage: "break", "period-start": "break", "period-end": "break", "game-end": "break", "shootout-complete": "break", penalty: "penalty", "delayed-penalty": "break" };
export function normNhlGame(pbp, box) {
  const st = nhlStatus(pbp), pre = st.state === "pre", post = st.state === "post";
  const H = nhlTeamObj(pbp.homeTeam, pre, post && pbp.homeTeam.score > pbp.awayTeam.score), A = nhlTeamObj(pbp.awayTeam, pre, post && pbp.awayTeam.score > pbp.homeTeam.score);
  const teams = { [H.id]: { name: H.name, short: H.short, abbr: H.abbr, color: H.color, alt: H.alt, logo: H.logo, side: "home" }, [A.id]: { name: A.name, short: A.short, abbr: A.abbr, color: A.color, alt: A.alt, logo: A.logo, side: "away" } };
  const who = {}; for (const r of pbp.rosterSpots || []) who[r.playerId] = { id: String(r.playerId), name: `${nm(r.firstName)} ${nm(r.lastName)}`.trim(), photo: r.headshot || null, team: String(r.teamId) };
  const N = id => (who[id] || {}).name || "";
  let sc = [0, 0];
  const plays = (pbp.plays || []).map((p, i) => {
    const d = p.details || {}, k = p.typeDescKey, per = p.periodDescriptor?.number, pt = p.periodDescriptor?.periodType;
    if (d.awayScore != null) sc = [d.awayScore, d.homeScore];
    const shot = d.shotType ? ` ${d.shotType[0].toUpperCase()}${d.shotType.slice(1)}` : "";
    const text = k === "goal" ? `${N(d.scoringPlayerId)} Goal (${d.scoringPlayerTotal || 1})${shot}${d.assist1PlayerId ? `, assists: ${N(d.assist1PlayerId)} (${d.assist1PlayerTotal})${d.assist2PlayerId ? `, ${N(d.assist2PlayerId)} (${d.assist2PlayerTotal})` : ""}` : ", unassisted"}`
      : k === "shot-on-goal" ? `${N(d.shootingPlayerId)}${shot} shot saved by ${N(d.goalieInNetId) || "the goalie"}`
      : k === "missed-shot" ? `${N(d.shootingPlayerId)}${shot} shot missed${d.reason ? ` (${String(d.reason).replace(/-/g, " ")})` : ""}`
      : k === "blocked-shot" ? `${N(d.blockingPlayerId)} blocked a shot from ${N(d.shootingPlayerId)}`
      : k === "hit" ? `${N(d.hittingPlayerId)} hit ${N(d.hitteePlayerId)}`
      : k === "faceoff" ? `${N(d.winningPlayerId)} won the faceoff against ${N(d.losingPlayerId)}`
      : k === "giveaway" || k === "takeaway" ? `${N(d.playerId)} ${k}`
      : k === "penalty" ? `${N(d.committedByPlayerId) || "Bench"} ${String(d.descKey || "penalty").replace(/-/g, " ")} (${d.duration || 2} min)`
      : k === "period-start" ? `Start of the ${pt === "OT" ? "overtime" : ORD(per) + " period"}` : k === "period-end" ? `End of the ${pt === "OT" ? "overtime" : ORD(per) + " period"}`
      : k === "stoppage" ? `Stoppage${d.reason ? `: ${String(d.reason).replace(/-/g, " ")}` : ""}` : k === "game-end" ? "End of game" : k.replace(/-/g, " ");
    const kind = NHL_KIND[k] || "play", owner = d.eventOwnerTeamId ? String(d.eventOwnerTeamId) : null;
    const actor = who[d.scoringPlayerId || d.shootingPlayerId || d.hittingPlayerId || d.winningPlayerId || d.playerId || d.committedByPlayerId];
    return { id: String(p.eventId), text, type: k, kind, minor: kind === "break" || kind === "play", period: per, periodText: pt === "OT" ? "OT" : ORD(per),
      head: per <= 3 ? `${ORD(per)} Period` : pt === "SO" ? "Shootout" : "Overtime", clock: p.timeInPeriod || null, away: sc[0], home: sc[1],
      scoring: k === "goal", team: owner, seq: p.sortOrder ?? i, ord: i, x: d.xCoord ?? null, y: d.yCoord ?? null, who: actor ? { id: actor.id, name: actor.name, photo: actor.photo } : undefined };
  }).filter(p => p.type !== "delayed-penalty");
  plays.forEach((p, i) => { p.ord = i; });
  const b = box?.playerByGameStats || {};
  const grp = (side, list, name, labels, keys) => ({ name, labels, rows: (b[side]?.[list] || []).map(x => ({ id: String(x.playerId), name: (who[x.playerId] || {}).name || nm(x.name), short: nm(x.name),
    photo: (who[x.playerId] || {}).photo || null, pos: x.position || "", starter: false, dnp: x.toi === "00:00", stats: keys.map(k => typeof k === "function" ? k(x) : String(x[k] ?? "")) })), totals: null });
  const SK = ["goals", "assists", "plusMinus", "sog", "hits", "blockedShots", "pim", "toi"], GK = ["shotsAgainst", "saves", "goalsAgainst", x => x.savePctg ? Number(x.savePctg).toFixed(3) : "", "toi"];
  const boxPlayers = [["awayTeam", A.id], ["homeTeam", H.id]].map(([side, id]) => ({ team: id, groups: [grp(side, "forwards", "Forwards", ["G", "A", "+/-", "SOG", "HT", "BS", "PIM", "TOI"], SK),
    grp(side, "defense", "Defense", ["G", "A", "+/-", "SOG", "HT", "BS", "PIM", "TOI"], SK), grp(side, "goalies", "Goalies", ["SA", "SV", "GA", "SV%", "TOI"], GK)].filter(g => g.rows.length) }));
  const tot = side => { const all = [...(b[side]?.forwards || []), ...(b[side]?.defense || [])], s = k => all.reduce((n, x) => n + (+x[k] || 0), 0);
    return [["Shots on goal", String(side === "homeTeam" ? pbp.homeTeam.sog ?? s("sog") : pbp.awayTeam.sog ?? s("sog"))], ["Hits", String(s("hits"))], ["Blocked shots", String(s("blockedShots"))], ["Penalty minutes", String(s("pim"))], ["Giveaways", String(s("giveaways"))], ["Takeaways", String(s("takeaways"))]]; };
  const byPer = side => { const out = []; for (const p of plays) if (p.scoring) { const i = Math.min(p.period, 4) - 1; while (out.length <= i) out.push(0); if (p.team === (side === "home" ? H.id : A.id)) out[i]++; } return out; };
  const pa = byPer("away"), ph = byPer("home"), np = Math.max(pa.length, ph.length, pre ? 0 : Math.min(st.period || 0, 4));
  const lines = np ? { n: np, away: Array.from({ length: np }, (_, i) => String(pa[i] || 0)), home: Array.from({ length: np }, (_, i) => String(ph[i] || 0)), extra: null } : null;
  const skaters = side => [...(b[side]?.forwards || []), ...(b[side]?.defense || [])].map(x => ({ x, pts: (+x.goals || 0) * 2 + (+x.assists || 0) })).filter(v => v.pts > 0).sort((a, c) => c.pts - a.pts).slice(0, 3)
    .map(({ x }) => ({ cat: "Points", value: `${x.goals} G, ${x.assists} A`, name: (who[x.playerId] || {}).name || nm(x.name), photo: (who[x.playerId] || {}).photo || null }));
  const leaders = [["awayTeam", A.id], ["homeTeam", H.id]].map(([s, id]) => ({ team: id, items: skaters(s) })).filter(l => l.items.length);
  const chron = plays.filter(p => p.scoring); let lead = 0; const ev = [];
  for (const p of chron) { const now = Math.sign(p.home - p.away); if (now !== lead) ev.push({ p, now, was: lead }); lead = now; }
  const swings = ev.slice(-3).map(e => ({ text: e.p.text, side: e.now > 0 ? "home" : e.now < 0 ? "away" : e.was > 0 ? "away" : "home", label: e.now === 0 ? "Tied it" : e.was === 0 ? "Went ahead" : "Flipped the lead",
    score: `${e.p.away}-${e.p.home}`, at: Math.round(e.p.ord / Math.max(1, plays.length - 1) * 1000) / 1000, when: [e.p.head, e.p.clock].filter(Boolean).join(" · "), pid: e.p.id }));
  plays.reverse();
  return { league: "nhl", id: "h" + pbp.id, asof: new Date().toISOString(), status: st, home: H, away: A, teams, homeWinProb: null, wpSeries: null, leaders,
    box: { teams: [{ id: A.id, side: "away", stats: tot("awayTeam") }, { id: H.id, side: "home", stats: tot("homeTeam") }], players: boxPlayers },
    info: { venue: nm(pbp.venue) || null, city: nm(pbp.venueLocation) || null, capacity: null, attendance: null, grass: null, weather: null, officials: [], odds: null, injuries: [], form: [], news: [] },
    lines, date: pbp.startTimeUTC || null, neutral: false, tv: (pbp.tvBroadcasts || [])[0]?.network || null, situation: null, videos: [], plays: plays.slice(0, 300), count: plays.length, swings };
}
const ymdDash = s => /^\d{8}$/.test(s || "") ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
const todayUS = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);   // the US sports day rolls over a few hours after midnight UTC
async function mlbScoreboard(dates, fetchImpl) {
  return normMlbSchedule(await getJSON(`${MLB_API}v1/schedule?sportId=1&date=${ymdDash(dates) || todayUS()}&hydrate=linescore,team,broadcasts(all),probablePitcher`, fetchImpl));
}
async function mlbGame(id, fetchImpl) {
  const pk = String(id).replace(/^m/, "");
  const [feed, wp, content] = await Promise.all([getJSON(`${MLB_API}v1.1/game/${pk}/feed/live`, fetchImpl, 20000), getJSON(`${MLB_API}v1/game/${pk}/winProbability`, fetchImpl).catch(() => null),
    getJSON(`${MLB_API}v1/game/${pk}/content`, fetchImpl).catch(() => null)]);
  return normMlbGame(feed, wp, content);
}
async function nhlScoreboard(dates, fetchImpl) { return normNhlScore(await getJSON(`${NHL_API}score/${ymdDash(dates) || todayUS()}`, fetchImpl)); }
async function nhlGame(id, fetchImpl) {
  const g = String(id).replace(/^h/, "");
  const [pbp, box] = await Promise.all([getJSON(`${NHL_API}gamecenter/${g}/play-by-play`, fetchImpl), getJSON(`${NHL_API}gamecenter/${g}/boxscore`, fetchImpl).catch(() => null)]);
  return normNhlGame(pbp, box);
}

/* ---- line score: points by quarter, period, half or inning (plus hits and errors in baseball) ---- */
function linesOf(c, H, A) {
  const cs = c.competitors || [], row = id => cs.find(x => String(x.team?.id || x.id) === String(id)) || {};
  const a = row(A.id), h = row(H.id), n = Math.max((a.linescores || []).length, (h.linescores || []).length);
  if (!n) return null;
  const v = (x, i) => { const l = (x.linescores || [])[i]; return l == null ? "" : String(l.displayValue ?? l.value ?? ""); };
  return { n, away: Array.from({ length: n }, (_, i) => v(a, i)), home: Array.from({ length: n }, (_, i) => v(h, i)),
    extra: a.hits != null ? { away: [a.hits, a.errors], home: [h.hits, h.errors] } : null };
}
/* ---- box score: team totals side by side, and each team's player tables ---- */
const NHL_SKATER = ["G", "A", "+/-", "SOG", "HT", "BS", "PIM", "TOI"], NHL_GOALIE = ["SA", "SV", "GA", "SV%", "TOI"];
const SOCCER_COLS = [["totalGoals", "G"], ["goalAssists", "A"], ["totalShots", "SH"], ["shotsOnTarget", "SOG"], ["foulsCommitted", "FC"], ["yellowCards", "YC"], ["redCards", "RC"], ["saves", "SV"]];
function boxOf(d, lg) {
  const bx = d.boxscore || {}, photo = (a) => a?.headshot?.href || (a?.id ? `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${a.id}.png` : null);
  // baseball nests its team totals by batting/pitching/fielding; pick the ones fans read
  const MLB_TEAM = [["batting", "H", "Hits"], ["batting", "HR", "Home runs"], ["batting", "RBI", "RBI"], ["batting", "BB", "Walks"], ["batting", "SO", "Strikeouts"], ["batting", "SB", "Stolen bases"], ["batting", "LOB", "Left on base"], ["pitching", "K", "Pitchers' strikeouts"], ["pitching", "BB", "Walks allowed"], ["fielding", "E", "Errors"]];
  const teams = (bx.teams || []).map(t => {
    const st = t.statistics || [];
    const stats = lg === "mlb"
      ? MLB_TEAM.map(([g, ab, label]) => { const x = (st.find(s => s.name === g)?.stats || []).find(s => s.abbreviation === ab); return x ? [label, String(x.displayValue)] : null; }).filter(Boolean)
      : st.filter(x => x.displayValue != null && x.displayValue !== "").map(x => [x.label || x.displayName || x.name, String(x.displayValue)]);
    return { id: String(t.team?.id || ""), side: t.homeAway || null, stats };
  });
  const players = [];
  if (Array.isArray(bx.players) && bx.players.length) {
    for (const t of bx.players) {
      const groups = [];
      for (const st of t.statistics || []) {
        if (!(st.athletes || []).length) continue;
        let labels = st.labels || st.names || [], pick = labels.map((_, i) => i);
        const name = st.name || st.type || st.text || "";
        if (lg === "nhl") { const want = /goal/i.test(name) ? NHL_GOALIE : NHL_SKATER; pick = want.map(w => labels.indexOf(w)).filter(i => i >= 0); }
        groups.push({ name: name ? name[0].toUpperCase() + name.slice(1) : "Players", labels: pick.map(i => labels[i]),
          rows: st.athletes.map(x => ({ id: String(x.athlete?.id || ""), name: x.athlete?.displayName || "", short: x.athlete?.shortName || "", photo: photo(x.athlete),
            pos: x.position?.abbreviation || x.athlete?.position?.abbreviation || "", starter: !!x.starter, dnp: !!x.didNotPlay || !(x.stats || []).length,
            stats: pick.map(i => (x.stats || [])[i] ?? "") })),
          totals: st.totals ? pick.map(i => st.totals[i] ?? "") : null });
      }
      if (groups.length) players.push({ team: String(t.team?.id || ""), groups });
    }
  } else if (Array.isArray(d.rosters)) {                       // soccer: lineups with each player's match stats
    for (const r of d.rosters) {
      const rows = (r.roster || []).map(x => { const m = {}; for (const s of x.stats || []) m[s.name] = s.displayValue;
        return { id: String(x.athlete?.id || ""), name: x.athlete?.displayName || "", photo: photo(x.athlete), pos: x.position?.abbreviation || "", jersey: x.jersey || "",
          starter: !!x.starter, subIn: !!x.subbedIn, stats: SOCCER_COLS.map(([k]) => m[k] ?? "") }; }).filter(x => x.starter || x.subIn);
      if (rows.length) players.push({ team: String(r.team?.id || ""), formation: r.formation || null, groups: [{ name: "Lineup", labels: SOCCER_COLS.map(c => c[1]), rows, totals: null }] });
    }
  }
  return teams.length || players.length ? { teams, players } : null;
}
/* ---- everything around the game: venue, weather, officials, odds, injuries, form and news ---- */
function infoOf(d, lg) {
  const gi = d.gameInfo || {}, v = gi.venue || {};
  const pc = (d.pickcenter || [])[0] || null;
  const injuries = (d.injuries || []).map(t => ({ team: String(t.team?.id || ""), items: (t.injuries || []).slice(0, 12).map(x => ({
    name: x.athlete?.displayName || "", pos: x.athlete?.position?.abbreviation || "", status: x.status || x.type?.description || "",
    detail: [x.details?.type, x.details?.location, x.details?.side].filter(Boolean).join(", ") || x.details?.detail || "",
    photo: x.athlete?.headshot?.href || (x.athlete?.id ? `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${x.athlete.id}.png` : null) })) })).filter(t => t.items.length);
  const form = (d.lastFiveGames || []).map(t => ({ team: String(t.team?.id || ""), results: (t.events || []).slice(0, 5).map(e => ({ r: e.gameResult || "", score: e.score || "", opp: e.opponent?.abbreviation || e.opponent?.displayName || "", date: e.gameDate || "" })) })).filter(t => t.results.length);
  return {
    venue: v.fullName || null, city: [v.address?.city, v.address?.state || v.address?.country].filter(Boolean).join(", ") || null,
    capacity: v.capacity || null, attendance: gi.attendance || null, grass: v.grass == null ? null : v.grass ? "Grass" : "Turf",
    weather: gi.weather ? { temp: gi.weather.temperature ?? null, text: gi.weather.displayValue || gi.weather.conditionId || "" } : null,
    officials: (gi.officials || []).map(o => [o.position?.displayName || o.position?.name || "", o.displayName || o.fullName || ""]).filter(o => o[1]).slice(0, 8),
    odds: pc ? { provider: pc.provider?.name || "", details: pc.details || null, overUnder: pc.overUnder ?? null, spread: pc.spread ?? null,
      homeML: pc.homeTeamOdds?.moneyLine ?? null, awayML: pc.awayTeamOdds?.moneyLine ?? null, drawML: pc.drawOdds?.moneyLine ?? null } : null,
    injuries, form,
    news: ((d.news && d.news.articles) || []).slice(0, 6).map(a => ({ title: a.headline || "", desc: a.description || "", url: a.links?.web?.href || null, img: (a.images || [])[0]?.url || null, date: a.published || null })),
  };
}
/* ---- standings ---- */
const STAND_COLS = {
  nfl: [["wins", "W"], ["losses", "L"], ["ties", "T"], ["winPercent", "PCT"], ["pointsFor", "PF"], ["pointsAgainst", "PA"], ["pointDifferential", "DIFF"], ["streak", "STRK"]],
  nba: [["wins", "W"], ["losses", "L"], ["winPercent", "PCT"], ["gamesBehind", "GB"], ["avgPointsFor", "PPG"], ["avgPointsAgainst", "OPP"], ["streak", "STRK"]],
  mlb: [["wins", "W"], ["losses", "L"], ["winPercent", "PCT"], ["gamesBehind", "GB"], ["pointsFor", "RS"], ["pointsAgainst", "RA"], ["Last Ten Games", "L10"], ["streak", "STRK"]],
  nhl: [["gamesPlayed", "GP"], ["wins", "W"], ["losses", "L"], ["otLosses", "OTL"], ["points", "PTS"], ["pointsFor", "GF"], ["pointsAgainst", "GA"], ["streak", "STRK"]],
  epl: [["gamesPlayed", "GP"], ["wins", "W"], ["ties", "D"], ["losses", "L"], ["pointsFor", "GF"], ["pointsAgainst", "GA"], ["pointDifferential", "GD"], ["points", "PTS"]],
};
export function normStandings(d, lg) {
  const cols = STAND_COLS[lg] || [], groups = [];
  const walk = (node, label) => {
    const entries = node.standings?.entries || [];
    if (entries.length) {
      const rows = entries.map(e => { const m = {}; for (const s of e.stats || []) if (!(s.name in m)) m[s.name] = s.displayValue ?? s.summary ?? "";
        const logo = (e.team?.logos || [])[0]?.href || null;
        return { id: String(e.team?.id || ""), name: e.team?.displayName || "", short: e.team?.shortDisplayName || "", abbr: e.team?.abbreviation || "", logo,
          seed: +(m.playoffSeed || m.rank || 0) || null, note: e.note ? { color: e.note.color, text: e.note.description } : null, vals: cols.map(([k]) => m[k] ?? "") }; });
      const sortKey = lg === "epl" || lg === "nhl" ? "points" : "winPercent", i = cols.findIndex(c => c[0] === sortKey);
      if (i >= 0) rows.sort((a, b) => (parseFloat(b.vals[i]) || 0) - (parseFloat(a.vals[i]) || 0) || (a.seed || 99) - (b.seed || 99));
      groups.push({ name: label || node.name || "", rows });
    }
    for (const c of node.children || []) walk(c, c.name);
  };
  walk(d, d.name);
  return { league: lg, cols: cols.map(c => c[1]), groups, season: d.seasons?.[0]?.displayName || null };
}
export async function espnStandings(lg, fetchImpl = fetch) {
  return normStandings(await firstOf([() => getJSON(`https://site.web.api.espn.com/apis/v2/sports/${LEAGUES[lg]}/standings`, fetchImpl),
    () => getJSON(`https://site.api.espn.com/apis/v2/sports/${LEAGUES[lg]}/standings`, fetchImpl)]), lg);
}
/* ---- news ---- */
export function normNews(d) {
  return (d.articles || []).filter(a => a.headline).map(a => ({ title: a.headline, desc: a.description || "", url: a.links?.web?.href || a.links?.mobile?.href || null,
    img: (a.images || []).find(i => i.url)?.url || null, date: a.published || a.lastModified || null, byline: a.byline || null, video: a.type === "Media" }));
}
export async function espnNews(lg, teamId = null, fetchImpl = fetch) {
  const q = `?limit=${teamId ? 12 : 30}${teamId ? `&team=${teamId}` : ""}`;
  return normNews(await firstOf([() => getJSON(`${ESPN_WEB}${LEAGUES[lg]}/news${q}`, fetchImpl), () => getJSON(`${ESPN}${LEAGUES[lg]}/news${q}`, fetchImpl)]));
}
/* ---- a team's page: record, schedule and results, roster ---- */
export function normTeam(t, sched, roster, lg) {
  t = t?.team || t || {};
  const logo = (t.logos || [])[0]?.href || null;
  const games = ((sched && sched.events) || []).map(e => {
    const c = (e.competitions || [])[0] || {}, cs = c.competitors || [], me = cs.find(x => String(x.id || x.team?.id) === String(t.id)) || cs[0] || {}, op = cs.find(x => x !== me) || {};
    const sc = x => x.score == null ? null : typeof x.score === "object" ? x.score.displayValue ?? x.score.value : String(x.score);
    const st = c.status?.type || e.status?.type || {};
    return { id: String(e.id), date: e.date, home: me.homeAway === "home", state: st.state || "pre", detail: st.shortDetail || st.detail || "",
      opp: { id: String(op.team?.id || op.id || ""), name: op.team?.displayName || "", short: op.team?.shortDisplayName || "", abbr: op.team?.abbreviation || "", logo: (op.team?.logos || [])[0]?.href || op.team?.logo || null },
      us: sc(me), them: sc(op), won: me.winner === true, lost: op.winner === true, tv: (c.broadcasts || []).map(b => b.media?.shortName || b.names?.[0]).filter(Boolean)[0] || null,
      label: e.week?.text || e.seasonType?.name || "" };
  });
  const groups = [];
  const people = roster?.athletes || [];
  const person = x => ({ id: String(x.id || ""), name: x.displayName || x.fullName || "", jersey: x.jersey || "", pos: x.position?.abbreviation || "", age: x.age || null,
    ht: x.displayHeight || "", wt: x.displayWeight || "", photo: x.headshot?.href || (x.id ? `https://a.espncdn.com/i/headshots/${HEADSHOT[lg]}/players/full/${x.id}.png` : null),
    hurt: (x.injuries || [])[0]?.status || null, from: x.college?.name || x.birthPlace?.country || "" });
  if (people.length && people[0].items) for (const g of people) groups.push({ name: (g.position || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase()), players: (g.items || []).map(person) });
  else if (people.length) {
    const by = {}; for (const x of people) { const k = x.position?.displayName || x.position?.name || "Players"; (by[k] = by[k] || []).push(person(x)); }
    for (const [name, players] of Object.entries(by)) groups.push({ name, players });
  }
  for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].players.length) groups.splice(i, 1);
  return { league: lg, id: String(t.id || ""), name: t.displayName || "", short: t.shortDisplayName || "", abbr: t.abbreviation || "", logo,
    color: t.color ? "#" + t.color : null, alt: t.alternateColor ? "#" + t.alternateColor : null,
    record: t.record?.items?.[0]?.summary || null, standing: t.standingSummary || null, games, roster: groups,
    coach: roster?.coach?.[0] ? `${roster.coach[0].firstName || ""} ${roster.coach[0].lastName || ""}`.trim() : null };
}
export async function espnTeam(lg, id, fetchImpl = fetch) {
  const base = `${ESPN_WEB}${LEAGUES[lg]}/teams/${id}`, soft = p => p.catch(() => null);
  const [t, s, r] = await Promise.all([getJSON(base, fetchImpl), soft(getJSON(base + "/schedule", fetchImpl)), soft(getJSON(base + "/roster", fetchImpl))]);
  return normTeam(t, s, r, lg);
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
/* ---------------- Ask Cosmo: the AI companion ----------------
 * Answers questions about games, teams and the model from live data. Runs on Cloudflare Workers AI (free daily
 * allowance, no key needed) or, when the ANTHROPIC_API_KEY secret is set, on Claude for sharper answers. */
const ASK_CF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ASK_CLAUDE_MODEL = "claude-opus-5";
const ASK_RATE = new Map();                          // per-visitor limit, kept in memory
function askAllowed(ip) {
  const now = Date.now(), list = (ASK_RATE.get(ip) || []).filter(t => now - t < 600e3);
  if (list.length >= 20) return false;
  list.push(now); ASK_RATE.set(ip, list); if (ASK_RATE.size > 5000) ASK_RATE.clear(); return true;
}
/* ---- Listen Live: a natural human voice for play calls (Workers AI text to speech, free daily allowance) ----
   Deepgram's Aura voices sound like a real announcer; MeloTTS is the low-cost backup. The app falls back to the phone's own
   voice if this is unavailable. Identical lines (the same play heard by many listeners) come from Cloudflare's cache. */
const TTS_RATE = new Map();
function ttsAllowed(ip) {
  const now = Date.now(), list = (TTS_RATE.get(ip) || []).filter(t => now - t < 600e3);
  if (list.length >= 120) return false;
  list.push(now); TTS_RATE.set(ip, list); if (TTS_RATE.size > 5000) TTS_RATE.clear(); return true;
}
const TTS_MODELS = [
  { m: "@cf/deepgram/aura-2-en", premium: true, input: (text, v) => ({ text, speaker: v === "female" ? "thalia" : "apollo", encoding: "mp3" }) },
  { m: "@cf/deepgram/aura-1", premium: true, input: (text, v) => ({ text, speaker: v === "female" ? "asteria" : "orion", encoding: "mp3" }) },
  { m: "@cf/myshell-ai/melotts", premium: false, input: text => ({ prompt: text, lang: "en" }) },
];
async function audioBytes(r) {
  if (!r) return null;
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (ArrayBuffer.isView(r)) return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
  if (typeof ReadableStream !== "undefined" && r instanceof ReadableStream) return new Uint8Array(await new Response(r).arrayBuffer());
  if (typeof Response !== "undefined" && r instanceof Response) return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  if (typeof r.audio === "string") { const bin = atob(r.audio); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  if (r.audio) return audioBytes(r.audio);
  return null;
}
const sniff = u => u[0] === 0x52 && u[1] === 0x49 ? "audio/wav" : u[0] === 0x4f && u[1] === 0x67 ? "audio/ogg" : "audio/mpeg";
export async function speak(env, text, voice, premiumOk = true) {
  let err;
  for (const x of TTS_MODELS) {
    if (x.premium && !premiumOk) continue;
    for (const raw of x.premium ? [false, true] : [false]) {
      try {
        const bytes = await audioBytes(await env.AI.run(x.m, x.input(text, voice), raw ? { returnRawResponse: true } : undefined));
        if (bytes && bytes.byteLength > 800) return { bytes, type: sniff(bytes), name: x.m.split("/").pop() };
      } catch (e) { err = e; }
    }
  }
  throw err || new Error("no voice available");
}

const LEAGUE_NAME = { nfl: "NFL", nba: "NBA", mlb: "MLB", nhl: "NHL", epl: "Premier League" };
async function askBoard(fetchImpl, dates) {
  const parts = await Promise.all(Object.keys(LEAGUE_NAME).map(async lg => {
    try {
      const d = await espnScoreboard(lg, fetchImpl, dates);
      const rows = (d.games || []).slice(0, 30).map(g => {
        const st = g.status?.state, sc = st === "pre" ? "" : ` ${g.away.score ?? ""}-${g.home.score ?? ""}`;
        return `${g.away.name} at ${g.home.name}${sc} (${st === "pre" ? g.status?.detail || "scheduled" : g.status?.short || st})${g.tv?.length ? ", TV " + g.tv[0] : ""}${g.odds?.details ? ", line " + g.odds.details : ""}`;
      });
      return rows.length ? `${LEAGUE_NAME[lg]}:\n- ${rows.join("\n- ")}` : `${LEAGUE_NAME[lg]}: no games on the current scoreboard`;
    } catch { return `${LEAGUE_NAME[lg]}: scores unavailable right now`; }
  }));
  return parts.join("\n\n");
}
const ASK_SYSTEM = `You are Cosmo, the sports companion inside the Cosmo Sports app. You help fans follow the NFL, NBA, MLB, NHL, Premier League and tennis.
How to answer:
- Be direct and conversational, like a knowledgeable friend. Keep most answers under 150 words; use a short list only when it helps.
- Ground every claim about scores, schedules, standings or predictions in the LIVE DATA and APP CONTEXT sections. Today's scoreboards show games scheduled or played today; yesterday's results are listed separately. Keep leagues straight: never call a hockey game a baseball game. If what's asked isn't there, say you don't have it right now instead of guessing, and suggest where in the app to look.
- The app has its own prediction model; when you quote its win chances, call them "the Cosmo model" and remember they're probabilities, not certainties.
- Betting: you may explain lines and compare them with the model, but don't tell people to bet or promise outcomes.
- Plain text only. You may use **bold** for a name or number and "- " bullets. No headings, tables or links.`;
export async function askCosmo(env, body, fetchImpl = fetch) {
  const history = (Array.isArray(body?.messages) ? body.messages : []).slice(-10)
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") throw new Error("no question");
  const today = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const y = etParts(new Date(Date.now() - 864e5)), [board, yboard] = await Promise.all([askBoard(fetchImpl), askBoard(fetchImpl, `${y.year}${y.month}${y.day}`)]);
  const context = `Current time (US Eastern): ${today}\n\nLIVE DATA - TODAY'S SCOREBOARDS:\n${board}\n\nLIVE DATA - YESTERDAY'S RESULTS:\n${yboard}\n\nAPP CONTEXT (from the person's app):\n${String(body?.context || "none").slice(0, 8000)}`;
  const enc = new TextEncoder();
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    // server-side fallbacks: if the model declines, the API retries on a fallback model in the same call
    const stream = client.beta.messages.stream({
      model: ASK_CLAUDE_MODEL, max_tokens: 4000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: ASK_SYSTEM }, { type: "text", text: context }],
      messages: history,
    });
    return new ReadableStream({
      async start(ctrl) {
        try {
          for await (const ev of stream) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") ctrl.enqueue(enc.encode(ev.delta.text));
          const msg = await stream.finalMessage();
          if (msg.stop_reason === "refusal") ctrl.enqueue(enc.encode("Sorry, I can't help with that one."));
        } catch (e) { ctrl.enqueue(enc.encode(e instanceof Anthropic.RateLimitError ? "\n\nI'm getting a lot of questions right now. Try again in a minute." : "\n\nSorry, I couldn't finish that answer. Try again.")); }
        ctrl.close();
      },
    });
  }
  if (!env.AI) throw new Error("no AI backend");
  const src = await env.AI.run(ASK_CF_MODEL, { messages: [{ role: "system", content: ASK_SYSTEM + "\n\n" + context }, ...history], stream: true, max_tokens: 900 });
  const dec = new TextDecoder(); let buf = "";
  return src.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) { const m = /^data:\s*(.*)$/.exec(l.trim()); if (!m || m[1] === "[DONE]") continue;
        try { const t = JSON.parse(m[1]).response; if (t) ctrl.enqueue(enc.encode(t)); } catch {} }
    },
  }));
}

/* ---------------- Track record: every model pick is locked in before the game starts, then graded when it ends ----------------
   Every 10 minutes, games starting in the next 90 minutes get the model's pick and the bookmaker's moneyline. The latest pre-game
   snapshot wins, and nothing changes once the game has started. Finished games get their result. Storage: one record per day
   ("trk:d:YYYYMMDD", US Eastern), the list of days ("trk:days"), and today's start times plus games awaiting a result ("trk:state").
   The model is the same one the app runs (models.json); these functions mirror the app's mTeam/mFeatures/mCore exactly. */
export const TRACK_SINCE = "2026-09-24";
const TRACK_LEAGUES = ["nfl", "nba", "mlb", "nhl", "epl"];
const LOCK_MS = 90 * 60e3, GAME_H = { nfl: 3.2, nba: 2.3, mlb: 2.7, nhl: 2.4, epl: 1.9 };
const etDay = d => { const p = etParts(new Date(d)); return `${p.year}${p.month}${p.day}`; };
const ymdMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const gapDays = (last, when) => last ? Math.round((ymdMs(etDay(when)) - ymdMs(last)) / 864e5) : null;
const mkey = n => String(n || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\b(fc|afc)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
function modelTeam(M, name) {
  if (!M._keys) { M._keys = {}; for (const n of Object.keys(M.state)) M._keys[mkey(n)] = n; }
  const k = mkey(name), alt = Object.keys(M._keys).find(x => x.endsWith(" " + k) || k.endsWith(" " + x)), n = M._keys[k] || (alt && M._keys[alt]);
  return n ? M.state[n] : null;
}
function pois3(lh, la, rho) {
  const N = 10, f = l => { const o = []; let p = Math.exp(-l); for (let i = 0; i <= N; i++) { o.push(p); p *= l / (i + 1); } return o; }, fh = f(lh), fa = f(la);
  const G = fh.map(x => fa.map(y => x * y));
  if (rho) { G[0][0] *= 1 - lh * la * rho; G[0][1] *= 1 + lh * rho; G[1][0] *= 1 + la * rho; G[1][1] *= 1 - rho; }
  let s = 0, h = 0, d = 0, a = 0; G.forEach(r => r.forEach(v => s += v));
  G.forEach((r, i) => r.forEach((v, j) => { v /= s; if (i > j) h += v; else if (i === j) d += v; else a += v; }));
  return { home: h, draw: d, away: a };
}
// the model's win chances and projected score for one scoreboard game (null when the model doesn't know a team)
export function modelProbs(models, lg, g) {
  const M = models && models[lg]; if (!M) return null;
  const H = modelTeam(M, g.home.name), A = modelTeam(M, g.away.name); if (!H || !A) return null;
  const m = M.model, cap = m.rest_cap, avg = m.lg_avg, when = g.date;
  const restOf = s => { const d = gapDays(s.last, when); return d == null ? cap : Math.max(0, Math.min(cap, d)); };
  const mean = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : .5;
  const share = (s, k) => s.x && s.x[k] != null ? s.x[k] : .5;
  const spRa = name => { const p = name && M.pitchers && M.pitchers[name]; if (!p) return 4.45; const [prior, roll, n] = p; return roll == null ? prior : (prior * 8 + roll * n) / (8 + n); };
  const pr = g.probables, dH = gapDays(H.last, when), dA = gapDays(A.last, when);
  const x = { home: g.neutral ? 0 : 1, elo_d: H.elo - A.elo, mov_d: H.mov - A.mov, form_d: mean(H.form) - mean(A.form), rest_d: restOf(H) - restOf(A),
    b2b_h: dH != null && dH <= 1 ? 1 : 0, b2b_a: dA != null && dA <= 1 ? 1 : 0, sp_d: lg === "mlb" ? spRa(pr && pr[0]) - spRa(pr && pr[1]) : 0, qb_d: 0,
    shots_d: share(H, "shots_share") - share(A, "shots_share"), sot_d: share(H, "sot_share") - share(A, "sot_share"), fg_d: share(H, "fg_share") - share(A, "fg_share"),
    pf_h: H.pf ?? avg, pa_h: H.pa ?? avg, pf_a: A.pf ?? avg, pa_a: A.pa ?? avg };
  const z = k => (x[k] - m.mean[k]) / m.sd[k];
  if (m.kind === "poisson") {
    const lam = (side, sign) => { const P = side === "h" ? m.home_goals : m.away_goals, v = m.feats.map(k => z(k) * sign).concat([Math.log(Math.max(.14, side === "h" ? x.pf_h : x.pf_a)), Math.log(Math.max(.14, side === "h" ? x.pa_a : x.pa_h))]);
      return Math.exp(P.intercept + v.reduce((s, vi, i) => s + vi * P.coef[i], 0)); };
    const lh = lam("h", 1), la = lam("a", -1);
    return { ...pois3(lh, la, m.rho), proj: [lh, la] };
  }
  let s = m.coef.home * x.home; for (const k of m.feats) s += m.coef[k] * z(k);
  const p = 1 / (1 + Math.exp(-s)), S = m.scores;
  return { home: p, away: 1 - p, proj: [S.home[0] + S.home[1] * x.pf_h + S.home[2] * x.pa_a + S.home[3] * x.home, S.away[0] + S.away[1] * x.pf_a + S.away[2] * x.pa_h + S.away[3] * x.home] };
}
const mlNum = v => { if (v == null || v === "") return null; if (/^\s*even\s*$/i.test(String(v))) return 100; const x = parseFloat(String(v).replace("−", "-")); return isFinite(x) && Math.abs(x) >= 100 ? x : null; };
export function trackOdds(o, soccer) {
  if (!o) return null; const h = mlNum(o.homeML), a = mlNum(o.awayML), d = mlNum(o.drawML);
  if (h == null || a == null || (soccer && d == null)) return null;
  return soccer ? { h, d, a, book: o.provider || null } : { h, a, book: o.provider || null };
}
let TRK_MODELS = null;
async function trackModels(env, fetchImpl) {
  if (TRK_MODELS && Date.now() - TRK_MODELS.at < 3600e3) return TRK_MODELS.m;
  const r = await siteGet(env, `/models.json?t=${Math.floor(Date.now() / 36e5)}`, fetchImpl);
  if (!r.ok) throw new Error("models " + r.status);
  TRK_MODELS = { at: Date.now(), m: await r.json() }; return TRK_MODELS.m;
}
export async function trackTick(env, fetchImpl = fetch, now = new Date(), force = false) {
  if (!force && now.getUTCMinutes() % 10 !== 4) return "not time";
  const db = store(env), t = now.getTime(), today = etDay(t);
  const st = JSON.parse(await db.get("trk:state") || "{}"); st.sched = st.sched || {}; st.open = st.open || [];
  const need = new Set();
  for (const lg of TRACK_LEAGUES) {
    const s = st.sched[lg];
    if (!s || s.day !== today || t - s.at >= 3600e3 || s.starts.some(x => x > t && x - t <= LOCK_MS + 10 * 60e3)) need.add(`${lg}|${today}`);
  }
  for (const o of st.open) if (t > o.start + GAME_H[o.lg] * 3600e3 || (o.start > t && o.start - t <= LOCK_MS)) need.add(`${o.lg}|${o.day}`);
  if (!need.size) return { boards: 0 };
  let models = null; try { models = await trackModels(env, fetchImpl); } catch {}
  const dayList = [...new Set([...need].map(k => k.split("|")[1]))], raw = await db.many(dayList.map(d => "trk:d:" + d)), days = {};
  for (const d of dayList) { const v = raw["trk:d:" + d]; days[d] = (typeof v === "string" ? JSON.parse(v) : v) || {}; }
  const dirty = new Set(); let locked = 0, graded = 0;
  for (const k of need) {
    const [lg, day] = k.split("|");
    let board; try { board = await espnScoreboard(lg, fetchImpl, day); } catch { continue; }
    const games = board.games || [], rec = days[day];
    const pre = g => lg !== "epl" && g.stype === 1;                                      // preseason: not tracked
    if (day === today) st.sched[lg] = { day, at: t, starts: games.filter(g => g.status?.state === "pre" && !pre(g)).map(g => Date.parse(g.date)).filter(x => x > t) };
    const inWin = g => { const s = Date.parse(g.date); return g.status?.state === "pre" && !pre(g) && s > t && s - t <= LOCK_MS; };
    let espnMlb = null;                                                                    // MLB's own feed has no odds: take ESPN's for the same game
    if (lg === "mlb" && games.some(inWin)) { try { espnMlb = (await espnBoard("mlb", fetchImpl, day)).games || []; } catch { espnMlb = []; } }
    for (const g of games) {
      const key = `${lg}/${g.id}`, cur = rec[key];
      if (inWin(g) && models && (!cur || cur.res == null)) {
        const p = modelProbs(models, lg, g); if (!p) continue;
        let o = g.odds;
        if (lg === "mlb") { const gs = Date.parse(g.date), m = (espnMlb || []).filter(x => mkey(x.home.name) === mkey(g.home.name) && mkey(x.away.name) === mkey(g.away.name))
            .sort((a, b) => Math.abs(Date.parse(a.date) - gs) - Math.abs(Date.parse(b.date) - gs))[0];
          o = m && Math.abs(Date.parse(m.date) - gs) < 4 * 3600e3 ? m.odds : null; }
        const r4 = v => Math.round(v * 1e4) / 1e4;
        const pick = { lg, id: g.id, day, start: g.date, home: { name: g.home.name, abbr: g.home.abbr || "" }, away: { name: g.away.name, abbr: g.away.abbr || "" },
          p: lg === "epl" ? [r4(p.home), r4(p.draw), r4(p.away)] : [r4(p.home), r4(p.away)], proj: p.proj.map(v => Math.round(v * 100) / 100),
          odds: trackOdds(o, lg === "epl") || cur?.odds || null, ...(lg === "mlb" && g.probables ? { sp: g.probables } : {}), locked: now.toISOString(), res: null };
        if (!cur || JSON.stringify(cur.p) !== JSON.stringify(pick.p) || JSON.stringify(cur.odds) !== JSON.stringify(pick.odds)) {
          rec[key] = pick; dirty.add(day); locked++;
          if (!st.open.some(x => x.k === key)) st.open.push({ k: key, lg, day, start: Date.parse(g.date) });
        }
      } else if (cur && cur.res == null && g.status?.state === "post") {
        const h = parseFloat(g.home.score), a = parseFloat(g.away.score);
        const bad = !g.status.completed || /postpon|cancel|suspend|forfeit|abandon|delay/i.test(`${g.status.detail || ""} ${g.status.short || ""}`) || !isFinite(h) || !isFinite(a);
        cur.res = bad ? "void" : h > a ? "home" : a > h ? "away" : "draw";
        if (!bad) cur.score = [h, a];
        cur.graded = now.toISOString(); dirty.add(day); graded++;
        st.open = st.open.filter(x => x.k !== key);
      }
    }
  }
  // a game that never reported a result within three days (moved, abandoned, missing from the feed): void it
  for (const o of st.open.filter(o => t - o.start > 72 * 3600e3)) { const r = days[o.day]?.[o.k]; if (r && r.res == null) { r.res = "void"; r.graded = now.toISOString(); dirty.add(o.day); } }
  st.open = st.open.filter(o => t - o.start <= 72 * 3600e3 || !days[o.day]).slice(-500);
  for (const d of dirty) await db.put("trk:d:" + d, JSON.stringify(days[d]));
  if (dirty.size) { const list = JSON.parse(await db.get("trk:days") || "[]"), add = [...dirty].filter(d => !list.includes(d)); if (add.length) await db.put("trk:days", JSON.stringify([...list, ...add].sort())); }
  await db.put("trk:state", JSON.stringify(st));
  return { boards: need.size, locked, graded, open: st.open.length };
}
export async function trackAll(db) {
  const days = JSON.parse(await db.get("trk:days") || "[]"), picks = [];
  for (let i = 0; i < days.length; i += 100) {
    const part = days.slice(i, i + 100), m = await db.many(part.map(d => "trk:d:" + d));
    for (const d of part) { const v = m["trk:d:" + d]; picks.push(...Object.values((typeof v === "string" ? JSON.parse(v) : v) || {})); }
  }
  return { since: TRACK_SINCE, asof: new Date().toISOString(), picks };
}

/* ---------------- Cosmic: social betting with Cosmic Coins, and limited-edition collectibles ----------------
   Play money only: Cosmic Coins can't be bought with money or cashed out; they only move inside Cosmic (bets, packs, and cards sold to the shop or other players). Everyone starts with 1,000 and can claim
   more every day; coins are won or lost betting on real games at real sportsbook prices (the model's fair price, with a small
   margin, where no book has a line). Coins open packs of numbered, limited-edition team and player cards (1 of 1 up to 1 of 1,000) whose
   supply is shared by everyone, so there is only ever one 1/1 of each. Cards live here, not on a blockchain, so they have
   no cash value either.
   Every change to coins or cards runs as one step inside the Durable Object (czTx), so two people can't buy the same last card. */
const CZ_SHOP = .4, CZ_FEE = .05, CZ_START = 1000, CZ_DAILY = 250, CZ_MIN = 10, CZ_MAX = 5000, CZ_OPEN_MAX = 30, CZ_MARGIN = 1.045;
// supply is for the whole game: one Singularity of each card exists, ten Supernovas, and so on
export const CZ_TIERS = [["singularity", "Singularity", 1, 25000], ["supernova", "Supernova", 10, 5000], ["quasar", "Quasar", 25, 2800], ["nebula", "Nebula", 50, 1500],
  ["pulsar", "Pulsar", 100, 800], ["stardust", "Stardust", 250, 400], ["comet", "Comet", 1000, 150]];
// packs: the chance (%) that each card is Singularity, Supernova, Quasar, Nebula, Pulsar, Stardust or Comet. Shown in the app.
export const CZ_PACKS = [
  { id: "comet", label: "Comet Pack", price: 250, cards: 3, odds: [0.01, 0.09, 0.4, 1.5, 5, 18, 75] },
  { id: "nebula", label: "Nebula Pack", price: 1000, cards: 3, odds: [0.05, 0.45, 1.5, 6, 17, 35, 40] },
  { id: "supernova", label: "Supernova Pack", price: 4000, cards: 3, odds: [0.2, 1.8, 6, 17, 30, 45, 0] },
  { id: "singularity", label: "Singularity Pack", price: 12000, cards: 2, odds: [1, 5, 14, 30, 50, 0, 0] },
];
const CZ_SCOPES = { all: null, nfl: ["nfl"], nba: ["nba"], mlb: ["mlb"], nhl: ["nhl"], epl: ["epl"], tennis: ["atp", "wta"] }, CZ_KINDS = ["all", "team", "player"];
const czSlug = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const czHash = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))))].map(b => b.toString(16).padStart(2, "0")).join("");
// leaderboard names are public, so offensive ones are refused (look-alike letters are folded, so "b1tch" or "F.U.C.K" don't get through)
const CZ_BAD = ["fuck", "shit", "bitch", "nigg", "faggot", "whore", "porn", "hitler", "asshole", "pussy", "retard", "rapist", "motherf"],
  CZ_BAD_WORD = ["fag", "sex", "dick", "cock", "cunt", "rape", "kkk", "nazi", "slut", "twat", "spic", "kike", "chink", "coon", "penis", "vagina", "tranny", "wank", "bastard", "cum", "tits", "anal", "nigga", "nigger"];
const czFold = t => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[0@4]/g, m => ({ 0: "o", "@": "a", 4: "a" })[m]).replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[5$]/g, "s").replace(/7/g, "t");
export const czNameOk = name => { const n = czFold(String(name)), all = n.replace(/[^a-z]/g, ""), words = n.split(/[\s_-]+/).map(w => w.replace(/[^a-z]/g, ""));
  return !CZ_BAD.some(w => all.includes(w)) && !words.some(w => CZ_BAD_WORD.includes(w)) && !CZ_BAD_WORD.includes(all); };
const czRand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const czPublic = u => u && ({ uid: u.uid, name: u.name, passkey: !!u.ident, tester: !!u.tester, bal: u.bal, packs: u.packs || 0, won: u.won || 0, lost: u.lost || 0, profit: u.profit || 0, streak: u.streak || 0, lastDaily: u.lastDaily || null,
  bets: (u.bets || []).slice(-100), items: u.items || [], created: u.created });
const czLbRow = u => ({ uid: u.uid, tester: !!u.tester || undefined, name: u.name, bal: u.bal, profit: u.profit || 0, won: u.won || 0, lost: u.lost || 0, cards: (u.items || []).length,
  best: (u.items || []).reduce((b, i) => Math.min(b, i.supply || 999), 999) });
// every change to coins and cards; st is the Durable Object's storage (or a KV stand-in), a is the action
export async function czTx(st, a) {
  const get = async (k, d) => (await st.get(k)) ?? d;
  const feed = async ev => { const f = await get("cz:feed", []); f.unshift({ ...ev, at: a.now }); await st.put("cz:feed", f.slice(0, 60)); };
  const lb = async u => { const L = await get("cz:lb", {}); L[u.uid] = czLbRow(u); await st.put("cz:lb", L); };
  if (a.act === "ident") {
    // passkey sign-in: the passkey's account id (stored only as a hash) finds the account, links an existing one, or starts a new one.
    // Each device that signs in gets its own key (only its hash is stored), so signing in on a new phone doesn't sign out the old.
    const map = await get("cz:id:" + a.sub, null), addTok = u => { u.toks = [...(u.toks || []), a.tok].slice(-10); };
    if (map) { const u = await st.get("cz:u:" + map); if (u) { addTok(u); await st.put("cz:u:" + u.uid, u); return { user: czPublic(u), uid: u.uid }; } }
    if (a.linkUid) { const u = await st.get("cz:u:" + a.linkUid); if (!u) return { error: "Account not found." }; u.ident = u.ident || a.sub; addTok(u); await st.put("cz:u:" + u.uid, u); await st.put("cz:id:" + a.sub, u.uid); return { user: czPublic(u), uid: u.uid, linked: true }; }
    if (!a.name) return { needName: true };
    const names = await get("cz:names", {}), key = a.name.toLowerCase();
    if (names[key]) return { error: "That name is taken. Try another.", needName: true };
    const u = { uid: a.uid, name: a.name, tok: a.tok, toks: [], ident: a.sub, bal: CZ_START, created: a.now, bets: [], items: [], won: 0, lost: 0, profit: 0, streak: 0 };
    names[key] = a.uid; await st.put("cz:names", names); await st.put("cz:u:" + a.uid, u); await st.put("cz:id:" + a.sub, a.uid); await lb(u);
    await feed({ kind: "join", name: a.name });
    return { user: czPublic(u), uid: a.uid, created: true };
  }
  if (a.act === "tester") {                                          // the site owner's testing switch: unlimited coins, off the leaderboards
    const u = await st.get("cz:u:" + a.uid); if (!u) return { error: "Account not found." };
    u.tester = !!a.on; await st.put("cz:u:" + u.uid, u); await lb(u); return { user: czPublic(u) };
  }
  if (a.act === "join") {
    const names = await get("cz:names", {}), key = a.name.toLowerCase();
    if (names[key]) return { error: "That name is taken. Try another." };
    const u = { uid: a.uid, name: a.name, tok: a.tok, bal: CZ_START, created: a.now, bets: [], items: [], won: 0, lost: 0, profit: 0, streak: 0 };
    names[key] = a.uid; await st.put("cz:names", names); await st.put("cz:u:" + a.uid, u); await lb(u);
    await feed({ kind: "join", name: a.name });
    return { user: czPublic(u) };
  }
  const u = await st.get("cz:u:" + a.uid);
  if (!u) return { error: "Account not found." };
  if (a.act === "daily") {
    if (u.lastDaily === a.day) return { error: "Already claimed today. Come back tomorrow." };
    u.streak = u.lastDaily === a.yday ? Math.min(7, (u.streak || 0) + 1) : 1;
    const amt = CZ_DAILY + (u.streak - 1) * 50; u.bal += amt; u.lastDaily = a.day;
    await st.put("cz:u:" + a.uid, u); await lb(u);
    return { user: czPublic(u), amount: amt };
  }
  if (a.act === "bet") {
    const b = a.bet, stake = Math.floor(+b.stake);
    if (!(stake >= CZ_MIN && stake <= CZ_MAX)) return { error: `Bets are ${CZ_MIN} to ${CZ_MAX.toLocaleString()} coins.` };
    if (stake > u.bal && !u.tester) return { error: "Not enough Cosmic Coins." };
    const open = (u.bets || []).filter(x => !x.res);
    if (open.length >= CZ_OPEN_MAX) return { error: `You can have ${CZ_OPEN_MAX} open bets at once.` };
    if (open.some(x => x.lg === b.lg && x.gid === b.gid && x.side !== b.side)) return { error: "You already have the other side of this game." };
    const bet = { ...b, stake, placed: a.now, res: null };
    if (!u.tester) u.bal -= stake; u.bets = [...(u.bets || []), bet].slice(-150);
    const O = await get("cz:open", []); O.push({ uid: u.uid, bid: bet.bid, lg: b.lg, gid: b.gid, day: b.day, start: b.start });
    await st.put("cz:open", O); await st.put("cz:u:" + a.uid, u); await lb(u);
    return { user: czPublic(u), bet };
  }
  if (a.act === "pack") {
    // open a pack: each card's tier is rolled with the pack's published odds, then a card of that tier the player doesn't own
    // yet is drawn from what's left. If every card of that tier is gone, the pull moves to the next more common tier.
    const pk = a.pack, mint = await get("cz:mint", {}), ret = await get("cz:ret", {}), owned = new Set((u.items || []).map(x => x.id));
    const out = id => (mint[id] || 0) - (ret[id] || []).length;                  // copies held by collectors (sold-back copies return to packs)
    if (u.bal < pk.price && !u.tester) return { error: "Not enough Cosmic Coins." };
    const order = CZ_TIERS.map(t => t[0]), pulled = [], rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const left = t => a.pool.filter(i => i.tier === t && out(i.id) < i.supply && !owned.has(i.id) && !pulled.some(x => x.id === i.id));
    for (let c = 0; c < pk.cards; c++) {
      let r = rnd() * 100, tier = order[order.length - 1];
      for (let k = 0; k < order.length; k++) { r -= pk.odds[k]; if (r < 0) { tier = order[k]; break; } }
      let ti = order.indexOf(tier), cands = left(tier);
      for (let k = ti + 1; !cands.length && k < order.length; k++) cands = left(order[k]);      // sold out: the next more common tier
      for (let k = ti - 1; !cands.length && k >= 0; k--) cands = left(order[k]);
      if (!cands.length) break;
      const it = cands[Math.floor(rnd() * cands.length)], back = ret[it.id] || [];
      let n; if (back.length) { back.sort((x, y) => x - y); n = back.shift(); ret[it.id] = back; } else { n = (mint[it.id] || 0) + 1; mint[it.id] = n; }
      pulled.push({ id: it.id, n, supply: it.supply, tier: it.tier, lg: it.lg, name: it.name, kind: it.kind, team: it.team, pos: it.pos, img: it.img, rolled: tier, at: a.now, pack: pk.id });
    }
    if (!pulled.length) return { error: "You've collected every card this pack could give you." };
    if (!u.tester) u.bal -= pk.price; u.items = [...(u.items || []), ...pulled]; u.packs = (u.packs || 0) + 1;
    for (const c of pulled) {
      const owners = await get("cz:own:" + c.id, []); owners.push({ n: c.n, uid: u.uid, name: u.name, at: a.now }); await st.put("cz:own:" + c.id, owners);
      if (c.supply <= 25) await feed({ kind: "pull", name: u.name, item: c.id, label: c.name, tier: c.tier, n: c.n, supply: c.supply, pack: pk.label });
    }
    await st.put("cz:mint", mint); await st.put("cz:ret", ret); await st.put("cz:u:" + a.uid, u); await lb(u);
    return { user: czPublic(u), cards: pulled };
  }
  const card = id => (u.items || []).find(x => x.id === id);
  const dropOwner = async (id, uid) => { const o = await get("cz:own:" + id, []); await st.put("cz:own:" + id, o.filter(x => x.uid !== uid)); };
  if (a.act === "delete") {
    // delete an account for good: its cards go back into packs, its listings and open bets are dropped,
    // its name is freed and it leaves the leaderboards, the feed and the saved teams and settings
    const del = k => st.delete ? st.delete(k) : st.put(k, null), ret = await get("cz:ret", {});
    for (const c of u.items || []) { ret[c.id] = [...(ret[c.id] || []), c.n]; await dropOwner(c.id, u.uid); }
    await st.put("cz:ret", ret);
    await st.put("cz:mkt", (await get("cz:mkt", [])).filter(x => x.uid !== u.uid));
    await st.put("cz:open", (await get("cz:open", [])).filter(x => x.uid !== u.uid));
    await st.put("cz:feed", (await get("cz:feed", [])).filter(x => x.name !== u.name && x.seller !== u.name));
    const names = await get("cz:names", {}), key = String(u.name).toLowerCase(); if (names[key] === u.uid) { delete names[key]; await st.put("cz:names", names); }
    const L = await get("cz:lb", {}); delete L[u.uid]; await st.put("cz:lb", L);
    if (u.ident) await del("cz:id:" + u.ident);
    await del("cz:data:" + u.uid); await del("cz:u:" + u.uid);
    return { deleted: true };
  }
  if (a.act === "sell") {                                            // sell back to the shop: coins now, and the copy goes back into packs
    const c = card(a.id); if (!c) return { error: "That card isn't in your collection." };
    if (c.listed) return { error: "Take it off the market first." };
    const pay = Math.max(1, Math.floor(a.value * CZ_SHOP));
    u.items = u.items.filter(x => x.id !== a.id); u.bal += pay; u.sold = (u.sold || 0) + 1;
    const ret = await get("cz:ret", {}); ret[a.id] = [...(ret[a.id] || []), c.n]; await st.put("cz:ret", ret);
    await dropOwner(a.id, u.uid); await st.put("cz:u:" + a.uid, u); await lb(u);
    return { user: czPublic(u), paid: pay };
  }
  if (a.act === "list") {
    const c = card(a.id), price = Math.floor(+a.price);
    if (!c) return { error: "That card isn't in your collection." };
    if (c.listed) return { error: "It's already on the market." };
    if (!(price >= 10 && price <= 1000000)) return { error: "Ask between 10 and 1,000,000 coins." };
    const M = await get("cz:mkt", []); if (M.filter(x => x.uid === u.uid).length >= 20) return { error: "You can have 20 cards on the market at once." };
    const lid = czRand(6); c.listed = lid;
    M.unshift({ lid, id: c.id, n: c.n, supply: c.supply, tier: c.tier, lg: c.lg, name: c.name, kind: c.kind, team: c.team, pos: c.pos, img: c.img, price, uid: u.uid, seller: u.name, at: a.now });
    await st.put("cz:mkt", M.slice(0, 2000)); await st.put("cz:u:" + a.uid, u);
    return { user: czPublic(u), lid };
  }
  if (a.act === "unlist") {
    const M = await get("cz:mkt", []), l = M.find(x => x.lid === a.lid && x.uid === u.uid); if (!l) return { error: "Listing not found." };
    const c = card(l.id); if (c) delete c.listed;
    await st.put("cz:mkt", M.filter(x => x.lid !== a.lid)); await st.put("cz:u:" + a.uid, u);
    return { user: czPublic(u) };
  }
  if (a.act === "buyl") {                                            // buy another player's card: coins to them (less the market fee), the card to you
    const M = await get("cz:mkt", []), l = M.find(x => x.lid === a.lid); if (!l) return { error: "Someone else got there first. That card is no longer for sale." };
    if (l.uid === u.uid) return { error: "That's your own listing." };
    if (card(l.id)) return { error: "You already own a copy of this card." };
    if (u.bal < l.price && !u.tester) return { error: "Not enough Cosmic Coins." };
    const s = await st.get("cz:u:" + l.uid); if (!s) return { error: "The seller's account is gone." };
    const c = (s.items || []).find(x => x.id === l.id && x.listed === l.lid); if (!c) { await st.put("cz:mkt", M.filter(x => x.lid !== l.lid)); return { error: "That card is no longer for sale." }; }
    const fee = Math.ceil(l.price * CZ_FEE);
    if (!u.tester) u.bal -= l.price; s.bal += l.price - fee; s.items = s.items.filter(x => x.id !== l.id); s.sold = (s.sold || 0) + 1;
    delete c.listed; u.items = [...(u.items || []), { ...c, at: a.now, bought: l.price, from: s.name }];
    const o = await get("cz:own:" + l.id, []); await st.put("cz:own:" + l.id, [...o.filter(x => x.uid !== s.uid), { n: c.n, uid: u.uid, name: u.name, at: a.now, price: l.price }]);
    await st.put("cz:mkt", M.filter(x => x.lid !== l.lid)); await st.put("cz:u:" + s.uid, s); await st.put("cz:u:" + a.uid, u); await lb(u); await lb(s);
    await feed({ kind: "sale", name: u.name, seller: s.name, label: c.name, tier: c.tier, n: c.n, supply: c.supply, price: l.price });
    return { user: czPublic(u), card: c };
  }
  return { error: "Unknown action." };
}
// results for finished games: pay out, refund, or settle as lost (one step for everyone at once)
export async function czSettleTx(st, a) {
  const O = (await st.get("cz:open")) ?? [], done = new Map(a.results.map(r => [r.uid + "/" + r.bid, r.res]));
  const users = {}, L = (await st.get("cz:lb")) ?? {}, F = (await st.get("cz:feed")) ?? [];
  for (const o of O) {
    const res = done.get(o.uid + "/" + o.bid); if (!res) continue;
    const u = users[o.uid] ??= await st.get("cz:u:" + o.uid); if (!u) continue;
    const b = (u.bets || []).find(x => x.bid === o.bid); if (!b || b.res) continue;
    b.res = res; b.settled = a.now;
    if (res === "win") { b.paid = Math.round(b.stake * b.dec); u.bal += b.paid; u.won = (u.won || 0) + 1; u.profit = (u.profit || 0) + b.paid - b.stake;
      if (b.paid - b.stake >= 1000) F.unshift({ kind: "win", name: u.name, label: b.label, paid: b.paid, dec: b.dec, at: a.now }); }
    else if (res === "loss") { b.paid = 0; u.lost = (u.lost || 0) + 1; u.profit = (u.profit || 0) - b.stake; }
    else { b.paid = b.stake; u.bal += b.stake; }
  }
  for (const u of Object.values(users)) if (u) { await st.put("cz:u:" + u.uid, u); L[u.uid] = czLbRow(u); }
  await st.put("cz:open", O.filter(o => !done.has(o.uid + "/" + o.bid)));
  await st.put("cz:lb", L); await st.put("cz:feed", F.slice(0, 60));
  return { settled: done.size };
}
function czKv(env) {                                                         // KV stand-in for setups without the Durable Object (not atomic)
  return { get: async k => { const v = await env.KV.get(k); return v == null ? undefined : JSON.parse(v); }, put: (k, v) => env.KV.put(k, JSON.stringify(v)), delete: k => env.KV.delete ? env.KV.delete(k) : env.KV.put(k, "null") };
}
async function cz(env, a) {
  if (env.STORE) { const stub = env.STORE.get(env.STORE.idFromName("main")); const r = await stub.fetch("https://store/", { method: "POST", body: JSON.stringify({ op: "cz", a }) }); return (await r.json()).v; }
  return a.act === "settle" ? czSettleTx(czKv(env), a) : czTx(czKv(env), a);
}
const czRead = async (env, k, d) => { const v = await store(env).get(k); return v == null ? d : typeof v === "string" ? JSON.parse(v) : v; };
// the prices on offer: the sportsbook's moneyline where there is one, else the model's chance with a small margin
const czDec = ml => ml > 0 ? 1 + ml / 100 : 1 + 100 / -ml;
function czOffer(lg, g, models, espnMlb) {
  let o = g.odds;
  if (lg === "mlb" && espnMlb) { const gs = Date.parse(g.date), m = espnMlb.filter(x => mkey(x.home.name) === mkey(g.home.name) && mkey(x.away.name) === mkey(g.away.name))
      .sort((a, b) => Math.abs(Date.parse(a.date) - gs) - Math.abs(Date.parse(b.date) - gs))[0]; o = m && Math.abs(Date.parse(m.date) - gs) < 4 * 3600e3 ? m.odds : null; }
  const book = trackOdds(o, lg === "epl"), p = modelProbs(models, lg, g);
  const sides = lg === "epl" ? ["home", "draw", "away"] : ["home", "away"];
  const r2 = v => Math.round(v * 100) / 100;
  if (book) return { src: book.book || "Sportsbook", dec: Object.fromEntries(sides.map(s => [s, r2(czDec(book[s[0]]))])), model: p ? Object.fromEntries(sides.map(s => [s, Math.round(p[s] * 1000) / 1000])) : null };
  if (p) return { src: "Cosmo model", dec: Object.fromEntries(sides.map(s => [s, r2(Math.min(30, Math.max(1.02, 1 / (p[s] * CZ_MARGIN))))])), model: Object.fromEntries(sides.map(s => [s, Math.round(p[s] * 1000) / 1000])) };
  return null;
}
const CZ_BOARD = new Map();
async function czMarkets(env, lg, day, fetchImpl = fetch) {
  const k = lg + day, hit = CZ_BOARD.get(k); if (hit && Date.now() - hit.at < 60e3) return hit.v;
  let models = null; try { models = await trackModels(env, fetchImpl); } catch {}
  const board = await espnScoreboard(lg, fetchImpl, day), now = Date.now();
  const games = (board.games || []).filter(g => g.status?.state === "pre" && Date.parse(g.date) > now + 60e3 && !(lg !== "epl" && g.stype === 1));
  let espnMlb = null; if (lg === "mlb" && games.length) { try { espnMlb = (await espnBoard("mlb", fetchImpl, day)).games || []; } catch { espnMlb = []; } }
  const v = games.map(g => { const o = czOffer(lg, g, models, espnMlb); return o && { lg, gid: g.id, day, start: g.date, home: { name: g.home.name, abbr: g.home.abbr, logo: g.home.logo, color: g.home.color },
    away: { name: g.away.name, abbr: g.away.abbr, logo: g.away.logo, color: g.away.color }, ...o }; }).filter(Boolean);
  CZ_BOARD.set(k, { at: Date.now(), v }); if (CZ_BOARD.size > 40) CZ_BOARD.clear();
  return v;
}
// the collectibles: every team in the five leagues and the top 24 players on each tennis tour, in seven tiers, 1 of 1 up to 1 of 1,000.
// Better teams (by the model's rating) and higher-ranked players cost more.
let CZ_CAT = null;
// the catalog: every team (by the model's rating), the top 24 players on each tennis tour, and every player on every NFL, NBA,
// MLB, NHL and Premier League roster (docs/rosters.json, rebuilt nightly), each in all seven tiers. Stars (the league
// leaders in docs/allstars.json) are valued higher than the rest of a roster.
async function czCatalog(env, fetchImpl = fetch) {
  if (CZ_CAT && Date.now() - CZ_CAT.at < 6 * 3600e3) return CZ_CAT.v;
  const models = await trackModels(env, fetchImpl), items = [];
  const add = (lg, kind, name, mult, extra, key) => { for (const [tier, label, supply, base] of CZ_TIERS) items.push({ id: `${lg}.${key}.${tier}`, lg, kind, name, tier, label, supply, price: Math.max(10, Math.round(base * mult / 10) * 10), ...extra }); };
  for (const lg of TRACK_LEAGUES) { const st = models[lg]?.state || {}, names = Object.keys(st).sort((a, b) => st[b].elo - st[a].elo);
    names.forEach((n, i) => add(lg, "team", n, 1.5 - .9 * (names.length > 1 ? i / (names.length - 1) : 0), { rank: i + 1 }, czSlug(n))); }
  try { const r = await siteGet(env, "/players.json", fetchImpl); const P = r.ok ? await r.json() : [];
    for (const tour of ["atp", "wta"]) { const names = P.filter(p => p.tour === tour).slice(0, 24).map(p => p.name);
      names.forEach((n, i) => add(tour, "player", n, 1.5 - .9 * (names.length > 1 ? i / (names.length - 1) : 0), { rank: i + 1 }, czSlug(n))); } } catch {}
  const stars = new Set();
  try { const r = await siteGet(env, "/allstars.json", fetchImpl); const A = r.ok ? await r.json() : {};
    for (const [lg, pools] of Object.entries(A.sports || {})) for (const l of Object.values(pools)) if (Array.isArray(l)) for (const p of l) stars.add(lg + ":" + czSlug(p.name)); } catch {}
  try { const r = await siteGet(env, "/rosters.json", fetchImpl); const R = r.ok ? await r.json() : {};
    for (const [lg, list] of Object.entries(R.leagues || {})) for (const p of list)
      add(lg, "player", p.name, stars.has(lg + ":" + czSlug(p.name)) ? 1.2 : .55, { team: p.team, pos: p.pos, num: p.num, img: p.img, star: stars.has(lg + ":" + czSlug(p.name)) || undefined }, "p" + p.id); } catch {}
  const byId = new Map(items.map(i => [i.id, i]));
  CZ_CAT = { at: Date.now(), v: items, byId }; return items;
}
// a card by id, even one whose player has since left the rosters (valued as an ordinary player card of its tier)
async function czItem(env, id) {
  await czCatalog(env); const it = CZ_CAT.byId.get(id); if (it) return it;
  const tier = CZ_TIERS.find(t => id.endsWith("." + t[0])); if (!tier) return null;
  return { id, tier: tier[0], label: tier[1], supply: tier[2], price: Math.round(tier[3] * .55 / 10) * 10, lg: id.split(".")[0], name: "", kind: "player" };
}
async function czAuth(req, env) {
  const m = /^Bearer\s+([a-f0-9]{24})\.([a-f0-9]{64})$/i.exec(req.headers.get("Authorization") || ""); if (!m) return null;
  const u = await czRead(env, "cz:u:" + m[1], null); if (!u) return null;
  const h = await czHash(m[2]);
  return u.tok === h || (u.toks || []).includes(h) ? u : null;
}
const CZ_JOIN = new Map();
/* ---- passkeys (WebAuthn): sign in with Face ID, a fingerprint or the device's passcode. No passwords and no outside service:
   the device makes a key pair, keeps the private half, and signs a one-time challenge from us; we check the signature with the
   public half saved when the passkey was created. Stored: "cz:pk:<credential id>" {uid, jwk, alg, count}. */
function cbor(buf) {                                     // just enough CBOR for WebAuthn (maps, arrays, byte and text strings, ints)
  let i = 0; const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = ai => ai < 24 ? ai : ai === 24 ? u8[i++] : ai === 25 ? (i += 2, dv.getUint16(i - 2)) : ai === 26 ? (i += 4, dv.getUint32(i - 4)) : ai === 27 ? (i += 8, Number(dv.getBigUint64(i - 8))) : NaN;
  const item = () => { const b = u8[i++], mt = b >> 5, ai = b & 31;
    if (mt === 7) return ai === 20 ? false : ai === 21 ? true : ai === 22 ? null : ai === 25 ? (i += 2, null) : ai === 26 ? (i += 4, dv.getFloat32(i - 4)) : ai === 27 ? (i += 8, dv.getFloat64(i - 8)) : undefined;
    const n = len(ai);
    if (mt === 0) return n; if (mt === 1) return -1 - n;
    if (mt === 2) { const v = u8.slice(i, i + n); i += n; return v; }
    if (mt === 3) { const v = new TextDecoder().decode(u8.slice(i, i + n)); i += n; return v; }
    if (mt === 4) return Array.from({ length: n }, item);
    if (mt === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    if (mt === 6) return item();
    throw new Error("cbor");
  };
  const v = item(); return { v, end: i };
}
function authData(a) {
  const d = a instanceof Uint8Array ? a : new Uint8Array(a), flags = d[32], out = { rpIdHash: d.slice(0, 32), flags, up: !!(flags & 1), uv: !!(flags & 4), count: new DataView(d.buffer, d.byteOffset + 33, 4).getUint32(0) };
  if (flags & 64) { const n = (d[53] << 8) | d[54]; out.credId = d.slice(55, 55 + n); out.cose = cbor(d.slice(55 + n)).v; }
  return out;
}
function coseJwk(m) {
  const g = k => m.get(k), alg = g(3);
  if (g(1) === 2 && g(-1) === 1) return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64u.enc(g(-2)), y: b64u.enc(g(-3)), ext: true } };
  if (g(1) === 3) return { alg: -257, jwk: { kty: "RSA", n: b64u.enc(g(-1)), e: b64u.enc(g(-2)), alg: "RS256", ext: true } };
  throw new Error("unsupported key " + alg);
}
function derToRaw(sig) {                                  // ECDSA signatures come DER-encoded; WebCrypto wants r || s
  let i = 2; const part = () => { i++; const n = sig[i++]; let v = sig.slice(i, i + n); i += n; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = part(), s = part(), out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
}
const CZ_RATE = new Map();
function czAllowed(key, max, win) { const now = Date.now(), l = (CZ_RATE.get(key) || []).filter(t => now - t < win); if (l.length >= max) return false; l.push(now); CZ_RATE.set(key, l); if (CZ_RATE.size > 20000) CZ_RATE.clear(); return true; }
const sha256 = async b => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b));
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function pkOrigins(env) { const o = new Set(); for (const u of [env.SITE_URL, env.SITE_FALLBACK, env.PK_EXTRA_ORIGIN]) { try { if (u) o.add(new URL(u).origin); } catch {} } return o; }
async function pkChallenge(env, kind, extra = {}) {
  const c = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
  await store(env).put("cz:pkc:" + c, JSON.stringify({ kind, exp: Date.now() + 5 * 60e3, ...extra })); return c;
}
async function pkClient(env, clientDataJSON, kind) {       // the browser's signed-over summary: type, our challenge, the page's origin
  const raw = b64u.dec(clientDataJSON), cd = JSON.parse(new TextDecoder().decode(raw));
  if (cd.type !== (kind === "reg" ? "webauthn.create" : "webauthn.get")) throw new Error("wrong step");
  if (!pkOrigins(env).has(cd.origin)) throw new Error("wrong site");
  const ch = await czRead(env, "cz:pkc:" + cd.challenge, null);
  if (!ch || ch.kind !== kind || ch.exp < Date.now()) throw new Error("expired");
  await store(env).put("cz:pkc:" + cd.challenge, JSON.stringify({ exp: 0 }));  // one use only
  return { raw, cd, ch, rpIdHash: await sha256(new URL(cd.origin).hostname) };
}
const etDayStr = t => etDay(t);
export async function cosmicRoute(req, env, ctx, url) {
  const p = url.pathname.replace(/^\/cosmic/, "") || "/", now = Date.now(), ip = req.headers.get("CF-Connecting-IP") || "anon";
  const today = etDayStr(now), tomorrow = etDayStr(now + 864e5);
  if (p === "/board" && req.method === "GET") return cached(req, ctx, 60, async () => {
    const out = [];
    for (const lg of TRACK_LEAGUES) for (const d of [today, tomorrow]) { try { out.push(...await czMarkets(env, lg, d)); } catch {} }
    const seen = new Set(), uniq = out.filter(m => !seen.has(m.lg + m.gid) && seen.add(m.lg + m.gid));
    return { asof: new Date().toISOString(), markets: uniq.sort((a, b) => a.start.localeCompare(b.start)) };
  });
  if (p === "/vault" && req.method === "GET") {
    const q = url.searchParams, lg = q.get("lg") || "all", tier = q.get("tier") || "all", kind = q.get("kind") || "all", term = czSlug(q.get("q") || "");
    const off = Math.max(0, +q.get("offset") || 0), lim = Math.min(96, Math.max(1, +q.get("limit") || 48));
    const [items, mint0, ret] = await Promise.all([czCatalog(env), czRead(env, "cz:mint", {}), czRead(env, "cz:ret", {})]);
    const held = id => (mint0[id] || 0) - (ret[id] || []).length;
    const scope = CZ_SCOPES[lg] || null;
    let list = items.filter(i => (!scope || scope.includes(i.lg)) && (tier === "all" || i.tier === tier) && (kind === "all" || i.kind === kind) && (!term || czSlug(`${i.name} ${i.team || ""}`).includes(term)));
    list.sort((a, b) => (held(a.id) >= a.supply) - (held(b.id) >= b.supply) || a.supply - b.supply || (a.kind === "team" ? 0 : 1) - (b.kind === "team" ? 0 : 1) || b.price - a.price);
    const page = list.slice(off, off + lim), owners = {};
    for (const i of page) if (i.supply === 1 && held(i.id)) { const o = await czRead(env, "cz:own:" + i.id, []); if (o[0]) owners[i.id] = o[0].name; }
    return json({ tiers: CZ_TIERS.map(([id, label, supply, price]) => ({ id, label, supply, price })), total: list.length, offset: off, cards: items.length,
      items: page.map(i => ({ ...i, value: i.price, shop: Math.max(1, Math.floor(i.price * CZ_SHOP)), minted: held(i.id), owner: owners[i.id] || undefined })), shop: CZ_SHOP, fee: CZ_FEE }, 200, { "Cache-Control": "no-store" });
  }
  if (p === "/market" && req.method === "GET") return json({ listings: (await czRead(env, "cz:mkt", [])).slice(0, 600), fee: CZ_FEE }, 200, { "Cache-Control": "no-store" });
  if (p === "/packs" && req.method === "GET") return json({ packs: CZ_PACKS, tiers: CZ_TIERS.map(([id, label, supply]) => ({ id, label, supply })), scopes: Object.keys(CZ_SCOPES), kinds: CZ_KINDS });
  if (p.startsWith("/card/") && req.method === "GET") { const id = decodeURIComponent(p.slice(6)), it = await czItem(env, id);
    return json({ owners: await czRead(env, "cz:own:" + id, []), item: it && { ...it, value: it.price, shop: Math.max(1, Math.floor(it.price * CZ_SHOP)) } }); }
  if (p === "/leaders" && req.method === "GET") {
    const [L, F] = await Promise.all([czRead(env, "cz:lb", {}), czRead(env, "cz:feed", [])]);
    const rows = Object.values(L).filter(r => !r.tester);
    return json({ rich: rows.sort((a, b) => b.bal - a.bal).slice(0, 50), sharp: rows.filter(r => r.won + r.lost >= 5).sort((a, b) => b.profit - a.profit).slice(0, 25),
      collectors: rows.filter(r => r.cards).sort((a, b) => a.best - b.best || b.cards - a.cards).slice(0, 25), feed: F.slice(0, 30), players: rows.length }, 200, { "Cache-Control": "no-store" });
  }
  if (p === "/config" && req.method === "GET") return json({ passkeys: true });
  if (p === "/pk/start" && req.method === "POST") {                          // a challenge to create or use a passkey
    const d = await req.json().catch(() => ({})), kind = d.kind === "reg" ? "reg" : "auth", name = String(d.name || "").replace(/\s+/g, " ").trim();
    if (!czAllowed("pk:" + ip, 30, 3600e3)) return json({ error: "Too many tries. Wait a few minutes." }, 429);
    if (kind === "reg") {
      const linker = d.link ? await czAuth(req, env) : null;
      if (!linker) { if (!/^[\p{L}\p{N} ._-]{3,20}$/u.test(name)) return json({ error: "Pick a name of 3 to 20 letters, numbers, spaces, dots, dashes or underscores." }, 400);
      if (!czNameOk(name)) return json({ error: "Please pick a different name." }, 400);
        if ((await czRead(env, "cz:names", {}))[name.toLowerCase()]) return json({ error: "That name is taken. Try another." }, 409); }
      const handle = linker ? (linker.handle || b64u.enc(crypto.getRandomValues(new Uint8Array(16)))) : b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
      return json({ challenge: await pkChallenge(env, "reg", { name, handle, link: linker ? linker.uid : null }), user: { id: handle, name: linker ? linker.name : name } });
    }
    return json({ challenge: await pkChallenge(env, "auth") });
  }
  if (p === "/pk/register" && req.method === "POST") {                       // save a new passkey and sign in (or add it to your account)
    const d = await req.json().catch(() => ({}));
    try {
      const { ch, rpIdHash } = await pkClient(env, d.clientDataJSON, "reg"), att = cbor(b64u.dec(d.attestationObject)).v, ad = authData(att.get("authData"));
      if (!eqBytes(ad.rpIdHash, rpIdHash) || !ad.up || !ad.credId) throw new Error("bad passkey");
      const { alg, jwk } = coseJwk(ad.cose), credId = b64u.enc(ad.credId), token = czRand(32), sub = await czHash("pk:" + ch.handle);
      if (await czRead(env, "cz:pk:" + credId, null)) throw new Error("already saved");
      const r = await cz(env, { act: "ident", sub, uid: czRand(12), tok: await czHash(token), name: ch.link ? "" : ch.name, linkUid: ch.link, now });
      if (r.error) return json(r, 409);
      await store(env).put("cz:pk:" + credId, JSON.stringify({ uid: r.uid, sub, jwk, alg, count: ad.count, at: now }));
      return json({ ...r, auth: `${r.uid}.${token}` });
    } catch (e) { return json({ error: "The passkey couldn't be saved (" + e.message + "). Try again." }, 400); }
  }
  if (p === "/pk/login" && req.method === "POST") {                          // sign in: check the device's signature over our challenge
    const d = await req.json().catch(() => ({}));
    try {
      const cred = await czRead(env, "cz:pk:" + String(d.id || ""), null); if (!cred) throw new Error("unknown passkey");
      const { raw, rpIdHash } = await pkClient(env, d.clientDataJSON, "auth"), adRaw = b64u.dec(d.authenticatorData), ad = authData(adRaw);
      if (!eqBytes(ad.rpIdHash, rpIdHash) || !ad.up) throw new Error("bad passkey");
      const signed = new Uint8Array([...adRaw, ...await sha256(raw)]), sig = b64u.dec(d.signature);
      const ok = cred.alg === -7
        ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await crypto.subtle.importKey("jwk", cred.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]), derToRaw(sig), signed)
        : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await crypto.subtle.importKey("jwk", cred.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]), sig, signed);
      if (!ok) throw new Error("bad signature");
      if (cred.count && ad.count && ad.count <= cred.count) throw new Error("copied passkey");
      if (ad.count) await store(env).put("cz:pk:" + d.id, JSON.stringify({ ...cred, count: ad.count }));
      const token = czRand(32), r = await cz(env, { act: "ident", sub: cred.sub, uid: czRand(12), tok: await czHash(token), name: "", now });
      if (r.needName) { await store(env).put("cz:pk:" + d.id, null); return json({ error: "That account was deleted. Create a new one." }, 409); }
      if (r.error) return json({ error: r.error }, 409);
      return json({ ...r, auth: `${r.uid}.${token}` });
    } catch (e) { return json({ error: e.message === "unknown passkey" ? "That passkey isn't linked to a Cosmic account. Create an account first." : "Sign-in didn't go through (" + e.message + "). Try again." }, 401); }
  }
  if (p === "/join" && req.method === "POST") {
    if (!(req.headers.get("X-No-Passkeys") === "1")) return json({ error: "Create your account with a passkey." }, 403);
    const l = (CZ_JOIN.get(ip) || []).filter(t => now - t < 3600e3); if (l.length >= 5) return json({ error: "Too many new accounts from here. Try again later." }, 429);
    const d = await req.json().catch(() => ({})), name = String(d.name || "").replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{N} ._-]{3,20}$/u.test(name)) return json({ error: "Pick a name of 3 to 20 letters, numbers, spaces, dots, dashes or underscores." }, 400);
    if (!czNameOk(name)) return json({ error: "Please pick a different name." }, 400);
    const uid = czRand(12), token = czRand(32);
    const r = await cz(env, { act: "join", uid, tok: await czHash(token), name, now });
    if (r.error) return json(r, 409);
    l.push(now); CZ_JOIN.set(ip, l); if (CZ_JOIN.size > 5000) CZ_JOIN.clear();
    return json({ ...r, auth: `${uid}.${token}` });
  }
  const u = await czAuth(req, env);
  if (!u) return json({ error: "Sign in to Cosmic first." }, 401);
  if (p === "/me" && req.method === "GET") return json({ user: czPublic(u) }, 200, { "Cache-Control": "no-store" });
  if (p === "/owner/unlimited" && req.method === "POST") {
    const key = env.COMETS_KEY, got = req.headers.get("X-Owner-Key") || "";
    if (!key) return json({ error: "The owner key (COMETS_KEY) isn't set up on the live service." }, 503);
    if (cometsTooManyFails(ip)) return json({ error: "Too many tries. Wait a few minutes." }, 429);
    const [x, y] = await Promise.all([czHash(key), czHash(got)]); let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    if (diff) { cometsFail(ip); return json({ error: "That isn't the owner key." }, 403); }
    const d = await req.json().catch(() => ({})), r = await cz(env, { act: "tester", uid: u.uid, on: d.on !== false, now });
    return json(r, r.error ? 409 : 200);
  }
  // the rest of the app's data (followed teams, settings, picks), kept with the account so it follows you to any device
  if (p === "/delete" && req.method === "POST") {                            // delete your account and everything saved with it
    const d = await req.json().catch(() => ({})); if (d.confirm !== "DELETE") return json({ error: "Confirm by sending DELETE." }, 400);
    const r = await cz(env, { act: "delete", uid: u.uid, now }); return json(r, r.error ? 409 : 200);
  }
  if (p === "/data" && req.method === "GET") return json({ data: await czRead(env, "cz:data:" + u.uid, null) }, 200, { "Cache-Control": "no-store" });
  if (p === "/data" && req.method === "PUT") {
    const raw = await req.text(); if (raw.length > 100000) return json({ error: "Too much data." }, 413);
    let d; try { d = JSON.parse(raw); } catch { return json({ error: "bad data" }, 400); }
    await store(env).put("cz:data:" + u.uid, JSON.stringify({ ...d, at: now })); return json({ ok: true, at: now });
  }
  if (p === "/daily" && req.method === "POST") { const r = await cz(env, { act: "daily", uid: u.uid, day: today, yday: etDayStr(now - 864e5), now }); return json(r, r.error ? 409 : 200); }
  if (p === "/bet" && req.method === "POST") {
    const d = await req.json().catch(() => ({})), lg = String(d.lg || ""), gid = String(d.gid || ""), side = String(d.side || "");
    if (!TRACK_LEAGUES.includes(lg) || !["home", "away", "draw"].includes(side)) return json({ error: "That bet isn't available." }, 400);
    let m = null;
    for (const day of [today, tomorrow]) { try { m = (await czMarkets(env, lg, day)).find(x => x.gid === gid); } catch {} if (m) break; }
    if (!m || Date.parse(m.start) <= now + 60e3) return json({ error: "Betting on this game has closed." }, 409);
    const dec = m.dec[side]; if (!dec) return json({ error: "That bet isn't available." }, 400);
    if (d.dec && Math.abs(d.dec - dec) > .005) return json({ error: "The price moved.", dec, moved: true }, 409);
    const label = side === "draw" ? `Draw: ${m.away.name} at ${m.home.name}` : `${m[side].name} to beat ${m[side === "home" ? "away" : "home"].name}`;
    const r = await cz(env, { act: "bet", uid: u.uid, now, bet: { bid: czRand(6), lg, gid, day: m.day, start: m.start, side, dec, stake: d.stake, label, home: m.home.name, away: m.away.name, src: m.src } });
    return json(r, r.error ? 409 : 200);
  }
  if (p === "/sell" && req.method === "POST") {
    const d = await req.json().catch(() => ({})), it = await czItem(env, String(d.item || ""));
    if (!it) return json({ error: "That card isn't in Cosmic." }, 404);
    const r = await cz(env, { act: "sell", uid: u.uid, now, id: it.id, value: it.price }); return json(r, r.error ? 409 : 200);
  }
  if (p === "/list" && req.method === "POST") { const d = await req.json().catch(() => ({})); const r = await cz(env, { act: "list", uid: u.uid, now, id: String(d.item || ""), price: d.price }); return json(r, r.error ? 409 : 200); }
  if (p === "/unlist" && req.method === "POST") { const d = await req.json().catch(() => ({})); const r = await cz(env, { act: "unlist", uid: u.uid, now, lid: String(d.lid || "") }); return json(r, r.error ? 409 : 200); }
  // cards belong to accounts: only a signed-in account with a passkey can pull or buy them
  if ((p === "/pack" || p === "/buylisting") && req.method === "POST" && !u.ident) return json({ error: "Create your Cosmo Sports account with a passkey to collect cards.", needPasskey: true }, 403);
  if (p === "/buylisting" && req.method === "POST") { const d = await req.json().catch(() => ({})); const r = await cz(env, { act: "buyl", uid: u.uid, now, lid: String(d.lid || "") }); return json(r, r.error ? 409 : 200); }
  if (p === "/pack" && req.method === "POST") {
    const d = await req.json().catch(() => ({})), pk = CZ_PACKS.find(x => x.id === String(d.pack || "")), scope = Object.hasOwn(CZ_SCOPES, d.scope) ? d.scope : "all";
    const kind = ["team", "player"].includes(d.kind) ? d.kind : "all";
    if (!pk) return json({ error: "That pack isn't available." }, 404);
    // shortlist: up to 80 random cards per tier that still have copies out there and that this player doesn't own;
    // the Durable Object then re-checks them in one step, so nobody gets a copy that's already gone
    const [items, mint, ret] = await Promise.all([czCatalog(env), czRead(env, "cz:mint", {}), czRead(env, "cz:ret", {})]), mine = new Set((u.items || []).map(x => x.id));
    const P = items.filter(i => (!CZ_SCOPES[scope] || CZ_SCOPES[scope].includes(i.lg)) && (kind === "all" || i.kind === kind) && !mine.has(i.id) && (mint[i.id] || 0) - (ret[i.id] || []).length < i.supply);
    const byTier = {}; for (const i of P) (byTier[i.tier] ||= []).push(i);
    const rnd = n => crypto.getRandomValues(new Uint32Array(1))[0] % n, pool = [];
    for (const list of Object.values(byTier)) { const k = Math.min(80, list.length), pick = new Set(); while (pick.size < k) pick.add(rnd(list.length));
      for (const j of pick) { const i = list[j]; pool.push({ id: i.id, tier: i.tier, supply: i.supply, lg: i.lg, name: i.name, kind: i.kind, team: i.team, pos: i.pos, img: i.img }); } }
    const r = await cz(env, { act: "pack", uid: u.uid, now, pack: pk, pool });
    return json(r, r.error ? 409 : 200);
  }
  return json({ error: "not found" }, 404);
}
// every 10 minutes: settle bets on finished games
export async function czSettle(env, fetchImpl = fetch, now = new Date(), force = false) {
  if (!force && now.getUTCMinutes() % 10 !== 8) return "not time";
  const t = now.getTime(), O = await czRead(env, "cz:open", []);
  const due = O.filter(o => t > Date.parse(o.start) + GAME_H[o.lg] * 3600e3); if (!due.length) return { open: O.length, settled: 0 };
  const results = [], boards = {};
  for (const k of [...new Set(due.map(o => o.lg + "|" + o.day))]) { const [lg, day] = k.split("|"); try { boards[k] = (await espnScoreboard(lg, fetchImpl, day)).games || []; } catch {} }
  for (const o of due) {
    const g = (boards[o.lg + "|" + o.day] || []).find(x => x.id === o.gid);
    if (!g) { if (t - Date.parse(o.start) > 72 * 3600e3) results.push({ uid: o.uid, bid: o.bid, res: "void" }); continue; }
    if (g.status?.state !== "post") { if (t - Date.parse(o.start) > 72 * 3600e3) results.push({ uid: o.uid, bid: o.bid, res: "void" }); continue; }
    const h = parseFloat(g.home.score), a = parseFloat(g.away.score);
    const bad = !g.status.completed || /postpon|cancel|suspend|forfeit|abandon/i.test(`${g.status.detail || ""} ${g.status.short || ""}`) || !isFinite(h) || !isFinite(a);
    const u = await czRead(env, "cz:u:" + o.uid, null), b = u && (u.bets || []).find(x => x.bid === o.bid); if (!b) continue;
    const win = h > a ? "home" : a > h ? "away" : "draw";
    results.push({ uid: o.uid, bid: o.bid, res: bad ? "void" : win === b.side ? "win" : win === "draw" && o.lg !== "epl" ? "push" : "loss" });
  }
  if (!results.length) return { open: O.length, settled: 0 };
  return cz(env, { act: "settle", results, now: now.toISOString() });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    let m;
    try {
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/scoreboard$/)))
        return await cached(req, ctx, 20, async () => espnScoreboard(m[1], fetch, url.searchParams.get("dates")));
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/game\/([mh]?\d+)$/)))
        return await cached(req, ctx, 10, async () => espnGame(m[1], m[2]));
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/standings$/)))
        return await cached(req, ctx, 600, async () => espnStandings(m[1]));
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/news$/)))
        return await cached(req, ctx, 300, async () => espnNews(m[1], url.searchParams.get("team")));
      if ((m = url.pathname.match(/^\/sports\/(nfl|nba|mlb|nhl|epl)\/team\/(\d+)$/)))
        return await cached(req, ctx, 300, async () => espnTeam(m[1], m[2]));
      if ((m = url.pathname.match(/^\/tennis\/game\/(\d+)$/)))
        return await cached(req, ctx, 10, async () => {
          const q = new URLSearchParams({ method: "get_livescore", APIkey: env.API_TENNIS_KEY, match_key: m[1], timezone: "America/New_York" });
          let d = await (await fetch(`${API}?${q}`)).json(), e = (d.result || []).find(x => String(x.event_key) === m[1]);
          if (!e) { const q2 = new URLSearchParams({ method: "get_fixtures", APIkey: env.API_TENNIS_KEY, match_key: m[1] });
            d = await (await fetch(`${API}?${q2}`)).json(); e = (d.result || []).find(x => String(x.event_key) === m[1]); }
          if (!e) return { error: "not found", plays: [] };
          let players = []; try { const r = await siteGet(env, "/players.json"); if (r.ok) players = await r.json(); } catch {}
          const t = TYPES[e.event_type_type]?.[0] || "atp";
          return normTennis(e, n => resolver(players)(n, t));
        });
    } catch (err) { return json({ error: String(err.message || err) }, 502); }
    const db = store(env);
    if (url.pathname === "/live.json") return new Response(await db.get("live") || '{"asof":"1970-01-01T00:00:00Z","matches":[]}',
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
    if (url.pathname === "/vapid") return json({ key: env.VAPID_PUBLIC_KEY });
    if (url.pathname.startsWith("/cosmic/")) { try { return await cosmicRoute(req, env, ctx, url); } catch (e) { return json({ error: "Cosmic isn't available right now." }, 503); } }
    if (url.pathname === "/track") return await cached(req, ctx, 120, () => trackAll(db)).catch(e => json({ error: String(e.message || e) }, 503));
    if (url.pathname === "/comets" || url.pathname.startsWith("/comets/")) { const r = await cometsRoute(req, env, ctx, url, db); if (r) return r; }
    if (url.pathname === "/ask" && req.method === "POST") {
      if (!askAllowed(req.headers.get("CF-Connecting-IP") || "anon")) return json({ error: "Too many questions. Try again in a few minutes." }, 429);
      const body = await req.json().catch(() => null);
      try { return new Response(await askCosmo(env, body), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors } }); }
      catch (e) { return json({ error: String(e.message || e) === "no question" ? "Ask a question." : "Ask Cosmo isn't available right now." }, String(e.message || e) === "no question" ? 400 : 503); }
    }
    if (url.pathname === "/tts" && req.method === "POST") {
      if (!env.AI) return json({ error: "no voice" }, 503);
      if (!ttsAllowed(req.headers.get("CF-Connecting-IP") || "anon")) return json({ error: "slow down" }, 429);
      const d = await req.json().catch(() => ({}));
      const text = String(d.text || "").replace(/\s+/g, " ").trim().slice(0, 420), voice = d.voice === "female" ? "female" : "male";
      if (!text) return json({ error: "no text" }, 400);
      const key = new Request(`https://tts.cosmo/${voice}/${await subId(text)}`), cache = caches.default;
      const hit = await cache.match(key); if (hit) return hit;
      // keep the premium voice inside the free daily allowance (and leave room for Ask Cosmo)
      const day = new Date().toISOString().slice(0, 10); let used = 0;
      if (db.durable) { used = +(await db.get("ttsc:" + day).catch(() => 0)) || 0; ctx.waitUntil(db.put("ttsc:" + day, used + text.length).catch(() => {})); }
      try {
        const out = await speak(env, text, voice, used < 6000);
        const res = new Response(out.bytes, { headers: { "Content-Type": out.type, "Cache-Control": "public, max-age=86400", "X-Voice": out.name, "Access-Control-Expose-Headers": "X-Voice", ...cors } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (e) { return json({ error: "voice unavailable", detail: String(e.message || e).slice(0, 200) }, 503); }
    }
    if (url.pathname === "/subscribe" && req.method === "POST") {
      const d = await req.json().catch(() => null);
      if (!d?.sub?.endpoint || !d.sub.keys?.p256dh || !d.sub.keys?.auth) return json({ error: "bad subscription" }, 400);
      const watch = { atp: (d.watch?.atp || []).slice(0, 50).map(String), wta: (d.watch?.wta || []).slice(0, 50).map(String) };
      const teams = {}; for (const lg of Object.keys(LEAGUES)) { const l = (d.teams?.[lg] || []).slice(0, 40).map(tkey).filter(Boolean); if (l.length) teams[lg] = l; }
      const games = (d.games || []).map(String).filter(k => /^(nfl|nba|mlb|nhl|epl)\/[mh]?\d+$/.test(k)).slice(0, 60);
      const prefs = {}; for (const k of Object.keys(DEFAULT_PREFS)) prefs[k] = d.prefs && k in d.prefs ? !!d.prefs[k] : DEFAULT_PREFS[k];
      const n = watch.atp.length + watch.wta.length + Object.values(teams).flat().length + games.length;
      if (!n && !(d.prefs && d.prefs.anyClose === false && d.explicit)) prefs.anyClose = true;   // no teams yet: close finishes anywhere
      const old = await db.subGet(d.sub.endpoint).catch(() => null);
      try { await db.subPut({ sub: d.sub, watch, teams, games, prefs, at: Date.now() }); }
      catch (e) { return json({ error: "Couldn't save your alerts right now: " + e.message }, 503); }
      return json({ ok: true, watching: n, isNew: !old, storage: db.durable ? "durable" : "kv" });
    }
    if (url.pathname === "/unsubscribe" && req.method === "POST") {
      const d = await req.json().catch(() => ({}));
      if (d.endpoint) await db.subDel(String(d.endpoint)).catch(() => {});
      return json({ ok: true });
    }
    if (url.pathname === "/test" && req.method === "POST") {           // "Send test notification" button
      const d = await req.json().catch(() => ({}));
      let s = d.endpoint ? await db.subGet(String(d.endpoint)).catch(() => null) : null;
      if (!s && d.sub?.endpoint && d.sub.keys?.p256dh && d.sub.keys?.auth) s = { sub: d.sub };    // not saved yet: still prove the phone can receive
      if (!s) return json({ error: "not subscribed" }, 404);
      const msg = d.welcome ? { title: "You're all set", body: "Cosmo Sports alerts are on. You'll hear about starts, big plays, close finishes and finals.", tag: "welcome", url: "./" }
        : { title: "Test from Cosmo Sports", body: "Notifications are working. This is what an alert looks like.", tag: "test", url: "./" };
      let r; try { r = await sendPush(s.sub, msg, env); } catch (e) { return json({ ok: false, status: 0, detail: String(e.message || e) }, 502); }
      const detail = r.ok ? "" : (await r.text().catch(() => "")).slice(0, 300);
      if (r.status === 404 || r.status === 410) await db.subDel(s.sub.endpoint).catch(() => {});
      return json({ ok: r.ok, status: r.status, detail }, r.ok ? 200 : 502);
    }
    return json({ service: "Cosmo Sports live service", ok: true, ask: env.ANTHROPIC_API_KEY ? "claude" : env.AI ? "workers-ai" : "off" });
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(Promise.allSettled([tick(env), sportsTick(env), trackTick(env), czSettle(env)]).then(r => console.log(JSON.stringify(r.map(x => x.value || String(x.reason))))));
  },
};
