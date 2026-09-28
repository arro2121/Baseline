(() => {
"use strict";
const F = window.SeamlineFit;
const { toCm, num, fmt, parseVal, CIRC, COLS, ZLABEL, STYLE_SHIFT, TARGET, shiftFactor, GIVE, sevClass, garmentCirc, fitSize, analyze, VERDICT } = F;

/* ---------------- state ---------------- */
const STORE = "seamline.v2";
const CODE_KEY = "seamline.code";
const uid = () => Math.random().toString(36).slice(2, 10);
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function sampleItem() {
  return {
    id: uid(), example: true, name: "Heavyweight cotton tee (example)", url: "", category: "top", fitStyle: "regular",
    fabric: "100% cotton jersey, 240 gsm", stretch: "low", color: "Navy", runs: 0, modelNote: "Model is 185 cm and wears M.",
    chartType: "garment", unit: "cm", flat: true, notes: ["Chest measured flat, pit to pit"],
    sizes: [
      { label: "S", chest: "50", waist: "", hips: "", shoulder: "44", length: "69", sleeve: "20", inseam: "", rise: "" },
      { label: "M", chest: "53", waist: "", hips: "", shoulder: "46", length: "71", sleeve: "21", inseam: "", rise: "" },
      { label: "L", chest: "56", waist: "", hips: "", shoulder: "48", length: "73", sleeve: "22", inseam: "", rise: "" },
      { label: "XL", chest: "59", waist: "", hips: "", shoulder: "50", length: "75", sleeve: "23", inseam: "", rise: "" },
    ],
    image: null, images: [], gpts: null, removeBg: true, tol: 40, advice: null, render: null,
  };
}
function blankItem() {
  return { id: uid(), example: false, name: "New item", url: "", category: "top", fitStyle: "regular", fabric: "", stretch: "low",
    color: "", runs: 0, modelNote: "", chartType: "garment", unit: "cm", flat: true, notes: [], sizes: [],
    image: null, images: [], gpts: null, removeBg: true, tol: 40, advice: null, render: null };
}
function defaultState() {
  const it = sampleItem();
  return {
    unit: "cm", tab: "tryon", view: "garment", opacity: 100, sel: null,
    profile: {
      example: true, height: 178, chest: 98, waist: 84, hips: 98, shoulder: 46, inseam: 81, arm: 60, pref: "regular",
      ref: { topChest: 54, topLength: 72, topShoulder: null, botWaist: null, botInseam: null, botRise: null },
      notes: "Casual most days, smart-casual at work. I like muted colors and clean lines.",
      photo: null, consent: false, pts: null,
    },
    items: [it], cur: it.id,
  };
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && s.profile && Array.isArray(s.items) && s.items.length) return s; } catch (e) {}
  return null;
}
let S = load() || defaultState();
F.setUnit(S.unit);
let saveT = null, warnedStorage = false;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(S)); return; } catch (e) {}
    // Out of room: keep everything except the older AI photos.
    try {
      const slim = JSON.parse(JSON.stringify(S));
      for (const it of slim.items) if (it.id !== slim.cur) it.render = null;
      localStorage.setItem(STORE, JSON.stringify(slim));
    } catch (e) {
      if (!warnedStorage) { warnedStorage = true; toast("This browser is out of room to save. Remove some items from the rack, or your latest changes will be lost when you close the page."); }
    }
  }, 300);
}
const curItem = () => S.items.find((i) => i.id === S.cur) || S.items[0];

let toastT = null;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 5000); }
function setStatus(id, text, err, busy) {
  const s = $(id); s.textContent = "";
  if (busy) s.append(el("span", "spin"));
  s.append(text); s.classList.toggle("err", !!err);
}

/* ---------------- server ---------------- */
let CONFIG = { needsCode: false, tryon: false, claude: false };
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ""; } catch (e) { return ""; } };
async function api(path, body, method) {
  const opts = { method: method || (body ? "POST" : "GET"), headers: { "x-access-code": getCode() } };
  if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch (e) { throw new Error("You're offline, or the server can't be reached."); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) {
    if ($("#gate").hidden) showGate("Enter the access code to continue.");
    throw new Error((data && data.error) || "Enter the access code first.");
  }
  if (!res.ok) throw new Error((data && data.error) || `The server returned an error (${res.status}).`);
  return data;
}
function showGate(msg) { $("#gate").hidden = false; if (msg) setStatus("#gate-status", msg); $("#gate-code").focus(); }
$("#gate").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { localStorage.setItem(CODE_KEY, $("#gate-code").value.trim()); } catch (err) {}
  try { await api("/api/check", {}); $("#gate").hidden = true; toast("Unlocked."); }
  catch (err) { setStatus("#gate-status", err.message, true); }
});

/* ---------------- images ---------------- */
const imgCache = new Map();
function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  imgCache.set(src, p);
  p.catch(() => imgCache.delete(src));
  return p;
}
async function srcToDataURL(src, maxDim, bg, quality) {
  const img = await loadImg(src);
  const sc = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  const x = c.getContext("2d");
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality || 0.88);
}
async function fileToDataURL(file, maxDim, bg) {
  const url = URL.createObjectURL(file);
  try { return await srcToDataURL(url, maxDim, bg); } finally { imgCache.delete(url); URL.revokeObjectURL(url); }
}
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ":" + h; };

/* Figure drawn from the measurements, used until a photo is added */
function makeMannequin(P) {
  const H = P.height || 170, k = 4;
  const sh = P.shoulder || H * 0.259, ch = P.chest || H * 0.55, wa = P.waist || H * 0.47, hp = P.hips || H * 0.55, ins = P.inseam || H * 0.45;
  const W = Math.round(Math.max(sh * k + 240, 380)), top = 30, Hpx = H * k, CH = Math.round(Hpx + 70);
  const c = document.createElement("canvas"); c.width = W; c.height = CH;
  const x = c.getContext("2d");
  const floor = top + Hpx, Y = (f) => floor - f * k, cx = W / 2;
  const g = x.createLinearGradient(0, 0, 0, CH); g.addColorStop(0, "#e7ebe8"); g.addColorStop(1, "#d6ddd8");
  x.fillStyle = g; x.fillRect(0, 0, W, CH);
  x.fillStyle = "rgba(0,0,0,.08)"; x.beginPath(); x.ellipse(cx, floor + 4, hp * 0.3 * k, 10, 0, 0, Math.PI * 2); x.fill();
  const headH = H * 0.13 * k, ySh = Y(H * 0.818), yNeck = top + headH - 2, yCh = Y(H * 0.72), yWa = Y(H * 0.62), yPw = Y(H * 0.575), yHip = Y(H * 0.52),
    yCr = Y(ins), yKnee = Y(H * 0.285), yAnk = Y(H * 0.04);
  const shW = (sh * k) / 2, chW = (ch * 0.34 * k) / 2, waW = (wa * 0.33 * k) / 2, hpW = (hp * 0.35 * k) / 2, neckW = 6 * k;
  x.lineJoin = "round"; x.lineCap = "round"; x.strokeStyle = "#9ea8a2"; x.lineWidth = 2; x.fillStyle = "#c7cec9";
  for (const s of [-1, 1]) {
    const sx = cx + s * (shW - 2 * k), ex = cx + s * (shW + 3 * k), wx = cx + s * (shW + 5 * k);
    const yE = Y(H * 0.63), yW = Y(H * 0.485);
    x.beginPath(); x.moveTo(sx - s * 4.5 * k, ySh + 2 * k); x.lineTo(sx + s * 4.5 * k, ySh);
    x.lineTo(ex + s * 3.6 * k, yE); x.lineTo(wx + s * 2.6 * k, yW); x.lineTo(wx - s * 2.6 * k, yW); x.lineTo(ex - s * 3.6 * k, yE); x.closePath();
    x.fill(); x.stroke();
    x.beginPath(); x.ellipse(wx, yW + 4 * k, 3.2 * k, 5 * k, 0, 0, Math.PI * 2); x.fill(); x.stroke();
  }
  for (const s of [-1, 1]) {
    const kx = cx + s * hpW * 0.5, ax = cx + s * hpW * 0.45;
    x.beginPath();
    x.moveTo(cx + s * hpW, yHip); x.lineTo(cx + s * hpW * 0.97, yCr); x.lineTo(kx + s * 5.5 * k, yKnee); x.lineTo(ax + s * 3.3 * k, yAnk);
    x.lineTo(ax - s * 3.3 * k, yAnk); x.lineTo(kx - s * 5.5 * k, yKnee); x.lineTo(cx + s * 1.5, yCr + 2 * k); x.lineTo(cx, yCr); x.lineTo(cx, yHip); x.closePath();
    x.fill(); x.stroke();
    x.beginPath(); x.ellipse(ax + s * 2 * k, floor - 2 * k, 5.5 * k, 2.6 * k, 0, 0, Math.PI * 2); x.fill(); x.stroke();
  }
  x.beginPath();
  x.moveTo(cx - neckW, yNeck);
  x.quadraticCurveTo(cx - neckW, ySh - 2 * k, cx - shW, ySh + 1 * k);
  x.lineTo(cx - chW, yCh); x.lineTo(cx - waW, yWa); x.lineTo(cx - hpW, yHip); x.lineTo(cx - hpW * 0.98, yCr - 2 * k);
  x.quadraticCurveTo(cx, yCr + 4 * k, cx + hpW * 0.98, yCr - 2 * k);
  x.lineTo(cx + hpW, yHip); x.lineTo(cx + waW, yWa); x.lineTo(cx + chW, yCh); x.lineTo(cx + shW, ySh + 1 * k);
  x.quadraticCurveTo(cx + neckW, ySh - 2 * k, cx + neckW, yNeck); x.closePath();
  x.fill(); x.stroke();
  x.beginPath(); x.ellipse(cx, top + headH / 2, headH * 0.37, headH / 2, 0, 0, Math.PI * 2); x.fill(); x.stroke();
  const pwW = waW + (hpW - waW) * ((yPw - yWa) / (yHip - yWa));
  const pts = { head: [cx, top], feet: [cx, floor], shL: [cx - shW, ySh], shR: [cx + shW, ySh], wL: [cx - pwW, yPw], wR: [cx + pwW, yPw] };
  const n = {}; for (const kk in pts) n[kk] = { x: pts[kk][0] / W, y: pts[kk][1] / CH };
  return { canvas: c, pts: n };
}

