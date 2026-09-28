// Fit engine checks: node test/test_fit.mjs
import assert from "node:assert/strict";
import "../public/fit.js";
const F = globalThis.SeamlineFit;

const person = { height: 178, chest: 98, waist: 84, hips: 98, shoulder: 46, inseam: 81, arm: 60, pref: "regular",
  ref: { topChest: null, topLength: null, topShoulder: null, botWaist: null, botInseam: null, botRise: null } };
const tee = { category: "top", fitStyle: "regular", stretch: "low", runs: 0, chartType: "garment", unit: "cm", flat: true,
  sizes: [
    { label: "S", chest: "50", shoulder: "44", length: "69", sleeve: "20" },
    { label: "M", chest: "54", shoulder: "46", length: "72", sleeve: "21" },
    { label: "L", chest: "58", shoulder: "48", length: "74", sleeve: "22" },
    { label: "XXL", chest: "66", shoulder: "53", length: "79", sleeve: "24" },
  ] };
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("parses numbers, ranges and inches", () => {
  assert.deepEqual(F.parseVal("53", "cm"), { lo: 53, hi: 53, mid: 53 });
  assert.equal(F.parseVal("96–101", "cm").mid, 98.5);
  assert.equal(F.parseVal("20", "in").mid, 50.8);
  assert.equal(F.parseVal("", "cm"), null);
  assert.equal(F.parseVal("n/a", "cm"), null);
});
t("recommends the regular-fit size and rejects the extremes", () => {
  const a = F.analyze(tee, person);
  assert.equal(a.rec.label, "M");
  assert.equal(a.rec.verdict, "yes");
  assert.equal(a.fits.find((f) => f.label === "S").rows.find((r) => r.z === "chest").st, "snug");
  assert.equal(a.fits.find((f) => f.label === "XXL").verdict, "no");
});
t("a favourite top outweighs the generic ease targets", () => {
  const p = { ...person, ref: { ...person.ref, topChest: 58, topLength: 74 } };
  assert.equal(F.analyze(tee, p).rec.label, "L");
  assert.equal(F.analyze(tee, p).conf, "high");
});
t("runs small takes 2 cm off every circumference", () => {
  const small = { ...tee, runs: -1 };
  assert.equal(F.garmentCirc(small, tee.sizes[1], "chest").mid, 106);
  assert.equal(F.garmentCirc(tee, tee.sizes[1], "chest").mid, 108);
  assert.equal(F.fitSize(small, tee.sizes[0], person).rows.find((r) => r.z === "chest").st, "snug");
});
t("a body-measurement chart uses ranges", () => {
  const body = { category: "top", fitStyle: "regular", stretch: "none", runs: 0, chartType: "body", unit: "cm", flat: false,
    sizes: [{ label: "M", chest: "96-101" }, { label: "L", chest: "102-107" }] };
  const a = F.analyze(body, person);
  assert.equal(a.rec.label, "M");
  assert.equal(a.conf, "medium");
});
t("missing chest measurement means low confidence", () => {
  const a = F.analyze(tee, { ...person, chest: null });
  assert.equal(a.conf, "low");
  assert.ok(a.missing.some((m) => /chest/.test(m)));
});
t("pants: long inseam can be hemmed, short cannot", () => {
  const jeans = { category: "bottom", fitStyle: "regular", stretch: "low", runs: 0, chartType: "garment", unit: "in", flat: true,
    sizes: [{ label: "32/29", waist: "16.5", hips: "21", inseam: "29" }, { label: "32/34", waist: "16.5", hips: "21", inseam: "34" }] };
  const short = F.fitSize(jeans, jeans.sizes[0], person).rows.find((r) => r.z === "inseam");
  const long = F.fitSize(jeans, jeans.sizes[1], person).rows.find((r) => r.z === "inseam");
  assert.equal(short.st, "too-short");
  assert.equal(long.st, "long");
  assert.equal(long.sev, 1);
});
t("dress length reports where the hem lands", () => {
  const dress = { category: "dress", fitStyle: "regular", stretch: "low", runs: 0, chartType: "garment", unit: "cm", flat: false,
    sizes: [{ label: "M", chest: "104", waist: "92", hips: "106", length: "100" }] };
  const len = F.fitSize(dress, dress.sizes[0], person).rows.find((r) => r.z === "length");
  assert.equal(len.st, "info");
  assert.match(len.text, /knee/);
});
t("inch display", () => {
  F.setUnit("in"); assert.equal(F.fmt(2.54), "1 in"); F.setUnit("cm");
});
console.log(`${n} fit checks passed`);
