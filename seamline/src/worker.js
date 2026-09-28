// Seamline API: product pages, Claude (reading, points, style advice) and the FASHN try-on.
// Static files in ./public are served by the assets binding; only /api/* reaches this code.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";
const FASHN_DEFAULT = "https://api.fashn.ai/v1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DATA_URL = 12 * 1024 * 1024;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    try {
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function route(request, env, url) {
  const p = url.pathname;
  if (p === "/api/config" && request.method === "GET") {
    return json({
      needsCode: !!env.ACCESS_CODE,
      tryon: !!env.FASHN_API_KEY || env.MOCK === "1",
      claude: !!env.ANTHROPIC_API_KEY || env.MOCK === "1",
    });
  }
  checkAccess(request, env);
  if (p === "/api/check" && request.method === "POST") return json({ ok: true });
  if (p === "/api/product" && request.method === "POST") return json(await product(await body(request), env));
  if (p === "/api/image" && request.method === "POST") return json(await imageFromUrl((await body(request)).url));
  if (p === "/api/extract" && request.method === "POST") {
    const b = await body(request);
    return json(await extract(env, String(b.text || ""), b.image || null));
  }
  if (p === "/api/points" && request.method === "POST") return json(await points(env, await body(request)));
  if (p === "/api/advice" && request.method === "POST") return json(await advice(env, await body(request)));
  if (p === "/api/tryon" && request.method === "POST") return json(await tryonStart(env, await body(request)));
  const m = p.match(/^\/api\/tryon\/([A-Za-z0-9_-]{1,100})$/);
  if (m && request.method === "GET") return json(await tryonStatus(env, m[1]));
  throw new HttpError(404, "Unknown endpoint.");
}

function checkAccess(request, env) {
  if (!env.ACCESS_CODE) return;
  const given = request.headers.get("x-access-code") || "";
  if (!timingSafeEqual(given, env.ACCESS_CODE)) throw new HttpError(401, "Wrong access code.");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function body(request) {
  const len = +request.headers.get("content-length") || 0;
  if (len > 30 * 1024 * 1024) throw new HttpError(413, "That upload is too large.");
  try { return await request.json(); } catch { throw new HttpError(400, "The request wasn't valid JSON."); }
}

/* ------------------------------------------------------------------ */
/* Fetching outside pages and images                                   */
/* ------------------------------------------------------------------ */
export function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new HttpError(400, "That isn't a valid link."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only web links (https://) work here.");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || !h.includes("."))
    throw new HttpError(400, "That link points somewhere this service can't open.");
  return u;
}

async function product(b, env) {
  const u = safeUrl(b.url);
  let res;
  try {
    res = await fetch(u.toString(), { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }, redirect: "follow" });
  } catch { throw new HttpError(502, "The store's page couldn't be reached. Paste the page text instead."); }
  if (!res.ok) throw new HttpError(502, `The store blocked the request (${res.status}). Paste the page text instead.`);
  const html = (await res.text()).slice(0, 3_000_000);
  const page = parseProductPage(html, res.url || u.toString());
  if (page.text.length < 200 && !page.ld) throw new HttpError(422, "The page didn't include the product details (the store may load them with scripts). Paste the page text instead.");
  const item = await extract(env, page.forClaude, null);
  return { item, images: page.images, url: res.url || u.toString() };
}

export function parseProductPage(html, baseUrl) {
  const images = [];
  const addImg = (src) => {
    if (!src || typeof src !== "string") return;
    try { const abs = new URL(src.trim(), baseUrl).toString(); if (/^https?:/.test(abs) && !images.includes(abs)) images.push(abs); } catch {}
  };
  let ld = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const found = findProduct(data);
      if (found) { ld = found; break; }
    } catch {}
  }
  if (ld) {
    const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
    for (const i of imgs) addImg(typeof i === "object" && i ? i.url || i.contentUrl : i);
  }
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re);
    return m ? decodeEntities(m[1] || m[2]) : null;
  };
  addImg(meta("og:image"));
  addImg(meta("og:image:secure_url"));
  addImg(meta("twitter:image"));
  const title = meta("og:title") || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const text = htmlToText(html);
  const parts = [];
  if (title) parts.push("Title: " + decodeEntities(title.trim()));
  if (ld) parts.push("Structured product data: " + JSON.stringify(slimLd(ld)).slice(0, 6000));
  parts.push("Page text:\n" + text.slice(0, 40000));
  return { title, ld: !!ld, images: images.slice(0, 12), text, forClaude: parts.join("\n\n") };
}
function findProduct(d) {
  if (!d || typeof d !== "object") return null;
  if (Array.isArray(d)) { for (const x of d) { const f = findProduct(x); if (f) return f; } return null; }
  const t = d["@type"];
  if (t === "Product" || (Array.isArray(t) && t.includes("Product")) || t === "ProductGroup") return d;
  if (d["@graph"]) return findProduct(d["@graph"]);
  return null;
}
function slimLd(d) {
  const keep = ["name", "brand", "description", "color", "material", "size", "sizes", "additionalProperty", "category"];
  const o = {};
  for (const k of keep) if (d[k] != null) o[k] = d[k];
  if (Array.isArray(d.hasVariant)) o.variantSizes = [...new Set(d.hasVariant.map((v) => v && v.size).filter(Boolean))].slice(0, 30);
  return o;
}
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/table)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