function makeSampleTee() {
  const c = document.createElement("canvas"); c.width = 800; c.height = 720;
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, 800, 720);
  x.fillStyle = "#2d3a57"; x.lineJoin = "round";
  x.beginPath();
  x.moveTo(338, 112); x.lineTo(240, 140); x.lineTo(104, 262); x.lineTo(166, 332); x.lineTo(216, 292);
  x.lineTo(214, 612); x.quadraticCurveTo(400, 622, 586, 612); x.lineTo(584, 292); x.lineTo(634, 332); x.lineTo(696, 262);
  x.lineTo(560, 140); x.lineTo(462, 112); x.quadraticCurveTo(400, 170, 338, 112); x.closePath(); x.fill();
  x.strokeStyle = "#223049"; x.lineWidth = 10; x.beginPath(); x.moveTo(338, 114); x.quadraticCurveTo(400, 172, 462, 114); x.stroke();
  x.lineWidth = 2; x.strokeStyle = "rgba(255,255,255,.12)";
  x.beginPath(); x.moveTo(218, 598); x.quadraticCurveTo(400, 608, 582, 598); x.stroke();
  x.beginPath(); x.moveTo(114, 272); x.lineTo(172, 322); x.stroke(); x.beginPath(); x.moveTo(686, 272); x.lineTo(628, 322); x.stroke();
  x.strokeStyle = "rgba(0,0,0,.18)"; x.lineWidth = 3;
  x.beginPath(); x.moveTo(240, 142); x.lineTo(218, 292); x.stroke(); x.beginPath(); x.moveTo(560, 142); x.lineTo(582, 292); x.stroke();
  return { canvas: c, pts: { p1: { x: 240 / 800, y: 140 / 720 }, p2: { x: 560 / 800, y: 140 / 720 }, p3: { x: 400 / 800, y: 614 / 720 } } };
}

/* Background removal: flood-fill from the border for pixels close to the border colour */
function cutout(c, tol) {
  const w = c.width, h = c.height, x = c.getContext("2d", { willReadFrequently: true });
  const d = x.getImageData(0, 0, w, h), p = d.data;
  let r = 0, g = 0, b = 0, n = 0;
  const addPx = (i) => { r += p[i * 4]; g += p[i * 4 + 1]; b += p[i * 4 + 2]; n++; };
  for (let xx = 0; xx < w; xx += 4) { addPx(xx); addPx((h - 1) * w + xx); }
  for (let yy = 0; yy < h; yy += 4) { addPx(yy * w); addPx(yy * w + w - 1); }
  r /= n; g /= n; b /= n;
  const t2 = tol * tol;
  const close = (i) => { const dr = p[i * 4] - r, dg = p[i * 4 + 1] - g, db = p[i * 4 + 2] - b; return dr * dr + dg * dg + db * db < t2; };
  const seen = new Uint8Array(w * h), st = new Int32Array(w * h); let sp = 0;
  const seed = (i) => { if (!seen[i] && close(i)) { seen[i] = 1; st[sp++] = i; } };
  for (let xx = 0; xx < w; xx++) { seed(xx); seed((h - 1) * w + xx); }
  for (let yy = 0; yy < h; yy++) { seed(yy * w); seed(yy * w + w - 1); }
  while (sp) {
    const i = st[--sp]; p[i * 4 + 3] = 0;
    const xx = i % w;
    if (xx > 0) seed(i - 1);
    if (xx < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  for (let i = w; i < w * (h - 1); i++) {
    if (p[i * 4 + 3] === 255 && (p[(i - 1) * 4 + 3] === 0 || p[(i + 1) * 4 + 3] === 0 || p[(i - w) * 4 + 3] === 0 || p[(i + w) * 4 + 3] === 0)) p[i * 4 + 3] = 150;
  }
  x.putImageData(d, 0, 0);
}

/* ---------------- body + garment caches ---------------- */
let BODY = null, GAR = null;
const hasPhoto = () => !!(S.profile.photo && S.profile.consent);
function bodyKey() {
  const P = S.profile;
  if (hasPhoto()) return "photo:" + hash(P.photo);
  return "m:" + [P.height, P.chest, P.waist, P.hips, P.shoulder, P.inseam].join(",");
}
async function ensureBody() {
  const key = bodyKey();
  if (BODY && BODY.key === key) { if (!BODY.mannequin) BODY.pts = S.profile.pts || BODY.pts; return; }
  const P = S.profile;
  if (hasPhoto()) {
    const img = await loadImg(P.photo);
    if (!P.pts) P.pts = defaultBodyPts();
    BODY = { key, img, w: img.naturalWidth, h: img.naturalHeight, pts: P.pts, mannequin: false };
  } else {
    const m = makeMannequin(P);
    BODY = { key, img: m.canvas, w: m.canvas.width, h: m.canvas.height, pts: m.pts, mannequin: true };
  }
  geoCache.clear();
}
function defaultBodyPts() {
  return { head: { x: 0.5, y: 0.04 }, feet: { x: 0.5, y: 0.97 }, shL: { x: 0.37, y: 0.2 }, shR: { x: 0.63, y: 0.2 }, wL: { x: 0.42, y: 0.48 }, wR: { x: 0.58, y: 0.48 } };
}
function garKey(item) { return item.id + ":" + (item.image ? hash(item.image) : "sample") + ":" + item.removeBg + ":" + item.tol; }
async function ensureGarment() {
  const item = curItem();
  if (!item.image && !item.example) { GAR = null; return; }
  const key = garKey(item);
  if (GAR && GAR.key === key) { GAR.pts = item.gpts || GAR.pts; return; }
  let src, preset = null;
  if (item.image) src = await loadImg(item.image);
  else { const t = makeSampleTee(); src = t.canvas; preset = t.pts; }
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(src, 0, 0);
  if (item.removeBg) cutout(c, item.tol);
  const alpha = new Uint8Array(w * h);
  const d = x.getImageData(0, 0, w, h).data;
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3]; alpha[i] = a;
    if (a > 40) { const xx = i % w, yy = (i / w) | 0; if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy; }
  }
  if (bx1 <= bx0) { bx0 = 0; by0 = 0; bx1 = w - 1; by1 = h - 1; }
  const bbox = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  if (!item.gpts) item.gpts = preset || defaultGarmentPts(item.category, bbox, w, h);
  GAR = { key, cut: c, w, h, alpha, bbox, pts: item.gpts };
  geoCache.clear();
}
function defaultGarmentPts(cat, b, w, h) {
  const P = (fx, fy) => ({ x: (b.x + fx * b.w) / w, y: (b.y + fy * b.h) / h });
  if (cat === "bottom") return { p1: P(0.08, 0.01), p2: P(0.92, 0.01), p3: P(0.25, 1) };
  return { p1: P(0.3, 0.05), p2: P(0.7, 0.05), p3: P(0.5, 1) };
}
function measureRun(y, cx) {
  const G = GAR; y = Math.round(y); cx = Math.round(cx);
  if (y < 0 || y >= G.h) return null;
  const at = (xx) => G.alpha[y * G.w + xx] > 60;
  let c = cx;
  if (!at(c)) { let f = -1; for (let dx = 1; dx < 30; dx++) { if (c + dx < G.w && at(c + dx)) { f = c + dx; break; } if (c - dx >= 0 && at(c - dx)) { f = c - dx; break; } } if (f < 0) return null; c = f; }
  let l = c, r = c;
  while (l > 0 && at(l - 1)) l--;
  while (r < G.w - 1 && at(r + 1)) r++;
  return r - l + 1;
}

