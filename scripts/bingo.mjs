// Bingos: 25 fields on a 5×5 card, checked automatically from Solo/Duo games in the
// bingo's window. The first `winners` players to complete a row, column or diagonal get
// `points` each (players who finish in the same game share the last place).
//
// challenge.bingos lists every bingo (finished ones stay, so their points stay); each one
// names its `card` from CARDS below. matchFacts() runs once per game in update.mjs and
// stores what the fields need on the game's log entry (g.f); scoreBingos() turns the logs
// into the cards for every player.
import { dayOf, zonedMidnight } from './challenge.mjs';

const hourIn = (t, timeZone) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
const kdaOf = (g) => (g.k + g.a) / Math.max(1, g.d);

// Cards in reading order (row by row). `src` is where you'd check it yourself.
// `mastery`: how many top-mastery champions to freeze at the start (for the "außerhalb deiner
// Top N" field). `elder`: the card needs the Elder Drake check from the match timeline.
export const CARDS = {
  week2: {
    mastery: 20, elder: true,
    cells: [
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
      { text: 'Sieg mit einem Champ außerhalb deiner Top 20 Mastery', src: 'Riot Mastery', test: (g, ctx) => g.win && ctx.topChamps != null && !ctx.topChamps.includes(g.champ) },
      { text: 'Mehr Kills + Assists als dein Lane-Gegner', src: 'OP.GG Match', test: (g) => g.f.ka != null && g.f.ka > 0 },
      { text: '5 Ranked-Spiele an einem Tag', src: 'League of Graphs', seq: 'fiveGamesDay' },
      { text: 'KDA ≥ 6 in einem Sieg', src: 'OP.GG', test: (g) => g.win && kdaOf(g) >= 6 },

      { text: 'Baron und Elder Drake als Team im selben Spiel', src: 'Riot Timeline', test: (g) => g.f.elder === true },
      { text: 'Duo-Sieg mit einem Challenge-Mitspieler', src: 'OP.GG', test: (g) => g.win && g.f.duo },
      { text: 'Sieg gegen höher gerankten Lane-Gegner', src: 'OP.GG Match', test: (g) => g.win && g.f.higher === true },
      { text: '15+ Assists in einem Sieg', src: 'OP.GG', test: (g) => g.win && g.a >= 15 },
      { text: '3 Siege an einem Tag', src: 'League of Graphs', seq: 'threeWinsDay' },
    ],
  },
  // Harder: every field is new or a tougher version of week 2, the hardest one in the middle.
  week3: {
    mastery: 40,
    cells: [
      { text: 'Sieg ohne Tod mit 10+ Kills/Assists', src: 'OP.GG', test: (g) => g.win && g.d === 0 && g.k + g.a >= 10 },
      { text: '100+ CS mehr als dein Lane-Gegner in einem Sieg (Support: 15+)', src: 'OP.GG Match', test: (g) => g.win && g.f.cs != null && g.f.cs >= (g.f.pos === 'UTILITY' ? 15 : 100) },
      { text: '3+ Solo-Kills in einem Spiel', src: 'OP.GG Match', test: (g) => (g.f.solo ?? 0) >= 3 },
      { text: 'Sieg nach 40+ Minuten', src: 'OP.GG', test: (g) => g.win && g.f.dur >= 40 * 60 },
      { text: 'Sieg trotz verlorenem Inhibitor', src: 'OP.GG Match', test: (g) => g.win && g.f.lostInhib === true },

      { text: 'Erster Turm (Kill oder Assist) in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.firstTower === true },
      { text: '4 Siege in Folge', src: 'OP.GG', seq: 'winStreak4' },
      { text: 'Höchster Vision Score aller 10 Spieler', src: 'OP.GG Match', test: (g) => g.f.vision10 === true },
      { text: 'Siege auf 3 verschiedenen Positionen', src: 'League of Graphs', seq: 'threePositions' },
      { text: '3.000+ Gold mehr als dein Lane-Gegner in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.gold != null && g.f.gold >= 3000 },

      { text: 'Triple Kill', src: 'OP.GG', test: (g) => g.f.triple === true },
      { text: '30 %+ des Team-Schadens in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.dmgShare >= 0.3 },
      { text: 'Quadra Kill', src: 'OP.GG', test: (g) => g.f.quadra },
      { text: 'Gegner gibt vor 25 Minuten auf', src: 'OP.GG', test: (g) => g.win && g.f.surr === true && g.f.dur < 25 * 60 },
      { text: 'Meiste CC-Zeit aller 10 Spieler', src: 'OP.GG Match', test: (g) => g.f.cc10 === true },

      { text: 'Sieg nach 3 Niederlagen in Folge', src: 'OP.GG', seq: 'winAfter3Losses' },
      { text: 'Sieg mit einem Champ außerhalb deiner Top 40 Mastery', src: 'Riot Mastery', test: (g, ctx) => g.win && ctx.topChamps != null && !ctx.topChamps.includes(g.champ) },
      { text: 'Lane-Sieg auf ganzer Linie: mehr Kills, CS, Gold und Schaden als dein Lane-Gegner, in einem Sieg', src: 'OP.GG Match', test: (g) => g.win && g.f.kd > 0 && g.f.cs > 0 && g.f.gold > 0 && g.f.dmg > 0 },
      { text: '4 Siege an einem Tag', src: 'League of Graphs', seq: 'fourWinsDay' },
      { text: 'KDA ≥ 10 in einem Sieg', src: 'OP.GG', test: (g) => g.win && kdaOf(g) >= 10 },

      { text: 'Meister Gebäudeschaden aller 10 Spieler', src: 'OP.GG Match', test: (g) => g.f.build10 === true },
      { text: '3 Duo-Siege mit Challenge-Mitspielern', src: 'OP.GG', seq: 'threeDuoWins' },
      { text: 'Sieg gegen Lane-Gegner, der 2+ Divisionen höher steht', src: 'OP.GG Match', test: (g) => g.win && g.f.rankDiff != null && g.f.rankDiff >= 200 },
      { text: '10+ Kills und 10+ Assists in einem Spiel', src: 'OP.GG', test: (g) => g.k >= 10 && g.a >= 10 },
      { text: '🦉 Nachteule: Sieg zwischen 0 und 6 Uhr', src: 'OP.GG', test: (g, ctx) => g.win && hourIn(g.t, ctx.tz) < 6 },
    ],
  },
};

// Rows, columns and both diagonals of the 5×5 card, as cell indexes.
export const LINES = [
  ...[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => r * 5 + c)),
  ...[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => r * 5 + c)),
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
];

const ROLE_POSITIONS = { top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', adc: 'BOTTOM', support: 'UTILITY' };
const kda = (x) => (x.kills + x.assists) / Math.max(1, x.deaths);
const cs = (x) => (x.totalMinionsKilled || 0) + (x.neutralMinionsKilled || 0);
const isBest = (me, all, f) => f(me) > 0 && f(me) >= Math.max(...all.map(f));

// What the bingos need from one game, stored compactly on its log entry.
// ctx: squadPuuids (Set), elder (true/false/undefined from the timeline),
//      rankDiff (lane opponent's Solo/Duo score minus ours right after the game, or undefined).
export function matchFacts(m, me, ctx = {}) {
  const all = m.info.participants;
  const team = all.filter((x) => x.teamId === me.teamId);
  const opp = me.teamPosition ? all.find((x) => x.teamId !== me.teamId && x.teamPosition === me.teamPosition) : null;
  const teamKills = team.reduce((n, x) => n + x.kills, 0);
  const teamDmg = team.reduce((n, x) => n + x.totalDamageDealtToChampions, 0);
  const objectives = m.info.teams.find((t) => t.teamId === me.teamId)?.objectives || {};
  const theirs = m.info.teams.find((t) => t.teamId !== me.teamId)?.objectives || {};
  return {
    pos: me.teamPosition || null,
    dur: m.info.gameDuration,
    cs: opp ? cs(me) - cs(opp) : null,
    gold: opp ? me.goldEarned - opp.goldEarned : null,
    kd: opp ? me.kills - opp.kills : null,
    ka: opp ? me.kills + me.assists - (opp.kills + opp.assists) : null,
    dmg: opp ? me.totalDamageDealtToChampions - opp.totalDamageDealtToChampions : null,
    dmgTop: me.totalDamageDealtToChampions >= Math.max(...team.map((x) => x.totalDamageDealtToChampions)),
    dmgShare: teamDmg ? me.totalDamageDealtToChampions / teamDmg : 0,
    vision: me.visionScore >= Math.max(...team.map((x) => x.visionScore)),
    vision10: isBest(me, all, (x) => x.visionScore || 0),
    cc10: isBest(me, all, (x) => x.timeCCingOthers || 0),
    build10: isBest(me, all, (x) => x.damageDealtToBuildings || 0),
    worstKda: kda(me) <= Math.min(...team.map(kda)),
    kda10: kda(me) >= Math.max(...all.map(kda)),
    kp: teamKills ? (me.kills + me.assists) / teamKills : 0,
    solo: me.challenges?.soloKills ?? 0,
    triple: (me.tripleKills || 0) > 0, // a quadra or penta also counts
    quadra: (me.quadraKills || 0) > 0, // a penta also counts
    firstTower: Boolean(me.firstTowerKill || me.firstTowerAssist),
    lostInhib: (theirs.inhibitor?.kills || 0) > 0,
    surr: Boolean(me.gameEndedInSurrender),
    drakes: objectives.dragon?.kills || 0,
    barons: objectives.baron?.kills || 0,
    duo: team.some((x) => x.puuid !== me.puuid && ctx.squadPuuids?.has(x.puuid)),
    elder: ctx.elder,
    higher: ctx.rankDiff == null ? undefined : ctx.rankDiff > 0,
    rankDiff: ctx.rankDiff,
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
  let streak = 0, losses = 0, duoWins = 0;
  const champs = new Set(), positions = new Set(), perDay = {}, winsPerDay = {};
  for (const g of games) {
    const day = dayOf(g.t, tz);
    perDay[day] = (perDay[day] || 0) + 1;
    if (perDay[day] >= 5) out.fiveGamesDay ??= g.t;
    if (g.win) {
      streak++;
      if (losses >= 2) out.winAfter2Losses ??= g.t;
      if (losses >= 3) out.winAfter3Losses ??= g.t;
      losses = 0;
      champs.add(g.champ);
      if (champs.size >= 4) out.fourChamps ??= g.t;
      if (g.f?.pos) positions.add(g.f.pos);
      if (positions.size >= 3) out.threePositions ??= g.t;
      if (g.f?.duo && ++duoWins >= 3) out.threeDuoWins ??= g.t;
      winsPerDay[day] = (winsPerDay[day] || 0) + 1;
      if (winsPerDay[day] >= 3) out.threeWinsDay ??= g.t;
      if (winsPerDay[day] >= 4) out.fourWinsDay ??= g.t;
      if (streak >= 3) out.winStreak3 ??= g.t;
      if (streak >= 4) out.winStreak4 ??= g.t;
    } else {
      streak = 0;
      losses++;
    }
  }
  return out;
}

export const bingoEdge = (v, tz, isEnd) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? zonedMidnight(v, tz, isEnd ? 1 : 0) : Date.parse(v));

// Frozen top-mastery list of a player for one bingo (older data stored a single snapshot).
export function masteryFor(p, id) {
  const m = p.bingoMastery;
  if (!m) return null;
  if (m.id) return m.id === id ? m.champs : null;
  return m[id]?.champs ?? null;
}

// One bingo for all players: adds its points to the Solo/Duo totals and returns its summary.
function scoreOne(players, b, tz, now) {
  const card = CARDS[b.card];
  const startMs = bingoEdge(b.start, tz, false), endMs = bingoEdge(b.end, tz, true);
  const rows = players.map((p) => {
    const games = (p.modes?.solo?.log || []).filter((g) => g.f && g.t >= startMs && g.t < endMs).sort((x, y) => x.t - y.t);
    const top = masteryFor(p, b.id);
    const ctx = { tz, mainPos: mainPosition(p), topChamps: top ? top.slice(0, card.mastery) : null };
    const seq = sequenceTimes(games, tz);
    const done = {};
    card.cells.forEach((c, i) => {
      const t = c.seq ? seq[c.seq] : games.find((g) => c.test(g, ctx))?.t;
      if (t != null) done[i] = t;
    });
    const lines = LINES.filter((l) => l.every((i) => done[i] != null)).map((l) => ({ cells: l, at: Math.max(...l.map((i) => done[i])) }));
    const bingoAt = lines.length ? Math.min(...lines.map((l) => l.at)) : null;
    const best = Math.max(0, ...LINES.map((l) => l.filter((i) => done[i] != null).length)); // most fields in one line
    return { key: p.key, done, lines: lines.map((l) => l.cells), bingoAt, best, mainPos: ctx.mainPos, hasMastery: top != null };
  });

  // First `winners` bingos get the points; a tie at the last place shares it.
  const finished = rows.filter((r) => r.bingoAt != null && r.bingoAt < endMs).sort((x, y) => x.bingoAt - y.bingoAt);
  const cut = finished[Math.min(b.winners, finished.length) - 1]?.bingoAt;
  const winners = finished.filter((r) => r.bingoAt <= cut);
  for (const r of rows) {
    const won = winners.some((w) => w.key === r.key);
    r.rank = won ? 1 + winners.filter((w) => w.bingoAt < r.bingoAt).length : null;
    r.points = won ? b.points : 0;
    const P = players.find((p) => p.key === r.key).points.solo;
    (P.bingos ??= {})[b.id] = { fields: Object.keys(r.done).length, lines: r.lines.length, points: r.points };
    P.total += r.points;
  }
  return {
    id: b.id, title: b.title, points: b.points, winners: b.winners, startMs, endMs,
    status: winners.length >= b.winners ? 'done' : now >= endMs ? 'over' : now < startMs ? 'upcoming' : 'open',
    cells: card.cells.map((c) => ({ text: c.text, src: c.src })),
    players: rows.sort((x, y) => (x.bingoAt ?? Infinity) - (y.bingoAt ?? Infinity) || y.best - x.best || Object.keys(y.done).length - Object.keys(x.done).length),
  };
}

// Every bingo in challenge.bingos: adds the points, re-ranks, returns the summaries.
export function scoreBingos(players, ch, now) {
  const tz = ch.timeZone || 'Europe/Berlin';
  const list = (ch.bingos || []).filter((b) => CARDS[b.card]).map((b) => scoreOne(players, b, tz, now));
  for (const mode of ['solo', 'flex']) {
    for (const p of players) p.points[mode].place = 1 + players.filter((o) => o.points[mode].total > p.points[mode].total).length;
  }
  return list;
}