async function imageFromUrl(raw) {
  const u = safeUrl(raw);
  let res;
  try { res = await fetch(u.toString(), { headers: { "user-agent": UA, accept: "image/avif,image/webp,image/png,image/jpeg,*/*" } }); }
  catch { throw new HttpError(502, "The image couldn't be downloaded."); }
  if (!res.ok) throw new HttpError(502, `The image couldn't be downloaded (${res.status}).`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) throw new HttpError(415, "That link isn't an image.");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "That image is too large.");
  return { dataUrl: `data:${type};base64,${toBase64(buf)}` };
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function parseDataUrl(d, what) {
  const m = typeof d === "string" && d.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, `The ${what} must be a JPEG, PNG, WebP or GIF image.`);
  if (d.length > MAX_DATA_URL) throw new HttpError(413, `The ${what} is too large.`);
  return { mediaType: m[1], data: m[2] };
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */
function claudeClient(env) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "Claude isn't set up on this server yet (ANTHROPIC_API_KEY is missing).");
  const opts = { apiKey: env.ANTHROPIC_API_KEY };
  if (env.ANTHROPIC_BASE_URL) opts.baseURL = env.ANTHROPIC_BASE_URL;
  return new Anthropic(opts);
}

// One structured-output call: returns the parsed JSON object.
async function askClaude(env, { content, schema, effort = "medium", maxTokens = 8000 }) {
  const client = claudeClient(env);
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The server's Claude key was rejected.");
    if (e instanceof Anthropic.BadRequestError) { console.error("Claude 400", e.message); throw new HttpError(502, "Claude couldn't process that request."); }
    if (e instanceof Anthropic.APIError) { console.error("Claude error", e.status, e.message); throw new HttpError(502, "Claude had a problem. Try again."); }
    throw e;
  }
  if (res.stop_reason === "refusal") throw new HttpError(422, "Claude declined that request. Try a different photo or text.");
  if (res.stop_reason === "max_tokens") throw new HttpError(502, "Claude's answer was cut short. Try with less text.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { throw new HttpError(502, "Claude's answer couldn't be read. Try again."); }
}
const imageBlock = (dataUrl, what) => {
  const { mediaType, data } = parseDataUrl(dataUrl, what);
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
};
const nullable = (t) => ({ type: [t, "null"] });
const POINT = { anyOf: [{ type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false }, { type: "null" }] };

