// Worker checks with every outside service faked: node test/test_worker.mjs
import assert from "node:assert/strict";
import worker, { parseProductPage, safeUrl } from "../src/worker.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG.split(",")[1]), (c) => c.charCodeAt(0));
const PAGE = `<html><head><title>Oxford Shirt | Shop</title>
<meta property="og:image" content="https://cdn.shop.example/og.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Oxford Shirt","brand":{"name":"Shop"},"image":["https://cdn.shop.example/flat.jpg","/img/model.jpg"],"material":"100% cotton"}]}</script>
<style>.x{}</style><script>var tracking=1</script></head>
<body><h1>Oxford Shirt</h1><p>Regular fit. Model is 186cm and wears M.</p>
<table><tr><th>Size</th><th>Chest (pit to pit)</th></tr><tr><td>S</td><td>52</td></tr><tr><td>M</td><td>55</td></tr></table>
${"<p>Soft brushed cotton for everyday wear.</p>".repeat(8)}</body></html>`;

const calls = [];
let claudeReply = null, fashnStatus = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init.method || (input.method ?? "GET");
  const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
  let body = init.body;
  if (body === undefined && typeof input === "object" && input.body) body = await input.text();
  calls.push({ url, method, headers, body });
  if (url.startsWith("https://shop.example/")) return new Response(PAGE, { headers: { "content-type": "text/html" } });
  if (url.startsWith("https://cdn.shop.example/") || url.startsWith("https://cdn.fashn.example/"))
    return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
  if (url.startsWith("https://blocked.example/")) return new Response("no", { status: 403 });
  if (url.includes("/v1/messages")) return new Response(JSON.stringify(claudeReply), { headers: { "content-type": "application/json", "request-id": "req_test" } });
  if (url === "https://fashn.test/v1/run") return new Response(JSON.stringify({ id: "pred_123", error: null }), { headers: { "content-type": "application/json" } });
  if (url === "https://fashn.test/v1/status/pred_123") return new Response(JSON.stringify(fashnStatus), { headers: { "content-type": "application/json" } });
  throw new Error("unexpected fetch " + url);
};