/* AI render bookkeeping: a render belongs to one photo + one product photo */
const renderKey = (item) => bodyKey() + "|" + (item.image ? hash(item.image) : "none");
function currentRender(item) { return item.render && item.render.key === renderKey(item) ? item.render : null; }
let RENDER = null; // {key, img, w, h, pts}
async function ensureRender() {
  const r = currentRender(curItem());
  if (!r) { RENDER = null; return; }
  if (RENDER && RENDER.key === r.key && RENDER.src === r.img) return;
  const img = await loadImg(r.img);
  RENDER = { key: r.key, src: r.img, img, w: img.naturalWidth, h: img.naturalHeight, pts: r.pts };
  geoCache.clear();
}

/* ---------------- garment geometry ---------------- */
const geoCache = new Map();
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function visibleWidth(gC, bC, stretch) {
  if (!gC) return null;
  if (!bC) return gC * 0.34;
  const eff = gC >= bC ? gC : gC + (bC - gC) * GIVE[stretch];
  return eff * 0.34;
}
const ZONE_BANDS = {
  top: [["shoulder", -2, 0.12], ["chest", 0.12, 0.5], ["waist", 0.5, 0.85], ["length", 0.85, 1.3]],
  outerwear: [["shoulder", -2, 0.12], ["chest", 0.12, 0.5], ["waist", 0.5, 0.85], ["length", 0.85, 1.3]],
  dress: [["shoulder", -2, 0.08], ["chest", 0.08, 0.32], ["waist", 0.32, 0.5], ["hips", 0.5, 0.75], ["length", 0.75, 1.3]],
  bottom: [["waist", -2, 0.08], ["hips", 0.08, 0.3], ["inseam", 0.82, 1.3]],
};
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

// mode: "garment" (product photo at measured size), "tint" (product photo tinted by fit), "bands" (fit colours only)
function geometry(size, mode, base) {
  const key = size.label + "|" + mode + "|" + base.key;
  if (geoCache.has(key)) return geoCache.get(key);
  const g = buildGeometry(size, mode, base);
  geoCache.set(key, g);
  return g;
}
function buildGeometry(size, mode, B) {
  const item = curItem(), P = S.profile, G = GAR;
  if (!G || !B) return null;
  const bp = (k) => ({ x: B.pts[k].x * B.w, y: B.pts[k].y * B.h });
  const gp = (k) => ({ x: G.pts[k].x * G.w, y: G.pts[k].y * G.h });
  const H = P.height || 170;
  const ppc = (bp("feet").y - bp("head").y) / H;
  if (!(ppc > 0)) return null;
  const cat = item.category, bottom = cat === "bottom";
  const A1 = bp(bottom ? "wL" : "shL"), A2 = bp(bottom ? "wR" : "shR");
  const g1 = gp("p1"), g2 = gp("p2"), g3 = gp("p3");
  const gMid = mid(g1, g2), bMid = mid(A1, A2), gSpan = dist(g1, g2), gLen = g3.y - gMid.y;
  if (gSpan < 5 || gLen < 10) return null;
  const theta = Math.atan2(A2.y - A1.y, A2.x - A1.x) - Math.atan2(g2.y - g1.y, g2.x - g1.x);
  const V = (z) => { const p = parseVal(size[z], item.unit); return p ? p.mid : null; };
  const C = (z) => {
    const r = garmentCirc(item, size, z);
    if (!r) return null;
    if (item.chartType === "body") { const T = TARGET[cat] && TARGET[cat][z]; return r.mid + (T ? (T[0] + T[1]) / 2 + STYLE_SHIFT[item.fitStyle] * shiftFactor(cat, z) : 6); }
    return r.mid;
  };
  let sy, knots = [];
  const add = (frac, gc, bc, spanPx) => {
    const y = gMid.y + frac * gLen;
    const r = spanPx || measureRun(y, gMid.x);
    const vis = visibleWidth(gc, bc, item.stretch);
    if (r && vis) knots.push([y, (vis * ppc) / r]);
  };
  if (!bottom) {
    const chestC = C("chest");
    let shoulderCm = V("shoulder");
    if (!shoulderCm) shoulderCm = chestC ? (chestC / 2) * 0.87 : P.shoulder || H * 0.259;
    const lengthCm = V("length") || P.ref.topLength || H * (cat === "outerwear" ? 0.43 : cat === "dress" ? 0.55 : 0.405);
    const sxS = (shoulderCm * ppc) / gSpan;
    sy = (Math.max(lengthCm - 3, 10) * ppc) / gLen;
    knots.push([gMid.y + 0.06 * gLen, sxS]);
    if (cat === "dress") { add(0.25, chestC, P.chest); add(0.42, C("waist"), P.waist); add(0.63, C("hips"), P.hips); }
    else { add(0.33, chestC, P.chest); const wc = C("waist"); if (wc) add(0.9, wc, P.waist); }
  } else {
    const inseam = V("inseam") || P.ref.botInseam || P.inseam || H * 0.45;
    const rise = V("rise") || P.ref.botRise || 27;
    sy = ((inseam + rise) * ppc) / gLen;
    const wc = C("waist"), hc = C("hips");
    if (wc) add(0, wc, P.waist, gSpan);
    if (hc) add(0.2, hc, P.hips);
    if (!knots.length) knots.push([gMid.y, sy]);
  }
  knots.sort((a, b) => a[0] - b[0]);
  const sxAt = (y) => {
    if (y <= knots[0][0]) return knots[0][1];
    for (let i = 1; i < knots.length; i++) if (y <= knots[i][0]) { const [y0, s0] = knots[i - 1], [y1, s1] = knots[i]; return s0 + ((s1 - s0) * (y - y0)) / (y1 - y0); }
    return knots[knots.length - 1][1];
  };
  const maxSx = Math.max(...knots.map((k) => k[1]));
  const offW = Math.ceil(2 * Math.max(gMid.x, G.w - gMid.x) * maxSx) + 4;
  const offH = Math.ceil(G.h * sy) + 4;
  if (offW > 6000 || offH > 6000) return null;
  const off = document.createElement("canvas"); off.width = offW; off.height = offH;
  const ox = off.getContext("2d");
  const y0 = Math.max(0, G.bbox.y - 2), y1 = Math.min(G.h, G.bbox.y + G.bbox.h + 2);
  for (let y = y0; y < y1; y += 2) {
    const s = sxAt(y + 1);
    ox.drawImage(G.cut, 0, y, G.w, 2, offW / 2 - gMid.x * s, y * sy, G.w * s, 2 * sy + 0.6);
  }
  if (mode !== "garment") {
    const fr = fitSize(item, size, P);
    const col = { ok: cssVar("--ok") || "#2a7549", warn: cssVar("--warn") || "#8f5e00", bad: cssVar("--bad") || "#ae3824" };
    if (mode === "bands") {
      // Keep only the garment's outline (as solid white) so the colours can sit over the AI photo.
      ox.globalCompositeOperation = "source-in";
      ox.fillStyle = "#ffffff"; ox.fillRect(0, 0, offW, offH);
    }
    for (const [z, f0, f1] of ZONE_BANDS[cat]) {
      const r = fr.rows.find((q) => q.z === z);
      const cls = r ? sevClass(r.sev, r.st) : "";
      const ya = Math.max(0, (gMid.y + f0 * gLen) * sy), yb = Math.min(offH, (gMid.y + f1 * gLen) * sy);
      if (yb <= ya) continue;
      if (cls) {
        ox.globalCompositeOperation = "source-atop"; ox.globalAlpha = mode === "bands" ? 1 : 0.55; ox.fillStyle = col[cls];
        ox.fillRect(0, ya, offW, yb - ya);
      } else if (mode === "bands") {
        ox.globalCompositeOperation = "destination-out"; ox.globalAlpha = 0.85; ox.fillStyle = "#000";
        ox.fillRect(0, ya, offW, yb - ya);
      }
    }
    if (mode === "bands") {
      // anything outside the zone bands (e.g. below the hem line) fades too
      const first = ZONE_BANDS[cat][0], last = ZONE_BANDS[cat][ZONE_BANDS[cat].length - 1];
      ox.globalCompositeOperation = "destination-out"; ox.globalAlpha = 0.85; ox.fillStyle = "#000";
      const top = Math.max(0, (gMid.y + first[1] * gLen) * sy), bot = Math.min(offH, (gMid.y + last[2] * gLen) * sy);
      if (top > 0) ox.fillRect(0, 0, offW, top);
      if (bot < offH) ox.fillRect(0, bot, offW, offH - bot);
    }
    ox.globalAlpha = 1; ox.globalCompositeOperation = "source-over";
  }
  return { off, ax: offW / 2, ay: gMid.y * sy, bMid, theta };
}