const SIZE_KEYS = ["chest", "waist", "hips", "shoulder", "length", "sleeve", "inseam", "rise"];
const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "brand", "category", "fitStyle", "fabric", "stretch", "color", "chartType", "unit", "flat", "sizes", "modelNote", "runs", "notes"],
  properties: {
    name: { type: "string" },
    brand: nullable("string"),
    category: { type: "string", enum: ["top", "bottom", "dress", "outerwear"] },
    fitStyle: { type: "string", enum: ["slim", "regular", "relaxed", "oversized", "cropped"] },
    fabric: nullable("string"),
    stretch: { type: "string", enum: ["none", "low", "medium", "high"] },
    color: nullable("string"),
    chartType: { type: "string", enum: ["garment", "body", "none"] },
    unit: { type: "string", enum: ["cm", "in"] },
    flat: { type: "boolean" },
    sizes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", ...SIZE_KEYS],
        properties: { label: { type: "string" }, ...Object.fromEntries(SIZE_KEYS.map((k) => [k, nullable("string")])) },
      },
    },
    modelNote: nullable("string"),
    runs: { type: "integer", enum: [-1, 0, 1] },
    notes: { type: "array", items: { type: "string" } },
  },
};
const EXTRACT_PROMPT = `You are reading a clothing product page. Extract the facts needed to check how it fits a shopper. Use only what the page says and never invent measurements.
- chartType "garment": the size chart measures the garment itself. "body": it lists the body measurements each size is meant for. "none": sizes but no measurements.
- If both cm and inches are given, use cm. Copy each number as written; a range like "96-101" stays a range. Use null for measurements the chart lacks.
- flat: true when chest, waist or hips are measured flat across one side ("pit to pit", "1/2 chest", "half waist"); false when measured all the way around; false for body charts.
- chest means bust for womenswear. length is from the top of the shoulder to the hem. sleeve is from the shoulder seam. For pants: waist, hips (seat), inseam, rise (front rise). Skirts count as "bottom".
- stretch from fabric and wording: rigid woven or denim with no elastane "none"; knits or up to 2% elastane "low"; 3-5% elastane or described as stretch "medium"; more than 5% elastane or "super stretch" "high".
- fitStyle from the fit wording ("slim fit", "boxy", "oversized", "relaxed", "cropped"); otherwise "regular".
- runs: -1 if the page or its reviews say it runs small or to size up, 1 if it runs large or to size down, else 0.
- modelNote: the model's height and the size they wear, as written, or null.
- notes: up to 5 short fit facts not captured above.`;

export async function extract(env, text, image) {
  if (env.MOCK === "1") return mockExtract(text);
  if (text.trim().length < 40) throw new HttpError(400, "Paste more of the product page.");
  const content = [];
  if (image) content.push(imageBlock(image, "product photo"));
  content.push({ type: "text", text: `${EXTRACT_PROMPT}\n${image ? "The image is the product photo; use it only to confirm the category and color.\n" : ""}\nProduct page:\n"""\n${text.slice(0, 60000)}\n"""` });
  return askClaude(env, { content, schema: EXTRACT_SCHEMA, effort: "medium" });
}

async function points(env, b) {
  const kind = b.kind === "garment" ? "garment" : "body";
  const keys = kind === "body" ? ["head", "feet", "shL", "shR", "wL", "wR"] : ["p1", "p2", "p3"];
  if (env.MOCK === "1") return mockPoints(kind);
  const schema = { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, POINT])) };
  const bottom = b.category === "bottom";
  const prompt = kind === "body"
    ? `The image is a full-body photo of a person standing and facing the camera. Locate these points. x and y are fractions of the image width and height (0 is left/top, 1 is right/bottom).
head: the very top of the head, including hair.
feet: ground level under the feet, centered between them.
shL: the outer tip of the shoulder on the image's left side. shR: the same on the image's right side.
wL and wR: the left and right edges of the body at the height where trousers usually sit, just below the navel.
Use null for any point you can't see.`
    : `The image is a product photo of ${bottom ? "a pair of pants or a skirt" : b.category === "dress" ? "a dress" : "a top or jacket"}. Locate these points. x and y are fractions of the image width and height (0 is left/top, 1 is right/bottom).
${bottom ? "p1: the left end of the top edge of the waistband. p2: the right end of the top edge of the waistband. p3: the bottom edge of one leg's hem (for a skirt, the middle of the hem)." : "p1: the shoulder seam on the image's left, where the sleeve joins the body. p2: the same on the image's right. p3: the bottom edge of the hem, at its center."}
Use null for any point you can't see.`;
  return askClaude(env, { content: [imageBlock(b.image, "photo"), { type: "text", text: prompt }], schema, effort: "medium", maxTokens: 4000 });
}

const ADVICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "headline", "why", "color", "wearWith", "sizeTip", "tryInstead"],
  properties: {
    verdict: { type: "string", enum: ["great", "good", "mixed", "skip"] },
    headline: { type: "string" },
    why: { type: "array", items: { type: "string" } },
    color: nullable("string"),
    wearWith: { type: "array", items: { type: "string" } },
    sizeTip: nullable("string"),
    tryInstead: { type: "array", items: { type: "string" } },
  },
};
async function advice(env, b) {
  if (env.MOCK === "1") return mockAdvice();
  const s = (v, n = 400) => String(v == null ? "" : v).slice(0, n);
  const content = [];
  const labels = [];
  if (b.photo) { content.push(imageBlock(b.photo, "photo of you")); labels.push("a photo of the shopper"); }
  if (b.tryon) { content.push(imageBlock(b.tryon, "try-on image")); labels.push("an AI try-on image of the shopper wearing the item"); }
  if (b.productImage) { content.push(imageBlock(b.productImage, "product photo")); labels.push("the product photo"); }
  const P = b.profile || {}, I = b.item || {};
  content.push({
    type: "text",
    text: `You are a personal stylist in a changing room. Tell this shopper honestly and specifically whether this item suits them and how to wear it. Be direct and kind. Talk about proportion, line, color and occasion. Never comment on weight or describe any part of the body as a problem to hide.

Shopper: ${s(P.measurements, 300)}. Likes clothes to fit: ${s(P.pref, 20)}.
In their words: "${s(P.notes, 800)}"

Item: ${s(I.name, 200)}. Type: ${s(I.category, 20)}. Cut: ${s(I.fitStyle, 20)}. Fabric: ${s(I.fabric, 200) || "unknown"}. Color: ${s(I.color, 80) || "unknown"}.
${I.notes ? "Page notes: " + s(I.notes, 600) : ""}

Size check: ${s(b.fit, 1500)}

${labels.length ? "Images, in order: " + labels.join(", ") + "." : "No photos; don't guess their coloring, and set color to null."}

Give 2-4 reasons in why, 3 specific pairings in wearWith, a sizeTip only if a different size would look better for their style (else null), and tryInstead only when the verdict is mixed or skip (else an empty list).`,
  });
  return askClaude(env, { content, schema: ADVICE_SCHEMA, effort: "medium" });
}

/* ------------------------------------------------------------------ */
/* FASHN try-on                                                        */
/* ------------------------------------------------------------------ */
const mockJobs = new Map();
const FASHN_CATEGORY = { top: "tops", outerwear: "tops", bottom: "bottoms", dress: "one-pieces" };

