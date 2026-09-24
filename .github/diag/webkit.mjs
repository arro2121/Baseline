import { webkit, chromium, devices } from "playwright";
const engine = process.argv[2] === "chromium" ? chromium : webkit;
const b = await engine.launch();
const ctx = await b.newContext({ ...devices["iPhone 15"] });
await ctx.addInitScript(() => { try { localStorage.setItem("baseline:onboarded", "true"); } catch {} });
const p = await ctx.newPage();
const log = [];
p.on("pageerror", e => log.push("PAGEERROR " + e.message + " @ " + (e.stack || "").split("\n").slice(0, 3).join(" / ")));
p.on("console", m => { if (["error", "warning"].includes(m.type())) log.push("CONSOLE " + m.type() + " " + m.text().slice(0, 300)); });
p.on("requestfailed", r => log.push("REQFAIL " + r.url().slice(0, 140) + " " + (r.failure()?.errorText || "")));
p.on("response", r => { if (r.status() >= 400) log.push("HTTP " + r.status() + " " + r.url().slice(0, 140)); });
await p.goto("https://arro2121.github.io/Baseline/?nowarp=1&v=" + Date.now(), { waitUntil: "load" }); await p.waitForTimeout(6000);
await p.screenshot({ path: `.github/diag/${process.argv[2] || "webkit"}-today.png` });
for (const lg of ["nfl", "nba", "mlb", "nhl", "epl"]) {
  await p.evaluate(lg => document.querySelector(`[data-sport="${lg}"]`).click(), lg); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('[data-tt="games"]').click()); await p.waitForTimeout(7000);
  const t = await p.evaluate(() => document.querySelector("#tt-games")?.innerText.replace(/\s+/g, " ").slice(0, 160));
  log.push(`GAMES ${lg}: ${t}`);
  await p.screenshot({ path: `.github/diag/${process.argv[2] || "webkit"}-${lg}.png` });
}
console.log(log.join("\n"));
await b.close();