function paint(canvas, size, view, maxW, maxH) {
  // "fit-measured": the fit colours on the measured body, used by the size thumbnails
  const measuredOnly = view === "fit-measured";
  if (measuredOnly) view = "fit";
  const useRender = !measuredOnly && (view === "ai" || view === "fit") && RENDER;
  const base = useRender ? RENDER : BODY;
  if (!base) return;
  const sc = Math.min(maxW / base.w, maxH / base.h);
  const w = Math.max(1, Math.round(base.w * sc)), h = Math.max(1, Math.round(base.h * sc));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
  ctx.drawImage(base.img, 0, 0, base.w, base.h);
  if (!GAR || !size || view === "ai") return;
  const mode = view === "fit" ? (useRender ? "bands" : "tint") : "garment";
  const geo = geometry(size, mode, base);
  if (!geo) return;
  ctx.save();
  ctx.translate(geo.bMid.x, geo.bMid.y);
  ctx.rotate(geo.theta);
  ctx.globalAlpha = (mode === "bands" ? 0.5 : 1) * (S.opacity / 100);
  if (mode !== "bands") { ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 10 * dpr; ctx.shadowOffsetY = 3 * dpr; }
  ctx.drawImage(geo.off, -geo.ax, -geo.ay);
  ctx.restore();
}

