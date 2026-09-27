// Round-2 review fixes (A1–A8, B4): each check fails on the code before the fix and passes after.
// Run: node alerts/test/test_round2.mjs
import * as W0 from "../worker.js";
// functions added by these fixes are stubbed on older code so every check still runs (and fails) there
const W = { ...W0, czNanFixTx: W0.czNanFixTx || (async () => ({})), dayBefore: W0.dayBefore || (() => ""), dayAfter: W0.dayAfter || (() => "") };
let fails = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  (got " + JSON.stringify(got)?.slice(0, 200) + ")"}`); if (!ok) fails++; };
const mem = () => { const m = new Map(); return { m, st: { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => m.delete(k), list: async ({ prefix = "" } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) } }; };
const now = Date.now();
const user = (m, uid, x = {}) => m.set("cz:u:" + uid, { uid, name: "N" + uid, ident: "id" + uid, bal: 1000, items: [], bets: [], created: now - 30 * 864e5, ...x });

// A1: a prop side like "constructor" has no real price; it must never be accepted or paid
{ const { m, st } = mem(), T = a => W.czTx(st, { now: new Date(now).toISOString(), ...a }); user(m, "A");
  const bad = { bid: "b1", lg: "mlb", gid: "g1", day: "20260927", start: new Date(now + 3600e3).toISOString(), side: "constructor", stake: 100, label: "x", prop: { key: "k1" } };
  const r = await T({ act: "bet", uid: "A", bet: bad });
  check("A1 a bet with no real price is refused", !!r.error && m.get("cz:u:A").bal === 1000, r);
  const r2 = await T({ act: "parlay", uid: "A", parlay: { bid: "p1", stake: 100, legs: [{ lg: "mlb", gid: "g1", dec: 2, start: bad.start }, { lg: "mlb", gid: "g2", start: bad.start }] } });
  check("A1 a parlay leg with no real price is refused", !!r2.error && m.get("cz:u:A").bal === 1000, r2);
  // a bet already stored with no price (placed before the fix) settles as a push, never NaN
  const U = m.get("cz:u:A"); U.bets = [{ bid: "old", lg: "mlb", gid: "g9", side: "constructor", stake: 100, res: null }]; U.bal = 900; m.set("cz:u:A", U);
  m.set("cz:open", [{ uid: "A", bid: "old", lg: "mlb", gid: "g9" }]);
  await W.czSettleTx(st, { act: "settle", now: new Date(now).toISOString(), results: [{ uid: "A", bid: "old", res: "win" }] });
  check("A1 an old priceless bet pays back its stake, not NaN", m.get("cz:u:A").bal === 1000, m.get("cz:u:A").bal);
  // an account whose balance is already NaN is repaired
  user(m, "Z", { bal: NaN }); const f = await W.czNanFixTx(st, { now });
  check("A1 broken balances are reset to 0 once", f.fixed === 1 && m.get("cz:u:Z").bal === 0 && (await W.czNanFixTx(st, { now })).already, f);
  user(m, "Y", { bal: NaN }); await T({ act: "daily", uid: "Y", day: "20260927", yday: "20260926" });
  check("A1 a NaN balance heals on the account's next action", Number.isFinite(m.get("cz:u:Y").bal), m.get("cz:u:Y").bal); }


const card = (id, n, x = {}) => ({ id, n, supply: 100, tier: "pulsar", lg: "nba", name: "X" + id, kind: "player", ...x });
// A2: an auction won by someone who already owns a copy doesn't give them a second one
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "S", { items: [card("nba.p1.pulsar", 5, { auction: "Q1" })] }); user(m, "B", { bal: 500, items: [card("nba.p1.pulsar", 9)] });
  m.set("cz:auc", [{ aid: "Q1", id: "nba.p1.pulsar", n: 5, seller: "S", bidder: "B", bid: 300, bT: false, ends: now - 1 }]); m.set("cz:lb", {});
  await T({ act: "aucsettle", uid: "S" });
  const B = m.get("cz:u:B"), S = m.get("cz:u:S");
  check("A2 an auction winner who already owns the card gets the bid back, the seller keeps the card", B.items.length === 1 && B.bal === 800 && S.items.length === 1 && !S.items[0].auction, { b: B.items.length, bal: B.bal, s: S.items.length }); }
