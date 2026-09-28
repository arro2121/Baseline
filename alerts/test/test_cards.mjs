// Grading, Daily Drop and Milestone cards.
// Run: node alerts/test/test_cards.mjs
import * as W from "../worker.js";
let fails = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  (got " + JSON.stringify(got)?.slice(0, 200) + ")"}`); if (!ok) fails++; };
const mem = () => { const m = new Map(); return { m, st: { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k) } }; };
const now = Date.parse("2026-09-28T12:00:00Z");
const card = (id, x = {}) => ({ id, n: 3, supply: 100, tier: id.split(".").pop(), lg: "nba", name: "P", kind: "player", ...x });

// GR1-GR5: grading
{ const G = W.CZ_GRADES, avg = G.reduce((t, g) => t + g[2] * g[3], 0) / 100;
  check("GR1 the grade odds add up to 100% and a grade adds less on average than the 30% fee", Math.abs(G.reduce((t, g) => t + g[3], 0) - 100) < 1e-9 && avg > 1 && avg < 1 + W.CZ_GRADE_FEE, avg);
  const n = {}; for (let k = 0; k < 1000; k++) { const g = W.czGradeRoll(k / 1000); n[g] = (n[g] || 0) + 1; }
  check("GR2 grades come out at PSA-like odds (25% Gem Mint 10, 35% 9s, 20% 8s, down to 0.3% 1s)", n[10] === 250 && n[9] === 350 && n[8] === 200 && n[1] === 3 && Object.keys(n).length === 10, n);
  check("GR3 a grade multiplies the copy's worth, on top of a case hit", W.czCopyMult({ gr: 10 }) === 2.5 && W.czCopyMult({ gr: 1 }) === .2 && Math.abs(W.czCopyMult({ ch: "gold", gr: 9 }) - 5.5) < 1e-9 && W.czCopyMult({}) === 1); }
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  await T({ act: "ident", sub: "S", uid: "S", tok: "t", name: "Slabber" });
  m.set("cz:u:S", { ...m.get("cz:u:S"), bal: 1000, items: [card("nba.p1.pulsar"), card("nba.p2.pulsar", { listed: "L1" }), card("nba.p3.pulsar", { ch: "neon" })] });
  const r = await T({ act: "grade", uid: "S", id: "nba.p1.pulsar", value: 1000 }), U = m.get("cz:u:S"), c = U.items[0];
  check("GR4 grading charges 30% of the value and gives a grade from 1 to 10", r.fee === 300 && U.bal === 700 && c.gr === r.grade && r.grade >= 1 && r.grade <= 10, r);
  check("GR4 a card is graded only once", /already been graded/.test((await T({ act: "grade", uid: "S", id: "nba.p1.pulsar", value: 1000 })).error || "") && m.get("cz:u:S").bal === 700);
  check("GR4 a listed card can't be graded", /market/.test((await T({ act: "grade", uid: "S", id: "nba.p2.pulsar", value: 1000 })).error || ""));
  const r2 = await T({ act: "grade", uid: "S", id: "nba.p3.pulsar", value: 100 });
  check("GR5 the fee counts the case hit's worth, with a 50-coin minimum", r2.fee === 60 && W.czGradeFee(1000, { ch: "neon" }) === 600 && W.czGradeFee(10, {}) === 50, r2);
  m.set("cz:u:S", { ...m.get("cz:u:S"), bal: 10, items: [card("nba.p4.pulsar")] });
  check("GR5 not enough coins, no grade", /costs/.test((await T({ act: "grade", uid: "S", id: "nba.p4.pulsar", value: 1000 })).error || "") && !m.get("cz:u:S").items[0].gr); }
// graded copies keep their grade on the market and in auctions
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  await T({ act: "ident", sub: "M", uid: "M", tok: "t", name: "Marketeer" }); m.set("cz:u:M", { ...m.get("cz:u:M"), bal: 0, items: [card("nba.p5.pulsar", { gr: 10 }), card("nba.p6.pulsar", { gr: 9 })] });
  await T({ act: "list", uid: "M", id: "nba.p5.pulsar", price: 500 }); await T({ act: "aucnew", uid: "M", id: "nba.p6.pulsar", start: 100, hours: 24 });
  check("GR6 the market listing and auction show the grade", (m.get("cz:mkt") || [])[0]?.gr === 10 && (m.get("cz:auc") || [])[0]?.gr === 9, [m.get("cz:mkt"), m.get("cz:auc")]); }
