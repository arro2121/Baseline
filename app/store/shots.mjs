// App Store screenshots from the live site: real games, real logos and player photos.
// Signs in with a temporary account (a virtual passkey), turns on the owner's testing switch so it stays off the
// leaderboards, opens a few packs, takes the screenshots, then deletes the account (its cards go back into packs).
// Run by .github/workflows/store-shots.yml. Needs COMETS_KEY (the owner key) in the environment.
import { chromium } from "playwright";
import { mkdirSync } from "fs";
const SITE = process.env.SITE || "https://arro2121.github.io/Baseline/", KEY = process.env.COMETS_KEY || "", OUT = process.env.OUT || "app/store/screenshots/";
mkdirSync(OUT, { recursive: true });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CosmoSportsApp/1";
const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, userAgent: UA, colorScheme: "dark" }), p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p); await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
p.on("dialog", d => d.accept()); p.on("pageerror", e => console.log("page error:", e.message));
const wait = ms => p.waitForTimeout(ms), closeDlg = () => p.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
const shot = async (n, settle = 2500) => { await wait(settle); await closeToasts(); await p.screenshot({ path: OUT + n + ".png" }); console.log("shot", n); };
const closeToasts = () => p.evaluate(() => document.querySelectorAll(".toast").forEach(t => t.remove()));
let signedIn = false;
try {
  await p.goto(SITE, { waitUntil: "load", timeout: 60000 }); await wait(4000);
  for (const name of ["Alex", "Alex R", "Jordan", "Jordan K", "Sam Rivera", "Casey " + Math.floor(Math.random() * 90 + 10)]) {
    await p.fill("#gate form[data-czpk=new] input", name); await p.click("#gate form[data-czpk=new] button"); await wait(4000);
    if (await p.evaluate(() => !!(window.CZ && CZ.me))) { signedIn = true; console.log("signed in as", name); break; }
    console.log("name", name, "didn't work:", await p.evaluate(() => document.querySelector("#gate .czerr")?.textContent));
  }
  if (!signedIn) throw new Error("couldn't create the preview account");
  await closeDlg();
  // follow a few big teams so Today and reminders look lived-in, and open packs for a showcase
  await p.evaluate(() => { const F = { nfl: ["kansas city chiefs", "philadelphia eagles"], nba: ["boston celtics"], mlb: ["los angeles dodgers"], epl: ["arsenal"] }; for (const [lg, a] of Object.entries(F)) FAV[lg] = a.map(tkey); localStorage.setItem("fav-teams", JSON.stringify(FAV)); });
  const packs = await p.evaluate(async key => {
    const log = []; if (!key) return ["no owner key: skipping packs"];
    try { CZ.me = (await czApi("/owner/unlimited", { on: true }, { headers: { "X-Owner-Key": key } })).user; } catch (e) { return ["owner switch failed: " + e.message]; }
    for (const [k, scope, kind] of [["singularity", "nfl", "player"], ["singularity", "nba", "player"], ["supernova", "all", "team"], ["supernova", "mlb", "player"], ["nebula", "epl", "all"]]) {
      try { const r = await czApi("/pack", { pack: k, scope, kind }); CZ.me = r.user; log.push(k + ": " + r.cards.map(c => c.name + " " + c.tier).join(", ")); } catch (e) { log.push(k + " failed: " + e.message); } }
    try { CZ.me = (await czApi("/owner/unlimited", { on: false }, { headers: { "X-Owner-Key": key } })).user; } catch {}
    try { CZ.me = (await czApi("/owner/unlimited", { on: true }, { headers: { "X-Owner-Key": key } })).user; } catch {}   // stay off the leaderboards until deleted
    return log; }, KEY);
  console.log(packs.join("\n"));
  await p.evaluate(() => setSport("universe")); await shot("01-today", 5000);
  await p.evaluate(() => { setSport("cosmic"); CZ.tab = "home"; }); await wait(1500); await p.evaluate(() => { CZ.tab = "home"; drawCosmic(); czLoad(["me", "board", "lb", "market"]); }); await shot("02-cosmic", 5000);
  await p.evaluate(() => { CZ.tab = "packs"; drawCosmic(); czLoad(["vault", "me"]); }); await shot("03-packs", 3000);
  await p.evaluate(() => { CZ.tab = "coll"; drawCosmic(); }); await wait(1500);
  await p.evaluate(() => document.querySelector(".czown")?.click()); await shot("04-card", 4000); await closeDlg();
  await p.evaluate(() => { CZ.tab = "bet"; drawCosmic(); czLoad(["board", "me"]); }); await shot("05-bet", 3000);
  await p.evaluate(() => setSport("nfl")); await wait(3000); await p.evaluate(() => document.querySelector('[data-tt="predict"]')?.click()); await shot("06-predict", 3000);
  await p.evaluate(() => setSport("nfl")); await wait(1500); await p.evaluate(() => document.querySelector('[data-tt="games"]')?.click()); await shot("07-games", 3000);
} finally {
  if (signedIn) { const r = await p.evaluate(async () => { try { await czApi("/delete", { confirm: "DELETE" }); return "preview account deleted"; } catch (e) { return "delete failed: " + e.message; } }); console.log(r); }
  await b.close();
}
