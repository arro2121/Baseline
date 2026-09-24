import ece from "http_ece";
import nodeCrypto from "node:crypto";
import { encryptPayload, vapidAuth, b64u } from "../worker.js";

// a "phone" subscription, like the browser creates
const ua = nodeCrypto.createECDH("prime256v1"); ua.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const sub = { endpoint: "https://web.push.apple.com/QGuQyavXutnMEh", keys: { p256dh: ua.getPublicKey("base64url"), auth: auth.toString("base64url") } };

const msg = JSON.stringify({ title: "Set to Sinner", body: "6-4 vs Alcaraz", tag: "set-1-1" });
const body = await encryptPayload(sub, msg);
const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
console.log("decrypted by independent library:", plain.toString() === msg ? "MATCH" : "MISMATCH", "|", plain.toString());

// VAPID signature check
const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const env = { VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64url"),
              VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey)), VAPID_SUBJECT: "mailto:test@example.com" };
const header = await vapidAuth(sub.endpoint, env);
const [, jwt, kpart] = header.match(/^vapid t=([^,]+), k=(.+)$/);
const [h, p, s] = jwt.split(".");
const claims = JSON.parse(Buffer.from(p, "base64url"));
const pubKey = await crypto.subtle.importKey("raw", b64u.dec(kpart), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, b64u.dec(s), new TextEncoder().encode(`${h}.${p}`));
console.log("VAPID signature valid:", ok, "| audience:", claims.aud, "| expires in h:", ((claims.exp - Date.now()/1000)/3600).toFixed(1), "| header ok:", JSON.parse(Buffer.from(h,"base64url")).alg);
