// Writes docs/scores.json: today's scoreboard for every league, read with the same code the app and the alerts service use.
// The site publishes it every few minutes, so a phone on a network that blocks ESPN and the alerts service still gets
// scores, straight from the app's own address. Run from the repository root: node alerts/snapshot.mjs
import { writeFileSync } from "node:fs";
import { LEAGUES, espnScoreboard } from "./worker.js";

const boards = {};
for (const lg of Object.keys(LEAGUES)) {
  try { const d = await espnScoreboard(lg); boards[lg] = { games: d.games || [] }; console.log(`${lg}: ${boards[lg].games.length} games`); }
  catch (e) { console.log(`${lg}: skipped (${e.message})`); }
}
if (!Object.keys(boards).length) { console.log("No league answered; keeping the previous copy."); process.exit(0); }
writeFileSync("docs/scores.json", JSON.stringify({ asof: new Date().toISOString(), boards }));
