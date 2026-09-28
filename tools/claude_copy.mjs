// Builds the private claude.ai copy of the site with Cosmic working inside it.
//
// A page hosted on claude.ai can only load its own files, so it can't reach the Cosmic service. This copy carries the
// service itself (alerts/worker.js, bundled for the browser) and answers the app's Cosmic requests in the page, keeping
// the records in the browser's own storage. Cosmic there is a separate, local game: its account, coins and cards live in
// that browser only and never reach the real service.
//
// Usage: node tools/claude_copy.mjs <out-dir> [path to esbuild's package dir]
//   then publish <out-dir>/index.html with the data files from docs/ alongside it.
// It's the owner's test copy, so its Cosmic player never runs out of coins.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createRequire } from "module";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.resolve(process.argv[2] || "claude-copy");
const require = createRequire(process.argv[3] ? path.join(path.resolve(process.argv[3]), "x.js") : import.meta.url);
const esbuild = require("esbuild");
mkdirSync(out, { recursive: true });

// the service, for the browser: the AI features have no key here, so their SDK is left out
const stub = path.join(out, "_anthropic_stub.js");
writeFileSync(stub, "export default class Anthropic { constructor(){ throw new Error('Not available in this copy.'); } }\n");
const entry = path.join(out, "_entry.js");
writeFileSync(entry, `export { default, Store } from ${JSON.stringify(path.join(root, "alerts/worker.js"))};\n`);
const r = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "iife", globalName: "CosmoLocal", platform: "browser",
  target: "es2022", minify: true, alias: { "@anthropic-ai/sdk": stub }, logLevel: "error" });
let bundle = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
bundle = `var CosmoLocal=(function(){var caches;${bundle.replace(/^var CosmoLocal=/, "return ")}})();`;   // no Cloudflare cache here

// the shim: records in this browser; the app's requests to the Cosmic service answered in the page
const shim = `
(function(){
  var W = window.CosmoLocal; if (!W) return;
  try { Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }); } catch (e) {}   // no passkeys in this frame: sign up with a name
  var P = "czlocal:", K = "czkv:", data = new Map(), kv = new Map();
  var ls = function(){ try { return window.localStorage; } catch (e) { return null; } }();
  if (ls) for (var i = 0; i < ls.length; i++) { var k = ls.key(i); try { if (k.indexOf(P) === 0) data.set(k.slice(P.length), JSON.parse(ls.getItem(k))); else if (k.indexOf(K) === 0) kv.set(k.slice(K.length), ls.getItem(k)); } catch (e) {} }
  function save(pre, k, s){ if (!ls) return; try { if (s == null) ls.removeItem(pre + k); else if (s.length < 300000) ls.setItem(pre + k, s); } catch (e) {} }
  var clone = function(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  // one player, nothing shared: the passkey rule (there to stop throwaway accounts on the real service) doesn't apply here
  // and it's the owner's test copy: coins never run out (the balance tops back up to a billion)
  var BANK = 1000000000;
  var local = function(k, v){ if (k.indexOf("cz:u:") === 0 && v && typeof v === "object"){ if (!v.ident) v.ident = "local-copy"; if (!(v.bal >= BANK)) v.bal = BANK; } return v; };
  data.forEach(function(v, k){ local(k, v); });
  var storage = {
    get: async function(k){ return Array.isArray(k) ? new Map(k.filter(function(x){ return data.has(x); }).map(function(x){ return [x, clone(data.get(x))]; })) : clone(data.get(k)); },
    put: async function(k, v){ v = local(k, clone(v)); data.set(k, v); save(P, k, JSON.stringify(v)); },
    delete: async function(k){ var had = data.delete(k); save(P, k, null); return had; },
    list: async function(o){ var pre = (o && o.prefix) || ""; return new Map(Array.from(data).filter(function(e){ return e[0].indexOf(pre) === 0; }).map(function(e){ return [e[0], clone(e[1])]; })); }
  };
  var base = new URL(".", location.href).href.replace(/\\/$/, "");
  var env = { KV: { get: async function(k){ return kv.has(k) ? kv.get(k) : null; }, put: async function(k, v){ v = String(v); kv.set(k, v); save(K, k, v); } }, SITE_URL: base, SITE_FALLBACK: base };
  var obj = new W.Store({ storage: storage }, env);
  env.STORE = { idFromName: function(n){ return n; }, get: function(){ return { fetch: function(u, init){ return obj.fetch(new Request(u, init)); } }; } };
  var SERVICE = ${JSON.stringify("__ALERTS__")}, origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    var url = typeof input === "string" ? input : input && input.url || String(input);
    if (SERVICE && url.indexOf(SERVICE) === 0){
      var req = typeof input === "string" ? new Request("https://local.cosmic" + url.slice(SERVICE.length), init) : new Request("https://local.cosmic" + url.slice(SERVICE.length), input);
      return W.default.fetch(req, env, { waitUntil: function(p){ if (p && p.catch) p.catch(function(){}); } });
    }
    return origFetch(input, init);
  };
})();`;

let html = readFileSync(path.join(root, "docs/index.html"), "utf8");
const alerts = (html.match(/const ALERTS_URL = "([^"]+)"/) || [])[1] || "";
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, "");                // claude.ai sets its own
const tag = `<script>${bundle}</script>\n<script>${shim.replace('"__ALERTS__"', JSON.stringify(alerts))}</script>\n`;
const at = html.search(/<script(\s[^>]*)?>/i);
html = html.slice(0, at) + tag + html.slice(at);
writeFileSync(path.join(out, "index.html"), html);
console.log("built", path.join(out, "index.html"), Math.round(html.length / 1024) + " KB", "service:", alerts || "(none)");
