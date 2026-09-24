import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
for (const [name, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2 });
  const bad = []; p.on("response", r => { if (/espncdn|espn\.com/.test(r.url()) && r.status() >= 400) bad.push(r.status() + " " + r.url().slice(0, 90)); });
  p.on("requestfailed", r => { if (/espncdn/.test(r.url())) bad.push("FAILED " + r.url().slice(0, 90) + " " + r.failure()?.errorText); });
  await p.goto("https://arro2121.github.io/Baseline/", { waitUntil: "load" }); await p.waitForTimeout(2500);
  await p.screenshot({ path: `shots/${name}-home.png` });
  for (const lg of ["mlb", "nfl", "epl"]) {
    await p.click(`[data-sport="${lg}"]`); await p.waitForTimeout(400);
    await p.click('[data-tt="games"]'); await p.waitForTimeout(4000);
    const imgs = await p.$$eval("#tt-games img", xs => xs.map(x => ({ src: x.src.slice(0, 70), ok: x.complete && x.naturalWidth > 0, w: x.getBoundingClientRect().width })));
    console.log(name, lg, "card images:", imgs.length, "loaded:", imgs.filter(x => x.ok).length, JSON.stringify(imgs.slice(0, 2)));
    await p.screenshot({ path: `shots/${name}-${lg}-games.png` });
  }
  const liveBtn = await p.$('[data-nav="live"], [data-tab="live"]'); if (liveBtn) { await liveBtn.click(); await p.waitForTimeout(2500); await p.screenshot({ path: `shots/${name}-live.png` }); }
  console.log(name, "image errors:", bad.slice(0, 5).join(" | ") || "none");
  await p.close();
}
await b.close();