// A2: a trade accept fails if the offerer already owns a card they asked for
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "F", { items: [card("nba.p2.pulsar", 1), card("nba.p3.pulsar", 4)] }); user(m, "U", { items: [card("nba.p3.pulsar", 7)] });
  m.set("cz:trades", [{ tid: "T1", from: "F", to: "U", status: "open", coins: 0, give: [card("nba.p2.pulsar", 1)], get: [card("nba.p3.pulsar", 7)] }]); m.set("cz:lb", {});
  const r = await T({ act: "tresp", uid: "U", tid: "T1", accept: true });
  check("A2 a trade that would give the offerer a second copy is called off", !!r.error && m.get("cz:u:F").items.length === 2 && m.get("cz:u:U").items.length === 1, r); }
// A2: selling one of two copies (an old duplicate) keeps the other and returns only the sold serial
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "D", { items: [card("nba.p4.pulsar", 3), card("nba.p4.pulsar", 8)] }); m.set("cz:lb", {});
  await T({ act: "sell", uid: "D", id: "nba.p4.pulsar", value: 100 });
  check("A2 selling removes one copy, not every copy with that id", m.get("cz:u:D").items.length === 1 && m.get("cz:ret")["nba.p4.pulsar"].length === 1, m.get("cz:u:D").items.length); }
// A3: a card in a battle lineup can't be listed; a bought card arrives without locks
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "A", { items: [card("nba.p5.pulsar", 2, { battle: "B1" })] }); m.set("cz:lb", {});
  const r = await T({ act: "list", uid: "A", id: "nba.p5.pulsar", price: 500 });
  check("A3 a card in a battle lineup can't be listed", !!r.error && !m.get("cz:u:A").items[0].listed, r);
  user(m, "S", { items: [card("nba.p6.pulsar", 2, { listed: "L1", battle: "old" })] }); user(m, "B", { bal: 1000 });
  m.set("cz:mkt", [{ lid: "L1", id: "nba.p6.pulsar", n: 2, uid: "S", price: 100 }]);
  await T({ act: "buyl", uid: "B", lid: "L1" });
  const got = m.get("cz:u:B").items[0];
  check("A3 a bought card arrives with no battle or market lock", got && !got.battle && !got.listed && !got.auction, got); }
// A4: deleting an account ends its battles: a challenge sent to it gives the stake back; one being judged is void
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "X", { bal: 0, items: [card("nba.p7.pulsar", 1, { battle: "B2" })] }); user(m, "Y", { bal: 0, items: [card("nba.p8.pulsar", 1, { battle: "B3" })] }); user(m, "Gone");
  m.set("cz:bat", [{ id: "B1", from: "Gone", status: "open", stake: 50, a: [] }, { id: "B2", from: "X", to: "Gone", status: "open", stake: 40, a: [{ id: "nba.p7.pulsar" }] },
    { id: "B3", from: "Y", by: "Gone", status: "judging", stake: 60, a: [{ id: "nba.p8.pulsar" }], b: [] }]); m.set("cz:lb", {}); m.set("cz:names", {});
  await T({ act: "delete", uid: "Gone" });
  const B = m.get("cz:bat");
  check("A4 the deleted account's challenges end and stakes come back", B[0].status === "cancelled" && B[1].status === "cancelled" && B[2].status === "void" && m.get("cz:u:X").bal === 40 && m.get("cz:u:Y").bal === 60 && !m.get("cz:u:X").items[0].battle, B.map(b => b.status));
  // a battle being judged whose joiner left is void when the verdict arrives
  user(m, "P", { bal: 0 }); m.set("cz:bat", [{ id: "B9", from: "P", by: "Nobody", status: "judging", stake: 25, a: [] }]);
  const r = await T({ act: "bdone", uid: "P", id: "B9", winner: "a" });
  check("A4 a verdict for a battle with a departed player voids it and refunds the stake", r.battle.status === "void" && m.get("cz:u:P").bal === 25, r.battle); }
