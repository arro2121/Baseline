// Round-2 review fixes (A1–A8, B4): each check fails on the code before the fix and passes after.
// Run: node alerts/test/test_round2.mjs
import * as W0 from "../worker.js";
// functions added by these fixes are stubbed on older code so every check still runs (and fails) there
const W = { ...W0, mlbEspnMatch: W0.mlbEspnMatch || (() => null), dhWaiting: W0.dhWaiting || (() => false), isOff: W0.isOff || (() => false), sportsDay: W0.sportsDay || (() => ""), normInjuries: W0.normInjuries || (() => ({})), czNanFixTx: W0.czNanFixTx || (async () => ({})), dayBefore: W0.dayBefore || (() => ""), dayAfter: W0.dayAfter || (() => "") };
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

// ---- batch 2: the shared score normalizers (used by the page and the alerts service) ----
// A11: postponed, cancelled and suspended games are marked off and never "completed"
{ const ev = (name, desc) => ({ id: "1", date: "2026-09-22T23:05Z", status: { type: { name, state: "post", completed: true, description: desc, detail: desc, shortDetail: desc } },
    competitions: [{ competitors: [{ homeAway: "home", score: "0", team: { id: "1", displayName: "Baltimore Orioles" } }, { homeAway: "away", score: "0", team: { id: "2", displayName: "Toronto Blue Jays" } }] }] });
  const B = W.normScoreboard ? W.normScoreboard({ events: [ev("STATUS_POSTPONED", "Postponed"), { ...ev("STATUS_FINAL", "Final"), id: "2" }] }, "mlb") : null;
  const g = B && (B.games || B)[0], f = B && (B.games || B)[1];
  check("A11 a postponed game is off and not completed; a final isn't", !!g && g.status.off === true && !g.status.completed && !f.status.off && f.status.completed, g && g.status);
  const T = W.normTeam({ id: "1", displayName: "Baltimore Orioles" }, { events: [ev("STATUS_POSTPONED", "Postponed")] }, null, "mlb");
  check("A11 team schedules mark postponed games too", T.games[0].off === true, T.games[0]); }
// A13: a soccer schedule that arrives newest-first is put in date order, and fixtures are fetched and merged
{ const mk = (id, date, st) => ({ id, date, status: { type: { state: st } }, competitions: [{ competitors: [{ homeAway: "home", id: "9", team: { id: "9" } }, { homeAway: "away", team: { id: "8", displayName: "Other" } }] }] });
  const results = { events: [mk("3", "2026-09-20T14:00Z", "post"), mk("2", "2026-08-30T14:00Z", "post"), mk("1", "2026-08-23T14:00Z", "post")] };
  const fixtures = { events: [mk("4", "2026-09-27T14:00Z", "pre"), mk("5", "2026-10-04T14:00Z", "pre")] };
  const fx = async url => new Response(JSON.stringify(/fixture=true/.test(url) ? fixtures : /schedule/.test(url) ? results : /roster/.test(url) ? {} : { team: { id: "9", displayName: "Manchester City" } }));
  const t = await W.espnTeam("epl", "9", fx), ids = t.games.map(x => x.id).join();
  const last = [...t.games].reverse().find(x => x.state === "post");
  check("A13 Premier League team games are in date order with upcoming fixtures", ids === "1,2,3,4,5" && last.id === "3", ids); }
