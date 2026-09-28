// Builds the private claude.ai copy of the site with Cosmic working inside it.
//
// A page hosted on claude.ai can only load its own files, so it can't reach the Cosmic service. This copy carries the
// service itself (alerts/worker.js, bundled for the browser) and answers the app's Cosmic requests in the page, keeping
// the records in the browser's own storage (IndexedDB). Cosmic there is a separate, local game: its account, coins and cards live in
// that browser only and never reach the real service.
//
// Usage: node tools/claude_copy.mjs <out-dir> [path to esbuild's package dir]
//   then publish <out-dir>/index.html with the data files from docs/ alongside it.
// The local game's records live in the browser's IndexedDB (moved there from localStorage by older copies).
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
  // claude.ai never shows the browser's own confirm() box (it answers "no" at once), so here the site's "Open this pack?"
  // style questions are taken as yes; the real site still asks
  try { window.confirm = function(){ return true; }; } catch (e) {}
  // Records are kept in the browser's IndexedDB: no size cap per record (a big collection's player record easily passes
  // the few hundred KB localStorage allows, and then grades, pulls and sales silently stopped being saved) and a far
  // bigger quota. Records an older copy kept in localStorage are moved over on the first load.
  var P = "czlocal:", K = "czkv:", data = new Map(), kv = new Map();
  var ls = function(){ try { return window.localStorage; } catch (e) { return null; } }();
  var idb = null;
  function openDb(){ return new Promise(function(res){ try { var r = indexedDB.open("cosmo-local", 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore("rec"); }; r.onsuccess = function(){ res(r.result); }; r.onerror = function(){ res(null); }; r.onblocked = function(){ res(null); };
  } catch (e) { res(null); } }); }
  function idbAll(db){ return new Promise(function(res){ try { var out = [], t = db.transaction("rec", "readonly"), c = t.objectStore("rec").openCursor();
    c.onsuccess = function(){ var x = c.result; if (x){ out.push([x.key, x.value]); x.continue(); } else res(out); }; c.onerror = function(){ res(out); };
  } catch (e) { res([]); } }); }
  // writes are batched into one IndexedDB transaction a moment later; anything not yet confirmed when the page is closed or
  // hidden is also written to localStorage right then (that is instant), and the next load takes it from there first
  var dirty = new Map(), inflight = new Map(), backed = new Set(), timer = 0;
  function lsPut(key, s){ if (!ls) return false; try { if (s == null) ls.removeItem(key); else ls.setItem(key, s); return true; } catch (e) { return false; } }
  function flush(){ clearTimeout(timer); timer = 0; if (!dirty.size) return; var batch = new Map(dirty); dirty.clear();
    if (!idb){ batch.forEach(function(s, key){ lsPut(key, s); }); return; }
    batch.forEach(function(s, key){ inflight.set(key, s); });
    // once IndexedDB has a record, any backup of it in localStorage is older: drop it so it can't win on the next load
    var done = function(ok){ batch.forEach(function(s, key){ if (inflight.get(key) === s) inflight.delete(key); if (!ok) lsPut(key, s); else if (backed.has(key) && !dirty.has(key) && !inflight.has(key)){ backed.delete(key); lsPut(key, null); } }); };
    try { var t = idb.transaction("rec", "readwrite"), o = t.objectStore("rec"); batch.forEach(function(s, key){ if (s == null) o.delete(key); else o.put(s, key); });
      t.oncomplete = function(){ done(true); }; t.onerror = t.onabort = function(){ done(false); }; } catch (e) { done(false); } }
  function save(pre, k, s){ dirty.set(pre + k, s); if (!timer) timer = setTimeout(flush, 60); }
  function rescue(){ var all = new Map(inflight); dirty.forEach(function(s, key){ all.set(key, s); }); all.forEach(function(s, key){ if (lsPut(key, s)) backed.add(key); }); flush(); }
  addEventListener("pagehide", rescue); document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden") rescue(); });
  function take(key, val){ try { if (key.indexOf(P) === 0) data.set(key.slice(P.length), JSON.parse(val)); else if (key.indexOf(K) === 0) kv.set(key.slice(K.length), val); } catch (e) {} }
  var clone = function(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  // one player, nothing shared: the passkey rule (there to stop throwaway accounts on the real service) doesn't apply here
  // and it's the owner's test copy: coins never run out (the balance tops back up to a billion)
  var BANK = 1000000000;
  var local = function(k, v){ if (k.indexOf("cz:u:") === 0 && v && typeof v === "object"){ if (!v.ident) v.ident = "local-copy"; if (!(v.bal >= BANK)) v.bal = BANK; } return v; };
  var ready = (async function(){
    idb = await openDb();
    if (idb) (await idbAll(idb)).forEach(function(e){ take(e[0], e[1]); });
    // then localStorage: what an older copy kept there, or what this copy rescued there as a page closed. It is never older
    // than IndexedDB's copy, so it wins; it moves into IndexedDB and leaves localStorage
    if (ls){ var old = []; for (var i = 0; i < ls.length; i++){ var k = ls.key(i); if (k && (k.indexOf(P) === 0 || k.indexOf(K) === 0)) old.push(k); }
      old.forEach(function(k){ var v = ls.getItem(k); take(k, v); if (idb) dirty.set(k, v); });
      old.forEach(function(k){ if (idb) backed.add(k); }); if (idb && old.length) flush(); }
    data.forEach(function(v, k){ local(k, v); });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}   // ask the browser not to clear it
  })();
  var storage = {
    get: async function(k){ await ready; return Array.isArray(k) ? new Map(k.filter(function(x){ return data.has(x); }).map(function(x){ return [x, clone(data.get(x))]; })) : clone(data.get(k)); },
    // like a Durable Object's storage: put takes a key and value or an object of many; delete takes a key or a list of keys
    put: async function(k, v){ await ready; var one = function(k, v){ v = local(k, clone(v)); data.set(k, v); save(P, k, JSON.stringify(v)); };
      if (k && typeof k === "object") Object.keys(k).forEach(function(x){ one(x, k[x]); }); else one(k, v); },
    delete: async function(k){ await ready; var n = 0; (Array.isArray(k) ? k : [k]).forEach(function(x){ if (data.delete(x)) n++; save(P, x, null); }); return Array.isArray(k) ? n : n > 0; },
    list: async function(o){ await ready; var pre = (o && o.prefix) || ""; return new Map(Array.from(data).filter(function(e){ return e[0].indexOf(pre) === 0; }).map(function(e){ return [e[0], clone(e[1])]; })); }
  };
  var base = new URL(".", location.href).href.replace(/\\/$/, "");
  var env = { KV: { get: async function(k){ await ready; return kv.has(k) ? kv.get(k) : null; }, put: async function(k, v){ await ready; v = String(v); kv.set(k, v); save(K, k, v); } }, SITE_URL: base, SITE_FALLBACK: base };
  var obj = new W.Store({ storage: storage }, env);
  // Cloudflare runs a Durable Object's requests one at a time; here they would interleave (a background refresh reading a
  // player, then writing that old copy back over a grade, a sale or a pack that finished meanwhile), so they queue
  var line = Promise.resolve();
  env.STORE = { idFromName: function(n){ return n; }, get: function(){ return { fetch: function(u, init){
    var run = line.then(function(){ return obj.fetch(new Request(u, init)); }); line = run.catch(function(){}); return run; } }; } };
  var SERVICE = ${JSON.stringify("__ALERTS__")}, origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    var url = typeof input === "string" ? input : input && input.url || String(input);
    if (SERVICE && url.indexOf(SERVICE) === 0){
      await ready;
      var req = typeof input === "string" ? new Request("https://local.cosmic" + url.slice(SERVICE.length), init) : new Request("https://local.cosmic" + url.slice(SERVICE.length), input);
      var res = await W.default.fetch(req, env, { waitUntil: function(p){ if (p && p.catch) p.catch(function(){}); } });
      // the answer carries the player as the service saw it a moment ago: show the topped-up balance straight away
      try { var j = await res.clone().json(), u = j && j.user;
        if (u && typeof u === "object" && u.uid){ if (!(u.bal >= BANK)) u.bal = BANK; u.secured = true;
          return new Response(JSON.stringify(j), { status: res.status, headers: res.headers }); } } catch (e) {}
      return res;
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
