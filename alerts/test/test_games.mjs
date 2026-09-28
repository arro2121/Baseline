// Cosmic Games: two lineups of cards play out a whole game of their sport. Run: node alerts/test/test_games.mjs
import * as W from "../worker.js";
import { simGame, simRating, simStrength, SIM_SPORTS } from "../sim.js";
let fails = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  (got " + JSON.stringify(got)?.slice(0, 200) + ")"}`); if (!ok) fails++; };
const mem = () => { const m = new Map(); return { m, st: { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k), list: async ({ prefix = "" } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) } }; };
const now = Date.now();
const POS = { mlb: ["SS", "CF", "1B", "SP", "RP"], nba: ["G", "F", "C", "G", "F"], cbb: ["", "", "", "", ""], nfl: ["QB", "WR", "RB", "LB", "PK"], cfb: ["", "", "", "", ""], nhl: ["C", "L", "D", "G", "R"], epl: ["F", "M", "D", "G", "F"], tennis: ["", "", "", "", ""] };
const lineup = (sp, r, n = 5) => POS[sp].slice(0, n).map((p, i) => ({ id: `${sp}.${i}.${r}`, name: `Player ${i} ${r}`, pos: p, kind: sp === "cbb" || sp === "cfb" ? "team" : "player", r }));

// SG1 the same seed replays the same game; another seed plays a different one
{ const a = simGame("mlb", lineup("mlb", 75), lineup("mlb", 72), "seed1", ["A", "B"]), b = simGame("mlb", lineup("mlb", 75), lineup("mlb", 72), "seed1", ["A", "B"]);
  const c = [...Array(8)].map((_, i) => JSON.stringify(simGame("mlb", lineup("mlb", 75), lineup("mlb", 72), "other" + i, ["A", "B"]).line));
  check("SG1 a seed replays the exact game", JSON.stringify(a) === JSON.stringify(b), null);
  check("SG1 different seeds play different games", new Set(c).size > 4, c); }
// SG2 every sport plays a full game with a winner, no tie, and a box line for each card
for (const sp of Object.keys(SIM_SPORTS)) { let ok = true, bad = null;
  for (let i = 0; i < 60; i++) { const g = simGame(sp, lineup(sp, 70 + i % 20), lineup(sp, 72), "g" + i, ["A", "B"]);
    const tied = sp !== "epl" && g.score[0] === g.score[1], cards = lineup(sp, 1).filter(c => c.kind !== "team").length;
    if (!["a", "b"].includes(g.winner) || tied || (sp !== "mlb" && g.box.a.length !== cards) || g.periods.length !== g.line.a.length || (sp === "mlb" && g.periods.length < 9)) { ok = false; bad = { sp, i, score: g.score, w: g.winner, box: g.box.a.length, per: g.periods.length }; break; } }
  check(`SG2 ${sp}: a full game, a winner and a box score every time`, ok, bad); }
// SG3 equal lineups are a coin flip; a stronger lineup usually wins, but not always
for (const sp of Object.keys(SIM_SPORTS)) { let eq = 0, st = 0; const N = 400;
  for (let i = 0; i < N; i++) { if (simGame(sp, lineup(sp, 72), lineup(sp, 72), "e" + i).winner === "a") eq++; if (simGame(sp, lineup(sp, 82), lineup(sp, 72), "s" + i).winner === "a") st++; }
  check(`SG3 ${sp}: equal lineups win about half (${eq}/${N}), +10 wins most but not all (${st}/${N})`, eq > N * .42 && eq < N * .58 && st > N * .68 && st < N * .98, { eq, st }); }
// SG4 ratings: rarer, higher-level and better real players rate higher; empty slots count as 50
{ const r = (tier, level, cat) => simRating({ tier, level }, cat);
  check("SG4 a Sun card outrates a Comet, a level adds, a star adds", r("singularity", 1) > r("comet", 1) && r("pulsar", 3) > r("pulsar", 1) && r("pulsar", 1, { ovr: 95 }) > r("pulsar", 1, { ovr: 70 }), [r("singularity", 1), r("comet", 1)]);
  check("SG4 a fuller lineup is stronger", simStrength([{ r: 80 }, { r: 80 }]) < simStrength([{ r: 80 }, { r: 80 }, { r: 70 }]), null); }
