import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
for (const [name, vp, scheme] of [["phone", { width: 390, height: 844 }, "light"], ["desktop", { width: 1280, height: 900 }, "dark"]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2, colorScheme: scheme });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  const imgs = []; p.on("response", r => { if (/logos\//.test(r.url())) imgs.push(r.status()); });
  await p.goto("http://localhost:8000/", { waitUntil: "load" }); await p.waitForTimeout(1500);
  for (const lg of ["mlb", "nfl", "nhl", "epl"]) {
    await p.evaluate(lg => document.querySelector(`[data-sport="${lg}"]`).click(), lg); await p.waitForTimeout(300);
    await p.evaluate(() => document.querySelector('[data-tt="games"]').click()); await p.waitForTimeout(4000);
    const logos = await p.$$eval("#tt-games .tlogo img", xs => ({ n: xs.length, loaded: xs.filter(x => x.complete && x.naturalWidth).length, local: xs.filter(x => /\/logos\//.test(x.src)).length }));
    console.log(name, lg, "card logos:", JSON.stringify(logos));
    if (lg === "mlb" || lg === "nfl") await p.screenshot({ path: `shots/${name}-${lg}-games.png` });
    if (lg === "nfl") { await p.evaluate(() => document.querySelector('[data-day="-1"]').click()); await p.waitForTimeout(3500); await p.screenshot({ path: `shots/${name}-nfl-yesterday.png` }); console.log(name, "nfl day:", await p.$eval(".gdate b", e => e.textContent)); await p.evaluate(() => document.querySelector('[data-day="0"]')?.click()); await p.waitForTimeout(2000); }
    const n = await p.$$eval("#tt-games [data-pbp]", x => x.length);
    if (n) {
      await p.$$eval("#tt-games [data-pbp]", x => x[x.length - 1].click()); await p.waitForTimeout(1300);
      await p.screenshot({ path: `shots/${name}-${lg}-pbp-mid.png` });
      await p.waitForTimeout(2200);
      const jank = await p.evaluate(() => new Promise(res => { const r = document.querySelector("#gReplay"); if (!r) return res("no replay"); let last = performance.now(), worst = 0, k = 0; const f = now => { worst = Math.max(worst, now - last); last = now; if (++k < 150) requestAnimationFrame(f); else res(worst.toFixed(1)); }; r.click(); requestAnimationFrame(f); }));
      console.log(name, lg, "longest frame during replay (ms):", jank);
      await p.waitForTimeout(3000); await p.screenshot({ path: `shots/${name}-${lg}-pbp.png` });
      await p.keyboard.press("Escape"); await p.waitForTimeout(400);
    }
  }
  console.log(name, "local logo responses:", imgs.length, "ok:", imgs.filter(s => s < 400).length, "| errors:", errs.join(" | ") || "none");
  await p.close();
}
await b.close();