/* ---------------- try-on rendering ---------------- */
function effectiveView() {
  if (S.view === "ai" && !RENDER) return "garment";
  return S.view;
}
function renderTryon() {
  const item = curItem(), P = S.profile;
  const A = analyze(item, P);
  const labels = A.fits.map((f) => f.label);
  if (!labels.includes(S.sel)) S.sel = A.rec ? A.rec.label : labels[0] || null;
  const selFit = A.fits.find((f) => f.label === S.sel) || null;
  const view = effectiveView();

  const ex = [];
  if (P.example) ex.push("an example person built from sample measurements");
  if (item.example) ex.push("an example tee");
  const note = $("#ex-note");
  note.hidden = !ex.length;
  if (ex.length) {
    note.textContent = "";
    note.append(el("b", null, "Example: "), `you're seeing ${ex.join(" and ")}. Add your measurements and photo under You, and bring in a product under The rack.`);
  }
  $("#t-title").textContent = selFit ? `${item.name || "Item"}, size ${selFit.label}` : item.name || "Item";

  // try-on button
  const tb = $("#btn-tryon");
  const staleRender = item.render && !currentRender(item);
  let why = "";
  if (!CONFIG.tryon) why = "AI try-on isn't set up on this server yet.";
  else if (!hasPhoto()) why = "Add a full-body photo of yourself under You to try things on.";
  else if (!item.image) why = "Bring in the product photo under The rack first.";
  if (!tryonBusy) {
    tb.disabled = !!why;
    tb.textContent = RENDER ? "Try it on again" : "Try it on";
    if (why) setStatus("#tryon-status", why);
    else if (staleRender) setStatus("#tryon-status", "Your photo or the product photo changed since the last try-on. Try it on again to update.");
    else if (!RENDER) setStatus("#tryon-status", "Takes about 15 seconds.");
    else setStatus("#tryon-status", "");
  }

  // verdict
  const v = $("#verdict"); v.textContent = ""; v.className = "verdict";
  const confText = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" }[A.conf];
  const pill = el("span", "pill " + (A.conf === "high" ? "ok" : A.conf === "medium" ? "warn" : "bad"), confText);
  if (!A.rec) {
    v.append(pill, el("div", "big", "Add the size chart"), el("p", null, "Bring the product in from a store link under The rack, or type the sizes in, to get a size."));
  } else if (A.conf === "low") {
    v.classList.add("bad");
    v.append(pill, el("div", "big", "Not enough information to pick a size"));
    const ul = el("ul", "plain"); for (const m of A.missing) ul.append(el("li", null, m));
    v.append(el("p", null, "Still needed:"), ul, el("p", "fine", `Leaning ${A.rec.label} from what's there.`));
  } else if (A.rec.verdict === "no") {
    v.classList.add("bad");
    v.append(pill, el("div", "big", "None of these sizes will fit"), el("p", null, `Closest is ${A.rec.label}: ${A.rec.worst ? A.rec.worst.text : ""}`));
  } else {
    v.classList.add(A.rec.verdict === "yes" ? "ok" : "warn");
    v.append(pill, el("div", "big", A.conf === "high" ? `Buy ${A.rec.label}` : `${A.rec.label} is your best bet`));
    v.append(el("p", null, A.rec.verdict === "yes" ? "It fits everywhere we can measure." : `It fits, with one thing to know: ${A.rec.worst.text}`));
    if (A.conf === "medium") v.append(el("p", "fine", item.chartType === "body" ? "The chart gives body sizes, not garment measurements, so this is less exact. Measuring a favorite top or pants under You helps." : "Add more measurements, or a favorite top or pants under You, to raise confidence."));
  }

  $("#r-title").textContent = selFit ? `Size ${selFit.label} on you` : "Size on you";
  const zl = $("#zones"); zl.textContent = "";
  if (selFit) {
    if (!selFit.rows.length) zl.append(el("li", null, "No measurements for this size yet."));
    for (const r of selFit.rows) {
      const li = el("li"); const z = el("div", "z");
      z.append(el("span", null, ZLABEL[r.z]), el("span", "pill " + sevClass(r.sev, r.st), r.label));
      li.append(z, el("div", "t", r.text)); zl.append(li);
    }
  }
  const ol = $("#others"); ol.textContent = "";
  for (const f of A.fits) {
    if (selFit && f.label === selFit.label) continue;
    const li = el("li"); const [vt, vc] = VERDICT[f.verdict];
    li.append(el("span", "dot " + vc), el("span", "sz", f.label), el("span", null, f.worst ? `${vt}. ${f.worst.text}` : `${vt} everywhere we can measure.`));
    ol.append(li);
  }
  if (!ol.children.length) ol.append(el("li", "fine", "No other sizes."));

  const notes = [...(item.notes || [])];
  if (item.modelNote) notes.unshift(item.modelNote + (P.height ? ` You're ${fmt(P.height)}.` : ""));
  if (+item.runs) notes.push(`Runs ${+item.runs < 0 ? "small" : "large"}. Sizes are adjusted for this.`);
  if (item.fabric) notes.push("Fabric: " + item.fabric);
  $("#page-notes-card").hidden = !notes.length;
  const pn = $("#page-notes"); pn.textContent = "";
  for (const n of notes) pn.append(el("li", null, n));

  const buy = $("#buy");
  if (item.url && /^https?:\/\//i.test(item.url)) {
    buy.hidden = false; buy.href = item.url;
    buy.textContent = A.rec && A.rec.verdict !== "no" && A.conf !== "low" ? `Open the store and choose size ${A.rec.label}` : "Open the store";
  } else buy.hidden = true;

  document.querySelectorAll("[data-view]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
    if (b.dataset.view === "ai") b.disabled = !RENDER;
  });
  $("#legend").hidden = view !== "fit";
  $("#opacity").value = S.opacity;
  $("#view-note").textContent =
    view === "ai" ? "This is an AI photo of you wearing the item. It shows the style, color and drape. It draws every size the same, so use the fit map and the report for size."
    : view === "fit" ? (RENDER ? "Colors over the AI photo show where the selected size is tight, right or loose, from the measurements." : "The product drawn at the selected size's measurements, colored by fit.")
    : "The product photo drawn at the selected size's real measurements on your body, scaled from your height.";

  const box = $(".stage-box");
  const maxW = Math.max(200, box.clientWidth || 400);
  const maxH = Math.min(820, Math.max(380, window.innerHeight * 0.78));
  paint($("#stage"), selFit ? selFit.size : null, view, maxW, maxH);
  const strip = $("#size-strip"); strip.textContent = "";
  const stripView = view === "fit" ? "fit" : "garment";
  for (const f of A.fits) {
    const b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", String(!!selFit && f.label === selFit.label));
    b.setAttribute("aria-label", `Size ${f.label}: ${VERDICT[f.verdict][0]}`);
    const c = el("canvas"); b.append(c);
    const l = el("span", "lbl"); l.append(el("i", "dot " + VERDICT[f.verdict][1]), el("span", null, f.label)); b.append(l);
    b.addEventListener("click", () => { S.sel = f.label; save(); renderTryon(); });
    strip.append(b);
    paint(c, f.size, stripView === "fit" ? "fit-measured" : "garment", 96, 150);
  }
  renderAdvice();
}
/* ---------------- AI try-on ---------------- */
const TRYON_W = 864, TRYON_H = 1296;
function personCrop() {
  // Frame the body at the try-on model's 2:3 output so our body points map straight onto the result.
  const B = BODY;
  const bp = (k) => ({ x: B.pts[k].x * B.w, y: B.pts[k].y * B.h });
  const head = bp("head"), feet = bp("feet"), cx = (bp("shL").x + bp("shR").x) / 2;
  const bodyH = Math.max(50, feet.y - head.y);
  const h = bodyH * 1.12, w = (h * TRYON_W) / TRYON_H;
  if (w < B.w * 0.6 && h < B.h) { /* keep */ }
  const sx = cx - w / 2, sy = head.y - (h - bodyH) / 2;
  const scale = TRYON_W / w;
  const c = document.createElement("canvas"); c.width = TRYON_W; c.height = TRYON_H;
  const x = c.getContext("2d");
  // fill any area outside the photo with its average edge colour
  const t = document.createElement("canvas"); t.width = 8; t.height = 8;
  const tx = t.getContext("2d", { willReadFrequently: true }); tx.drawImage(B.img, 0, 0, 8, 8);
  const d = tx.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < 64; i++) { const xx = i % 8, yy = (i / 8) | 0; if (xx === 0 || yy === 0 || xx === 7 || yy === 7) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; } }
  x.fillStyle = `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})`; x.fillRect(0, 0, TRYON_W, TRYON_H);
  x.drawImage(B.img, -sx * scale, -sy * scale, B.w * scale, B.h * scale);
  const pts = {};
  for (const k in B.pts) pts[k] = { x: ((B.pts[k].x * B.w - sx) * scale) / TRYON_W, y: ((B.pts[k].y * B.h - sy) * scale) / TRYON_H };
  return { dataUrl: c.toDataURL("image/jpeg", 0.92), pts };
}
let tryonBusy = false;
$("#btn-tryon").addEventListener("click", async () => {
  const item = curItem();
  if (tryonBusy || !hasPhoto() || !item.image) return;
  tryonBusy = true;
  const btn = $("#btn-tryon"); btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => setStatus("#tryon-status", `Dressing you… ${Math.round((Date.now() - t0) / 1000)} s`, false, true), 1000);
  setStatus("#tryon-status", "Dressing you…", false, true);
  try {
    await ensureBody();
    const crop = personCrop();
    const key = renderKey(item);
    const { id } = await api("/api/tryon", { person: crop.dataUrl, garment: item.image, category: item.category });
    let out = null;
    while (Date.now() - t0 < 180000) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = await api("/api/tryon/" + encodeURIComponent(id));
      if (st.status === "completed") { out = st.output && st.output[0]; break; }
      if (st.status === "failed") throw new Error(st.error || "The try-on didn't work for this photo.");
    }
    if (!out) throw new Error("The try-on took too long. Try again.");
    const img = await srcToDataURL(out, 1296, null, 0.9);
    item.render = { key, img, pts: crop.pts, at: Date.now() };
    item.advice = null;
    S.view = "ai";
    save(); await ensureRender(); geoCache.clear();
    setStatus("#tryon-status", "");
  } catch (e) {
    setStatus("#tryon-status", e.message, true);
  } finally {
    clearInterval(tick); tryonBusy = false; btn.disabled = false;
    renderTryon();
  }
});

/* ---------------- point editors ---------------- */
class PointEditor {
  constructor(canvas, cfg) {
    this.c = canvas; this.cfg = cfg; this.drag = null;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
  }
  layout() {
    const src = this.cfg.image();
    if (!src) { this.c.hidden = true; return null; }
    this.c.hidden = false;
    const maxW = Math.max(200, this.c.parentElement.clientWidth - 2);
    const sc = Math.min(maxW / src.w, 540 / src.h);
    this.src = src;
    return { w: Math.round(src.w * sc), h: Math.round(src.h * sc) };
  }
  draw() {
    const L = this.layout(); if (!L) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.c.width = L.w * dpr; this.c.height = L.h * dpr; this.c.style.width = L.w + "px"; this.c.style.height = L.h + "px";
    const x = this.c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.cfg.checker) {
      const s = 12, c1 = cssVar("--check1"), c2 = cssVar("--check2");
      for (let yy = 0; yy < L.h; yy += s) for (let xx = 0; xx < L.w; xx += s) { x.fillStyle = ((xx + yy) / s) % 2 ? c1 : c2; x.fillRect(xx, yy, s, s); }
    }
    x.drawImage(this.src.img, 0, 0, L.w, L.h);
    const pts = this.cfg.get(); if (!pts) return;
    const P = (k) => ({ x: pts[k].x * L.w, y: pts[k].y * L.h });
    const accent = cssVar("--tape") || "#ddaa2e";
    x.lineWidth = 2; x.strokeStyle = accent; x.setLineDash([6, 5]);
    for (const [a, b] of this.cfg.lines) { const A = P(a), B2 = P(b); x.beginPath(); x.moveTo(A.x, A.y); x.lineTo(B2.x, B2.y); x.stroke(); }
    x.setLineDash([]);
    x.font = "600 12px " + getComputedStyle(document.body).fontFamily;
    for (const k of this.cfg.keys) {
      const p = P(k.k);
      x.beginPath(); x.arc(p.x, p.y, 8, 0, Math.PI * 2); x.fillStyle = accent; x.fill(); x.lineWidth = 2; x.strokeStyle = "#1b1b1b"; x.stroke();
      const tw = x.measureText(k.label).width + 10, left = p.x + 12 + tw > L.w ? p.x - 12 - tw : p.x + 12;
      x.fillStyle = "rgba(20,24,22,.78)"; x.fillRect(left, p.y - 9, tw, 18);
      x.fillStyle = "#fff"; x.fillText(k.label, left + 5, p.y + 4);
    }
  }
  pos(e) { const r = this.c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; }
  down(e) {
    if (this.cfg.locked && this.cfg.locked()) return;
    const pts = this.cfg.get(); if (!pts) return;
    const p = this.pos(e); let best = null, bd = 30;
    for (const k of this.cfg.keys) { const d = Math.hypot((pts[k.k].x - p.x) * p.r.width, (pts[k.k].y - p.y) * p.r.height); if (d < bd) { bd = d; best = k.k; } }
    if (best) { this.drag = best; this.c.setPointerCapture(e.pointerId); e.preventDefault(); }
  }
  move(e) {
    if (!this.drag) return;
    const p = this.pos(e); const pts = this.cfg.get();
    pts[this.drag] = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
    this.draw();
  }
  up() { if (!this.drag) return; this.drag = null; this.cfg.commit(); }
}

