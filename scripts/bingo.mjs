// Weekly bingo: 25 fields on a 5×5 card, checked automatically from Solo/Duo games in the
// bingo window. The first `winners` players to complete a row, column or diagonal get
// `points` each (players who finish in the same game share the last place).
//
// matchFacts() runs once per game in update.mjs and stores what the fields need on the
// game's log entry (g.f); scoreBingo() turns the logs into the card for every player.
import { dayOf, zonedMidnight } from './challenge.mjs';

// Card order = reading order (row by row). `src` is where you'd check it yourself.
export const CELLS = [
  { text: 'Sieg ohne einen einzigen Tod', src: 'OP.GG', test: (g) => g.win && g.d === 0 },
  { text: '67+ CS mehr als dein Lane-Gegner in einem Sieg (Support: 7+)', src: 'OP.GG Match', test: (g) => g.win && g.f.cs != null && g.f.cs >= (g.f.pos === 'UTILITY' ? 7 : 67) },
  { text: 'Bestes KDA aller 10 Spieler in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.kda10 },
  { text: 'Sieg nach 42+ Minuten', src: 'OP.GG', test: (g) => g.win && g.f.dur >= 42 * 60 },
  { text: '4 Drachen als Team in einem Spiel', src: 'OP.GG Match', test: (g) => g.f.drakes >= 4 },

  { text: 'Sieg auf einer Off-Role', src: 'League of Graphs', test: (g, ctx) => g.win && g.f.pos && ctx.mainPos && g.f.pos !== ctx.mainPos },
  { text: '3 Siege in Folge', src: 'OP.GG', seq: 'winStreak3' },
  { text: 'Höchster Vision Score in deinem Team', src: 'OP.GG Match', test: (g) => g.f.vision },
  { text: 'Sieg mit 4 verschiedenen Champs in einer Woche', src: 'League of Graphs', seq: 'fourChamps' },
  { text: '1.000+ Gold mehr als dein Lane-Gegner in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.gold != null && g.f.gold >= 1000 },

  { text: 'Sieg trotz schlechtester KDA im Team', src: 'OP.GG Match', test: (g) => g.win && g.f.worstKda },
  { text: '≥ 70 % Kill-Beteiligung in einem Sieg', src: 'OP.GG', test: (g) => g.win && g.f.kp >= 0.7 },
  { text: 'Quadra Kill', src: 'OP.GG', test: (g) => g.f.quadra },
  { text: 'Sieg in unter 22 Minuten', src: 'OP.GG', test: (g) => g.win && g.f.dur < 22 * 60 },
  { text: 'Höchster Schaden im Team (Support: 10k mehr als Lane-Gegner)', src: 'OP.GG Match', test: (g) => g.f.dmgTop || (g.f.pos === 'UTILITY' && g.f.dmg != null && g.f.dmg >= 10000) },

  { text: 'Sieg nach 2 Niederlagen in Folge', src: 'OP.GG', seq: 'winAfter2Losses' },
  { text: 'Sieg mit einem Champ außerhalb deiner Top 20 Mastery', src: 'Riot Mastery', test: (g, ctx) => g.win && ctx.top20 != null && !ctx.top20.includes(g.champ) },
  { text: 'Mehr Kills + Assists als dein Lane-Gegner', src: 'OP.GG Match', test: (g) => g.f.ka != null && g.f.ka > 0 },
  { text: '5 Ranked-Spiele an einem Tag', src: 'League of Graphs', seq: 'fiveGamesDay' },
  { text: 'KDA ≥ 6 in einem Sieg', src: 'OP.GG', test: (g) => g.win && (g.k + g.a) / Math.max(1, g.d) >= 6 },

  { text: 'Baron und Elder Drake als Team im selben Spiel', src: 'Riot Timeline', test: (g) => g.f.elder === true },
  { text: 'Duo-Sieg mit einem Challenge-Mitspieler', src: 'OP.GG', test: (g) => g.win && g.f.duo },
  { text: 'Sieg gegen höher gerankten Lane-Gegner', src: 'OP.GG Match', test: (g) => g.win && g.f.higher === true },
  { text: '15+ Assists in einem Sieg', src: 'OP.GG', test: (g) => g.win && g.a >= 15 },
  { text: '3 Siege an einem Tag', src: 'League of Graphs', seq: 'threeWinsDay' },
];

// Rows, columns and both diagonals of the 5×5 card, as cell indexes.
export const LINES = [
  ...[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => r * 5 + c)),
  ...[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => r * 5 + c)),
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
];

