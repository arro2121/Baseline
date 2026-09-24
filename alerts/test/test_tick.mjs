import ece from "http_ece";
import nodeCrypto from "node:crypto";
import worker, { tick } from "../worker.js";

const kv = new Map(); const KV = { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } };
const vk = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const env = { KV, API_TENNIS_KEY: "test", SITE_URL: "https://me.github.io/baseline",
  VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey("raw", vk.publicKey)).toString("base64url"),
  VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", vk.privateKey)) };
const device = () => { const e = nodeCrypto.createECDH("prime256v1"); e.generateKeys(); const a = nodeCrypto.randomBytes(16);
  return { ecdh: e, auth: a, sub: { endpoint: "https://fcm.googleapis.com/fcm/send/" + nodeCrypto.randomBytes(6).toString("hex"), keys: { p256dh: e.getPublicKey("base64url"), auth: a.toString("base64url") } } }; };
const sinnerFan = device(), rybFan = device(), oldPhone = device();

// devices subscribe through the worker's web endpoint, exactly as the site does
const post = (path, body) => worker.fetch(new Request("https://alerts.example.workers.dev" + path, { method: "POST", body: JSON.stringify(body) }), env);
console.log("subscribe:", await (await post("/subscribe", { sub: sinnerFan.sub, watch: { atp: ["Jannik Sinner"], wta: [] } })).json());
await post("/subscribe", { sub: rybFan.sub, watch: { atp: [], wta: ["Elena Rybakina"] } });
await post("/subscribe", { sub: oldPhone.sub, watch: { atp: ["Jannik Sinner"], wta: [] } });

const players = [{ name: "Jannik Sinner", tour: "atp" }, { name: "Carlos Alcaraz", tour: "atp" }, { name: "Elena Rybakina", tour: "wta" }];
const ev = (status, live, scores, extra = {}) => ({ event_key: "777", event_type_type: "Atp Singles", tournament_name: "Beijing", event_first_player: "J. Sinner", event_second_player: "C. Alcaraz",
  event_status: status, event_live: live, event_time: "08:30", scores: scores.map((s, i) => ({ score_first: String(s[0]), score_second: String(s[1]), score_set: String(i + 1) })), ...extra });
const states = [
  ev("", "0", []),
  ev("Set 1", "1", [[2, 1]], { event_game_result: "15 - 0", event_serve: "First Player" }),
  ev("Set 2", "1", [[6, 4], [0, 0]], { event_game_result: "0 - 0", event_serve: "Second Player" }),
  ev("Finished", "0", [[6, 4], [6, 3]], { event_winner: "First Player" }),
];
let step = 0; const pushes = [];
const fakeFetch = async (url, opts = {}) => {
  url = String(url);
  if (url.endsWith("/players.json")) return new Response(JSON.stringify(players));
  if (url.includes("api-tennis")) { const m = new URL(url).searchParams.get("method");
    return new Response(JSON.stringify({ success: 1, result: m === "get_livescore" ? (states[step].event_live === "1" ? [states[step]] : []) : (states[step].event_live === "1" ? [] : [states[step]]) })); }
  pushes.push({ url, opts }); return new Response(null, { status: url.includes(oldPhone.sub.endpoint.split("/").pop()) ? 410 : 201 });
};
for (step = 0; step < states.length; step++) { const r = await tick(env, fakeFetch); console.log(`check ${step + 1}:`, JSON.stringify(r)); }

const decode = (d, p) => JSON.parse(ece.decrypt(Buffer.from(p.opts.body), { version: "aes128gcm", privateKey: d.ecdh, authSecret: d.auth }).toString());
console.log("\nnotifications received by the Sinner fan:");
pushes.filter(p => p.url === sinnerFan.sub.endpoint).forEach(p => { const m = decode(sinnerFan, p); console.log("  -", m.title, "|", m.body); });
console.log("Rybakina fan received:", pushes.filter(p => p.url === rybFan.sub.endpoint).length, "(should be 0)");
console.log("uninstalled phone removed:", !JSON.parse(kv.get("subs")).some(s => s.sub.endpoint === oldPhone.sub.endpoint));
const live = await (await worker.fetch(new Request("https://x/live.json"), env)).json();
console.log("site's /live.json:", live.matches.map(m => `${m.a} v ${m.b} ${m.status} ${JSON.stringify(m.sets)}`));
