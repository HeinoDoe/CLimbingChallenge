// Scoring tests on a small fake dataset. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeWindow, activeWindow, emptyStats, addMatch, lpEarned, computePoints, scoreModes, pureQuadras } from './challenge.mjs';

const CH = {
  start: '2026-10-01', end: '2026-10-14', timeZone: 'Europe/Berlin', lpQueue: 'solo', minGames: 20, oneTrickMinGames: 10,
  points: {
    uniqueChampion: 5, pentakill: 10, quadrakill: 5, mostGames: 10, highestWinRate: 10, highestKda: 10,
    lowestKda: 10, bestVision: 10, longestWinStreak: 10, longestLoseStreak: 10, mostDeathsPerGame: 10, oneTrick: 10,
  },
};
const WIN = challengeWindow(CH);
const at = (iso) => Date.parse(iso);
const DURING = at('2026-10-12T12:00:00Z');
const AFTER = at('2026-10-20T12:00:00Z');

// Plays `games` fake matches: each is [champion, win, {k,d,a,vision,penta,quadra}]
function player(key, role, games = [], history = []) {
  const p = { key, name: key, role, stats: emptyStats(), champions: {}, recent: [], history };
  games.forEach(([champ, win, o = {}], i) => {
    const m = { metadata: { matchId: `EUW1_${i}` }, info: { gameDuration: 1800, gameEndTimestamp: DURING, queueId: 420 } };
    const me = { championName: champ, win, kills: o.k ?? 5, deaths: o.d ?? 5, assists: o.a ?? 5, visionScore: o.vision ?? 30,
      timePlayed: 1800, pentaKills: o.penta ?? 0, quadraKills: o.quadra ?? 0 };
    addMatch(p, m, me);
  });
  return p;
}
const many = (n, champ, win, o) => Array.from({ length: n }, () => [champ, win, o]);

test('dates: start/end are whole Berlin days, end day included', () => {
  assert.equal(new Date(WIN.startMs).toISOString(), '2026-09-30T22:00:00.000Z'); // 1 Oct 00:00 CEST
  assert.equal(new Date(WIN.endMs).toISOString(), '2026-10-14T22:00:00.000Z');   // 15 Oct 00:00 CEST
  // Across the DST switch (25 Oct): midnight is +01:00 afterwards.
  const w = challengeWindow({ start: '2026-10-20', end: '2026-10-26' });
  assert.equal(new Date(w.endMs).toISOString(), '2026-10-26T23:00:00.000Z');
});

test('LP: Plat 4 0 LP -> Plat 1 0 LP is +300', () => {
  const h = [{ t: '2026-10-01T08:00:00Z', solo: 1600 }, { t: '2026-10-05T08:00:00Z', solo: 1900 }];
  assert.equal(lpEarned(h, 'solo', WIN, DURING).lp, 300);
});

test('LP: snapshots before the start are ignored, losses go negative', () => {
  const h = [{ t: '2026-09-20T08:00:00Z', solo: 2000 }, { t: '2026-10-01T08:00:00Z', solo: 1950 }, { t: '2026-10-06T08:00:00Z', solo: 1810 }];
  const r = lpEarned(h, 'solo', WIN, DURING);
  assert.equal(r.baseScore, 1950);
  assert.equal(r.lp, -140);
});

test('LP: unranked at the start uses the first ranked snapshot', () => {
  const h = [{ t: '2026-10-01T08:00:00Z', solo: null }, { t: '2026-10-04T08:00:00Z', solo: 1200 }, { t: '2026-10-08T08:00:00Z', solo: 1275 }];
  const r = lpEarned(h, 'solo', WIN, DURING);
  assert.equal(r.baseScore, 1200);
  assert.equal(r.lp, 75);
  assert.equal(lpEarned([{ t: '2026-10-02T08:00:00Z', solo: null }], 'solo', WIN, DURING), null);
});

test('LP: frozen at the last snapshot before the end', () => {
  const h = [{ t: '2026-10-01T08:00:00Z', solo: 1000 }, { t: '2026-10-14T20:00:00Z', solo: 1150 }, { t: '2026-10-16T08:00:00Z', solo: 1500 }];
  const live = lpEarned(h, 'solo', WIN, at('2026-10-14T21:00:00Z')); // last evening, still running
  assert.deepEqual([live.lp, live.frozen], [150, false]);
  const r = lpEarned(h, 'solo', WIN, AFTER);
  assert.equal(r.lp, 150);
  assert.equal(r.frozen, true);
});