// A5: accounts without a passkey can't bid, offer or accept trades, or battle players for coins
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "NP", { ident: undefined }); user(m, "S", { items: [card("nba.p9.pulsar", 1, { auction: "Q1" })] }); m.set("cz:names", { ns: "S", nnp: "NP" }); m.set("cz:lb", {});
  m.set("cz:auc", [{ aid: "Q1", id: "nba.p9.pulsar", seller: "S", start: 10, bid: 0, bidder: null, ends: now + 3600e3 }]);
  const bid = await T({ act: "aucbid", uid: "NP", aid: "Q1", amount: 50 });
  const off = await T({ act: "toffer", uid: "NP", to: "ns", give: [], get: ["nba.p9.pulsar"], coins: 10 });
  const off2 = await T({ act: "toffer", uid: "S", to: "nnp", give: ["nba.p9.pulsar"], get: [], coins: 0 });
  const bat = await T({ act: "bnew", uid: "NP", id: "bb", sport: "nba", cards: [], stake: 100, to: "ns", day: "20260927" });
  check("A5 no-passkey accounts can't bid, trade or stake coins against players", !!bid.error && !!off.error && !!off2.error && !!bat.error && m.get("cz:u:NP").bal === 1000, [bid.error, off.error, off2.error, bat.error]); }
// A6: the unlimited-coins tester can't sell cards to players
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a });
  user(m, "T", { tester: true, items: [card("nba.p10.pulsar", 1), card("nba.p11.pulsar", 1)] }); m.set("cz:lb", {});
  const l = await T({ act: "list", uid: "T", id: "nba.p10.pulsar", price: 100 }), au = await T({ act: "aucnew", uid: "T", id: "nba.p11.pulsar", start: 100, hours: 24 });
  check("A6 the tester account can't list or auction cards", !!l.error && !!au.error, [l.error, au.error]); }
// A7: on the night clocks go back, "yesterday" is still yesterday
check("A7 the day before is counted on the calendar", W.dayBefore("20261102") === "20261101" && W.dayBefore("20260301") === "20260228" && W.dayBefore("20270101") === "20261231" && W.dayAfter("20261231") === "20270101", W.dayBefore("20261102"));
// A8: malformed lists are refused cleanly instead of crashing
{ const { m, st } = mem(), T = a => W.czTx(st, { now, ...a }); user(m, "A"); m.set("cz:lb", {});
  let crashed = null; const tries = [{ act: "sellmany", uid: "A", cards: "nope" }, { act: "sellmany", uid: "A", cards: [null, 5] }, { act: "parlay", uid: "A", parlay: { stake: 50, legs: [null, null] } }, { act: "parlay", uid: "A", parlay: null }, { act: "toffer", uid: "A", to: "x", give: "abc" }];
  for (const a of tries) { try { const r = await T(a); if (!r || !r.error) crashed = crashed || { a, r }; } catch (e) { crashed = { a: a.act, e: e.message }; } }
  check("A8 malformed requests get an error, not a crash", !crashed, crashed); }
// B4: the battle judge uses a small model, never Opus, and doesn't call any model for battles against the AI
{ const src = (await import("fs")).readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  let called = 0; const env = { ANTHROPIC_API_KEY: "k", AI: { run: async () => { called++; return { response: "{}" }; } } };
  const v = await W.czJudge(env, { house: true, a: [card("nba.p1.pulsar", 1)], b: [card("nba.p2.pulsar", 1)], fromName: "A", sport: "nba" }, async () => { called++; return new Response("{}"); });
  check("B4 house battles call no model and still get a recap", called === 0 && v.judge === "formula" && v.report.length > 10, { called, judge: v.judge });
  check("B4 the judge model is small (not Opus)", /JUDGE_CLAUDE_MODEL = "claude-haiku-4-5"/.test(src) && !/claude-opus-5"/.test(src.match(/judge[\s\S]{0,400}/i)[0])); }
console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