async function fashn(env, path, init) {
  if (!env.FASHN_API_KEY) throw new HttpError(503, "AI try-on isn't set up on this server yet (FASHN_API_KEY is missing).");
  const base = env.FASHN_BASE_URL || FASHN_DEFAULT;
  let res;
  try {
    res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${env.FASHN_API_KEY}`, ...(init && init.headers) } });
  } catch { throw new HttpError(502, "The try-on service couldn't be reached. Try again."); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 429) throw new HttpError(429, "The try-on service is busy. Try again in a minute.");
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "The server's try-on key was rejected.");
  if (!res.ok) throw new HttpError(502, (data && data.error && (data.error.message || data.error)) ? `Try-on failed: ${String(data.error.message || data.error).slice(0, 200)}` : `Try-on failed (${res.status}).`);
  return data || {};
}

async function tryonStart(env, b) {
  parseDataUrl(b.person, "photo of you");
  let garment;
  if (typeof b.garment === "string" && b.garment.startsWith("data:")) { parseDataUrl(b.garment, "product photo"); garment = b.garment; }
  else garment = safeUrl(b.garment).toString();
  const category = FASHN_CATEGORY[b.category] || "auto";
  if (env.MOCK === "1") {
    const id = "mock" + Math.random().toString(36).slice(2, 10);
    mockJobs.set(id, { person: b.person, polls: 0 });
    return { id };
  }
  const data = await fashn(env, "/run", {
    method: "POST",
    body: JSON.stringify({
      model_name: "tryon-v1.6",
      inputs: { model_image: b.person, garment_image: garment, category, garment_photo_type: "auto", mode: b.mode === "quality" ? "quality" : "balanced", num_samples: 1 },
    }),
  });
  if (!data.id) throw new HttpError(502, "The try-on service didn't start the job.");
  return { id: String(data.id) };
}

async function tryonStatus(env, id) {
  if (env.MOCK === "1") {
    const job = mockJobs.get(id);
    if (!job) throw new HttpError(404, "That try-on job wasn't found.");
    job.polls++;
    return job.polls < 2 ? { status: "processing" } : { status: "completed", output: [job.person] };
  }
  const data = await fashn(env, "/status/" + encodeURIComponent(id), { method: "GET" });
  const status = String(data.status || "processing");
  if (status === "failed") {
    const msg = data.error && (data.error.message || data.error.name);
    return { status, error: msg ? String(msg).slice(0, 300) : "The try-on didn't work for this photo." };
  }
  if (status === "completed") {
    const out = Array.isArray(data.output) ? data.output.filter((x) => typeof x === "string") : [];
    if (!out.length) return { status: "failed", error: "The try-on finished without an image." };
    const first = out[0];
    // Hand the browser a data URL so it can keep the result; FASHN's links expire.
    if (/^https:/.test(first)) { const img = await imageFromUrl(first); return { status, output: [img.dataUrl] }; }
    return { status, output: [first] };
  }
  return { status };
}

/* ------------------------------------------------------------------ */
/* Mock mode (MOCK=1) for local development without keys              */
/* ------------------------------------------------------------------ */
function mockExtract(text) {
  const inch = /\binch|\bin\b/i.test(text) && !/\bcm\b/i.test(text);
  return {
    name: (text.match(/Title:\s*(.+)/) || [])[1]?.slice(0, 80) || "Mock oxford shirt",
    brand: "Mockbrand", category: "top", fitStyle: "regular", fabric: "100% cotton oxford", stretch: "none", color: "Light blue",
    chartType: "garment", unit: inch ? "in" : "cm", flat: true,
    sizes: [
      { label: "S", chest: "52", waist: "49", hips: null, shoulder: "44", length: "72", sleeve: "62", inseam: null, rise: null },
      { label: "M", chest: "55", waist: "52", hips: null, shoulder: "46", length: "74", sleeve: "63", inseam: null, rise: null },
      { label: "L", chest: "58", waist: "55", hips: null, shoulder: "48", length: "76", sleeve: "64", inseam: null, rise: null },
    ],
    modelNote: "Model is 186 cm and wears M.", runs: 0, notes: ["Mock data: the server is running with MOCK=1"],
  };
}
function mockPoints(kind) {
  return kind === "body"
    ? { head: { x: 0.5, y: 0.05 }, feet: { x: 0.5, y: 0.96 }, shL: { x: 0.36, y: 0.21 }, shR: { x: 0.64, y: 0.21 }, wL: { x: 0.41, y: 0.49 }, wR: { x: 0.59, y: 0.49 } }
    : { p1: { x: 0.3, y: 0.18 }, p2: { x: 0.7, y: 0.18 }, p3: { x: 0.5, y: 0.86 } };
}
function mockAdvice() {
  return {
    verdict: "good", headline: "Mock advice: a clean everyday piece that suits your frame.",
    why: ["The regular cut follows your shoulders without adding bulk.", "A mid-length hem keeps your proportions balanced."],
    color: null, wearWith: ["Dark straight jeans", "White low-top sneakers", "A navy overshirt"], sizeTip: null, tryInstead: [],
  };
}