// a grade is saved: it's still there after the player sells other cards, sells in bulk and trades, and a traded graded copy keeps it
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  await T({ act: "ident", sub: "G", uid: "G", tok: "t", name: "Keeper" }); await T({ act: "ident", sub: "H", uid: "H", tok: "t", name: "Friend" });
  m.set("cz:u:G", { ...m.get("cz:u:G"), bal: 5000, items: [card("nba.p7.pulsar"), card("nba.p8.pulsar"), card("nba.p9.pulsar"), card("nba.q1.pulsar")] });
  const g = (await T({ act: "grade", uid: "G", id: "nba.p7.pulsar", value: 1000 })).grade, g2 = (await T({ act: "grade", uid: "G", id: "nba.q1.pulsar", value: 1000 })).grade;
  await T({ act: "sell", uid: "G", id: "nba.p8.pulsar", value: 100 }); await T({ act: "sellmany", uid: "G", cards: [{ id: "nba.p9.pulsar", value: 100 }] });
  const U = m.get("cz:u:G");
  check("GR7 a grade stays saved through later sales", U.items.length === 2 && U.items.find(i => i.id === "nba.p7.pulsar")?.gr === g && U.items.find(i => i.id === "nba.q1.pulsar")?.gr === g2, U.items);
  m.set("cz:u:H", { ...m.get("cz:u:H"), items: [card("nba.q2.pulsar")] });
  const off = await T({ act: "toffer", uid: "G", to: "Friend", give: ["nba.q1.pulsar"], get: ["nba.q2.pulsar"], coins: 0 }), tid = (m.get("cz:trades") || [])[0]?.tid;
  await T({ act: "tresp", uid: "H", tid, accept: true });
  check("GR7 a traded graded copy arrives with its grade", !!tid && m.get("cz:u:H").items.find(i => i.id === "nba.q1.pulsar")?.gr === g2, [off, m.get("cz:u:H").items]); }

// EA1: earning is 5% under the round numbers: the daily claim, bet winnings (the profit only), the wheel, prizes and the shop
check("EA1 a day-one claim pays 238, a 7-day streak 523", W.czDailyAmt(1) === 238 && W.czDailyAmt(7) === 523, [W.czDailyAmt(1), W.czDailyAmt(7)]);
check("EA1 a price of 2.00 pays 1.95: the stake back plus 95% of the profit", Math.abs(W.czTrim(2) - 1.95) < 1e-9 && Math.abs(W.czTrim(3.5) - 3.375) < 1e-9);
check("EA1 wheel coins, season prizes and the shop are 5% lower", W.CZ_WHEEL.filter(x => x.coins).every(x => x.coins % 5 !== 0 || [95, 285, 475, 950].includes(x.coins)) && W.CZ_RANKS.at(-1)[3] === 19000 && W.CZ_EARN === .95);

// DD1-DD6: Daily Drop and Milestones
const items = [1, 2, 3, 4, 5, 6, 7].flatMap(i => ["comet", "nebula"].map(t => ({ id: `nba.p${i}.${t}`, lg: "nba", kind: "player", tier: t, name: "Player " + i, team: "T", pos: "G", mult: 1 + i / 10, price: 100 * i })));
const pf = (i, score, x = {}) => ({ k: `nba:player ${i}`, lg: "nba", at: now - 10 * 3600e3, line: `${score} PTS`, game: "A at B", score, feats: [], ...x });
{
  const perf = [pf(1, 40), pf(2, 55, { feats: [["50pt", "50-Point Game"]] }), pf(3, 30), pf(4, 35), pf(5, 20), pf(6, 44), pf(7, 25), pf(1, 12), pf(3, 90, { at: now - 50 * 3600e3 })];
  const out = W.czMakeDrops(perf, items, "20260928", now), dd = out.filter(r => r.kind === "drop"), ms = out.filter(r => r.kind === "ms");
  check("DD1 the drop is the night's five best performances, best first, one per player", dd.map(r => r.name).join() === "Player 2,Player 6,Player 1,Player 4,Player 3", dd.map(r => r.name));
  check("DD1 games older than 36 hours don't count", !dd.some(r => r.score === 90));
  check("DD2 drop cards are /50 for 24 hours; a milestone is /10 for 48 hours", dd.every(r => r.id.endsWith("-dd20260928.nebula") && r.until === now + 24 * 3600e3) && ms.length === 1 && ms[0].title === "50-Point Game" && ms[0].id === "nba.p2-ms2026092850pt.supernova" && ms[0].until === now + 48 * 3600e3, ms);
  const again = W.czMakeDrops(perf, items, "20260929", now + 3600e3, new Set(out.map(r => r.key)));
  check("DD3 a performance or feat is never dropped twice", !again.some(r => out.some(o => o.key === r.key)) && again.filter(r => r.kind === "drop").every(r => r.name === "Player 5" || r.name === "Player 7"), again.map(r => r.key));
  const it = W.czDropItem(dd[0], items.find(i => i.id === "nba.p2.comet")), reg = { price: W.czCoins(W.czUsd(25, 1.2, "player", "nba")) };
  check("DD4 a drop card is worth more than the player's regular card of the same run", it.supply === 50 && it.tier === "nebula" && it.price > reg.price && it.drop.line === "55 PTS", { it: it.price, reg: reg.price });
  const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  const r1 = await T({ act: "drops", day: "20260928", add: out }), r2 = await T({ act: "drops", day: "20260928", add: out });
  m.set("cz:dropday", 20260930);                                      // a stored day can read back as a number
  check("DD5 a day stored as a number still counts as done", (await T({ act: "drops", day: "20260930", add: out })).already);
  m.set("cz:dropday", "20260927");
  check("DD5 the day's drop is made once", r1.added === out.length && r2.already && m.get("cz:drops").length === out.length && (m.get("cz:feed") || []).some(f => f.kind === "milestone"), [r1, r2]); }