// SG5 against the AI its lineup is rated to match yours, whatever its cards
{ const v = await W.czJudge({}, { house: true, sport: "nba", fromName: "A", a: [{ id: "x", tier: "singularity", level: 5, kind: "player", name: "X" }], b: [{ id: "y", tier: "singularity", level: 1, kind: "player", name: "Y" }] });
  check("SG5 the AI's lineup is rated to match yours", v.ra[0] === v.rb[0] && v.chance === .5 && v.judge === "sim", v); }
// SG6 a finished battle keeps its game, replays exactly, and moves both players' game ratings
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a }); m.set("cz:lb", {});
  const mk = (uid, x) => m.set("cz:u:" + uid, { uid, name: "N" + uid, ident: "i" + uid, bal: 1000, bets: [], created: now - 30 * 864e5, items: [{ id: "nba.p" + uid + ".pulsar", n: 1, supply: 100, tier: "pulsar", lg: "nba", name: "Card " + uid, kind: "player", pos: "G" }], ...x });
  mk("A"); mk("B");
  const r1 = await T({ act: "bnew", uid: "A", id: "BT1", sport: "nba", cards: ["nba.pA.pulsar"], stake: 100, day: "20260928" });
  const r2 = await T({ act: "bjoin", uid: "B", id: "BT1", cards: ["nba.pB.pulsar"] });
  const v = await W.czJudge({}, r2.battle); delete v.full;
  const r3 = await T({ act: "bdone", uid: "B", id: "BT1", ...v });
  const bt = r3.battle, A = m.get("cz:u:A"), B = m.get("cz:u:B"), wA = bt.winner === "a";
  check("SG6 the battle is settled by the game and keeps its score", !r1.error && !r2.error && bt.status === "done" && bt.game && bt.game.score.length === 2 && bt.seed, bt);
  check("SG6 the winner gains rating and the loser loses the same", (wA ? A.gr > 1000 && B.gr < 1000 : B.gr > 1000 && A.gr < 1000) && A.gr + B.gr === 2000, { a: A.gr, b: B.gr });
  check("SG6 the winner takes both stakes", (wA ? A.bal : B.bal) === 1100 && (wA ? B.bal : A.bal) === 900, { a: A.bal, b: B.bal });
  const g = W.czReplay(bt); check("SG6 a stored game replays to the same score", g && JSON.stringify(g.score) === JSON.stringify(bt.game.score) && g.winner === bt.winner, g && g.score);
  // against the AI: +8 or -8
  const r4 = await T({ act: "bnew", uid: "A", id: "BT2", sport: "nba", cards: ["nba.pA.pulsar"], stake: 0, house: true, day: "20260928", houseCards: [{ id: "nba.pz.pulsar", name: "Z", tier: "pulsar", n: 1, supply: 100, lg: "nba", kind: "player" }] });
  const before = m.get("cz:u:A").gr, v2 = await W.czJudge({}, r4.battle); delete v2.full; const r5 = await T({ act: "bdone", uid: "A", id: "BT2", ...v2 });
  check("SG6 a game against the AI moves the rating by 8", Math.abs(m.get("cz:u:A").gr - before) === 8 && r5.battle.elo.length === 1, { before, after: m.get("cz:u:A").gr }); }
// SG7 score alerts are retired: every stored push subscription is deleted
{ const kv = new Map([["subs", JSON.stringify([{ sub: { endpoint: "https://push.test/1" }, teams: {} }, { sub: { endpoint: "https://push.test/2" }, prefs: {} }])]]);
  const env = { KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  const n = await W.pushRetire(env);
  check("SG7 retired alerts: every push subscription is deleted", n === 2 && JSON.parse(kv.get("subs")).length === 0, { n, left: kv.get("subs") }); }
console.log(fails ? `\n${fails} failed` : "\nall passed"); process.exit(fails ? 1 : 0);
