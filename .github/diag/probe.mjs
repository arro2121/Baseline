import { chromium } from "playwright";
const b = await chromium.launch();
for (const ua of [null, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"]) {
  const p = await b.newPage(ua ? { userAgent: ua } : {});
  console.log("\n##### UA:", ua || "default headless");
  p.on("console", m => console.log("console:", m.type(), m.text().slice(0, 300)));
  p.on("requestfailed", r => console.log("FAILED:", r.url().slice(0, 150), r.failure()?.errorText));
  p.on("response", async r => { const u = r.url(); if (/espn|workers\.dev/.test(u)) console.log("resp:", r.status(), u.slice(0, 150), JSON.stringify(await r.allHeaders()).slice(0, 400)); });
  await p.goto("https://arro2121.github.io/Baseline/", { waitUntil: "load" });
  console.log("has ESPN_DIRECT:", await p.evaluate(() => typeof ESPN_DIRECT));
  const direct = await p.evaluate(async () => { try { const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"); return r.status + " " + (await r.text()).slice(0, 150); } catch (e) { return "ERR " + e; } });
  console.log("page fetch ESPN:", direct);
  await p.click('[data-sport="mlb"]'); await p.waitForTimeout(500);
  await p.click('[data-tt="games"]'); await p.waitForTimeout(4000);
  console.log("games box:", (await p.textContent("#tt-games")).replace(/\s+/g, " ").slice(0, 300));
  await p.close();
}
await b.close();