const ROLE_POSITIONS = { top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', adc: 'BOTTOM', support: 'UTILITY' };
const kda = (x) => (x.kills + x.assists) / Math.max(1, x.deaths);
const cs = (x) => (x.totalMinionsKilled || 0) + (x.neutralMinionsKilled || 0);

// What the bingo needs from one game, stored compactly on its log entry.
// ctx: squadPuuids (Set), elder (true/false/undefined from the timeline),
//      higher (opponent's solo rank above ours, or undefined if not checked).
export function matchFacts(m, me, ctx = {}) {
  const team = m.info.participants.filter((x) => x.teamId === me.teamId);
  const opp = me.teamPosition ? m.info.participants.find((x) => x.teamId !== me.teamId && x.teamPosition === me.teamPosition) : null;
  const teamKills = team.reduce((n, x) => n + x.kills, 0);
  const objectives = m.info.teams.find((t) => t.teamId === me.teamId)?.objectives || {};
  return {
    pos: me.teamPosition || null,
    dur: m.info.gameDuration,
    cs: opp ? cs(me) - cs(opp) : null,
    gold: opp ? me.goldEarned - opp.goldEarned : null,
    ka: opp ? me.kills + me.assists - (opp.kills + opp.assists) : null,
    dmg: opp ? me.totalDamageDealtToChampions - opp.totalDamageDealtToChampions : null,
    dmgTop: me.totalDamageDealtToChampions >= Math.max(...team.map((x) => x.totalDamageDealtToChampions)),
    vision: me.visionScore >= Math.max(...team.map((x) => x.visionScore)),
    worstKda: kda(me) <= Math.min(...team.map(kda)),
    kda10: kda(me) >= Math.max(...m.info.participants.map(kda)),
    kp: teamKills ? (me.kills + me.assists) / teamKills : 0,
    quadra: (me.quadraKills || 0) > 0, // a penta also counts
    drakes: objectives.dragon?.kills || 0,
    barons: objectives.baron?.kills || 0,
    duo: team.some((x) => x.puuid !== me.puuid && ctx.squadPuuids?.has(x.puuid)),
    elder: ctx.elder,
    higher: ctx.higher,
  };
}

// Did our team kill an Elder Drake? Match data only counts drakes; the timeline names them.
export const teamKilledElder = (timeline, teamId) => (timeline?.info?.frames || []).some((f) => (f.events || [])
  .some((e) => e.type === 'ELITE_MONSTER_KILL' && e.monsterSubType === 'ELDER_DRAGON' && e.killerTeamId === teamId));
// Only worth a timeline call when we killed a Baron and a team reached dragon soul (4 drakes),
// after which the Elder Drake spawns.
export const mightHaveElder = (m, me) => {
  const t = m.info.teams;
  const ours = t.find((x) => x.teamId === me.teamId)?.objectives || {};
  return (ours.baron?.kills || 0) > 0 && Math.max(...t.map((x) => x.objectives?.dragon?.kills || 0)) >= 4;
};

// Main position for "Off-Role": the configured role, else the most played position.
export function mainPosition(p) {
  const fixed = ROLE_POSITIONS[String(p.role || '').trim().toLowerCase()];
  if (fixed) return fixed;
  const count = {};
  for (const m of ['solo', 'flex']) for (const g of p.modes?.[m]?.log || []) if (g.f?.pos) count[g.f.pos] = (count[g.f.pos] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// First time each sequence field is reached, from the window's games in order.
function sequenceTimes(games, tz) {
  const out = {};
  let streak = 0, losses = 0;
  const champs = new Set(), perDay = {}, winsPerDay = {};
  for (const g of games) {
    const day = dayOf(g.t, tz);
    perDay[day] = (perDay[day] || 0) + 1;
    if (perDay[day] >= 5) out.fiveGamesDay ??= g.t;
    if (g.win) {
      streak++;
      if (losses >= 2) out.winAfter2Losses ??= g.t;
      losses = 0;
      champs.add(g.champ);
      if (champs.size >= 4) out.fourChamps ??= g.t;
      winsPerDay[day] = (winsPerDay[day] || 0) + 1;
      if (winsPerDay[day] >= 3) out.threeWinsDay ??= g.t;
      if (streak >= 3) out.winStreak3 ??= g.t;
    } else {
      streak = 0;
      losses++;
    }
  }
  return out;
}

const edge = (v, tz, isEnd) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? zonedMidnight(v, tz, isEnd ? 1 : 0) : Date.parse(v));

// Scores the bingo for all players, adds the points to the Solo/Duo totals, re-ranks and
// returns the summary for data.json (null when no bingo is configured).
export function scoreBingo(players, ch, now) {
  const b = ch.bingo;
  if (!b) return null;
  const tz = ch.timeZone || 'Europe/Berlin';
  const startMs = edge(b.start, tz, false), endMs = edge(b.end, tz, true);
  const rows = players.map((p) => {
    const games = (p.modes?.solo?.log || []).filter((g) => g.f && g.t >= startMs && g.t < endMs).sort((x, y) => x.t - y.t);
    const ctx = { mainPos: mainPosition(p), top20: p.bingoMastery?.id === b.id ? p.bingoMastery.champs : null };
    const seq = sequenceTimes(games, tz);
    const done = {};
    CELLS.forEach((c, i) => {
      const t = c.seq ? seq[c.seq] : games.find((g) => c.test(g, ctx))?.t;
      if (t != null) done[i] = t;
    });
    const lines = LINES.filter((l) => l.every((i) => done[i] != null)).map((l) => ({ cells: l, at: Math.max(...l.map((i) => done[i])) }));
    const bingoAt = lines.length ? Math.min(...lines.map((l) => l.at)) : null;
    const best = Math.max(0, ...LINES.map((l) => l.filter((i) => done[i] != null).length)); // most fields in one line
    return { key: p.key, done, lines: lines.map((l) => l.cells), bingoAt, best, mainPos: ctx.mainPos, hasMastery: ctx.top20 != null };
  });

  // First `winners` bingos get the points; a tie at the last place shares it.
  const finished = rows.filter((r) => r.bingoAt != null && r.bingoAt < endMs).sort((x, y) => x.bingoAt - y.bingoAt);
  const cut = finished[Math.min(b.winners, finished.length) - 1]?.bingoAt;
  const winners = finished.filter((r) => r.bingoAt <= cut);
  for (const r of rows) {
    const rank = winners.findIndex((w) => w.key === r.key);
    r.rank = rank < 0 ? null : 1 + winners.filter((w) => w.bingoAt < r.bingoAt).length;
    r.points = rank < 0 ? 0 : b.points;
    const P = players.find((p) => p.key === r.key).points.solo;
    P.bingo = { fields: Object.keys(r.done).length, lines: r.lines.length, points: r.points };
    P.total += r.points;
  }
  for (const mode of ['solo', 'flex']) {
    for (const p of players) p.points[mode].place = 1 + players.filter((o) => o.points[mode].total > p.points[mode].total).length;
  }
  return {
    id: b.id, title: b.title, points: b.points, winners: b.winners, startMs, endMs,
    status: winners.length >= b.winners ? 'done' : now >= endMs ? 'over' : now < startMs ? 'upcoming' : 'open',
    cells: CELLS.map((c) => ({ text: c.text, src: c.src })),
    players: rows.sort((x, y) => (x.bingoAt ?? Infinity) - (y.bingoAt ?? Infinity) || y.best - x.best || Object.keys(y.done).length - Object.keys(x.done).length),
  };
}
