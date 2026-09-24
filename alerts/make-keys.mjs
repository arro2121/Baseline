// Creates the key pair that proves notifications come from you (VAPID).
//   node make-keys.mjs          -> prints the keys to copy
//   node make-keys.mjs --json   -> prints {"public": ..., "private": {...}} (used by setup.sh)
const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64url");
const priv = await crypto.subtle.exportKey("jwk", k.privateKey);
if (process.argv.includes("--json")) console.log(JSON.stringify({ public: pub, private: priv }));
else { console.log("\nVAPID_PUBLIC_KEY (public):\n" + pub); console.log("\nVAPID_PRIVATE_JWK (secret, keep it private):\n" + JSON.stringify(priv) + "\n"); }
