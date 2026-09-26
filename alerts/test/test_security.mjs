// Checks for the 2026-09-25 security review (S1–S12, P6), run against the worker with a stand-in for its Durable Object.
// Run: node test_security.mjs   (Node 20+; no network needed). Prints PASS/FAIL per check and exits 1 on any failure.
import * as W from "../worker.js";
import nodeCrypto from "node:crypto";
// a minimal CBOR encoder and a software authenticator, doing what a phone's passkey does
const enc = v => { const hd = (mt, n) => n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255];
  if (typeof v === "number") return Buffer.from(v >= 0 ? hd(0, v) : hd(1, -1 - v));
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([Buffer.from(hd(3, b.length)), b]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([Buffer.from(hd(2, v.length)), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([Buffer.from(hd(5, v.size)), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]); };
const b64 = b => Buffer.from(b).toString("base64url"), sha = b => nodeCrypto.createHash("sha256").update(b).digest();
function device(origin) {
  const creds = []; let count = 0;
  return {
    creds,
    create(ch, over0 = {}) { const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }), j = publicKey.export({ format: "jwk" }), id = nodeCrypto.randomBytes(16);
      creds.push({ id, privateKey, handle: ch.user.id });
      const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, "base64url")], [-3, Buffer.from(j.y, "base64url")]]));
      const ad = Buffer.concat([sha(new URL(origin).hostname), Buffer.from([over0.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, 16]), id, cose]);
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: ch.challenge, origin }));
      return { id: b64(id), clientDataJSON: b64(cd), attestationObject: b64(enc(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))) }; },
    get(ch, which = 0, over = {}) { const c = creds[which]; count++;
      const ad = Buffer.concat([sha(new URL(over.rpOrigin || origin).hostname), Buffer.from([over.flags ?? 0x05]), Buffer.from([0, 0, 0, over.count ?? count])]);
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch.challenge, origin: over.origin || origin }));
      const sig = nodeCrypto.sign("sha256", Buffer.concat([ad, sha(cd)]), c.privateKey);
      return { id: b64(c.id), clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(sig), userHandle: c.handle }; },
  };
}
// the Cloudflare env, with the real Store class over an in-memory storage
function fakeEnv(extra = {}) {
  const data = new Map();
  const storage = { get: async k => Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, structuredClone(data.get(x))])) : structuredClone(data.get(k)),
    put: async (k, v) => { data.set(k, structuredClone(v)); }, delete: async k => data.delete(k), list: async ({ prefix = "" } = {}) => new Map([...data].filter(([k]) => k.startsWith(prefix))) };
  const env = { KV: { get: async () => null, put: async () => {} }, SITE_URL: "https://cosmosports.app", ...extra };
  const obj = new W.Store({ storage }, env); data.set("migrated", 1);
  env.STORE = { idFromName: n => n, get: () => ({ fetch: (u, init) => obj.fetch(new Request(u, init)) }) };
  return { env, data };
}
const caller = (M, env) => async (path, body, auth, method, hdr = {}) => {
  const r = await M.default.fetch(new Request("https://w.dev/cosmic" + path, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", "CF-Connecting-IP": hdr.ip || "1.2.3.4", ...hdr, ...(auth ? { Authorization: "Bearer " + auth } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  let j = null; try { j = await r.json(); } catch {} return [r.status, j]; };
let fails = 0; const check = (name, ok, got) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  (got " + JSON.stringify(got) + ")"}`); };
let sent = [];
globalThis.fetch = async (u, init) => { u = String(u);
  if (u.includes("api.anthropic.com")) { sent.push(JSON.parse(init.body)); const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
    return new Response(ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }) + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude" } }) + ev("content_block_stop", { type: "content_block_stop", index: 0 }) + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + ev("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } }); }
  return new Response(JSON.stringify(u.includes("players") ? [] : { events: [], dates: [], games: [] })); };
const { env, data } = fakeEnv({ COMETS_KEY: "owner-secret" }), call = caller(W, env), now0 = Date.now(), U = auth => data.get("cz:u:" + auth.split(".")[0]);
async function pkAccount(name, ip) { const ph = device("https://cosmosports.app"); const [, ch] = await call("/pk/start", { kind: "reg", name }, null, "POST", { ip }); const [, r] = await call("/pk/register", ph.create(ch), null, "POST", { ip }); return { ...r, ph }; }
const NP = { "X-No-Passkeys": "1" };

