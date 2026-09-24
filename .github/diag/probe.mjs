import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage();
const hits = [];
p.on("response", r => { const u = r.url(); if (/espn\.com|workers\.dev\/sports/.test(u)) hits.push(`${r.status()} ${new URL(u).host}${new URL(u).pathname.slice(0, 50)}`); });
p.on("pageerror", e => console.log("PAGE ERROR:", e.message));
await p.goto("http://localhost:8000/", { waitUntil: "load" });
for (const lg of ["mlb", "nfl", "nhl", "epl", "nba"]) {
  hits.length = 0;
  await p.click(`[data-sport="${lg}"]`); await p.waitForTimeout(400);
  await p.click('[data-tt="games"]'); await p.waitForTimeout(5000);
  const games = (await p.textContent("#tt-games")).replace(/\s+/g, " ").slice(0, 160);
  let pbp = "";
  const btn = await p.$("#tt-games [data-pbp]");
  if (btn) { await btn.click(); await p.waitForTimeout(5000); pbp = (await p.textContent("#gbody")).replace(/\s+/g, " ").slice(0, 200); await p.keyboard.press("Escape"); await p.waitForTimeout(300); }
  console.log(`\n### ${lg}\nrequests: ${[...new Set(hits)].join(" | ")}\ngames: ${games}\npbp: ${pbp || "(no finished/live game to open)"}`);
}
await b.close();