// the big-game scan keeps each performance's score and feats
check("DD6 feats and scores from a box score", W.czFeats("nhl", { G: 3, A: 2 }).map(f => f[0]).join() === "hat,5pt" && W.czFeats("nba", { PTS: 12, REB: 11, AST: 10 })[0][0] === "tdbl" && W.czFeats("mlb", { "batting:HR": 1 }).length === 0 && W.czPerfScore("nba", { PTS: 40, REB: 10, AST: 5 }) === 59.5);

// GL1-GL4: the Grails
{ const cat = [{ id: "nba.p1.singularity", price: 2e6 }, { id: "nba.at-x.singularity", price: 1.5e6 }, { id: "nfl.p2.comet", price: 30 }], G = W.czGrails(cat);
  check("GL1 one Grail per league, each worth 3x the most valuable card in the game", G.length === 6 && new Set(G.map(g => g.lg)).size === 6 && G.every(g => g.price >= 6e6 && g.supply === 1 && g.grail && g.tier === "singularity"), G.map(g => g.price));
  check("GL2 a Grail is valued at exactly its price (no level, hot or scarcity bonus)", W.czValueOf(G[0], { xp: 99, hot: true, held: 1 }).value === G[0].price); }
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a }), odds = W.CZ_TIERS.map(t => t[0] === "comet" ? 100 : 0);
  const grail = { id: "nba.grail.singularity", tier: "singularity", supply: 1, lg: "nba", name: "The Hardwood Grail", kind: "grail", grail: true };
  const pool = [grail, ...Array.from({ length: 20 }, (_, i) => ({ id: `nba.g${i}.comet`, tier: "comet", supply: 1000, lg: "nba", name: "G" + i, kind: "player" })), { id: "nba.s1.singularity", tier: "singularity", supply: 1, lg: "nba", name: "S1", kind: "player" }];
  await T({ act: "ident", sub: "G", uid: "G", tok: "t", name: "Grailer" }); m.set("cz:u:G", { ...m.get("cz:u:G"), bal: 1e8, freePack: false });
  const r = await T({ act: "pack", uid: "G", pack: { id: "galaxy", label: "P", price: 100, cards: 3, odds, ch: 0, gc: 1 }, pool, rid: "aaaaaaaaaaaaaaaa" });
  check("GL3 a pack's grail roll gives the Grail (once), never as a case hit or ink", r.cards.filter(c => c.grail).length === 1 && r.cards.find(c => c.grail).id === grail.id && !r.cards.find(c => c.grail).ch && !r.cards.find(c => c.grail).ink && r.cards.length === 3, r.cards.map(c => c.id));
  check("GL3 a Grail can't be graded", /isn't graded/.test((await T({ act: "grade", uid: "G", id: grail.id, value: 6e6 })).error || ""));
  await T({ act: "ident", sub: "H", uid: "H", tok: "t", name: "Second" }); m.set("cz:u:H", { ...m.get("cz:u:H"), bal: 1e8, freePack: false });
  const r2 = await T({ act: "pack", uid: "H", pack: { id: "galaxy", label: "P", price: 100, cards: 3, odds, ch: 0, gc: 1 }, pool, rid: "bbbbbbbbbbbbbbbb" });
  check("GL4 once it's pulled it's gone from every pack", !r2.error && !r2.cards.some(c => c.grail), r2.cards && r2.cards.map(c => c.id));
  let n = 0; for (let k = 0; k < 30; k++) { const { m: m2, st: s2 } = mem(); await W.czTx(s2, { now, act: "ident", sub: "Z", uid: "Z", tok: "t", name: "Z" }); m2.set("cz:u:Z", { ...m2.get("cz:u:Z"), bal: 1e8, freePack: false });
    const rr = await W.czTx(s2, { now, act: "pack", uid: "Z", pack: { id: "x", label: "P", price: 100, cards: 2, odds: W.CZ_TIERS.map(t => t[0] === "singularity" ? 100 : 0) }, pool, rid: "cccccccccccccccc" }); if (rr.cards.some(c => c.grail)) n++; }
  check("GL4 an ordinary 1-of-1 pull never hands out a Grail", n === 0, n);
  check("GL5 the grail chance scales with the pack's price (about 3% of its value)", Math.abs(W.czGrailChance(100000, 3, 5.7e6) * 5.7e6 * 3 / 100000 - .03) < 1e-9 && W.czGrailChance(100, 1, 5.7e6) < 1e-6 && W.czGrailChance(1e9, 1, 1) === .01); }
console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
