// Seamline fit engine: compares a size chart with a person's measurements.
// Loaded by the browser (window.SeamlineFit) and by the tests (globalThis.SeamlineFit).
(function () {
"use strict";
const state = { unit: "cm" };
const setUnit = (u) => { state.unit = u === "in" ? "in" : "cm"; };
const toCm = (v, u) => (u === "in" ? v * 2.54 : v);
const fromCm = (cm, u) => (u === "in" ? cm / 2.54 : cm);
function num(cm) { const v = fromCm(cm, state.unit); const r = Math.round(v * 2) / 2; return (Number.isInteger(r) ? String(r) : r.toFixed(1)); }
const fmt = (cm) => num(Math.abs(cm)) + " " + state.unit;
function parseVal(s, u) {
  if (s == null) return null;
  s = String(s).trim().replace(/,/g, ".");
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  let lo = +m[1], hi = m[2] ? +m[2] : lo;
  if (hi < lo) [lo, hi] = [hi, lo];
  lo = toCm(lo, u); hi = toCm(hi, u);
  return { lo, hi, mid: (lo + hi) / 2 };
}

/* ---------------- fit engine ---------------- */
const CIRC = ["chest", "waist", "hips"];
const COLS = {
  top: ["chest", "waist", "shoulder", "length", "sleeve"],
  outerwear: ["chest", "waist", "shoulder", "length", "sleeve"],
  dress: ["chest", "waist", "hips", "shoulder", "length"],
  bottom: ["waist", "hips", "inseam", "rise"],
};
const ZLABEL = { chest: "Chest", waist: "Waist", hips: "Hips", shoulder: "Shoulders", length: "Length", sleeve: "Sleeves", inseam: "Inseam", rise: "Rise" };
const STYLE_SHIFT = { slim: -4, regular: 0, relaxed: 6, oversized: 16, cropped: 0 };
const STYLE_NAME = { slim: "slim", regular: "regular", relaxed: "relaxed", oversized: "oversized", cropped: "cropped" };
const PREF_SHIFT = { fitted: -3, regular: 0, relaxed: 4 };
const STRETCH = { none: 0, low: 2, medium: 5, high: 9 };
const GIVE = { none: 0, low: 0.3, medium: 0.7, high: 1 };
// [target ease low, target ease high, minimum wearable ease, how far past "high" still counts as roomy] in cm of circumference
const TARGET = {
  top: { chest: [8, 16, 2, 10], waist: [8, 22, 0, 14] },
  outerwear: { chest: [12, 22, 6, 12], waist: [12, 28, 4, 16] },
  dress: { chest: [5, 12, 1, 8], waist: [4, 14, 0, 10], hips: [6, 16, 1, 10] },
  bottom: { waist: [0, 4, -1, 5], hips: [4, 10, 1, 10] },
};
const shiftFactor = (cat, z) => (cat === "bottom" ? (z === "waist" ? 0 : 0.6) : 1);
const STATUS = {
  good: ["Good", 0], info: ["Note", 0], unknown: ["Missing", 0],
  snug: ["Snug", 1], roomy: ["Roomy", 1], short: ["Short", 1], long: ["Long", 1], higher: ["Higher", 1], lower: ["Lower", 1],
  "too-tight": ["Too tight", 3], "too-loose": ["Too loose", 3], "too-short": ["Too short", 3], "too-long": ["Too long", 3],
};
const sevClass = (sev, st) => (st === "unknown" || st === "info" ? "" : sev === 0 ? "ok" : sev >= 3 ? "bad" : "warn");
function row(z, st, text, sevOverride) {
  const [label, sev] = STATUS[st];
  return { z, st, label, sev: sevOverride != null ? sevOverride : sev, text };
}

function garmentCirc(item, size, z) {
  const p = parseVal(size[z], item.unit);
  if (!p) return null;
  let r = { ...p };
  if (item.chartType === "garment" && item.flat) r = { lo: p.lo * 2, hi: p.hi * 2, mid: p.mid * 2 };
  const adj = (+item.runs || 0) * 2;
  return { lo: r.lo + adj, hi: r.hi + adj, mid: r.mid + adj };
}

function fitCirc(item, z, g, P) {
  const cat = item.category, T = TARGET[cat] && TARGET[cat][z];
  if (!T) return null;
  const b = P[z];
  const isTop = cat === "top" || cat === "outerwear";
  const refFlat = isTop && z === "chest" ? P.ref.topChest : cat === "bottom" && z === "waist" ? P.ref.botWaist : null;
  const refName = isTop ? "favorite top" : "favorite pants";
  const word = z === "hips" ? "hips" : z;
  if (b == null && !refFlat) return row(z, "unknown", `Add your ${word} measurement to check this.`);

  if (item.chartType === "body") {
    if (b == null) return row(z, "unknown", `Add your ${word} measurement to check this.`);
    let lo = g.lo, hi = g.hi;
    if (hi - lo < 0.5) { lo -= 2; hi += 2; }
    const allow = STRETCH[item.stretch] / 2;
    if (b >= lo && b <= hi) return row(z, "good", `Your ${fmt(b)} ${word} is inside this size's ${num(lo)}–${fmt(hi)} range.`);
    if (b < lo) {
      const gap = lo - b;
      return row(z, gap <= 4 ? "roomy" : "too-loose", `You're ${fmt(gap)} under this size's ${word} range, so it will sit looser than designed.`);
    }
    const over = b - hi;
    return row(z, over <= 2 + allow ? "snug" : "too-tight",
      over <= 2 + allow ? `You're ${fmt(over)} over this size's ${word} range. It will be close fitting.` : `You're ${fmt(over)} over this size's ${word} range. It will be too small.`);
  }

  const noPrefShift = cat === "bottom" && z === "waist";
  const shift = STYLE_SHIFT[item.fitStyle] * shiftFactor(cat, z) + (noPrefShift ? 0 : PREF_SHIFT[P.pref] || 0);
  const lo = T[0] + shift, hi = T[1] + shift;
  const minW = T[2] - STRETCH[item.stretch] * (noPrefShift ? 0.6 : 1);
  let st = null, text = "";
  if (b != null) {
    const ease = g.mid - b;
    const room = ease >= 0 ? `${fmt(ease)} of room around your ${word}` : `${fmt(ease)} smaller than your ${word}`;
    if (ease < minW) { st = "too-tight"; text = ease < 0 ? `${cap(room)}. It won't fit${STRETCH[item.stretch] ? ", even with the stretch" : ""}.` : `Only ${room}. Too tight to move in.`; }
    else if (ease < lo) { st = "snug"; text = `${cap(room)}. A close fit${ease < 0 ? " that relies on the fabric stretching" : ""}.`; }
    else if (ease <= hi) { st = "good"; text = `${cap(room)}, right for a ${STYLE_NAME[item.fitStyle]} cut.`; }
    else if (ease <= hi + T[3]) { st = "roomy"; text = `${cap(room)}. Looser than a ${STYLE_NAME[item.fitStyle]} cut usually is.`; }
    else { st = "too-loose"; text = `${cap(room)}. It will look baggy.`; }
  }
  if (refFlat) {
    const refC = refFlat * 2;
    const expected = STYLE_SHIFT[item.fitStyle] * shiftFactor(cat, z) + (cat === "outerwear" ? 6 : 0);
    const d = g.mid - refC - expected;
    let rs = Math.abs(d) <= 3 ? "good" : d < 0 ? (d >= -7 ? "snug" : "too-tight") : d <= 9 ? "roomy" : "too-loose";
    if (rs === "too-tight" && STRETCH[item.stretch] >= 5) rs = "snug";
    const flatDiff = (g.mid - refC) / 2;
    const refText = Math.abs(flatDiff) < 0.75 ? `Same width as your ${refName} laid flat.` : `${fmt(flatDiff)} ${flatDiff > 0 ? "wider" : "narrower"} laid flat than your ${refName}.`;
    if (st === "too-tight") return row(z, st, refText + " " + text);
    const roomNote = b != null ? (g.mid - b >= 0 ? ` ${cap(fmt(g.mid - b))} of room around your ${word}.` : ` ${cap(fmt(g.mid - b))} smaller than your ${word}, so it relies on stretch.`) : "";
    return row(z, rs, refText + roomNote);
  }
  return row(z, st, text);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function fitLin(item, z, g, P) {
  const cat = item.category, H = P.height, v = g.mid;
  if (z === "shoulder") {
    if (cat === "bottom") return null;
    const ref = P.ref.topShoulder, base = ref || P.shoulder;
    if (!base) return row(z, "unknown", "Add your shoulder width to check this.");
    const exp = ({ relaxed: 2, oversized: 7 }[item.fitStyle] || 0) + (cat === "outerwear" ? 1.5 : 0);
    const d = v - base - exp, raw = v - base;
    const st = d < -3 ? "too-tight" : d < -1.5 ? "snug" : d <= 2.5 ? "good" : d <= 6 ? "roomy" : "too-loose";
    let text;
    if (ref) text = Math.abs(raw) < 0.75 ? "Same shoulder width as your favorite top." : `${fmt(raw)} ${raw > 0 ? "wider" : "narrower"} across the shoulders than your favorite top.`;
    else if (Math.abs(raw) < 1) text = "Shoulder seams sit right at your shoulder tips.";
    else if (raw < 0) text = `Shoulder seams sit ${fmt(raw)} inside your shoulder tips${st === "too-tight" ? ", so it will pull across your back" : ""}.`;
    else text = `Shoulder seams drop ${fmt(raw)} past your shoulder tips${exp >= 5 ? ", as this dropped-shoulder cut intends" : ""}.`;
    return row(z, st, text);
  }
  if (z === "length") {
    if (cat === "bottom") return null;
    if (cat === "dress") {
      if (!H) return row(z, "unknown", "Add your height to see where the hem lands.");
      const hemFloor = H * 0.818 + 2 - v;
      const crotch = P.inseam || H * 0.45;
      if (hemFloor < 1) return row(z, "too-long", "The hem will reach the floor.");
      if (hemFloor > crotch - 3) return row(z, "too-short", `The hem lands about ${fmt(hemFloor)} above the floor, at the very top of your legs.`);
      const spots = [[H * 0.04, "at your ankles"], [H * 0.12, "at your lower calf"], [H * 0.2, "at mid-calf"], [H * 0.285, "at your knees"], [H * 0.36, "just above your knees"], [H * 0.42, "at mid-thigh"], [crotch, "high on your thighs"]];
      let place = spots[spots.length - 1][1], best = Infinity;
      for (const [h, name] of spots) { const dd = Math.abs(h - hemFloor); if (dd < best) { best = dd; place = name; } }
      return row(z, "info", `The hem lands about ${fmt(hemFloor)} above the floor, ${place}.`);
    }
    const ref = P.ref.topLength;
    const ideal = ref || (H ? H * (cat === "outerwear" ? 0.43 : 0.405) : null);
    if (!ideal) return row(z, "unknown", "Add your height to check the length.");
    const exp = { oversized: 4, cropped: -10 }[item.fitStyle] || 0;
    const d = v - ideal - exp, raw = v - ideal;
    const st = d < -6 ? "too-short" : d < -3 ? "short" : d <= 3 ? "good" : d <= 7 ? "long" : "too-long";
    const who = ref ? "your favorite top" : "a standard length for your height";
    let text = Math.abs(raw) < 1 ? `The same length as ${who}.` : `${fmt(raw)} ${raw < 0 ? "shorter" : "longer"} than ${who}.`;
    if (st === "short" || st === "too-short") text += " It may ride up when you lift your arms.";
    if (st === "too-long") text += " It will hang well past your hips.";
    return row(z, st, text);
  }
  if (z === "sleeve") {
    if (v < 40) return null;
    if (!P.arm) return row(z, "unknown", "Add your arm length to check the sleeves.");
    const d = v - P.arm;
    const st = d < -5 ? "too-short" : d < -2 ? "short" : d <= 3 ? "good" : d <= 7 ? "long" : "too-long";
    const text = Math.abs(d) < 1 ? "Sleeves end right at your wrist." : `Sleeves end ${fmt(d)} ${d < 0 ? "above" : "past"} your wrist bone.`;
    return row(z, st, text);
  }
  if (z === "inseam") {
    const ref = P.ref.botInseam, base = ref || P.inseam;
    if (!base) return row(z, "unknown", "Add your inseam to check the leg length.");
    const exp = item.fitStyle === "cropped" ? -6 : 0;
    const d = v - base - exp, raw = v - base;
    const who = ref ? "your favorite pants" : "your inseam";
    if (d > 8) return row(z, "too-long", `${fmt(raw)} longer than ${who}. It needs hemming.`, 2);
    if (d > 2) return row(z, "long", `${fmt(raw)} longer than ${who}. It will stack at the ankle, or can be hemmed.`);
    if (d >= -2) return row(z, "good", Math.abs(raw) < 1 ? `Same leg length as ${who}.` : `${fmt(raw)} ${raw < 0 ? "shorter" : "longer"} than ${who}.`);
    if (d >= -5) return row(z, "short", `${fmt(raw)} shorter than ${who}. It will end above the ankle.`);
    return row(z, "too-short", `${fmt(raw)} shorter than ${who}. It can't be let down much.`);
  }
  if (z === "rise") {
    const ref = P.ref.botRise;
    if (!ref) return null;
    const d = v - ref;
    if (Math.abs(d) <= 2) return row(z, "good", "Sits at the same height on your waist as your favorite pants.");
    return row(z, d > 0 ? "higher" : "lower", `Sits ${fmt(d)} ${d > 0 ? "higher" : "lower"} on your waist than your favorite pants.`);
  }
  return null;
}

const WEIGHT = (cat, z) => ({ chest: 3, waist: cat === "bottom" ? 3 : cat === "dress" ? 2 : 1, hips: cat === "bottom" ? 2.5 : 2, shoulder: 2, length: 1.5, sleeve: 1, inseam: 1, rise: 0.5 }[z] || 1);

function fitSize(item, size, P) {
  const rows = [];
  for (const z of COLS[item.category]) {
    let r = null;
    if (CIRC.includes(z)) { const g = garmentCirc(item, size, z); if (g) r = fitCirc(item, z, g, P); }
    else {
      const g = parseVal(size[z], item.unit);
      if (g && item.chartType !== "none") r = item.chartType === "body" && (z === "length" || z === "shoulder") ? null : fitLin(item, z, g, P);
    }
    if (r) rows.push(r);
  }
  let score = 0, maxSev = 0;
  for (const r of rows) { score += r.sev * WEIGHT(item.category, r.z); maxSev = Math.max(maxSev, r.sev); }
  const verdict = maxSev >= 3 ? "no" : maxSev >= 1 ? "caveat" : "yes";
  const worst = rows.slice().sort((a, b) => b.sev * WEIGHT(item.category, b.z) - a.sev * WEIGHT(item.category, a.z))[0];
  return { label: size.label, size, rows, score, verdict, worst: worst && worst.sev > 0 ? worst : null };
}

const PRIMARY = { top: ["chest"], outerwear: ["chest"], dress: ["chest", "waist", "hips"], bottom: ["waist", "hips"] };
function analyze(item, P) {
  const sizes = (item.sizes || []).filter((s) => s.label && s.label.trim());
  const fits = sizes.map((s) => fitSize(item, s, P));
  const missing = [];
  if (!sizes.length) missing.push("No sizes yet. Add the size chart on The rack.");
  const prim = PRIMARY[item.category];
  const chartHas = (z) => sizes.some((s) => parseVal(s[z], item.unit));
  const primInChart = prim.filter(chartHas);
  if (sizes.length && (item.chartType === "none" || !primInChart.length)) missing.push(`The size chart has no ${prim.join(" or ")} measurements.`);
  for (const z of primInChart) {
    const hasRef = (z === "chest" && item.category !== "bottom" && item.category !== "dress" && P.ref.topChest) || (z === "waist" && item.category === "bottom" && P.ref.botWaist);
    if (P[z] == null && !hasRef) missing.push(`Your ${z} measurement.`);
  }
  if (!P.height) missing.push("Your height.");
  const order = { yes: 0, caveat: 1, no: 2 };
  const ranked = fits.slice().sort((a, b) => order[a.verdict] - order[b.verdict] || a.score - b.score);
  const rec = ranked[0] || null;
  let conf = "low";
  if (!missing.length && rec) {
    const usedRef = rec.rows.some((r) => /favorite/.test(r.text));
    const known = rec.rows.filter((r) => r.st !== "unknown").length;
    conf = item.chartType === "body" ? "medium" : usedRef || known >= 3 ? "high" : "medium";
  }
  return { fits, rec, conf, missing };
}

const VERDICT = { yes: ["Fits", "ok"], caveat: ["Fits, with notes", "warn"], no: ["Won't fit", "bad"] };
globalThis.SeamlineFit = {
  setUnit, toCm, fromCm, num, fmt, parseVal, CIRC, COLS, ZLABEL, STYLE_SHIFT, STRETCH, GIVE, TARGET, shiftFactor,
  STATUS, sevClass, garmentCirc, fitCirc, fitLin, fitSize, analyze, VERDICT,
};
})();