// A14/A15: the sports day is the Eastern-time date with a 6 am cutoff, whatever the device's zone
check("A14 the sports day is Eastern time with a 6 am cutoff", W.sportsDay(Date.parse("2026-09-27T03:30:00Z")) === "20260926" && W.sportsDay(Date.parse("2026-09-27T09:30:00Z")) === "20260926" && W.sportsDay(Date.parse("2026-09-27T10:30:00Z")) === "20260927", W.sportsDay(Date.parse("2026-09-27T03:30:00Z")));
check("A15 daylight saving is handled (EST after Nov 1)", W.sportsDay(Date.parse("2026-11-03T10:30:00Z")) === "20261102" && W.sportsDay(Date.parse("2026-11-03T11:30:00Z")) === "20261103", W.sportsDay(Date.parse("2026-11-03T10:30:00Z")));
// A9: the injury report can be computed from ESPN's data by the page itself
{ const r = W.normInjuries("nba", { injuries: [{ displayName: "Lakers", injuries: [{ athlete: { displayName: "Star Guy", position: { abbreviation: "G" } }, status: "Out" }] }] }, new Map([["star guy", { pool: "guards", rank: 0, size: 50 }]]));
  check("A9 injuries are computed from ESPN's report without the alerts service", r.teams && r.teams.Lakers && r.teams.Lakers.pen > 0, r); }

// ---- batch 3 ----
// A10: doubleheader game 2 gets game 2's line and waits for game 1 to finish
{ const tm = (h, a) => ({ home: { name: h }, away: { name: a } });
  const espn = [{ ...tm("New York Yankees", "Baltimore Orioles"), date: "2026-09-25T17:05Z", odds: { details: "G1" } }, { ...tm("New York Yankees", "Baltimore Orioles"), date: "2026-09-25T23:05Z", odds: { details: "G2" } }];
  const g1 = { ...tm("New York Yankees", "Baltimore Orioles"), date: "2026-09-25T17:05Z", gnum: 1, dh: "Y", status: { state: "in" } };
  const g2 = { ...tm("New York Yankees", "Baltimore Orioles"), date: "2026-09-25T17:05Z", gnum: 2, dh: "Y", status: { state: "pre" } };   // placeholder time
  check("A10 game 2 of a doubleheader gets game 2's line", W.mlbEspnMatch(espn, g2)?.odds?.details === "G2" && W.mlbEspnMatch(espn, g1)?.odds?.details === "G1", W.mlbEspnMatch(espn, g2));
  check("A10 game 2 isn't locked while game 1 is still going", W.dhWaiting(g2, [g1, g2]) === true && W.dhWaiting(g2, [{ ...g1, status: { state: "post" } }, g2]) === false); }