const bodyEditor = new PointEditor($("#body-editor"), {
  keys: [{ k: "head", label: "Top of head" }, { k: "feet", label: "Feet" }, { k: "shL", label: "Shoulder" }, { k: "shR", label: "Shoulder" }, { k: "wL", label: "Waist" }, { k: "wR", label: "Waist" }],
  lines: [["shL", "shR"], ["wL", "wR"], ["head", "feet"]],
  image: () => (BODY ? { img: BODY.img, w: BODY.w, h: BODY.h } : null),
  get: () => (BODY ? BODY.pts : null),
  locked: () => !BODY || BODY.mannequin,
  commit: () => { S.profile.pts = BODY.pts; S.profile.example = false; save(); geoCache.clear(); },
});
const garEditor = new PointEditor($("#garment-editor"), {
  get keys() { return curItem().category === "bottom" ? [{ k: "p1", label: "Waistband" }, { k: "p2", label: "Waistband" }, { k: "p3", label: "Leg hem" }] : [{ k: "p1", label: "Shoulder seam" }, { k: "p2", label: "Shoulder seam" }, { k: "p3", label: "Hem" }]; },
  lines: [["p1", "p2"]],
  checker: true,
  image: () => (GAR ? { img: GAR.cut, w: GAR.w, h: GAR.h } : null),
  get: () => (GAR ? GAR.pts : null),
  commit: () => { curItem().gpts = GAR.pts; save(); geoCache.clear(); },
});

/* ---------------- forms: You ---------------- */
const BODY_FIELDS = [["height", "Height"], ["chest", "Chest"], ["waist", "Waist (where pants sit)"], ["hips", "Hips"], ["shoulder", "Shoulder width"], ["inseam", "Inseam"], ["arm", "Arm length"]];
const REF_TOP = [["topChest", "Pit to pit"], ["topLength", "Length, shoulder to hem"], ["topShoulder", "Shoulder seam to seam"]];
const REF_BOTTOM = [["botWaist", "Waistband, flat"], ["botInseam", "Inseam"], ["botRise", "Front rise"]];
function numField(container, key, label, getObj) {
  const id = "f-" + key;
  const lab = el("label"); lab.htmlFor = id;
  const t = el("span"); t.append(label + " ", el("span", "u", S.unit));
  const inp = el("input"); inp.type = "number"; inp.id = id; inp.step = "0.5"; inp.min = "0"; inp.inputMode = "decimal";
  const v = getObj()[key]; inp.value = v == null ? "" : num(v);
  inp.addEventListener("input", () => {
    const n = parseFloat(inp.value);
    getObj()[key] = isFinite(n) && n > 0 ? toCm(n, S.unit) : null;
    S.profile.example = false; changed();
  });
  lab.append(t, inp); container.append(lab);
}
function renderYou() {
  const P = S.profile;
  const bf = $("#body-fields"); bf.textContent = "";
  for (const [k, l] of BODY_FIELDS) numField(bf, k, l, () => S.profile);
  const rt = $("#ref-top-fields"); rt.textContent = "";
  for (const [k, l] of REF_TOP) numField(rt, k, l, () => S.profile.ref);
  const rb = $("#ref-bottom-fields"); rb.textContent = "";
  for (const [k, l] of REF_BOTTOM) numField(rb, k, l, () => S.profile.ref);
  $("#pref").value = P.pref;
  $("#notes").value = P.notes || "";
  $("#consent").checked = !!P.consent;
  $("#photo-file").disabled = !P.consent;
  $("#btn-photo-clear").hidden = !P.photo;
  $("#btn-body-auto").hidden = !CONFIG.claude;
  $("#btn-body-auto").disabled = !hasPhoto();
  $("#body-help").textContent = BODY && !BODY.mannequin
    ? "Drag the points onto your body: top of head, bottom of your feet, both shoulder tips, and both sides of your waist where your pants sit. Your height sets the scale, so place them carefully."
    : "No photo yet, so this is a figure drawn from your measurements. Add a photo to try clothes on.";
  bodyEditor.draw();
}

