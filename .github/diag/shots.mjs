// Live check of every feature in real Chrome, and the store screenshots.
import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
const errs = [], log = (...a) => console.log(...a);
async function page(vp, scheme = "light"){ const p = await b.newPage({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1, colorScheme: scheme }); p.on("pageerror", e => errs.push(e.message)); return p; }
const ev = (p, f, a) => p.evaluate(f, a), wait = (p, ms) => p.waitForTimeout(ms);
const p = await page({ width: 390, height: 844 });
await p.goto("http://localhost:8000/", { waitUntil: "load" }); await wait(p, 1500);
log("title:", await p.title(), "| brand:", await ev(p, () => document.querySelector(".brand").textContent.trim()));
// games with the most going on
let best = null;
for (const lg of ["mlb", "nfl", "nhl", "epl", "nba"]) {
  await ev(p, lg => document.querySelector(`[data-sport="${lg}"]`).click(), lg); await wait(p, 300);
  await ev(p, () => document.querySelector('[data-tt="games"]').click()); await wait(p, 3500);
  const n = await ev(p, () => ({ live: document.querySelectorAll(".gcard.live").length, all: document.querySelectorAll(".gcard").length }));
  log(lg, "games:", JSON.stringify(n));
  if (!best && n.live) best = lg;
  for (const t of ["stand", "news"]) { await ev(p, t => document.querySelector(`[data-tt="${t}"]`).click(), t); await wait(p, 2500); log("  ", t, await ev(p, t => document.querySelector("#tt-" + t).querySelectorAll("tr[data-team], .ncard").length, t), "rows/cards"); }
}
best = best || "mlb";
// store screenshot 1: games
await ev(p, lg => document.querySelector(`[data-sport="${lg}"]`).click(), best); await wait(p, 300); await ev(p, () => document.querySelector('[data-tt="games"]').click()); await wait(p, 3500);
await ev(p, () => document.querySelector(".gdate").scrollIntoView({ block: "start" })); await wait(p, 300);
await p.screenshot({ path: "shots/phone-games.png" });
// store screenshot 2: play-by-play of a live game (or the latest final)
await ev(p, () => (document.querySelector(".gcard.live [data-pbp]") || [...document.querySelectorAll("#tt-games [data-pbp]")].pop()).click()); await wait(p, 4500);
await p.screenshot({ path: "shots/phone-pbp.png" });
// 3: box score
await ev(p, () => document.querySelector('[data-gt="box"]').click()); await wait(p, 1200);
log("box sections:", await ev(p, () => [...document.querySelectorAll("#gList .bsec h3")].map(h => h.textContent).join(" | ")), "| tables:", await ev(p, () => document.querySelectorAll("#gList table").length));
await ev(p, () => document.querySelector("#gList .bsec h3")?.scrollIntoView({ block: "start" })); await wait(p, 400);
await p.screenshot({ path: "shots/phone-box.png" });
await ev(p, () => document.querySelector('[data-gt="info"]').click()); await wait(p, 1200);
log("info sections:", await ev(p, () => [...document.querySelectorAll("#gList .bsec h3")].map(h => h.textContent).join(" | ")));
await p.keyboard.press("Escape"); await wait(p, 400);
// 4: team page from standings
await ev(p, () => document.querySelector('[data-tt="stand"]').click()); await wait(p, 2500);
await ev(p, () => document.querySelector("#tt-stand [data-team]").click()); await wait(p, 3500);
log("team page:", await ev(p, () => document.querySelector(".thd h2")?.textContent + " | " + document.querySelector(".thd p")?.textContent + " | schedule rows " + document.querySelectorAll("#tList .srow").length));
await p.screenshot({ path: "shots/phone-team.png" });
await ev(p, () => document.querySelector("#tFav").click()); await ev(p, () => document.querySelector('[data-tt2="roster"]').click()); await wait(p, 800);
log("roster rows:", await ev(p, () => document.querySelectorAll("#tList .rrow").length));
await p.keyboard.press("Escape"); await wait(p, 400);
await ev(p, () => document.querySelector('[data-sport="following"]').click()); await wait(p, 4000);
log("following:", await ev(p, () => document.querySelector(".fcard")?.textContent.replace(/\s+/g, " ").slice(0, 120)));
await ev(p, () => openSearch()); await p.fill("#searchIn", "yankees"); await wait(p, 300);
log("search:", await ev(p, () => document.querySelector("#searchOut").textContent.replace(/\s+/g, " ").slice(0, 80)));
await p.close();
// 5: desktop
const d = await page({ width: 1280, height: 800 }, "dark");
await d.goto("http://localhost:8000/", { waitUntil: "load" }); await wait(d, 1200);
await ev(d, lg => document.querySelector(`[data-sport="${lg}"]`).click(), best); await wait(d, 300); await ev(d, () => document.querySelector('[data-tt="games"]').click()); await wait(d, 3500);
await ev(d, () => (document.querySelector(".gcard.live [data-pbp]") || [...document.querySelectorAll("#tt-games [data-pbp]")].pop()).click()); await wait(d, 4500);
await d.screenshot({ path: "shots/desktop.png" });
log("errors:", errs.slice(0, 8).join(" | ") || "none");
await b.close();
