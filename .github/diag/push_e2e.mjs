// End-to-end check of the alerts service: a real push subscription on Mozilla's push service (no browser needed),
// subscribed to the live worker, then a test notification that must arrive and decrypt.
import crypto from "node:crypto";
import ece from "http_ece";
import { readFileSync, writeFileSync } from "node:fs";
const require_fs = () => ({ writeFileSync });
const ALERTS = process.env.ALERTS || JSON.parse(readFileSync("site_config.json", "utf8")).alerts_url;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log("worker:", ALERTS, JSON.stringify(await (await fetch(ALERTS + "/")).json().catch(e => String(e))));
const { key } = await (await fetch(ALERTS + "/vapid")).json(); log("vapid key", key.slice(0, 12) + "…");
const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
const auth = crypto.randomBytes(16);
const ws = new WebSocket("wss://push.services.mozilla.com/");
const inbox = []; let endpoint = null;
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.messageType === "hello") ws.send(JSON.stringify({ messageType: "register", channelID: crypto.randomUUID(), key }));
  else if (m.messageType === "register") { endpoint = m.pushEndpoint; log("register", m.status, endpoint && endpoint.slice(0, 60) + "…"); }
  else if (m.messageType === "notification") { ws.send(JSON.stringify({ messageType: "ack", updates: [{ channelID: m.channelID, version: m.version }] }));
    try { const plain = ece.decrypt(Buffer.from(m.data, "base64url"), { version: "aes128gcm", privateKey: ecdh, authSecret: auth }); inbox.push(plain.toString()); log("PUSH RECEIVED:", plain.toString()); }
    catch (e) { log("push received but could not decrypt:", e.message); inbox.push("undecryptable"); } }
  else log("ws:", ev.data.slice(0, 200)); };
ws.onopen = () => ws.send(JSON.stringify({ messageType: "hello", use_webpush: true }));
for (let i = 0; i < 40 && !endpoint; i++) await new Promise(r => setTimeout(r, 250));
if (!endpoint) { log("FAIL: no push endpoint"); process.exit(1); }
const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
const post = async (path, body) => { const r = await fetch(ALERTS + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return [r.status, await r.text()]; };
log("subscribe (no teams):", ...(await post("/subscribe", { sub, teams: {}, games: [], prefs: {} })));
log("test (no teams):", ...(await post("/test", { endpoint, sub })));
log("subscribe (teams):", ...(await post("/subscribe", { sub, teams: { mlb: ["New York Yankees"] }, games: [], prefs: { start: true, score: true, close: true, final: true, daily: true } })));
log("test (teams):", ...(await post("/test", { endpoint, sub })));
for (let i = 0; i < 40 && !inbox.length; i++) await new Promise(r => setTimeout(r, 250));
log(inbox.length ? `RESULT: OK, ${inbox.length} notification(s) arrived` : "RESULT: FAIL, nothing arrived");
if (process.env.TTS) for (const voice of ["", "male", "female"]) { const r = await fetch(ALERTS + "/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Touchdown Chiefs! Mahomes finds Kelce in the corner of the end zone.", voice }) });
  const b = Buffer.from(await r.arrayBuffer()); if (r.status === 200) require_fs().writeFileSync(`.github/diag/voice-${voice || "default"}.mp3`, b); log("tts", voice || "default", r.status, r.headers.get("content-type"), r.headers.get("x-voice"), b.length, "bytes"); }
await post("/unsubscribe", { endpoint });
ws.close(); process.exit(0);
