// Screenshots real Cosmic cards from the live site (real player photos), for checking the card designs.
import { chromium } from "playwright";
const b = await chromium.launch(), p = await (await b.newContext({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 })).newPage();
const log = []; p.on("requestfailed", r => { if (/espncdn|mlbstatic|nhle|premierleague/.test(r.url())) log.push("FAILED " + r.url()); });
p.on("response", r => { if (/espncdn|mlbstatic|nhle|premierleague/.test(r.url())) log.push(r.status() + " " + r.url()); });
await p.goto("https://cosmosports.app/?sport=cosmic", { waitUntil: "networkidle" }); await p.waitForTimeout(3000);
const info = await p.evaluate(async () => {
  const out = [];
  for (const lg of ["nba", "nfl", "mlb", "nhl", "epl", "tennis"]) { const V = await czApi(`/vault?lg=${lg}&kind=player&tier=nebula&limit=4`); out.push(...V.items.slice(0, 3)); }
  document.body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;padding:10px;background:#0b0420">${out.map(c => czCard(c, 7)).join("")}</div>`;
  return out.map(c => c.lg + " " + c.name + " img=" + (c.img || "none"));
});
await p.waitForTimeout(8000);
const faces = await p.evaluate(() => [...document.querySelectorAll(".czcard")].map(c => { const i = c.querySelector("img.czhs"); return (c.querySelector(".czc-name")?.innerText || "").replace(/\s+/g, " ") + ": " + (i ? (i.complete && i.naturalWidth ? "PHOTO " + i.naturalWidth + "x" + i.naturalHeight + " " + i.currentSrc : "photo not loaded " + i.src) : "NO PHOTO (logo)"); }));
await p.screenshot({ path: "shots/cards.png", fullPage: true });
const fs = await import("node:fs"); fs.writeFileSync("shots/report.txt", [...info, "", ...faces, "", ...log.slice(0, 80)].join("\n"));
await b.close();
