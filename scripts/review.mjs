// Daily review ("Tagesrückblick"): about 5 highlights for every finished day of the
// challenge, built from each player's game log and rank history. Pure functions;
// scripts/update.mjs writes the result into data.json and the page only shows it.
// Names are wrapped in **…** and the page turns them bold.
import { zonedMidnight, dayOf } from './challenge.mjs';

export const MAX_HIGHLIGHTS = 5;
const TIERS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Plat', 'Emerald', 'Diamond'];

// Rank label for a score on the 100-per-division scale (see update.mjs).
const rankLabel = (v) => (v >= 2800 ? `Master+ ${v - 2800} LP` : `${TIERS[Math.floor(v / 400)]} ${4 - Math.floor((v % 400) / 100)}`);
const tierOf = (v) => (v >= 2800 ? 7 : Math.floor(v / 400));
const divisionOf = (v) => (v >= 2800 ? 28 : Math.floor(v / 100));

// Ranked snapshots of one queue from the LP baseline (first snapshot at/after the start) on.
function rankedFrom(history, q, win) {
  const ranked = (history || []).filter((h) => h[q] != null).map((h) => ({ t: Date.parse(h.t), v: h[q] }));
  const i = ranked.findIndex((h) => h.t >= win.startMs);
  return i < 0 ? [] : ranked.slice(i);
}
// Rank at time t: the last snapshot at or before t, but never earlier than the baseline.
function rankAt(ranked, t) {
  if (!ranked.length || ranked[0].t > t) return null;
  let v = ranked[0].v;
  for (const h of ranked) { if (h.t > t) break; v = h.v; }
  return v;
}
// LP change between a and b, counted from the baseline like the standings do.
function lpBetween(ranked, a, b) {
  const end = rankAt(ranked, b);
  if (end == null) return null;
  return end - (rankAt(ranked, Math.max(a, ranked[0].t)) ?? ranked[0].v);
}

const kda = (g) => (g.k + g.a) / Math.max(1, g.d);
export const champName = (c) => ({ MonkeyKing: 'Wukong', Belveth: "Bel'Veth", Khazix: "Kha'Zix", Chogath: "Cho'Gath", JarvanIV: 'Jarvan IV', KSante: "K'Sante", Kaisa: "Kai'Sa", Velkoz: "Vel'Koz", RekSai: "Rek'Sai", KogMaw: "Kog'Maw", MissFortune: 'Miss Fortune', MasterYi: 'Master Yi', TwistedFate: 'Twisted Fate', LeeSin: 'Lee Sin', XinZhao: 'Xin Zhao', DrMundo: 'Dr. Mundo', TahmKench: 'Tahm Kench', AurelionSol: 'Aurelion Sol', Leblanc: 'LeBlanc', Nunu: 'Nunu & Willump', Renata: 'Renata Glasc' }[c] || c);
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);
const best = (rows, f) => rows.reduce((top, r) => (top == null || f(r) > f(top) ? r : top), null);

// Points a player earned in [a, b) in one mode: LP change + new champions + multikills.
// End awards aren't included; they only count once the challenge is over.
function periodPoints(p, mode, ch, win, a, b) {
  const pts = ch.points || {};
  const log = p.modes?.[mode]?.log || [];
  const before = new Set(log.filter((g) => g.t < a).map((g) => g.champ));
  const games = log.filter((g) => g.t >= a && g.t < b);
  const newChamps = new Set(games.map((g) => g.champ).filter((c) => !before.has(c))).size;
  const lp = lpBetween(rankedFrom(p.history, mode, win), a, b);
  const pentas = games.reduce((n, g) => n + g.penta, 0), quadras = games.reduce((n, g) => n + g.quadra, 0);
  return {
    games, lp, newChamps, pentas, quadras,
    points: (lp ?? 0) + newChamps * (pts.uniqueChampion ?? 0) + pentas * (pts.pentakill ?? 0) + quadras * (pts.quadrakill ?? 0),
  };
}