// S5: user verification required
{ const ph = device("https://cosmosports.app"); const [, ch] = await call("/pk/start", { kind: "reg", name: "NoUV" }, null, "POST", { ip: "8.8.8.1" });
  check("S5 a passkey without Face ID/fingerprint/passcode can't be created", (await call("/pk/register", ph.create(ch, { flags: 0x41 })))[0] === 400); }
const ann = await pkAccount("Ann", "1.1.1.1");
{ let [, ch] = await call("/pk/start", { kind: "auth" }); check("S5 sign-in without user verification is refused", (await call("/pk/login", ann.ph.get(ch, 0, { flags: 0x01 })))[0] === 401);
  [, ch] = await call("/pk/start", { kind: "auth" }); check("S5 sign-in with user verification works", (await call("/pk/login", ann.ph.get(ch)))[0] === 200); }
// S12
{ const ph = device("https://arro2121.github.io"); const [, ch] = await call("/pk/start", { kind: "reg", name: "OldSite" }); check("S12 passkeys from the old github.io address are refused", (await call("/pk/register", ph.create(ch)))[0] === 400); }
// S1
const np = (await call("/join", { name: "NoKey" }, null, "POST", { ...NP, ip: "2.2.2.2" }))[1];
const bob = await pkAccount("Bob", "1.1.1.2"), cat = await pkAccount("Cat", "1.1.1.3"), dan = await pkAccount("Dan", "1.1.1.4"), vic = await pkAccount("Victim", "1.1.1.5");
const L = (await call("/leaders"))[1];
check("S1 no-passkey accounts are left off the leaderboards", !L.rich.some(r => r.name === "NoKey") && L.rich.some(r => r.name === "Bob"), L.rich.map(r => r.name));
check("S1 no-passkey accounts can't report", (await call("/report", { name: "Victim", reason: "x" }, np.auth))[0] === 409);
{ const lb = data.get("cz:lb"), wk = "20260101"; lb[np.auth.split(".")[0]].wkp = { [wk]: 9999 }; lb[bob.uid].wkp = { [wk]: 10 }; data.set("cz:lb", lb);
  const r = await W.czTx({ get: async k => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)) }, { act: "weekaward", week: wk, now: now0 });
  check("S1 no-passkey accounts don't win weekly prizes", r.winners.length === 1 && r.winners[0].name === "Bob", r.winners); }
// S2
for (const x of [bob, cat, dan]) await call("/report", { name: "Victim", reason: "rude" }, x.auth);
await call("/report", { name: "Victim", reason: "again" }, bob.auth);
check("S2 three reports don't rename anyone", U(vic.auth).name === "Victim", U(vic.auth).name);
check("S2 a repeat report within a week isn't added", data.get("cz:reports").length === 3, data.get("cz:reports").length);
check("S2 reports from accounts under 3 days old don't count", data.get("cz:reports").every(r => !r.counts));
check("S2 a wrong owner key can't rename", (await call("/owner/review", { name: "Victim", action: "rename" }, null, "POST", { "X-Owner-Key": "nope", ip: "9.9.9.9" }))[0] === 403);
{ const [s, r] = await call("/owner/review", { name: "Victim", action: "rename" }, null, "POST", { "X-Owner-Key": "owner-secret" });
  check("S2 the owner renames after review", s === 200 && U(vic.auth).name === r.name && data.get("cz:reports").every(x => x.done), r); }
// S3 / S7
{ let [, ch] = await call("/pk/start", { kind: "auth" }); const second = (await call("/pk/login", ann.ph.get(ch)))[1].auth;
  await call("/signout", {}, ann.auth);
  check("S3 signing out cancels that device's key only", (await call("/me", null, ann.auth))[0] === 401 && (await call("/me", null, second))[0] === 200);
  await call("/signout", { all: true }, second); check("S3 sign out everywhere cancels every key", (await call("/me", null, second))[0] === 401);
  const [s, r] = await call("/key/new", {}, bob.auth);
  check("S7 a new account key replaces the old one", s === 200 && (await call("/me", null, bob.auth))[0] === 401 && (await call("/me", null, r.auth))[0] === 200); }