/* ---------------- forms: Rack ---------------- */
const ITEM_FIELDS = ["name", "category", "fitStyle", "stretch", "runs", "fabric", "color", "modelNote", "chartType", "unit"];
const COL_LABEL = (item, z) => {
  if (CIRC.includes(z)) return item.chartType === "body" ? `${ZLABEL[z]} (body)` : item.flat ? `${ZLABEL[z]} (flat)` : `${ZLABEL[z]} (around)`;
  return ZLABEL[z];
};
function renderItem() {
  const item = curItem();
  const sel = $("#item-select"); sel.textContent = "";
  for (const it of S.items) { const o = el("option", null, it.name || "Untitled"); o.value = it.id; sel.append(o); }
  sel.value = item.id;
  for (const f of ITEM_FIELDS) { const e = $("#i-" + f); if (e && document.activeElement !== e) e.value = item[f] == null ? "" : String(item[f]); }
  if (document.activeElement !== $("#i-url")) $("#i-url").value = item.url || "";
  $("#i-flat").checked = !!item.flat;
  $("#i-flat").disabled = item.chartType !== "garment";
  $("#g-bg").checked = !!item.removeBg;
  $("#g-tol").value = item.tol;
  $("#g-tol").disabled = !item.removeBg;
  $("#btn-g-auto").hidden = !CONFIG.claude;
  $("#btn-g-auto").disabled = !item.image;
  $("#g-help").textContent = GAR
    ? (item.category === "bottom" ? "Drag the points to both ends of the waistband and the bottom of one leg. These are used for the measured view and fit map." : "Drag the points to both shoulder seams and the bottom of the hem. These are used for the measured view and fit map.")
    : "Bring the product in from a link, or upload its photo.";
  renderCands();
  renderChart();
  garEditor.draw();
}
function renderCands() {
  const item = curItem(), box = $("#cands");
  box.textContent = "";
  const list = item.images || [];
  box.hidden = list.length < 2;
  list.forEach((src) => {
    const b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", String(item.imageUrl === src));
    b.setAttribute("aria-label", "Use this product photo");
    const img = el("img"); img.src = src; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    b.append(img);
    b.addEventListener("click", () => pickImage(src));
    box.append(b);
  });
}
async function pickImage(src) {
  const item = curItem();
  setStatus("#link-status", "Getting the photo…", false, true);
  try {
    const { dataUrl } = await api("/api/image", { url: src });
    item.image = await srcToDataURL(dataUrl, 1200, "#ffffff");
    item.imageUrl = src; item.gpts = null; GAR = null; item.render = null;
    save(); await ensureGarment(); renderItem();
    setStatus("#link-status", "Photo added. Check the points on it below.");
  } catch (e) { setStatus("#link-status", e.message, true); }
}
function renderChart() {
  const item = curItem(), cols = COLS[item.category];
  const t = $("#chart"); t.textContent = "";
  const thead = el("thead"), hr = el("tr");
  hr.append(el("th", null, "Size"));
  for (const z of cols) hr.append(el("th", null, COL_LABEL(item, z)));
  hr.append(el("th")); thead.append(hr); t.append(thead);
  const tb = el("tbody");
  item.sizes.forEach((s, i) => {
    const tr = el("tr");
    const mk = (key, mono) => {
      const td = el("td"); const inp = el("input"); inp.type = "text"; inp.value = s[key] || ""; inp.id = `c-${i}-${key}`;
      inp.setAttribute("aria-label", key === "label" ? `Size ${i + 1} name` : `${s.label || "Size"} ${ZLABEL[key]}`);
      if (!mono) inp.style.fontFamily = "var(--body)";
      inp.addEventListener("input", () => { s[key] = inp.value; item.example = false; changed(true); });
      td.append(inp); return td;
    };
    tr.append(mk("label", false));
    for (const z of cols) tr.append(mk(z, true));
    const td = el("td"); const x = el("button", "btn small", "×"); x.type = "button"; x.setAttribute("aria-label", `Remove size ${s.label || i + 1}`);
    x.addEventListener("click", () => { item.sizes.splice(i, 1); changed(); renderChart(); });
    td.append(x); tr.append(td); tb.append(tr);
  });
  t.append(tb);
  if (!item.sizes.length) { const tr = el("tr"); const td = el("td", "fine", "No sizes yet."); td.colSpan = cols.length + 2; tr.append(td); tb.append(tr); }
}
function applyExtract(item, r) {
  const s = (v) => (v == null ? "" : String(v).slice(0, 200));
  if (r.name) item.name = s(r.name) + (r.brand && !String(r.name).includes(r.brand) ? ` (${s(r.brand)})` : "");
  if (["top", "bottom", "dress", "outerwear"].includes(r.category)) { if (item.category !== r.category) { item.gpts = null; GAR = null; } item.category = r.category; }
  if (["slim", "regular", "relaxed", "oversized", "cropped"].includes(r.fitStyle)) item.fitStyle = r.fitStyle;
  if (["none", "low", "medium", "high"].includes(r.stretch)) item.stretch = r.stretch;
  item.fabric = s(r.fabric); item.color = s(r.color);
  if (["garment", "body", "none"].includes(r.chartType)) item.chartType = r.chartType;
  item.unit = r.unit === "in" ? "in" : "cm";
  item.flat = !!r.flat;
  item.runs = [-1, 0, 1].includes(+r.runs) ? +r.runs : 0;
  item.modelNote = s(r.modelNote);
  item.notes = Array.isArray(r.notes) ? r.notes.slice(0, 5).map(s).filter(Boolean) : [];
  if (Array.isArray(r.sizes)) {
    item.sizes = r.sizes.slice(0, 20).filter((z) => z && z.label).map((z) => {
      const o = { label: s(z.label) };
      for (const k of ["chest", "waist", "hips", "shoulder", "length", "sleeve", "inseam", "rise"]) o[k] = s(z[k]);
      return o;
    });
  }
  item.example = false; item.advice = null; S.sel = null;
}

/* ---------------- change plumbing ---------------- */
let rT = null;
function changed(skipItemForm) {
  save(); geoCache.clear();
  clearTimeout(rT);
  rT = setTimeout(async () => {
    await ensureAll();
    if (S.tab === "tryon") renderTryon();
    if (S.tab === "you") bodyEditor.draw();
    if (S.tab === "item" && !skipItemForm) garEditor.draw();
  }, 150);
}
async function ensureAll() { await ensureBody(); await ensureGarment(); await ensureRender(); }
async function show(tab) {
  S.tab = tab; save();
  for (const t of ["you", "item", "tryon"]) {
    $("#tab-" + t).hidden = t !== tab;
    $("#tab-btn-" + t).setAttribute("aria-selected", String(t === tab));
  }
  try { await ensureAll(); } catch (e) { toast("An image couldn't be loaded."); }
  if (tab === "tryon") renderTryon();
  if (tab === "you") renderYou();
  if (tab === "item") renderItem();
}
function renderUnits() {
  $("#u-cm").setAttribute("aria-pressed", String(S.unit === "cm"));
  $("#u-in").setAttribute("aria-pressed", String(S.unit === "in"));
}

/* ---------------- events ---------------- */
document.querySelectorAll("nav.steps button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
const setUnit = (u) => { S.unit = u; F.setUnit(u); renderUnits(); save(); show(S.tab); };
$("#u-cm").addEventListener("click", () => setUnit("cm"));
$("#u-in").addEventListener("click", () => setUnit("in"));
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.view; save(); renderTryon(); }));
$("#opacity").addEventListener("input", (e) => { S.opacity = +e.target.value; save(); renderTryon(); });
$("#pref").addEventListener("change", (e) => { S.profile.pref = e.target.value; S.profile.example = false; changed(); });
$("#notes").addEventListener("input", (e) => { S.profile.notes = e.target.value; save(); });
$("#consent").addEventListener("change", async (e) => {
  S.profile.consent = e.target.checked; save();
  await ensureBody(); renderYou();
});
$("#photo-file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    S.profile.photo = await fileToDataURL(f, 1400, "#ffffff");
    S.profile.pts = defaultBodyPts(); S.profile.example = false;
    save(); await ensureBody(); renderYou();
    if (CONFIG.claude) $("#btn-body-auto").click();
    else toast("Photo added. Drag the points onto your body.");
  } catch (err) { toast("That file couldn't be opened as an image."); }
  e.target.value = "";
});
$("#btn-photo-clear").addEventListener("click", async () => { S.profile.photo = null; S.profile.pts = null; save(); await ensureBody(); renderYou(); });

$("#item-select").addEventListener("change", async (e) => { S.cur = e.target.value; S.sel = null; GAR = null; save(); await ensureAll(); renderItem(); });
$("#btn-new-item").addEventListener("click", async () => {
  const it = blankItem(); S.items.push(it); S.cur = it.id; S.sel = null; GAR = null; save(); await ensureAll(); renderItem();
  $("#i-url").focus();
});
let delArm = null;
$("#btn-del-item").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!delArm) { b.textContent = "Tap again to remove"; delArm = setTimeout(() => { delArm = null; b.textContent = "Remove"; }, 3000); return; }
  clearTimeout(delArm); delArm = null; b.textContent = "Remove";
  S.items = S.items.filter((i) => i.id !== S.cur);
  if (!S.items.length) S.items.push(blankItem());
  S.cur = S.items[0].id; S.sel = null; GAR = null; save(); await ensureAll(); renderItem();
});
for (const f of ITEM_FIELDS) {
  const e = $("#i-" + f);
  e.addEventListener(e.tagName === "SELECT" ? "change" : "input", () => {
    const item = curItem();
    item[f] = f === "runs" ? +e.value : e.value;
    item.example = false;
    if (f === "category") { item.gpts = null; GAR = null; }
    if (f === "name") { const o = $("#item-select").selectedOptions[0]; if (o) o.textContent = e.value || "Untitled"; }
    save(); geoCache.clear();
    if (f === "category" || f === "chartType" || f === "unit") ensureGarment().then(renderItem); else changed(true);
  });
}
$("#i-url").addEventListener("input", (e) => { curItem().url = e.target.value.trim(); save(); });
$("#i-flat").addEventListener("change", (e) => { curItem().flat = e.target.checked; curItem().example = false; renderChart(); changed(true); });
$("#btn-add-size").addEventListener("click", () => {
  const item = curItem();
  item.sizes.push({ label: "", chest: "", waist: "", hips: "", shoulder: "", length: "", sleeve: "", inseam: "", rise: "" });
  renderChart(); save();
  const inp = $(`#c-${item.sizes.length - 1}-label`); if (inp) inp.focus();
});
$("#g-file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const item = curItem();
    item.image = await fileToDataURL(f, 1200, "#ffffff");
    item.imageUrl = null; item.gpts = null; item.example = false; GAR = null;
    save(); await ensureGarment(); renderItem();
  } catch (err) { toast("That file couldn't be opened as an image."); }
  e.target.value = "";
});
$("#g-bg").addEventListener("change", async (e) => { const it = curItem(); it.removeBg = e.target.checked; GAR = null; save(); await ensureGarment(); renderItem(); });
let tolT = null;
$("#g-tol").addEventListener("input", (e) => {
  const it = curItem(); it.tol = +e.target.value; save();
  clearTimeout(tolT); tolT = setTimeout(async () => { GAR = null; const keep = it.gpts; await ensureGarment(); it.gpts = keep; GAR.pts = keep; garEditor.draw(); }, 200);
});
window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => show(S.tab), 200); });

