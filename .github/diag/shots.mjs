import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://localhost:8000/", { waitUntil: "load" }); await p.waitForTimeout(800);
for (const lg of ["mlb", "nfl", "nhl", "epl", "nba"]) {
  await p.click(`[data-sport="${lg}"]`); await p.waitForTimeout(300);
  await p.click('[data-tt="rank"]'); await p.waitForTimeout(1200);
  if (lg === "mlb" || lg === "epl") await p.screenshot({ path: `shots/rank-${lg}.png` });
  await p.click('[data-tt="predict"]'); await p.waitForTimeout(1200);
  if (lg === "nfl") await p.screenshot({ path: `shots/predict-${lg}.png` });
  await p.click('[data-tt="games"]'); await p.waitForTimeout(4000);
  const btn = await p.$("#tt-games [data-pbp]");
  if (btn) { await btn.click(); await p.waitForTimeout(3500); await p.screenshot({ path: `shots/pbp-${lg}.png` }); await p.keyboard.press("Escape"); await p.waitForTimeout(400); }
  console.log(lg, btn ? "pbp ok" : "no game to open");
}
console.log("errors:", errs.join(" | ") || "none");
await b.close();