// S4: two copies of the worker share the counts
{ const W2 = await import("../worker.js?copy2"), call2 = caller(W2, env); let ok = 0;
  for (let i = 0; i < 4; i++) { if ((await call("/join", { name: "Fl" + i }, null, "POST", { ...NP, ip: "6.6.6.6" }))[0] === 200) ok++; if ((await call2("/join", { name: "Fm" + i }, null, "POST", { ...NP, ip: "6.6.6.6" }))[0] === 200) ok++; }
  check("S4 sign-up limit (5 an hour) holds across copies of the worker", ok === 5, ok);
  let locked = 0; for (let i = 0; i < 10; i++) if ((await (i % 2 ? call : call2)("/owner/inbox", null, null, "GET", { "X-Owner-Key": "g" + i, ip: "4.4.4.4" }))[0] === 429) locked++;
  check("S4 owner-key lockout after 8 misses holds across copies", locked === 2, locked);
  check("S4 long-window counts are saved in the Store", data.has("rl:join:6.6.6.6") && data.has("rl:own:4.4.4.4")); }
// S6
await call("/support", { message: "old message here", contact: "a@b.c" }, null, "POST", { ip: "3.3.3.1" });
{ const S = JSON.parse(data.get("cz:support")); S[0].at = now0 - 200 * 864e5; data.set("cz:support", JSON.stringify(S)); }
await call("/support", { message: "a newer message", contact: "d@e.f" }, cat.auth, "POST", { ip: "3.3.3.2" });
check("S6 support messages older than 180 days are dropped", JSON.parse(data.get("cz:support")).map(x => x.contact).join() === "d@e.f");
await call("/delete", { confirm: "DELETE" }, cat.auth);
check("S6 support messages go when the account is deleted", JSON.parse(data.get("cz:support")).length === 0);
// S8
{ const r = await W.default.fetch(new Request("https://w.dev/cosmic/leaders"), { KV: env.KV, SITE_URL: env.SITE_URL }, { waitUntil() {} }); check("S8 Cosmic refuses to run without the Durable Object", r.status === 503); }
// S9 + AI1
{ const envC = { ...env, ANTHROPIC_API_KEY: "sk-test", AI: { run: async () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"workers-ai"}\n\n')); c.close(); } }) } };
  const ask = async auth => (await W.default.fetch(new Request("https://w.dev/ask", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.6.7.8", ...(auth ? { Authorization: "Bearer " + auth } : {}) }, body: JSON.stringify({ messages: [{ role: "user", content: "How is PCA doing?" }], focus: "Cubs at Brewers. Pete Crow-Armstrong (CF, PCA)", member: true }) }), envC, { waitUntil() {} })).text();
  check("S9 anonymous visitors don't reach Claude (even claiming membership)", await ask(null) === "workers-ai" && !sent.length);
  check("S9 no-passkey accounts don't reach Claude", await ask(np.auth) === "workers-ai" && !sent.length);
  check("S9 passkey accounts get Claude with the smaller model and fewer tokens", await ask(dan.auth) === "claude" && sent[0].model === "claude-sonnet-5" && sent[0].max_tokens === 1200, sent[0] && [sent[0].model, sent[0].max_tokens]);
  check("AI1 the open game goes first, as FOCUS", sent[0].system[1].text.startsWith("FOCUS:")); }
// S11
{ const c = W.czSyncClean({ v: 1, ls: { picks: { a: 1 }, evil: "<x>", spoil: "x".repeat(5000) }, fav: { nfl: ["Chiefs", 5], "../x": ["y"] }, settings: { theme: "dark", obj: { deep: 1 } }, extra: 1 });
  check("S11 synced data keeps only known keys within their size caps", JSON.stringify(c) === '{"v":1,"ls":{"picks":{"a":1}},"fav":{"nfl":["Chiefs"]},"settings":{"theme":"dark"}}', c);
  check("S11 junk is refused", (await call("/data", "not an object", dan.auth, "PUT"))[0] === 400); }
// email and password sign-in was removed: no routes, and a one-time purge erases anything it stored
{ check("NOPW email sign-in is gone", (await call("/pw/login", { email: "a@b.co", password: "whatever-long-1" }, null, "POST", { ip: "12.0.0.1" }))[0] >= 400);
  check("NOPW email sign-up is gone", (await call("/pw/join", { name: "Nope", email: "n@b.co", password: "whatever-long-1" }, null, "POST", { ip: "12.0.0.2" }))[0] >= 400);
  const uid = dan.auth.split(".")[0], U = data.get("cz:u:" + uid); U.pw = { salt: "x", hash: "y" }; U.emh = "h"; U.emmask = "d•••@x.com"; data.set("cz:u:" + uid, U); data.set("cz:em:h", { uid }); data.set("rl:pwem:h", [1]);
  const r1 = await (await env.STORE.get().fetch("https://store/", { method: "POST", body: JSON.stringify({ op: "pwpurge" }) })).json();
  const U2 = data.get("cz:u:" + uid);
  check("NOPW purge erases email hashes, masked emails and password hashes", r1.v.done && !U2.pw && !U2.emh && !U2.emmask && !data.has("cz:em:h") && !data.has("rl:pwem:h"), r1.v);
  check("NOPW purge runs only once", (await (await env.STORE.get().fetch("https://store/", { method: "POST", body: JSON.stringify({ op: "pwpurge" }) })).json()).v.already === true);
  check("NOPW the account still works with its existing key", (await call("/me", null, dan.auth))[0] === 200); }
// P6: the owner's unlimited-coins test account stays out of other players' coins and cards
{ const m = new Map(), st = { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) }, T = a => W.czTx(st, { now: now0, ...a });
  for (const [uid, name] of [["O", "Owner"], ["S", "Seller"]]) await T({ act: "ident", sub: uid, uid, tok: "t", name });
  const c1 = { id: "nfl.x.singularity", tier: "singularity", supply: 1, n: 1, lg: "nfl", name: "X", kind: "player" }, c2 = { ...c1, id: "nfl.z.singularity" }, mine = { ...c1, id: "nfl.y.comet", tier: "comet", supply: 1000 };
  m.set("cz:u:S", { ...m.get("cz:u:S"), items: [c1, c2] }); m.set("cz:u:O", { ...m.get("cz:u:O"), tester: true, bal: 0, items: [mine] });
  const { lid } = await T({ act: "list", uid: "S", id: c1.id, price: 50000 }); await T({ act: "aucnew", uid: "S", id: c2.id, start: 100, hours: 1 });
  check("P6 test account can't buy listings", !!(await T({ act: "buyl", uid: "O", lid })).error);
  check("P6 test account can't bid in auctions", !!(await T({ act: "aucbid", uid: "O", aid: m.get("cz:auc")[0].aid, amount: 99999 })).error);
  check("P6 test account can't offer trades", !!(await T({ act: "toffer", uid: "O", to: "Seller", give: [], get: [c1.id], coins: 99999 })).error);
  check("P6 test account can't challenge players", !!(await T({ act: "bnew", uid: "O", sport: "nfl", id: "b1", cards: [mine.id], stake: 5000, to: "Seller", day: "d" })).error);
  check("P6 test account can still play Cosmo AI", !(await T({ act: "bnew", uid: "O", sport: "nfl", id: "b2", cards: [mine.id], stake: 0, house: true, houseCards: [c1], day: "d" })).error); }
// PK1: a pack bought twice with the same purchase id (a double tap, or a retry after a dropped connection) opens once
{ const m = new Map(), st = { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) }, T = a => W.czTx(st, { now: now0, ...a });
  await T({ act: "ident", sub: "B", uid: "B", tok: "t", name: "Buyer" }); m.set("cz:u:B", { ...m.get("cz:u:B"), bal: 5000, freePack: false });
  const pool = Array.from({ length: 30 }, (_, i) => ({ id: `nfl.p${i}.comet`, tier: "comet", supply: 1000, lg: "nfl", name: "P" + i, kind: "player" }));
  const pk = W.CZ_PACKS.find(x => x.id === "comet"), buy = rid => T({ act: "pack", uid: "B", pack: pk, pool, rid });
  const a = await buy("aaaaaaaaaaaaaaaa"), b = await buy("aaaaaaaaaaaaaaaa"), U = m.get("cz:u:B");
  check("PK1 the repeat returns the same cards", b.repeat && JSON.stringify(b.cards) === JSON.stringify(a.cards), b);
  check("PK1 charged once and given one pack's cards", U.bal === 5000 - pk.price && U.items.length === pk.cards && U.packs === 1, { bal: U.bal, items: U.items.length });
  const c = await buy("bbbbbbbbbbbbbbbb"), U2 = m.get("cz:u:B");
  check("PK1 a new purchase id opens a new pack", !c.repeat && U2.bal === 5000 - 2 * pk.price && U2.items.length === 2 * pk.cards); }
// SA1: Sell all sells every free card at shop value, skips cards on the market, and puts the copies back into packs
{ const m = new Map(), st = { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) }, T = a => W.czTx(st, { now: now0, ...a });
  await T({ act: "ident", sub: "V", uid: "V", tok: "t", name: "Vendor" });
  const cs = [1, 2, 3].map(i => ({ id: `nfl.q${i}.comet`, tier: "comet", supply: 1000, n: i, lg: "nfl", name: "Q" + i, kind: "player" }));
  m.set("cz:u:V", { ...m.get("cz:u:V"), bal: 0, items: cs.map((c, i) => i === 2 ? { ...c, listed: "L1" } : c) });
  const r = await T({ act: "sellmany", uid: "V", cards: cs.map(c => ({ id: c.id, value: 1000 })) }), U = m.get("cz:u:V");
  check("SA1 sells the free cards and pays shop value", r.sold === 2 && r.skipped === 1 && U.bal === 800 && U.items.length === 1 && U.items[0].listed, r);
  check("SA1 sold copies go back into packs", (m.get("cz:ret") || {})["nfl.q1.comet"]?.[0] === 1);
  check("SA1 cards you don't own can't be sold", !!(await T({ act: "sellmany", uid: "V", cards: [{ id: "nfl.q1.comet", value: 1e6 }] })).error); }
// RC1 / TP1: rookie premium and team-pack prices
check("RC1 rookie premium grows with play (10% to 45%)", W.czRookieX(0, null) === 1.1 && W.czRookieX(0, 0) === 1.15 && Math.abs(W.czRookieX(0, 1) - 1.45) < 1e-9 && W.czRookieX(8, 1) < 1.13);
check("TP1 team pack price follows the team's card value, 600 to 2,500", W.czTeamPackPrice(1) === 1000 && W.czTeamPackPrice(.2) === 600 && W.czTeamPackPrice(9) === 2500 && W.czTeamPackPrice(1.33) === 1350);
// SET1 / CH1: set checklists pay once when complete; case hits sell for 3 times the value
{ const m = new Map(), st = { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) }, T = a => W.czTx(st, { now: now0, ...a });
  await T({ act: "ident", sub: "K", uid: "K", tok: "t", name: "Keeper" });
  const mk = (b, tier) => ({ id: `${b}.${tier}`, tier, supply: 100, n: 1, lg: "nba", name: b, kind: "player" }), set = { id: "stars:nba", label: "NBA Superstars", reward: 5000, members: ["nba.p1", "nba.p2"] };
  m.set("cz:u:K", { ...m.get("cz:u:K"), bal: 0, items: [mk("nba.p1", "comet")] });
  check("SET1 an unfinished set can't be claimed", /still need 1 card/.test((await T({ act: "setclaim", uid: "K", set })).error || ""));
  m.set("cz:u:K", { ...m.get("cz:u:K"), items: [mk("nba.p1", "comet"), mk("nba.p2", "nebula")] });
  const r = await T({ act: "setclaim", uid: "K", set });
  check("SET1 a finished set pays its reward (any tier counts)", r.reward === 5000 && m.get("cz:u:K").bal === 5000);
  check("SET1 a set pays only once", !!(await T({ act: "setclaim", uid: "K", set })).error && m.get("cz:u:K").bal === 5000);
  m.set("cz:u:K", { ...m.get("cz:u:K"), bal: 0, items: [{ ...mk("nba.p3", "comet"), ch: "starfall" }, mk("nba.p4", "comet")] });
  await T({ act: "sell", uid: "K", id: "nba.p3.comet", value: 1000 }); const b1 = m.get("cz:u:K").bal; await T({ act: "sell", uid: "K", id: "nba.p4.comet", value: 1000 });
  check("CH1 a case hit sells for 3 times a regular copy", b1 === 1200 && m.get("cz:u:K").bal - b1 === 400, { b1, b2: m.get("cz:u:K").bal });
  check("CH1 about 1 card in 300 is a case hit", Math.abs(W.CZ_CASE.rate - 1 / 300) < 1e-9 && W.CZ_CASE.inserts.length === 3); }
console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