const env = { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://anthropic.test", FASHN_API_KEY: "fa-test", FASHN_BASE_URL: "https://fashn.test/v1", ACCESS_CODE: "letmein" };
const req = (path, body, code = "letmein", method) =>
  worker.fetch(new Request("https://seamline.test" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-access-code": code },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
const claudeJSON = (obj, stop = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: stop, stop_sequence: null,
  content: stop === "refusal" ? [] : [{ type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 10 },
});
const EXTRACTED = { name: "Oxford Shirt", brand: "Shop", category: "top", fitStyle: "regular", fabric: "100% cotton", stretch: "none", color: "Blue",
  chartType: "garment", unit: "cm", flat: true, sizes: [{ label: "S", chest: "52", waist: null, hips: null, shoulder: null, length: null, sleeve: null, inseam: null, rise: null }],
  modelNote: "Model is 186cm and wears M.", runs: 0, notes: [] };

let n = 0;
const t = async (name, fn) => { calls.length = 0; await fn(); n++; console.log("ok -", name); };

await t("config says what is set up, without the code", async () => {
  const r = await (await req("/api/config", null, "")).json();
  assert.deepEqual(r, { needsCode: true, tryon: true, claude: true });
});
await t("the access code is required", async () => {
  assert.equal((await req("/api/check", {}, "nope")).status, 401);
  assert.equal((await req("/api/check", {}, "")).status, 401);
  assert.equal((await req("/api/check", {})).status, 200);
});
await t("unsafe links are refused", async () => {
  for (const u of ["http://localhost/x", "http://127.0.0.1/", "file:///etc/passwd", "https://intranet/", "http://[::1]/"]) assert.throws(() => safeUrl(u));
  assert.equal(safeUrl("https://shop.example/p").hostname, "shop.example");
});
await t("product pages yield structured data, photos and table text", async () => {
  const p = parseProductPage(PAGE, "https://shop.example/p/oxford");
  assert.equal(p.ld, true);
  assert.deepEqual(p.images, ["https://cdn.shop.example/flat.jpg", "https://shop.example/img/model.jpg", "https://cdn.shop.example/og.jpg"]);
  assert.match(p.text, /M \| 55 \|/);
  assert.doesNotMatch(p.text, /tracking/);
});
await t("/api/product reads the page with Claude", async () => {
  claudeReply = claudeJSON(EXTRACTED);
  const res = await req("/api/product", { url: "https://shop.example/p/oxford" });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.item.name, "Oxford Shirt");
  assert.equal(r.images[0], "https://cdn.shop.example/flat.jpg");
  const c = calls.find((x) => x.url.includes("/v1/messages"));
  const sent = JSON.parse(c.body);
  assert.equal(sent.model, "claude-opus-5");
  assert.equal(sent.fallbacks, "default");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.match(c.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.match(sent.messages[0].content.at(-1).text, /Chest \(pit to pit\)/);
});
await t("a store that blocks us gives a clear message", async () => {
  const res = await req("/api/product", { url: "https://blocked.example/p" });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Paste the page text/);
});
await t("a Claude refusal becomes a 422", async () => {
  claudeReply = claudeJSON(null, "refusal");
  const res = await req("/api/extract", { text: "x".repeat(100) });
  assert.equal(res.status, 422);
});
await t("/api/points sends the photo to Claude", async () => {
  claudeReply = claudeJSON({ head: { x: 0.5, y: 0.05 }, feet: { x: 0.5, y: 0.95 }, shL: null, shR: null, wL: null, wR: null });
  const r = await (await req("/api/points", { kind: "body", image: PNG })).json();
  assert.equal(r.head.y, 0.05);
  const sent = JSON.parse(calls.find((x) => x.url.includes("/v1/messages")).body);
  assert.equal(sent.messages[0].content[0].type, "image");
  assert.equal(sent.messages[0].content[0].source.media_type, "image/png");
});
await t("bad images are refused before any outside call", async () => {
  const res = await req("/api/points", { kind: "body", image: "data:text/html;base64,PGI+" });
  assert.equal(res.status, 400);
  assert.equal(calls.filter((x) => x.url.includes("/v1/messages")).length, 0);
});
await t("/api/tryon starts a FASHN job with the right inputs", async () => {
  const r = await (await req("/api/tryon", { person: PNG, garment: PNG, category: "dress" })).json();
  assert.equal(r.id, "pred_123");
  const c = calls.find((x) => x.url === "https://fashn.test/v1/run");
  assert.equal(c.headers.get("authorization"), "Bearer fa-test");
  const sent = JSON.parse(c.body);
  assert.equal(sent.model_name, "tryon-v1.6");
  assert.equal(sent.inputs.category, "one-pieces");
  assert.equal(sent.inputs.model_image, PNG);
});
await t("a finished job comes back as an image the browser can keep", async () => {
  fashnStatus = { id: "pred_123", status: "completed", output: ["https://cdn.fashn.example/out.png"], error: null };
  const r = await (await req("/api/tryon/pred_123")).json();
  assert.equal(r.status, "completed");
  assert.match(r.output[0], /^data:image\/png;base64,/);
});
await t("a failed job passes on FASHN's reason", async () => {
  fashnStatus = { id: "pred_123", status: "failed", output: null, error: { name: "PoseError", message: "Couldn't find a person" } };
  const r = await (await req("/api/tryon/pred_123")).json();
  assert.deepEqual(r, { status: "failed", error: "Couldn't find a person" });
});
await t("an in-progress job just reports its status", async () => {
  fashnStatus = { id: "pred_123", status: "processing", output: null, error: null };
  assert.deepEqual(await (await req("/api/tryon/pred_123")).json(), { status: "processing" });
});
await t("missing keys give a setup message, not a crash", async () => {
  const bare = { ACCESS_CODE: "" };
  const res = await worker.fetch(new Request("https://seamline.test/api/tryon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ person: PNG, garment: PNG, category: "top" }) }), bare);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /FASHN_API_KEY/);
});
console.log(`${n} worker checks passed`);
