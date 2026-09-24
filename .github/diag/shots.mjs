import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://localhost:8000/", { waitUntil: "load" }); await p.waitForTimeout(800);
for (const lg of ["mlb", "nhl", "epl", "nfl"]) {
  await p.click(`[data-sport="${lg}"]`); await p.waitForTimeout(300);
  await p.click('[data-tt="games"]'); await p.waitForTimeout(4000);
  // open finished games until one has a replay button
  const n = await p.$$eval("#tt-games [data-pbp]", x => x.length);
  let opened = false;
  for (let i = n - 1; i >= 0 && !opened; i--) {
    await p.$$eval("#tt-games [data-pbp]", (x, i) => x[i].click(), i); await p.waitForTimeout(3500);
    const info = await p.evaluate(() => ({ photos: document.querySelectorAll("#gList .pchip .ph").length, watch: document.querySelectorAll("#gList .vbtn").length, clips: document.querySelectorAll("#gScene .hl").length }));
    console.log(lg, "game", i, JSON.stringify(info));
    if (info.watch || info.clips) {
      opened = true;
      await p.screenshot({ path: `shots/${lg}-top.png` });
      if (info.watch) { await p.evaluate(() => document.querySelector("#gList .vbtn").scrollIntoView({ block: "center" })); await p.screenshot({ path: `shots/${lg}-row.png` }); await p.click("#gList .vbtn"); }
      else await p.click("#gScene .hl");
      await p.waitForTimeout(6000);
      const v = await p.evaluate(() => { const v = document.querySelector("#gScene video"); return v ? { readyState: v.readyState, t: v.currentTime.toFixed(1), err: v.error && v.error.code, src: v.currentSrc.slice(0, 80), w: v.videoWidth } : document.querySelector("#gScene .gvideo")?.textContent; });
      console.log("  video:", JSON.stringify(v));
      await p.screenshot({ path: `shots/${lg}-video.png` });
    }
    await p.keyboard.press("Escape"); await p.waitForTimeout(400);
  }
}
console.log("errors:", errs.join(" | ") || "none");
await b.close();
