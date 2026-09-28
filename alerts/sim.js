/* Cosmic Games: two lineups of cards play out a whole game of their sport (nine innings, four quarters, three periods,
   ninety minutes, or a tennis team match), play by play.

   How strong a side is comes only from its cards' ratings (rarity, level and how good the real athlete or team is), as the
   average over five slots, with an empty slot counting as a replacement-level 50. Every outcome on the field is drawn from
   the two sides' strengths, so the stronger lineup usually wins and upsets happen. Positions decide who gets the credit (a
   pitcher pitches, a goalie saves, a quarterback throws), never the odds, so two lineups of equal strength are a true
   50/50 whatever their positions. That keeps games against Cosmo AI fair: its lineup is rated to match yours.

   Everything is drawn from a seeded random stream: the same seed and lineups replay the same game, pitch for pitch. */

export const SIM_V = 1;
export const SIM_TIER = { comet: 60, stardust: 64, pulsar: 68, nebula: 72, quasar: 77, supernova: 83, singularity: 90 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// a card's game rating (40 to 99): its tier, +1.5 a level, and up to -4/+6 for the real athlete (this season's rating) or
// team (its value multiplier, which follows the team's rating)
export function simRating(c, cat) {
  const base = SIM_TIER[c.tier] || 60, lvl = Math.min(9, 1.5 * ((c.level || 1) - 1));
  let q = 0;
  if (cat && +cat.ovr) q = clamp((+cat.ovr - 78) / 3, -4, 6);
  else if (cat && +cat.mult) q = clamp((+cat.mult - 1) * 5, -4, 6);
  return Math.round(clamp(base + lvl + q, 40, 99));
}
export const simStrength = cards => { const r = (cards || []).map(c => +c.r || 50).sort((a, b) => b - a).slice(0, 5); while (r.length < 5) r.push(50); return r.reduce((s, x) => s + x, 0) / 5; };

export function simRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const wpick = (R, list, w) => { const ws = list.map(w), tot = ws.reduce((s, x) => s + x, 0); let x = R() * tot; for (let i = 0; i < list.length; i++) { x -= ws[i]; if (x <= 0) return list[i]; } return list[list.length - 1]; };
const ri = (R, a, b) => a + Math.floor(R() * (b - a + 1));
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const grade = gs => Math.round(clamp(gs, 1, 10) * 10) / 10;

// a side's people: its cards (who get the credit) plus unnamed teammates to fill out the field
function people(cards, fill) {
  const out = (cards || []).filter(c => c.kind !== "team").map(c => ({ id: c.id, name: c.name, pos: String(c.pos || ""), r: +c.r || 60, card: true, st: {} }));
  for (let i = 0; i < fill; i++) out.push({ id: null, name: null, pos: "", r: 55, card: false, st: {} });
  return out;
}
const nm = (p, generic) => p && p.name ? p.name : generic;

// ---------------------------------------------------------------- baseball
const PITCH = /^(P|SP|RP|TWP)$/;
function baseball(R, A, B, sa, sb, names) {
  const home = R() < .5 ? "a" : "b", away = home === "a" ? "b" : "a", S = { a: sa, b: sb }, side = { a: A, b: B };
  const lineup = {}, staff = {};
  for (const s of ["a", "b"]) {
    const ps = people(side[s], 0), hit = ps.filter(p => !PITCH.test(p.pos) || p.pos === "TWP").sort((x, y) => y.r - x.r), pit = ps.filter(p => PITCH.test(p.pos)).sort((x, y) => y.r - x.r);
    const order = new Array(9).fill(null), slots = [2, 3, 1, 4, 0, 5, 6, 7, 8];
    hit.slice(0, 9).forEach((p, i) => { order[slots[i]] = p; });
    for (let i = 0; i < 9; i++) if (!order[i]) order[i] = { id: null, name: null, r: 55, card: false, st: {}, slot: i + 1 };
    order.forEach((p, i) => p.slot = i + 1);
    lineup[s] = { order, at: 0 };
    const arm = p => ({ ...p, st: {} }), pc = pit.map(arm);
    staff[s] = { start: pc[0] || { name: null, card: false, st: {} }, pen: pc[1] || { name: null, card: false, st: {} }, cards: pc };
  }
  const line = { a: [], b: [] }, score = { a: 0, b: 0 }, ev = [];
  const who = p => p.name || `the ${ord(p.slot)} hitter`;
  const tally = (p, k, n = 1) => { p.st[k] = (p.st[k] || 0) + n; };
  let inn = 0, over = false;
  while (!over) {
    inn++;
    for (const bat of [away, home]) {
      if (bat === home && inn >= 9 && score[home] > score[away]) { line[home].push("X"); continue; }
      const fld = bat === "a" ? "b" : "a", d = (S[bat] - S[fld]) / 10, L = lineup[bat];
      const P = staff[fld], pit = (inn <= 6 || (P.start.card && inn <= 7)) ? P.start : P.pen;
      let outs = 0, runs = 0, bases = [null, null, null], ks = 0;
      if (inn >= 10) bases[1] = L.order[(L.at + 8) % 9];                            // extra innings: a runner starts on second
      const k = .22 * Math.exp(-.2 * d), bb = .08 * Math.exp(.1 * d), hr = .031 * Math.exp(.32 * d), dbl = .046 * Math.exp(.16 * d), tri = .004, sgl = .148 * Math.exp(.12 * d);
      const scoreRun = (r, bt, what) => { runs++; score[bat]++; if (r) tally(r, "R"); if (bt) tally(bt, "RBI"); tally(pit, "ER"); };
      while (outs < 3) {
        const b = L.order[L.at % 9]; L.at++; const x = R(); let text = null, before = score[bat];
        tally(b, "PA");
        if (x < k) { outs++; ks++; tally(b, "AB"); tally(b, "K"); tally(pit, "K"); tally(pit, "OUT"); if (b.card && R() < .35) text = `${who(b)} strikes out`; }
        else if (x < k + bb) { tally(b, "BB"); tally(pit, "BB"); if (bases[0] && bases[1] && bases[2]) scoreRun(bases[2], b); bases = bases[0] ? (bases[1] ? [b, bases[0], bases[1]] : [b, bases[0], bases[2]]) : [b, bases[1], bases[2]];
          if (score[bat] > before) text = `${who(b)} draws a bases-loaded walk`; }
        else if (x < k + bb + hr) { tally(b, "AB"); tally(b, "H"); tally(b, "HR"); tally(pit, "H"); const n = bases.filter(Boolean).length; for (const r of bases) if (r) scoreRun(r, b); scoreRun(b, b); bases = [null, null, null];
          text = n === 3 ? `${who(b)} hits a GRAND SLAM` : n ? `${who(b)} hits a ${n + 1}-run homer` : `${who(b)} homers`; }
        else if (x < k + bb + hr + tri) { tally(b, "AB"); tally(b, "H"); tally(pit, "H"); for (const r of bases) if (r) scoreRun(r, b); bases = [null, null, b]; text = `${who(b)} triples${score[bat] > before ? `, ${score[bat] - before === 1 ? "a run scores" : score[bat] - before + " runs score"}` : ""}`; }
        else if (x < k + bb + hr + tri + dbl) { tally(b, "AB"); tally(b, "H"); tally(b, "2B"); tally(pit, "H"); if (bases[2]) scoreRun(bases[2], b); if (bases[1]) scoreRun(bases[1], b); const f = bases[0]; bases = [null, b, null]; if (f) { if (R() < .4) scoreRun(f, b); else bases[2] = f; }
          text = score[bat] > before ? `${who(b)} doubles, ${score[bat] - before === 1 ? "a run scores" : score[bat] - before + " runs score"}` : b.card ? `${who(b)} doubles` : null; }
        else if (x < k + bb + hr + tri + dbl + sgl) { tally(b, "AB"); tally(b, "H"); tally(pit, "H"); if (bases[2]) scoreRun(bases[2], b); const s2 = bases[1], s1 = bases[0]; bases = [b, null, null];
          if (s2) { if (R() < .6) scoreRun(s2, b); else bases[2] = s2; } if (s1) { if (!bases[2] && R() < .3) bases[2] = s1; else bases[1] = s1; }
          text = score[bat] > before ? `${who(b)} singles, ${score[bat] - before === 1 ? "a run scores" : score[bat] - before + " runs score"}` : b.card && R() < .5 ? `${who(b)} singles` : null; }
        else { tally(b, "AB"); outs++; tally(pit, "OUT");
          if (R() < .45) { if (bases[0] && outs < 3 && R() < .3) { outs++; tally(pit, "OUT"); bases[0] = null; if (outs < 3 && b.card) text = `${who(b)} grounds into a double play`; }
            else if (bases[2] && outs < 3 && R() < .4) { scoreRun(bases[2], b); bases[2] = null; text = `${who(b)} drives in a run on a groundout`; } }
          else if (bases[2] && outs < 3 && R() < .5) { scoreRun(bases[2], b); bases[2] = null; text = `${who(b)} hits a sacrifice fly`; } }
        if (text) ev.push({ p: `${bat === away ? "Top" : "Bottom"} ${ord(inn)}`, s: bat, t: text, k: score[bat] > before ? "score" : "hl", sc: [score.a, score.b], who: b.card ? b.id : null });
        if (bat === home && inn >= 9 && score[home] > score[away]) { ev.push({ p: `Bottom ${ord(inn)}`, s: bat, t: "Walk-off! The game is over", k: "end", sc: [score.a, score.b] }); break; }
      }
      if (ks === 3 && pit.card) ev.push({ p: `${bat === away ? "Top" : "Bottom"} ${ord(inn)}`, s: fld, t: `${pit.name} strikes out the side`, k: "hl", sc: [score.a, score.b], who: pit.id });
      line[bat].push(runs);
    }
    if (inn >= 9 && score.a !== score.b) over = true;
    if (inn >= 20 && score.a === score.b) {                                      // the longest game ends with one more run
      const w = R() < .5 ? "a" : "b"; score[w]++; line[w][line[w].length - 1]++; ev.push({ p: `${ord(inn)} inning`, s: w, t: "A run scores to end a marathon", k: "score", sc: [score.a, score.b] }); over = true; }
  }
  const box = {};
  for (const s of ["a", "b"]) {
    const rows = [];
    for (const p of lineup[s].order.filter(p => p.card)) { const t = p.st, H = t.H || 0, AB = t.AB || 0;
      const bits = [`${H}-${AB}`]; if (t.HR) bits.push(t.HR > 1 ? `${t.HR} HR` : "HR"); if (t["2B"]) bits.push(t["2B"] > 1 ? `${t["2B"]} 2B` : "2B"); if (t.RBI) bits.push(`${t.RBI} RBI`); if (t.R) bits.push(`${t.R} R`); if (t.BB) bits.push(`${t.BB} BB`);
      rows.push({ id: p.id, name: p.name, line: bits.join(", "), g: grade(5.2 + H * 1.1 + (t.HR || 0) * 1.4 + (t["2B"] || 0) * .4 + (t.RBI || 0) * .7 + (t.R || 0) * .4 + (t.BB || 0) * .4 - (AB - H) * .45 - (t.K || 0) * .2) }); }
    for (const p of staff[s].cards) { const t = p.st, o = t.OUT || 0; if (!o && !t.H && !t.ER) { rows.push({ id: p.id, name: p.name, line: "Didn't pitch", g: 5 }); continue; }
      rows.push({ id: p.id, name: p.name, line: `${Math.floor(o / 3)}${o % 3 ? "." + (o % 3) : ""} IP, ${t.H || 0} H, ${t.ER || 0} R, ${t.K || 0} K`, g: grade(5 + o / 3 * .45 + (t.K || 0) * .25 - (t.ER || 0) * .9 - (t.H || 0) * .12 - (t.BB || 0) * .15) }); }
    box[s] = rows;
  }
  return { periods: line.a.map((_, i) => String(i + 1)), line, score, ev, box, home, note: inn > 9 ? `F/${inn}` : "Final", unit: inn > 9 ? `${inn} innings` : "9 innings" };
}

// ---------------------------------------------------------------- basketball
function basketball(R, A, B, sa, sb, names, college) {
  const S = { a: sa, b: sb }, P = { a: people(A, 0), b: people(B, 0) };
  for (const s of ["a", "b"]) { while (P[s].length < 8) P[s].push({ id: null, name: null, r: 55, card: false, st: {} }); }
  const per = college ? 2 : 4, poss = college ? 35 : 25, plab = i => i < per ? (college ? `${ord(i + 1)} half` : `Q${i + 1}`) : `OT${i - per + 1 > 1 ? i - per + 1 : ""}`;
  const line = { a: [], b: [] }, score = { a: 0, b: 0 }, ev = [];
  const use = p => Math.pow(p.r / 55, 4), tally = (p, k, n = 1) => { p.st[k] = (p.st[k] || 0) + n; };
  let q = 0;
  const period = n => { const pts = { a: 0, b: 0 }, first = R() < .5 ? "a" : "b";
    for (let i = 0; i < n * 2; i++) { const o = i % 2 ? (first === "a" ? "b" : "a") : first, dfn = o === "a" ? "b" : "a", d = (S[o] - S[dfn]) / 10, clutch = q >= per - 1 && i >= n * 2 - 10 && Math.abs(score.a - score.b) <= 6;
      if (R() < .13 * Math.exp(-.12 * d)) { const p = wpick(R, P[o], use); tally(p, "TO"); continue; }
      for (let tries = 0; tries < 3; tries++) {
        const sh = wpick(R, P[o], use), x = R(), before = score[o];
        let made = 0, text = null;
        if (x < .12) { const m = (R() < .78 ? 1 : 0) + (R() < .78 ? 1 : 0); made = m; tally(sh, "PTS", m); if (m && sh.card && clutch) text = `${sh.name} hits ${m === 2 ? "both" : "one of two"} at the line`; }
        else if (x < .12 + .36) { if (R() < .355 + .03 * d) { made = 3; tally(sh, "PTS", 3); tally(sh, "3PM"); if (sh.card) text = `${sh.name} drains a three`; } }
        else if (R() < .52 + .035 * d) { made = 2; tally(sh, "PTS", 2); if (R() < .05) { made++; tally(sh, "PTS"); if (sh.card) text = `${sh.name} scores and gets the foul: and-one`; } else if (sh.card && sh.r >= 80 && R() < .25) text = `${sh.name} throws down a dunk`; else if (sh.card && clutch) text = `${sh.name} scores inside`; }
        if (made) { score[o] += made; pts[o] += made;
          if (x >= .12 && R() < .6) { const as = wpick(R, P[o].filter(p => p !== sh), use); tally(as, "AST"); if (text && as.card && R() < .5) text += ` (${as.name} with the assist)`; }
          if (text) ev.push({ p: plab(q), s: o, t: text, k: "score", sc: [score.a, score.b], who: sh.id }); break; }
        if (R() < .26) { tally(wpick(R, P[o], use), "REB"); continue; }
        tally(wpick(R, P[dfn], use), "REB"); break;
      } }
    line.a.push(pts.a); line.b.push(pts.b); };
  for (q = 0; q < per; q++) { period(poss); ev.push({ p: plab(q), s: null, t: `End of ${college ? `the ${ord(q + 1)} half` : q === 1 ? "the first half" : `the ${ord(q + 1)} quarter`}`, k: "end", sc: [score.a, score.b] }); }
  while (score.a === score.b && q < per + 6) { period(college ? 7 : 6); ev.push({ p: plab(q), s: null, t: `End of overtime`, k: "end", sc: [score.a, score.b] }); q++; }
  if (score.a === score.b) { const w = R() < .5 ? "a" : "b"; score[w]++; line[w][line[w].length - 1]++; ev.push({ p: plab(q - 1), s: w, t: "A free throw at the buzzer wins it", k: "score", sc: [score.a, score.b] }); }
  const box = {};
  for (const s of ["a", "b"]) box[s] = P[s].filter(p => p.card).map(p => { const t = p.st, bits = [`${t.PTS || 0} PTS`, `${t.REB || 0} REB`, `${t.AST || 0} AST`]; if (t["3PM"]) bits.push(`${t["3PM"]} 3PM`);
    return { id: p.id, name: p.name, line: bits.join(", "), g: grade(3 + (t.PTS || 0) * .19 + (t.REB || 0) * .16 + (t.AST || 0) * .2 - (t.TO || 0) * .25) }; });
  return { periods: line.a.map((_, i) => plab(i).replace(/ half$/, "H").replace(/^(\d)(st|nd)H$/, "$1H")), line, score, ev, box, note: q > per ? (q - per > 1 ? `F/${q - per}OT` : "F/OT") : "Final", unit: q > per ? "overtime" : college ? "two halves" : "four quarters" };
}

// ---------------------------------------------------------------- football
const QB = /^QB$/, RB = /^(RB|FB)$/, REC = /^(WR|TE)$/, DEF = /^(DE|DT|LB|CB|S|DB|DL|NT|OLB|ILB|MLB|FS|SS)$/, KICK = /^(PK|K)$/;
function football(R, A, B, sa, sb, names) {
  const S = { a: sa, b: sb }, P = { a: people(A, 0), b: people(B, 0) }, role = (s, re) => P[s].filter(p => re.test(p.pos));
  const line = { a: [0, 0, 0, 0], b: [0, 0, 0, 0] }, score = { a: 0, b: 0 }, ev = [], tally = (p, k, n = 1) => { if (p) p.st[k] = (p.st[k] || 0) + n; };
  const w = p => Math.pow(p.r / 55, 3), one = (s, re) => { const l = role(s, re); return l.length ? wpick(R, l, w) : null; };
  let t = 0, off = R() < .5 ? "a" : "b", q = 0;
  const drive = (o, ot) => { const dfn = o === "a" ? "b" : "a", d = (S[o] - S[dfn]) / 10, x = R(), qb = one(o, QB), before = score[o], per = ot ? "OT" : `Q${q + 1}`;
    const pTD = .21 * Math.exp(.34 * d), pFG = .14, pTO = .11 * Math.exp(-.28 * d);
    const credit = yds => { const pass = R() < .62; if (pass) { tally(qb, "PY", yds); tally(one(o, REC), "RY", yds); } else tally(one(o, RB), "RU", yds); return pass; };
    let text = null;
    if (x < pTD) { const yds = ri(R, 1, 75), pass = credit(ri(R, 45, 80)); let who;
      if (pass) { const rc = one(o, REC); tally(qb, "PTD"); tally(rc, "TD"); who = rc ? `${qb ? qb.name + " finds " : ""}${rc.name} for a ${yds}-yard touchdown` : qb ? `${qb.name} throws a ${yds}-yard touchdown` : null; }
      else { const rb = one(o, RB) || (R() < .3 ? qb : null); tally(rb, "TD"); who = rb ? `${rb.name} runs it in from ${yds}` : null; }
      score[o] += R() < .94 ? 7 : 6; text = (who || `A ${yds}-yard touchdown`) + (score[o] - before === 6 ? " (the extra point misses)" : ""); }
    else if (x < pTD + pFG) { const dist = ri(R, 22, 54), k = one(o, KICK); credit(ri(R, 25, 50)); tally(k, "FGA");
      if (R() < .96 - (dist - 22) * .013) { score[o] += 3; tally(k, "FG"); text = `${k ? k.name + " kicks" : "A"} ${dist}-yard field goal${k ? "" : " is good"}`; }
      else text = `${k ? k.name + "'s" : "A"} ${dist}-yard field goal is no good`; }
    else if (x < pTD + pFG + pTO) { credit(ri(R, 0, 25)); const df = one(dfn, DEF);
      if (R() < .62) { tally(qb, "INT"); tally(df, "DINT"); text = df ? `${df.name} intercepts${qb ? " " + qb.name : ""}` : qb ? `${qb.name} is intercepted` : "An interception"; if (df && R() < .12) { score[dfn] += 7; line[dfn][Math.min(q, 3)] += 7; ev.push({ p: per, s: dfn, t: `${text} and takes it back for a touchdown`, k: "score", sc: [score.a, score.b], who: df.id }); return; } }
      else { text = df ? `${df.name} forces a fumble` : "A fumble, and the defense recovers"; if (df) tally(df, "FF"); } if (!df && !qb) text = null; }
    else { credit(ri(R, 0, 35)); const df = one(dfn, DEF); if (df && R() < .35) { tally(df, "SACK"); tally(qb, "SACKED"); if (R() < .6) text = `${df.name} sacks${qb ? " " + qb.name : " the quarterback"}`; } }
    if (score[o] > before) line[o][Math.min(q, 3)] += score[o] - before;
    if (text) ev.push({ p: per, s: score[o] > before ? o : x >= pTD + pFG ? dfn : o, t: text, k: score[o] > before ? "score" : "hl", sc: [score.a, score.b], who: null });
  };
  const drives = 24 + ri(R, -2, 2);
  for (let i = 0; i < drives; i++) { q = Math.min(3, Math.floor(i / drives * 4)); drive(off); off = off === "a" ? "b" : "a";
    if (i + 1 < drives && Math.floor((i + 1) / drives * 4) > q) ev.push({ p: `Q${q + 1}`, s: null, t: q === 1 ? "Halftime" : `End of the ${ord(q + 1)} quarter`, k: "end", sc: [score.a, score.b] }); }
  let ot = 0;
  if (score.a === score.b) { line.a.push(0); line.b.push(0); ev.push({ p: "Q4", s: null, t: "Tied at the end of regulation: overtime", k: "end", sc: [score.a, score.b] }); q = 4;
    for (; ot < 8 && score.a === score.b; ot++) { drive(off, true); off = off === "a" ? "b" : "a"; }
    if (score.a === score.b) { const w = R() < .5 ? "a" : "b"; score[w] += 3; line[w][4] += 3; ev.push({ p: "OT", s: w, t: "A walk-off field goal ends it", k: "score", sc: [score.a, score.b] }); } }
  const box = {};
  for (const s of ["a", "b"]) box[s] = P[s].filter(p => p.card).map(p => { const t = p.st, bits = [];
    if (t.PY) bits.push(`${t.PY} pass yds`); if (t.PTD) bits.push(`${t.PTD} TD pass${t.PTD > 1 ? "es" : ""}`); if (t.INT) bits.push(`${t.INT} INT`);
    if (t.RU) bits.push(`${t.RU} rush yds`); if (t.RY) bits.push(`${t.RY} rec yds`); if (t.TD) bits.push(`${t.TD} TD`);
    if (t.SACK) bits.push(`${t.SACK} sack${t.SACK > 1 ? "s" : ""}`); if (t.DINT) bits.push(`${t.DINT} INT`); if (t.FF) bits.push("forced fumble");
    if (t.FGA) bits.push(`${t.FG || 0}/${t.FGA} FG`);
    const gs = 5 + (t.PY || 0) / 70 + (t.PTD || 0) * .8 - (t.INT || 0) * 1.2 + ((t.RU || 0) + (t.RY || 0)) / 30 + (t.TD || 0) * 1.1 + (t.SACK || 0) * 1 + (t.DINT || 0) * 1.6 + (t.FF || 0) * 1 + (t.FG || 0) * .6 - ((t.FGA || 0) - (t.FG || 0)) * .8 - (t.SACKED || 0) * .15;
    return { id: p.id, name: p.name, line: bits.join(", ") || "Quiet day", g: grade(gs) }; });
  return { periods: line.a.map((_, i) => i < 4 ? String(i + 1) : "OT"), line, score, ev, box, note: ot ? "F/OT" : "Final", unit: ot ? "overtime" : "four quarters" };
}

// ---------------------------------------------------------------- hockey
function hockey(R, A, B, sa, sb, names) {
  const S = { a: sa, b: sb }, P = { a: people(A, 0), b: people(B, 0) };
  for (const s of ["a", "b"]) { while (P[s].filter(p => p.pos !== "G").length < 6) P[s].push({ id: null, name: null, pos: "F", r: 55, card: false, st: {} }); }
  const G = s => P[s].filter(p => p.pos === "G").sort((x, y) => y.r - x.r)[0] || null;
  const shw = p => p.pos === "G" ? 0 : Math.pow(p.r / 55, 3) * (p.pos === "D" ? .5 : 1);
  const line = { a: [], b: [] }, score = { a: 0, b: 0 }, ev = [], tally = (p, k, n = 1) => { if (p) p.st[k] = (p.st[k] || 0) + n; };
  const minute = (s, per, min, rate, pp) => { const o = s === "a" ? "b" : "a", d = (S[s] - S[o]) / 10;
    if (R() < rate * Math.exp(.1 * d)) { const sh = wpick(R, P[s], shw), g = G(o); tally(sh, "SOG"); tally(g, "SA");
      if (R() < .092 * Math.exp(.22 * d) * (pp ? 1.8 : 1)) { score[s]++; line[s][line[s].length - 1]++; tally(sh, "G"); tally(g, "GA");
        const as = P[s].filter(p => p !== sh && p.pos !== "G"), a1 = R() < .85 ? wpick(R, as, shw) : null; if (a1) tally(a1, "A");
        const who = sh.name ? `${sh.name} scores${pp ? " on the power play" : ""}${a1 && a1.name ? ` (from ${a1.name})` : ""}` : a1 && a1.name ? `${a1.name} sets up a goal${pp ? " on the power play" : ""}` : `A goal${pp ? " on the power play" : ""}`;
        ev.push({ p: per, s, t: `${who}, ${min - 1}:${String(ri(R, 0, 59)).padStart(2, "0")}`, k: "score", sc: [score.a, score.b], who: sh.id }); return true; }
      tally(g, "SV"); if (g && g.card && R() < .06) ev.push({ p: per, s: o, t: `${g.name} makes a huge save`, k: "hl", sc: [score.a, score.b], who: g.id }); }
    return false; };
  const pl = ["1st", "2nd", "3rd"];
  for (let p = 0; p < 3; p++) { line.a.push(0); line.b.push(0); let pp = null;
    for (let m = 1; m <= 20; m++) { if (!pp && R() < .035) pp = { s: R() < .5 ? "a" : "b", until: m + 2 };
      for (const s of R() < .5 ? ["a", "b"] : ["b", "a"]) minute(s, pl[p], m, .52, pp && pp.s === s);
      if (pp && m >= pp.until) pp = null; }
    ev.push({ p: pl[p], s: null, t: `End of the ${pl[p]} period`, k: "end", sc: [score.a, score.b] }); }
  let note = "Final", unit = "three periods";
  if (score.a === score.b) { line.a.push(0); line.b.push(0); note = "F/OT"; unit = "overtime";
    for (let m = 1; m <= 5 && score.a === score.b; m++) for (const s of R() < .5 ? ["a", "b"] : ["b", "a"]) if (minute(s, "OT", m, .8, false)) break; }
  if (score.a === score.b) { note = "F/SO"; unit = "a shootout"; let sa2 = 0, sb2 = 0;
    for (let i = 0; i < 20; i++) { const d = (S.a - S.b) / 10, ma = R() < .33 * Math.exp(.15 * d), mb = R() < .33 * Math.exp(-.15 * d); sa2 += ma; sb2 += mb;
      if (i >= 2 && sa2 !== sb2) break; }
    if (sa2 === sb2) (R() < .5 ? sa2++ : sb2++);
    const w = sa2 > sb2 ? "a" : "b"; score[w]++; line[w][3]++; ev.push({ p: "SO", s: w, t: `Wins the shootout ${Math.max(sa2, sb2)}-${Math.min(sa2, sb2)}`, k: "score", sc: [score.a, score.b] }); }
  const box = {};
  for (const s of ["a", "b"]) box[s] = P[s].filter(p => p.card).map(p => { const t = p.st;
    if (p.pos === "G") return { id: p.id, name: p.name, line: `${t.SV || 0} saves on ${t.SA || 0} shots`, g: grade(5 + (t.SV || 0) * .1 - (t.GA || 0) * .8 + (t.SA && !t.GA ? 1.5 : 0)) };
    const bits = [`${t.G || 0} G`, `${t.A || 0} A`, `${t.SOG || 0} SOG`]; return { id: p.id, name: p.name, line: bits.join(", "), g: grade(5 + (t.G || 0) * 1.8 + (t.A || 0) * 1.1 + (t.SOG || 0) * .15 - (!t.G && !t.A ? .6 : 0)) }; });
  return { periods: line.a.map((_, i) => i < 3 ? String(i + 1) : i === 3 ? (note === "F/SO" ? "OT/SO" : "OT") : "SO"), line, score, ev, box, note, unit };
}

// ---------------------------------------------------------------- soccer
function soccer(R, A, B, sa, sb, names) {
  const S = { a: sa, b: sb }, P = { a: people(A, 0), b: people(B, 0) };
  for (const s of ["a", "b"]) { while (P[s].filter(p => p.pos !== "G").length < 10) P[s].push({ id: null, name: null, pos: "M", r: 55, card: false, st: {} }); }
  const G = s => P[s].filter(p => p.pos === "G").sort((x, y) => y.r - x.r)[0] || null;
  const shw = p => p.pos === "G" ? 0 : Math.pow(p.r / 55, 3) * (p.pos === "F" ? 3 : p.pos === "M" ? 1.5 : .45);
  const line = { a: [0, 0], b: [0, 0] }, score = { a: 0, b: 0 }, ev = [], tally = (p, k, n = 1) => { if (p) p.st[k] = (p.st[k] || 0) + n; };
  for (let m = 1; m <= 94; m++) {
    const half = m <= 46 ? 0 : 1;
    if (m === 47) ev.push({ p: "1st half", s: null, t: "Half-time", k: "end", sc: [score.a, score.b] });
    for (const s of R() < .5 ? ["a", "b"] : ["b", "a"]) { const o = s === "a" ? "b" : "a", d = (S[s] - S[o]) / 10;
      if (R() < .135 * Math.exp(.12 * d)) { const sh = wpick(R, P[s], shw), g = G(o); tally(sh, "SH");
        if (R() < .105 * Math.exp(.25 * d)) { score[s]++; line[s][half]++; tally(sh, "G"); tally(g, "GA"); const a1 = R() < .7 ? wpick(R, P[s].filter(p => p !== sh), shw) : null; if (a1) tally(a1, "A");
          const min = m > 90 ? `90+${m - 90}'` : m > 45 && half === 0 ? `45+${m - 45}'` : `${half ? m - 1 : m}'`;
          ev.push({ p: half ? "2nd half" : "1st half", s, t: `${sh.name ? `${sh.name} scores` : a1 && a1.name ? `${a1.name} sets up a goal` : "Goal"}${sh.name && a1 && a1.name ? ` (assist ${a1.name})` : ""}, ${min}`, k: "score", sc: [score.a, score.b], who: sh.id }); }
        else if (R() < .4) { tally(g, "SV"); if (g && g.card && R() < .2) ev.push({ p: half ? "2nd half" : "1st half", s: o, t: `${g.name} with a big save`, k: "hl", sc: [score.a, score.b], who: g.id }); } } }
  }
  let note = "Full time", unit = "ninety minutes";
  if (score.a === score.b) { note = "Pens"; unit = "a penalty shootout"; let pa = 0, pb = 0, i = 0;
    for (; i < 30; i++) { const d = (S.a - S.b) / 10; pa += R() < .76 * Math.exp(.04 * d); pb += R() < .76 * Math.exp(-.04 * d); if (i >= 4 && pa !== pb) break;
      if (i < 4 && (pa > pb + (4 - i) || pb > pa + (4 - i))) break; }
    if (pa === pb) (R() < .5 ? pa++ : pb++);
    const w = pa > pb ? "a" : "b"; ev.push({ p: "Pens", s: w, t: `Level at full time. Wins ${Math.max(pa, pb)}-${Math.min(pa, pb)} on penalties`, k: "score", sc: [score.a, score.b] });
    return fin(w, `${Math.max(pa, pb)}-${Math.min(pa, pb)} pens`); }
  return fin(score.a > score.b ? "a" : "b");
  function fin(w, pens) {
    const box = {};
    for (const s of ["a", "b"]) box[s] = P[s].filter(p => p.card).map(p => { const t = p.st;
      if (p.pos === "G") return { id: p.id, name: p.name, line: `${t.SV || 0} saves, ${t.GA || 0} conceded`, g: grade(5.5 + (t.SV || 0) * .45 - (t.GA || 0) * .8 + (!t.GA ? 1.3 : 0)) };
      return { id: p.id, name: p.name, line: [`${t.G || 0} G`, `${t.A || 0} A`, `${t.SH || 0} shots`].join(", "), g: grade(5.5 + (t.G || 0) * 1.9 + (t.A || 0) * 1.2 + (t.SH || 0) * .12 - (!t.G && !t.A && p.pos === "F" ? .5 : 0)) }; });
    return { periods: ["1H", "2H"], line, score, ev, box, note, unit, winner: w, pens };
  }
}

// ---------------------------------------------------------------- tennis: singles rubbers, best of three sets each
function tennis(R, A, B, sa, sb, names) {
  const pl = cs => (cs || []).map(c => ({ id: c.id, name: c.name, r: +c.r || 60, card: true, st: {} })).sort((x, y) => y.r - x.r);
  const PA = pl(A), PB = pl(B), n = Math.max(1, PA.length, PB.length);
  while (PA.length < n) PA.push({ id: null, name: "A qualifier", r: 50, card: false, st: {} });
  while (PB.length < n) PB.push({ id: null, name: "A qualifier", r: 50, card: false, st: {} });
  const line = { a: [], b: [] }, ev = [], tally = (p, k, n2 = 1) => { p.st[k] = (p.st[k] || 0) + n2; };
  const point = (srv, ret) => { const p = clamp(.63 + .0022 * (srv.r - ret.r), .5, .76), x = R();
    if (x < .03) { tally(srv, "DF"); return false; } if (x < .03 + .08 * (p / .63)) { tally(srv, "ACE"); return true; } return R() < p; };
  const game = (srv, ret) => { let a = 0, b = 0; for (;;) { if (point(srv, ret)) a++; else b++; if (a >= 4 && a - b >= 2) return true; if (b >= 4 && b - a >= 2) { tally(ret, "BRK"); return false; } } };
  const set = (x, y, first) => { let gx = 0, gy = 0, s = first; for (;;) {
      if (gx === 6 && gy === 6) { let tx = 0, ty = 0, sv = s; for (let i = 0; ; i++) { if (i % 2 === 1 || i === 0) sv = i === 0 ? s : (sv === x ? y : x); const w = point(sv, sv === x ? y : x) ? sv : (sv === x ? y : x); if (w === x) tx++; else ty++; if ((tx >= 7 || ty >= 7) && Math.abs(tx - ty) >= 2) break; }
        return tx > ty ? [7, 6, true] : [6, 7, true]; }
      const won = game(s, s === x ? y : x); if ((won && s === x) || (!won && s === y)) gx++; else gy++; s = s === x ? y : x;
      if ((gx >= 6 || gy >= 6) && Math.abs(gx - gy) >= 2) return [gx, gy, false]; } };
  let wa = 0, wb = 0;
  for (let i = 0; i < n; i++) { const x = PA[i], y = PB[i]; let sx = 0, sy = 0, first = R() < .5 ? x : y; const sets = [];
    while (sx < 2 && sy < 2) { const [gx, gy, tb] = set(x, y, first); sets.push(`${gx}-${gy}`); tally(x, "GW", gx); tally(y, "GW", gy); if (gx > gy) sx++; else sy++; first = first === x ? y : x;
      if (sx < 2 && sy < 2) { const sw = gx > gy ? x : y; ev.push({ p: `Match ${i + 1}`, s: gx > gy ? "a" : "b", t: `${sw.name} takes the ${ord(sets.length)} set ${Math.max(gx, gy)}-${Math.min(gx, gy)}${tb ? " in a tiebreak" : ""} against ${(gx > gy ? y : x).name === "A qualifier" ? "a qualifier" : (gx > gy ? y : x).name}`, k: "hl", sc: [wa, wb], who: sw.id }); } }
    const aw = sx > sy; if (aw) { wa++; tally(x, "W"); } else { wb++; tally(y, "W"); } tally(x, "SW", sx); tally(y, "SW", sy);
    line.a.push(aw ? 1 : 0); line.b.push(aw ? 0 : 1);
    const W = aw ? x : y, L = aw ? y : x;
    ev.push({ p: `Match ${i + 1}`, s: aw ? "a" : "b", t: `${W.name} beats ${L.name === "A qualifier" ? "a qualifier" : L.name} ${aw ? sets.join(" ") : sets.map(z => z.split("-").reverse().join("-")).join(" ")}`, k: "score", sc: [wa, wb], who: W.id }); }
  let note = "Final", unit = n === 1 ? "one match" : `${n} matches`;
  if (wa === wb) { const d = (simStrength(A) - simStrength(B)) / 10, aw = R() < 1 / (1 + Math.exp(-.45 * d)); aw ? wa++ : wb++; line.a.push(aw ? 1 : 0); line.b.push(aw ? 0 : 1); note = "Final (tiebreak)"; unit += " and a deciding doubles tiebreak";
    ev.push({ p: "Decider", s: aw ? "a" : "b", t: `Level at ${(wa + wb - 1) / 2}-${(wa + wb - 1) / 2}: ${names[aw ? 0 : 1] || "their pair"} ${names[aw ? 0 : 1] === "You" ? "win" : "wins"} the deciding doubles match tiebreak 10-${ri(R, 4, 8)}`, k: "score", sc: [wa, wb] }); }
  const box = {};
  for (const [s, L] of [["a", PA], ["b", PB]]) box[s] = L.filter(p => p.card).map(p => { const t = p.st;
    return { id: p.id, name: p.name, line: `${t.W ? "Won" : "Lost"}, ${t.SW || 0} set${t.SW === 1 ? "" : "s"}, ${t.ACE || 0} aces, ${t.BRK || 0} breaks`, g: grade(4 + (t.W ? 2.6 : 0) + (t.SW || 0) * .6 + (t.ACE || 0) * .08 + (t.BRK || 0) * .35 - (t.DF || 0) * .1) }; });
  return { periods: line.a.map((_, i) => i < n ? `M${i + 1}` : "TB"), line, score: { a: wa, b: wb }, ev, box, note, unit };
}

export const SIM_SPORTS = { mlb: baseball, nba: basketball, cbb: (R, A, B, sa, sb, n) => basketball(R, A, B, sa, sb, n, true), nfl: football, cfb: football, nhl: hockey, epl: soccer, tennis };

// play a game. A and B are the two lineups: cards with id, name, pos, kind and a rating r. names = [side A, side B].
export function simGame(sport, A, B, seed, names = ["Side A", "Side B"]) {
  const f = SIM_SPORTS[sport] || SIM_SPORTS.nba, R = simRng(`${SIM_V}:${sport}:${seed}`);
  const sa = simStrength(A), sb = simStrength(B), g = f(R, A, B, sa, sb, names);
  const winner = g.winner || (g.score.a > g.score.b ? "a" : "b");
  const rank = ["a", "b"].flatMap(s => g.box[s].map(x => ({ ...x, s }))).sort((x, y) => y.g - x.g);
  const mvp = rank.find(x => x.s === winner) || rank[0] || null;
  const W = names[winner === "a" ? 0 : 1], Lz = names[winner === "a" ? 1 : 0], hi = Math.max(g.score.a, g.score.b), lo = Math.min(g.score.a, g.score.b);
  const recap = `${W} ${W === "You" ? "beat" : "beats"} ${Lz} ${sport === "tennis" ? `${hi} matches to ${lo}` : `${hi}-${lo}`}${g.pens ? ` (${g.pens})` : ""} after ${g.unit}.${mvp ? ` ${mvp.name} (${mvp.line}) is the player of the game.` : ""}`;
  return { v: SIM_V, sport, periods: g.periods, line: g.line, score: [g.score.a, g.score.b], winner, note: g.note, home: g.home || null, pens: g.pens || null,
    str: [Math.round(sa * 10) / 10, Math.round(sb * 10) / 10], ev: g.ev.slice(0, 80), box: g.box, rank, mvp: mvp ? { s: mvp.s, id: mvp.id, name: mvp.name } : null, recap };
}

// the chance side A wins, estimated by playing it out: used for the pre-game line, never to decide a game
export function simChance(sport, sa, sb, n = 200) {
  const mk = r => [0, 1, 2, 3, 4].map(i => ({ id: "x" + i, name: null, pos: "", kind: "team", r }));
  let w = 0; for (let i = 0; i < n; i++) if (simGame(sport, mk(sa), mk(sb), "chance" + i).winner === "a") w++;
  return w / n;
}
// ranked play: an Elo rating that starts at 1000
export const SIM_ELO0 = 1000;
export const simElo = (ra, rb, aWon, k = 32) => { const e = 1 / (1 + Math.pow(10, (rb - ra) / 400)); return Math.round(k * ((aWon ? 1 : 0) - e)); };