test('achievements: unique champs, pentas, quadras', () => {
  const p = player('a', 'Mid', [
    ['Ahri', true],
    ['Jinx', true, { penta: 1, quadra: 1 }],  // one penta (Riot also counts its quadra)
    ['Jinx', false, { quadra: 2 }],           // two real quadras
    ['Lux', true],
  ]);
  computePoints([p], CH, WIN, DURING);
  const a = p.points.achievements;
  assert.deepEqual(Object.keys(a), ['uniqueChampions', 'pentakills', 'quadrakills']);
  assert.deepEqual([a.uniqueChampions.points, a.pentakills.points, a.quadrakills.points], [15, 10, 10]);
  assert.equal(p.points.achievementsTotal, 35);
});

test('quadras: a quadra that became a penta is not counted', () => {
  // Real match EUW1_7991476648 reported quadraKills=1, pentaKills=1 for one penta.
  assert.equal(pureQuadras({ quadraKills: 1, pentaKills: 1 }), 0);
  assert.equal(pureQuadras({ quadraKills: 2, pentaKills: 1 }), 1); // one penta + one separate quadra
  assert.equal(pureQuadras({ quadraKills: 1, pentaKills: 0 }), 1);
  const p = player('q', 'Mid', [['Katarina', true, { quadra: 1, penta: 1 }]]);
  computePoints([p], CH, WIN, DURING);
  assert.equal(p.points.achievements.quadrakills.count, 0);
  assert.equal(p.points.achievements.pentakills.count, 1);
});

test('awards: under 20 games does not qualify, ties share first, pending until the end', () => {
  const lp = (v) => [{ t: '2026-10-01T08:00:00Z', solo: 1000 }, { t: '2026-10-10T08:00:00Z', solo: 1000 + v }];
  const ann = player('ann', 'Top', [...many(15, 'Garen', true), ...many(10, 'Darius', false)], lp(-80));   // 25 games, 60%
  const ben = player('ben', 'Mid', [...many(15, 'Ahri', true), ...many(10, 'Zed', false)], lp(120));      // 25 games, 60% (tie)
  const cat = player('cat', 'ADC', many(12, 'Jinx', true), lp(40));                                      // 12 games, 100% but < 20
  const dan = player('dan', 'Support', [], []);                                                          // unranked, no games
  const all = [ann, ben, cat, dan];

  const live = computePoints(all, CH, WIN, DURING);
  const wr = live.find((a) => a.key === 'highestWinRate');
  assert.deepEqual(wr.leaders.map((l) => l.key).sort(), ['ann', 'ben']);
  assert.equal(cat.points.awards.highestWinRate.qualifies, false);
  assert.equal(ann.points.awardsTotal, 0);           // pending before the end
  assert.ok(ann.points.awardsProvisional > 0);
  assert.equal(ann.points.lp, -80);
  assert.equal(dan.points.lp, null);
  assert.equal(dan.points.total, 0);

  const final = computePoints(all, CH, WIN, AFTER);
  assert.equal(final[0].final, true);
  assert.equal(ann.points.awards.highestWinRate.points, 10);
  assert.equal(ben.points.awards.highestWinRate.points, 10);
  assert.equal(cat.points.awards.highestWinRate.points, 0);
  // Total = LP + achievements + awards, and it can be negative.
  for (const p of all) assert.equal(p.points.total, (p.points.lp ?? 0) + p.points.achievementsTotal + p.points.awardsTotal);
  // mostGames: ann and ben tie on 25.
  assert.deepEqual(final.find((a) => a.key === 'mostGames').leaders.map((l) => l.key).sort(), ['ann', 'ben']);
});

test('awards: lowest KDA, deaths per game, streaks', () => {
  const a = player('a', 'Top', many(20, 'Garen', true, { k: 2, d: 8, a: 2 }));   // KDA 0.5, 8 deaths/game, 20-win streak
  const b = player('b', 'Mid', [...many(4, 'Ahri', false, { k: 10, d: 1, a: 10 }), ...many(16, 'Ahri', true, { k: 10, d: 1, a: 10 })]);
  const aw = computePoints([a, b], CH, WIN, AFTER);
  const lead = (k) => aw.find((x) => x.key === k).leaders.map((l) => l.key);
  assert.deepEqual(lead('lowestKda'), ['a']);
  assert.deepEqual(lead('highestKda'), ['b']);
  assert.deepEqual(lead('mostDeathsPerGame'), ['a']);
  assert.deepEqual(lead('longestWinStreak'), ['a']);
  assert.deepEqual(lead('longestLoseStreak'), ['b']);
});