/* ---------------- Claude + store features ---------------- */
$("#link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let item = curItem();
  const url = $("#i-url").value.trim();
  if (!url) return;
  if (item.example) { item = blankItem(); S.items.push(item); S.cur = item.id; GAR = null; }
  item.url = url;
  const btn = $("#btn-link"); btn.disabled = true;
  setStatus("#link-status", "Reading the store's page…", false, true);
  try {
    const r = await api("/api/product", { url });
    applyExtract(item, r.item);
    item.url = r.url || url;
    item.images = Array.isArray(r.images) ? r.images.slice(0, 12) : [];
    item.render = null;
    save(); geoCache.clear();
    if (item.images.length) await pickImage(item.images[0]);
    else { await ensureGarment(); renderItem(); }
    setStatus("#link-status", `Found ${item.sizes.length} size${item.sizes.length === 1 ? "" : "s"}${item.images.length ? ` and ${item.images.length} photo${item.images.length === 1 ? "" : "s"}` : ""}. Check the details, then go to Try it on.${item.images.length > 1 ? " Pick a different photo below if a flat-lay one is available." : ""}`);
  } catch (err) {
    setStatus("#link-status", err.message, true);
    renderItem();
  } finally { btn.disabled = false; }
});

$("#btn-read").addEventListener("click", async () => {
  const text = $("#i-page").value.trim();
  if (text.length < 40) { setStatus("#read-status", "Paste the product page text first.", true); return; }
  const item = curItem();
  const btn = $("#btn-read"); btn.disabled = true; setStatus("#read-status", "Reading the page…", false, true);
  try {
    const r = await api("/api/extract", { text: text.slice(0, 60000), image: item.image || null });
    applyExtract(item, r);
    save(); geoCache.clear(); await ensureGarment(); renderItem();
    setStatus("#read-status", `Found ${item.sizes.length} size${item.sizes.length === 1 ? "" : "s"}. Check the details.`);
  } catch (e) { setStatus("#read-status", e.message, true); }
  finally { btn.disabled = false; }
});

const validPt = (o) => o && typeof o.x === "number" && typeof o.y === "number" && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1 ? { x: o.x, y: o.y } : null;
$("#btn-body-auto").addEventListener("click", async () => {
  const P = S.profile;
  if (!hasPhoto()) return;
  const b = $("#btn-body-auto"); b.disabled = true; setStatus("#body-status", "Finding your head, feet, shoulders and waist…", false, true);
  try {
    const r = await api("/api/points", { kind: "body", image: P.photo });
    const out = { ...(P.pts || defaultBodyPts()) }; let n = 0;
    for (const k of ["head", "feet", "shL", "shR", "wL", "wR"]) { const p = validPt(r && r[k]); if (p) { out[k] = p; n++; } }
    P.pts = out; if (BODY && !BODY.mannequin) BODY.pts = out;
    save(); geoCache.clear(); bodyEditor.draw();
    setStatus("#body-status", n ? "Placed. Check each point and drag any that are off." : "The points couldn't be found. Drag them by hand.", !n);
  } catch (e) { setStatus("#body-status", e.message, true); }
  finally { b.disabled = false; }
});
$("#btn-g-auto").addEventListener("click", async () => {
  const item = curItem();
  if (!item.image) return;
  const b = $("#btn-g-auto"); b.disabled = true; setStatus("#g-status", "Finding the seams and hem…", false, true);
  try {
    const r = await api("/api/points", { kind: "garment", category: item.category, image: item.image });
    const out = { ...(item.gpts || {}) }; let n = 0;
    for (const k of ["p1", "p2", "p3"]) { const p = validPt(r && r[k]); if (p) { out[k] = p; n++; } }
    if (out.p1 && out.p2 && out.p3) { item.gpts = out; if (GAR) GAR.pts = out; }
    save(); geoCache.clear(); garEditor.draw();
    setStatus("#g-status", n ? "Placed. Check the points and drag any that are off." : "The points couldn't be found. Drag them by hand.", !n);
  } catch (e) { setStatus("#g-status", e.message, true); }
  finally { b.disabled = false; }
});

$("#btn-style").addEventListener("click", async () => {
  const item = curItem(), P = S.profile;
  const A = analyze(item, P);
  const b = $("#btn-style"); b.disabled = true; setStatus("#style-status", "Thinking it over…", false, true);
  const cm = (v) => (v ? Math.round(v) + " cm" : "unknown");
  const fit = A.rec ? `Recommended size ${A.rec.label} (${VERDICT[A.rec.verdict][0]}). ` + A.rec.rows.map((r) => `${ZLABEL[r.z]}: ${r.label}. ${r.text}`).join(" ") : "No size chart.";
  const render = currentRender(item);
  try {
    const r = await api("/api/advice", {
      profile: {
        measurements: `height ${cm(P.height)}, chest ${cm(P.chest)}, waist ${cm(P.waist)}, hips ${cm(P.hips)}, shoulder width ${cm(P.shoulder)}, inseam ${cm(P.inseam)}`,
        pref: P.pref, notes: P.notes || "",
      },
      item: { name: item.name, category: item.category, fitStyle: item.fitStyle, fabric: item.fabric, color: item.color, notes: (item.notes || []).join("; ") },
      fit,
      photo: render ? null : hasPhoto() ? P.photo : null,
      tryon: render ? render.img : null,
      productImage: item.image || null,
    });
    item.advice = r; save(); renderAdvice();
    setStatus("#style-status", "");
  } catch (e) { setStatus("#style-status", e.message, true); }
  finally { b.disabled = false; }
});
function renderAdvice() {
  const out = $("#style-out"); out.textContent = "";
  $("#btn-style").disabled = !CONFIG.claude;
  if (!CONFIG.claude) setStatus("#style-status", "Style advice isn't set up on this server yet.");
  const a = curItem().advice;
  if (!a) return;
  const V = { great: ["Great on you", "ok"], good: ["Good on you", "ok"], mixed: ["Mixed", "warn"], skip: ["Skip it", "bad"] }[a.verdict] || ["Advice", ""];
  out.append(el("span", "pill " + V[1], V[0]), el("p", "head", String(a.headline)));
  const list = (title, arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    out.append(el("h4", null, title)); const ul = el("ul"); for (const x of arr.slice(0, 5)) ul.append(el("li", null, String(x))); out.append(ul);
  };
  list("Why", a.why);
  if (a.color) out.append(el("h4", null, "Color"), el("p", null, String(a.color)));
  list("Wear it with", a.wearWith);
  if (a.sizeTip) out.append(el("h4", null, "Size for the look"), el("p", null, String(a.sizeTip)));
  list("Try instead", a.tryInstead);
}

/* ---------------- boot ---------------- */
renderUnits();
show(S.tab || "tryon");
(async () => {
  try { CONFIG = await (await fetch("/api/config")).json(); } catch (e) { CONFIG = { needsCode: false, tryon: false, claude: false }; }
  $("#btn-link").disabled = !CONFIG.claude;
  $("#btn-read").disabled = !CONFIG.claude;
  if (!CONFIG.claude) setStatus("#link-status", "Reading store pages isn't set up on this server yet. Fill in the details by hand.");
  if (CONFIG.needsCode) {
    if (!getCode()) showGate();
    else api("/api/check", {}).catch(() => {});
  }
  show(S.tab || "tryon");
})();
})();