// ---- batch 4 ----
// B3: when the free AI allowance is used up, the voice says it's resting (so the app can say so) instead of a bare failure
{ globalThis.caches = globalThis.caches || { default: { match: async () => undefined, put: async () => {} } };
  const env = { KV: { get: async () => null, put: async () => {} }, AI: { run: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } } };
  const r = await W0.default.fetch(new Request("https://w.dev/tts", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" }, body: JSON.stringify({ text: "Touchdown, Chiefs!" }) }), env, { waitUntil() {} });
  const j = await r.json().catch(() => ({}));
  check("B3 the voice reports it's resting when the daily AI allowance is used up", r.status === 503 && j.error === "resting", [r.status, j.error]); }
// BK1-BK3: backups of the whole Store, restore, and the undo backup a restore takes first
{ const { m, st } = mem(); st.list = async ({ prefix = "" } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
  st.delete = async k => Array.isArray(k) ? k.forEach(x => m.delete(x)) : m.delete(k); const put0 = st.put; st.put = async (k, v) => typeof k === "object" ? Object.entries(k).forEach(([a, b]) => m.set(a, structuredClone(b))) : put0(k, v);
  const kv = new Map(), env = { KV: { get: async (k, o) => { const v = kv.get(k); if (v == null) return null; return o && o.type === "arrayBuffer" ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v; }, put: async (k, v) => { kv.set(k, v); } } };
  user(m, "A", { items: [{ id: "nba.p1.pulsar", n: 3, gr: 9 }] }); m.set("cz:mkt", [{ lid: "L1" }]); m.set("rl:x", [now]);
  const b = await W0.czBackupTake(st, env, { now, why: "test" }), idx = JSON.parse(kv.get("bk:index"));
  check("BK1 a backup keeps every record but the attempt counters, gzipped, and is listed", b.keys === 2 && b.bytes > 0 && b.bytes < b.raw + 50 && idx[0].id === b.id && idx[0].until > now, b);
  m.get("cz:u:A").items = []; m.set("cz:u:A", { ...m.get("cz:u:A"), bal: 5, items: [] }); m.set("cz:u:Z", { uid: "Z" }); m.delete("cz:mkt");
  const r = await W0.czBackupRestore(st, env, { id: b.id, now });
  check("BK2 a restore brings back the saved records exactly and removes ones made since", m.get("cz:u:A").bal === 1000 && m.get("cz:u:A").items[0].gr === 9 && m.get("cz:mkt")[0].lid === "L1" && !m.has("cz:u:Z") && m.has("rl:x") && r.removed === 1, r);
  const idx2 = JSON.parse(kv.get("bk:index")), undo = idx2.find(x => x.id === r.undo);
  check("BK3 a restore first backs up what it replaces, so it can be undone", !!undo && /before restoring/.test(undo.why) && (await W0.czBackupRead(env, r.undo)) !== null, idx2);
  check("BK3 the restored backup is still there too (the undo never replaces it)", idx2.some(x => x.id === b.id) && r.undo !== b.id);
  // an account deleted after the backup stays deleted when that backup is restored
  kv.set("bk:deleted", JSON.stringify([{ uid: "A", at: now + 5000 }]));
  const r2 = await W0.czBackupRestore(st, env, { id: b.id, now: now + 6000 });
  check("BK4 a restore never brings back an account deleted since the backup", r2.redeleted === 1 && !m.has("cz:u:A") && m.get("cz:mkt")[0].lid === "L1", [r2, [...m.keys()]]);
  check("BK3 an unknown backup is refused", !!(await W0.czBackupRestore(st, env, { id: "nope" })).error); }
// QS1-QS3: Daily Quests: counted after an action succeeds, collected once, the bonus only when all three are collected
{ const { m, st } = mem(); let t = Date.UTC(2026, 8, 28, 16), day;
  for (let i = 0; i < 60; i++, t += 864e5) { const d = new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, ""); if (W0.czQuestIds(d).includes("list")) { day = d; break; } }
  const T = a => W0.czTx(st, { now: t, ...a }); user(m, "Q", { items: [card("nba.q1.pulsar"), card("nba.q2.pulsar")] });
  const ids = W0.czQuestIds(day), Q = W0.CZ_QUESTS.find(x => x.id === "list");
  check("QS1 three different quests a day, the same for everyone", ids.length === 3 && new Set(ids).size === 3 && W0.czQuestIds(day).join() === ids.join());
  check("QS1 an unfinished quest can't be collected", /Finish/.test((await T({ act: "qclaim", uid: "Q", id: "list" })).error || ""));
  const bad = await T({ act: "list", uid: "Q", id: "nba.nope.pulsar", price: 100 });
  check("QS2 a failed action doesn't count", !!bad.error && !(m.get("cz:u:Q").qd?.p?.list));
  const ok = await T({ act: "list", uid: "Q", id: "nba.q1.pulsar", price: 100 });
  check("QS2 a listing moves the quest and the answer shows it", !ok.error && m.get("cz:u:Q").qd.p.list === 1 && ok.user.quests.list.find(x => x.id === "list").have === 1, [ok.error, m.get("cz:u:Q").qd]);
  const bal = m.get("cz:u:Q").bal, c = await T({ act: "qclaim", uid: "Q", id: "list" });
  check("QS3 collecting pays the reward once", c.reward === Q.reward && m.get("cz:u:Q").bal === bal + Q.reward && /Already/.test((await T({ act: "qclaim", uid: "Q", id: "list" })).error || ""), c);
  check("QS3 the all-three bonus waits for all three", /all three/.test((await T({ act: "qclaim", uid: "Q", id: "all" })).error || ""));
  check("QS3 only today's quests can be collected", /today/.test((await T({ act: "qclaim", uid: "Q", id: W0.CZ_QUESTS.find(x => !ids.includes(x.id)).id })).error || "")); }
console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