test('one-trick: top two by best-champion win rate, ties at the cut-off included', () => {
  const p1 = player('p1', 'Top', [...many(9, 'Garen', true), ...many(1, 'Garen', false)]);   // 90%
  const p2 = player('p2', 'Mid', [...many(8, 'Ahri', true), ...many(2, 'Ahri', false)]);     // 80%
  const p3 = player('p3', 'ADC', [...many(8, 'Jinx', true), ...many(2, 'Jinx', false)]);     // 80% (tie at cut-off)
  const p4 = player('p4', 'Support', [...many(7, 'Lulu', true), ...many(3, 'Lulu', false)]); // 70%
  const p5 = player('p5', 'Jungle', many(9, 'Shaco', true));                                  // 9 games: not enough
  const aw = computePoints([p1, p2, p3, p4, p5], CH, WIN, AFTER);
  assert.deepEqual(aw.find((a) => a.key === 'oneTrick').leaders.map((l) => l.key), ['p1', 'p2', 'p3']);
  assert.equal(p4.points.awards.oneTrick.points, 0);
  assert.equal(p5.points.awards.oneTrick.qualifies, false);
});

test('places: ties share a place, sorted by total', () => {
  const x = player('x', 'Top', [['Garen', true]]);
  const y = player('y', 'Mid', [['Ahri', true]]);
  const z = player('z', 'ADC', [['Jinx', true], ['Ezreal', true]]);
  computePoints([x, y, z], CH, WIN, DURING);
  assert.deepEqual([z, x, y].map((p) => p.points.place), [1, 2, 2]);
});

test('trial run: counts from its own start until the real start, then switches', () => {
  const ch = { ...CH, preview: { start: '2026-09-28' } };
  const trial = activeWindow(ch, at('2026-09-29T12:00:00Z'));
  assert.equal(trial.preview, true);
  assert.equal(new Date(trial.startMs).toISOString(), '2026-09-27T22:00:00.000Z'); // 28 Sep 00:00 Berlin
  assert.equal(trial.endMs, WIN.startMs);                                           // ends when the real one starts
  const real = activeWindow(ch, at('2026-10-01T08:00:00Z'));
  assert.equal(real.preview, undefined);
  assert.deepEqual([real.startMs, real.endMs], [WIN.startMs, WIN.endMs]);
  // After the switch, trial snapshots no longer count for LP.
  const h = [{ t: '2026-09-28T10:00:00Z', solo: 1000 }, { t: '2026-09-30T10:00:00Z', solo: 1200 }, { t: '2026-10-01T06:00:00Z', solo: 1200 }, { t: '2026-10-03T06:00:00Z', solo: 1230 }];
  assert.equal(lpEarned(h, 'solo', trial, at('2026-09-30T12:00:00Z')).lp, 200);
  assert.equal(lpEarned(h, 'solo', real, at('2026-10-03T12:00:00Z')).lp, 30);
});

test('solo and flex are separate competitions', () => {
  const mode = (games) => { const { stats, champions, recent } = player('tmp', 'Mid', games); return { stats, champions, recent }; };
  const h = [{ t: '2026-10-01T08:00:00Z', solo: 1000, flex: 2000 }, { t: '2026-10-05T08:00:00Z', solo: 1100, flex: 1950 }];
  const p = { key: 'p', history: h, modes: { solo: mode([['Ahri', true], ['Zed', true]]), flex: mode([['Jinx', false]]) } };
  const awards = scoreModes([p], CH, WIN, DURING);
  assert.equal(p.points.solo.lp, 100);
  assert.equal(p.points.flex.lp, -50);
  assert.equal(p.points.solo.achievements.uniqueChampions.count, 2);
  assert.equal(p.points.flex.achievements.uniqueChampions.count, 1);
  assert.deepEqual(Object.keys(awards), ['solo', 'flex']);
});

import { isRemake } from './challenge.mjs';

test('remakes: only Riot\'s early-surrender flag counts, not the game length', () => {
  // EUW1_8001245197: 4:20, enemy surrendered after a leaver, +31 LP for the winners.
  assert.equal(isRemake({ win: true, gameEndedInEarlySurrender: false, gameEndedInSurrender: true, timePlayed: 260 }), false);
  assert.equal(isRemake({ win: false, gameEndedInEarlySurrender: true, timePlayed: 200 }), true);
});