function longestRun(games, won) {
  let best = 0, cur = 0;
  for (const g of games) { cur = g.win === won ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}

// Highlights for one day [a, b).
export function reviewDay(players, ch, win, a, b) {
  const solo = players.map((p) => ({ p, ...periodPoints(p, 'solo', ch, win, a, b) }));
  const flex = players.map((p) => ({ p, ...periodPoints(p, 'flex', ch, win, a, b) }));
  const name = (p) => `**${p.name}**`;
  const all = players.flatMap((p) => ['solo', 'flex'].flatMap((m) => (p.modes?.[m]?.log || []).filter((g) => g.t >= a && g.t < b).map((g) => ({ ...g, p }))));
  const out = [];
  const add = (icon, text) => { if (text) out.push({ icon, text }); };

  // 1. Day winner (Solo/Duo points)
  const top = best(solo.filter((r) => r.games.length || r.lp), (r) => r.points);
  if (top && top.points > 0) {
    add('📈', `Tagessieger: ${name(top.p)} mit ${signed(top.points)} Punkten (${top.lp == null ? '±0' : signed(top.lp)} LP, ${top.games.length} ${top.games.length === 1 ? 'Game' : 'Games'}).`);
  }
  // 2. Pentakills (each one is worth a line)
  for (const g of all.filter((g) => g.penta).slice(0, 2)) add('💥', `PENTAKILL! ${name(g.p)} hat auf ${champName(g.champ)} alle fünf weggeräumt.`);
  // 3. New leader in the Solo/Duo standings
  if (a > win.startMs) {
    const totalAt = (p, t) => periodPoints(p, 'solo', ch, win, win.startMs, t).points;
    const leaders = (t) => { const v = players.map((p) => totalAt(p, t)); const m = Math.max(...v); return players.filter((_, i) => v[i] === m); };
    const before = leaders(a), after = leaders(b);
    if (after.length === 1 && !before.includes(after[0])) add('👑', `Neuer Spitzenreiter: ${name(after[0])}.`);
  }
  // 4. Biggest LP loss
  const loser = best(solo.filter((r) => r.lp < 0), (r) => -r.lp);
  if (loser) add('📉', `${name(loser.p)} hat ${-loser.lp} LP gespendet. Danke für die Spende.`);
  // 5. Promotions / demotions (tier changes first, else division changes)
  const moves = players.map((p) => {
    const ranked = rankedFrom(p.history, 'solo', win);
    const from = rankAt(ranked, Math.max(a, ranked[0]?.t ?? a)), to = rankAt(ranked, b);
    return from == null || to == null ? null : { p, from, to, tier: tierOf(to) - tierOf(from), div: divisionOf(to) - divisionOf(from) };
  }).filter(Boolean);
  const move = moves.find((m) => m.tier > 0) || moves.find((m) => m.tier < 0) || moves.find((m) => m.div > 0) || moves.find((m) => m.div < 0);
  if (move) {
    const up = move.tier > 0 || (!move.tier && move.div > 0);
    add(up ? '⬆️' : '⬇️', `${name(move.p)} ist ${up ? 'aufgestiegen' : 'abgestiegen'}: ${rankLabel(move.from)} → ${rankLabel(move.to)}.`);
  }
  // 6. Best game of the day
  const star = best(all.filter((g) => g.k + g.a >= 8), (g) => kda(g) * 100 + g.k);
  if (star) add('🎯', `Bestes Game: ${name(star.p)} mit ${star.k}/${star.d}/${star.a} auf ${champName(star.champ)}${star.win ? '.' : ' – und trotzdem verloren.'}`);
  // 7. Worst game of the day
  const grey = best(all.filter((g) => g.d >= 8), (g) => g.d * 100 - g.k);
  if (grey) add('🪦', `${name(grey.p)} ist ${grey.d} Mal gestorben (${grey.k}/${grey.d}/${grey.a} auf ${champName(grey.champ)}). Grey-Screen-Simulator.`);
  // 8. Flex day winner
  const flexTop = best(flex.filter((r) => r.games.length), (r) => r.points);
  if (flexTop && flexTop.points > 0) add('🧑‍🤝‍🧑', `Flex-Tagessieger: ${name(flexTop.p)} mit ${signed(flexTop.points)} Punkten.`);
  // 9. Quadrakills
  const quad = all.find((g) => g.quadra);
  if (quad) add('🔥', `Quadrakill für ${name(quad.p)} auf ${champName(quad.champ)}. Der Penta war so nah.`);
  // 10. Streaks inside the day
  const streaks = solo.map((r) => ({ p: r.p, w: longestRun(r.games, true), l: longestRun(r.games, false) }));
  const hot = best(streaks.filter((s) => s.w >= 4), (s) => s.w), cold = best(streaks.filter((s) => s.l >= 4), (s) => s.l);
  if (hot) add('🚀', `${name(hot.p)} hat ${hot.w} Games in Folge gewonnen.`);
  if (cold) add('💀', `${name(cold.p)} hat ${cold.l} Games am Stück verloren. PC aus?`);
  // 11. Grinder
  const grind = best(solo.filter((r) => r.games.length >= 4), (r) => r.games.length);
  if (grind) {
    const w = grind.games.filter((g) => g.win).length;
    add('🎮', `${name(grind.p)} hat ${grind.games.length} Games gespielt (${w}W ${grind.games.length - w}L). Gras anfassen ist auch eine Option.`);
  }
  // 12. Who didn't play at all
  const idle = players.filter((p) => !all.some((g) => g.p === p));
  if (idle.length && idle.length < players.length) add('😴', `Kein einziges Game: ${idle.map(name).join(', ')}.`);

  if (!out.length) add('😴', 'Ruhiger Tag: niemand hat Ranked gespielt.');
  return out.slice(0, MAX_HIGHLIGHTS);
}

// Reviews for every finished day so far. Days already in `existing` are kept as they are.
export function buildReviews(players, ch, win, now, existing = []) {
  const tz = ch.timeZone || 'Europe/Berlin';
  const done = new Map(existing.map((r) => [r.date, r]));
  const out = [];
  for (let day = dayOf(win.startMs, tz); ; day = dayOf(zonedMidnight(day, tz, 1), tz)) {
    const a = Math.max(zonedMidnight(day, tz), win.startMs), b = Math.min(zonedMidnight(day, tz, 1), win.endMs);
    if (a >= win.endMs || b > now) break;
    out.push(done.get(day) || { date: day, startMs: a, endMs: b, highlights: reviewDay(players, ch, win, a, b) });
  }
  return out;
}
