// Bingo tests: facts from a match, the timeline Elder check and the card scoring.
// Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CELLS, LINES, matchFacts, teamKilledElder, mightHaveElder, mainPosition, scoreBingo } from './bingo.mjs';

const P = (puuid, teamId, pos, o = {}) => ({
  puuid, teamId, teamPosition: pos, win: teamId === 100, kills: o.k ?? 2, deaths: o.d ?? 2, assists: o.a ?? 2,
  totalMinionsKilled: o.cs ?? 150, neutralMinionsKilled: 0, goldEarned: o.gold ?? 9000, visionScore: o.vs ?? 20,
  totalDamageDealtToChampions: o.dmg ?? 10000, quadraKills: o.quadra ?? 0,
});
const match = (participants, dragons = [0, 0], barons = [0, 0]) => ({
  metadata: { matchId: 'EUW1_1' },
  info: { gameDuration: 1500, participants, teams: [
    { teamId: 100, objectives: { dragon: { kills: dragons[0] }, baron: { kills: barons[0] } } },
    { teamId: 200, objectives: { dragon: { kills: dragons[1] }, baron: { kills: barons[1] } } },
  ] },
});

test('facts: lane opponent diffs, team bests, kill share, duo partner', () => {
  const me = P('me', 100, 'MIDDLE', { k: 10, d: 0, a: 5, cs: 260, gold: 14000, vs: 40, dmg: 30000 });
  const m = match([me, P('mate', 100, 'TOP', { k: 3 }), P('x1', 100, 'JUNGLE', { k: 2 }), P('x2', 100, 'BOTTOM'), P('x3', 100, 'UTILITY'),
    P('opp', 200, 'MIDDLE', { k: 1, d: 6, a: 1, cs: 180, gold: 9000, dmg: 9000 }), P('e2', 200, 'TOP'), P('e3', 200, 'JUNGLE'), P('e4', 200, 'BOTTOM'), P('e5', 200, 'UTILITY')], [4, 1]);
  const f = matchFacts(m, me, { squadPuuids: new Set(['mate']) });
  assert.deepEqual([f.cs, f.gold, f.ka, f.dmg], [80, 5000, 13, 21000]);
  assert.equal(f.dmgTop && f.vision && f.kda10, true);
  assert.equal(f.worstKda, false);
  assert.equal(f.drakes, 4);
  assert.equal(f.duo, true);
  assert.equal(Math.round(f.kp * 100), Math.round(15 / 19 * 100)); // (10 + 5) / team kills 19
});

test('elder: timeline check, and only fetched when it could have happened', () => {
  const me = P('me', 100, 'JUNGLE');
  const tl = { info: { frames: [{ events: [{ type: 'ELITE_MONSTER_KILL', monsterType: 'DRAGON', monsterSubType: 'ELDER_DRAGON', killerTeamId: 100 }] }] } };
  assert.equal(teamKilledElder(tl, 100), true);
  assert.equal(teamKilledElder(tl, 200), false);
  assert.equal(mightHaveElder(match([me], [1, 4], [1, 0]), me), true);  // they have soul, we have a Baron
  assert.equal(mightHaveElder(match([me], [3, 2], [1, 0]), me), false); // nobody reached soul
  assert.equal(mightHaveElder(match([me], [4, 0], [0, 0]), me), false); // no Baron
});

const W = { start: '2026-10-03T07:30:00+02:00', end: '2026-10-09' };
const CH = { timeZone: 'Europe/Berlin', bingo: { id: 'b2', title: 'Bingo', points: 20, winners: 3, ...W } };
const t0 = Date.parse('2026-10-03T08:00:00+02:00');
const base = { pos: 'MIDDLE', dur: 1500, cs: 0, gold: 0, ka: -1, dmg: 0, dmgTop: false, vision: false, worstKda: false, kda10: false, kp: 0.3, quadra: false, drakes: 0, duo: false };
let n = 0;
const game = (o = {}, f = {}) => ({ t: t0 + (n++) * 3600_000, win: true, champ: 'Ahri', k: 3, d: 3, a: 3, ...o, f: { ...base, ...f } });
const pl = (key, games, extra = {}) => ({ key, role: 'Mid', points: { solo: { total: 0, place: 0 }, flex: { total: 0, place: 0 } }, modes: { solo: { log: games }, flex: { log: [] } }, ...extra });
const firstRow = () => [game({ d: 0 }), game({}, { cs: 70 }), game({}, { kda10: true }), game({}, { dur: 2600 }), game({ win: false }, { drakes: 4 })];

test('a full row is a bingo; only games inside the window count', () => {
  n = 0;
  const p = pl('a', [game({ t: t0 - 86_400_000, d: 0 }), ...firstRow().slice(1)]); // deathless win before the start
  let s = scoreBingo([p], CH, t0 + 86_400_000);
  assert.equal(s.players[0].bingoAt, null);
  assert.equal(Object.keys(s.players[0].done).includes('0'), false);
  n = 0;
  const q = pl('a', firstRow());
  s = scoreBingo([q], CH, t0 + 86_400_000);
  assert.deepEqual(s.players[0].lines, [[0, 1, 2, 3, 4]]);
  assert.equal(q.points.solo.total, 20);
  assert.equal(s.cells.length, 25);
});

test('first 3 bingos get the points, the 4th does not', () => {
  const ps = ['a', 'b', 'c', 'd'].map((k, i) => { n = i * 10; return pl(k, firstRow()); });
  const s = scoreBingo(ps, CH, t0 + 5 * 86_400_000);
  assert.deepEqual(ps.map((p) => p.points.solo.total), [20, 20, 20, 0]);
  assert.equal(s.status, 'done');
  assert.deepEqual(s.players.slice(0, 3).map((r) => r.rank), [1, 2, 3]);
});

test('sequence fields: 3 wins in a row, win after 2 losses, 5 games and 3 wins a day, 4 champions', () => {
  n = 0;
  const games = [game({ win: false }), game({ win: false }), game({ champ: 'Zed' }), game({ champ: 'Lux' }), game({ champ: 'Jinx' })];
  const s = scoreBingo([pl('a', games)], CH, t0 + 86_400_000);
  const done = s.players[0].done;
  const idx = (text) => CELLS.findIndex((c) => c.text.startsWith(text));
  assert.equal(done[idx('3 Siege in Folge')], games[4].t);
  assert.equal(done[idx('Sieg nach 2 Niederlagen')], games[2].t);
  assert.equal(done[idx('5 Ranked-Spiele')], games[4].t);
  assert.equal(done[idx('3 Siege an einem Tag')], games[4].t);
  assert.equal(done[idx('Sieg mit 4 verschiedenen')], undefined); // only 3 different winning champs
});

test('off-role uses the configured role, else the most played position; top-20 mastery from the snapshot', () => {
  n = 0;
  const idx = (text) => CELLS.findIndex((c) => c.text.startsWith(text));
  const p = pl('a', [game({ champ: 'Garen' }, { pos: 'TOP' })], { bingoMastery: { id: 'b2', champs: ['Ahri', 'Zed'] } });
  const s = scoreBingo([p], CH, t0 + 86_400_000);
  assert.ok(s.players[0].done[idx('Sieg auf einer Off-Role')]);
  assert.ok(s.players[0].done[idx('Sieg mit einem Champ außerhalb')]); // Garen isn't in the top 20
  const noRole = pl('b', [game({}, { pos: 'BOTTOM' }), game({}, { pos: 'BOTTOM' }), game({}, { pos: 'TOP' })], { role: '' });
  assert.equal(mainPosition(noRole), 'BOTTOM');
  assert.equal(LINES.length, 12);
});
