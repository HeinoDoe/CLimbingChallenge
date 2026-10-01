// Daily review tests on a small fake two-day dataset. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeWindow, emptyMode, addMatch } from './challenge.mjs';
import { buildReviews, reviewDay } from './review.mjs';

const CH = { start: '2026-09-30T17:40:00+02:00', end: '2026-10-14', timeZone: 'Europe/Berlin', points: { uniqueChampion: 5, pentakill: 10, quadrakill: 5 } };
const WIN = challengeWindow(CH);
const at = (iso) => Date.parse(iso);
const DAY1 = [WIN.startMs, at('2026-09-30T22:00:00Z')];          // 30 Sep 17:40 - 1 Oct 00:00 Berlin
const DAY2 = [at('2026-09-30T22:00:00Z'), at('2026-10-01T22:00:00Z')];

function player(name, history, games) {
  const p = { key: name.toLowerCase(), name, history, modes: { solo: emptyMode(), flex: emptyMode() } };
  games.forEach(([iso, champ, win, o = {}], i) => {
    const m = { metadata: { matchId: `EUW1_${name}_${i}` }, info: { gameDuration: 1800, gameEndTimestamp: at(iso), queueId: 420 } };
    addMatch(p.modes[o.flex ? 'flex' : 'solo'], m, { championName: champ, win, kills: o.k ?? 5, deaths: o.d ?? 4, assists: o.a ?? 6, pentaKills: o.penta ?? 0, quadraKills: o.penta ?? 0 });
  });
  return p;
}

const squad = () => [
  player('Heino', [{ t: '2026-09-30T15:41:00Z', solo: 2790 }, { t: '2026-09-30T21:00:00Z', solo: 2830 }], [
    ['2026-09-30T18:00:00Z', 'Ahri', true], ['2026-09-30T19:00:00Z', 'Ekko', true, { k: 15, d: 1, a: 7, penta: 1 }], ['2026-09-30T20:00:00Z', 'Ahri', true],
  ]),
  player('Smette', [{ t: '2026-09-30T15:41:00Z', solo: 1950 }, { t: '2026-09-30T20:30:00Z', solo: 1890 }], [
    ['2026-09-30T19:30:00Z', 'Shaco', false, { k: 2, d: 10, a: 1 }], ['2026-09-30T20:15:00Z', 'Shaco', false, { d: 9 }],
  ]),
  player('Kolbe', [{ t: '2026-09-30T15:41:00Z', solo: 1600 }, { t: '2026-10-01T20:00:00Z', solo: 1700 }], [
    ['2026-10-01T10:00:00Z', 'Garen', true], ['2026-10-01T11:00:00Z', 'Garen', true], ['2026-10-01T12:00:00Z', 'Garen', true],
    ['2026-10-01T13:00:00Z', 'Garen', true], ['2026-10-01T14:00:00Z', 'Garen', true],
  ]),
];

test('day 1: winner, penta, LP loss, promotion, best game (max 5 highlights)', () => {
  const h = reviewDay(squad(), CH, WIN, ...DAY1);
  assert.equal(h.length, 5);
  assert.deepEqual(h.map((x) => x.icon), ['📈', '💥', '📉', '⬆️', '🎯']);
  assert.match(h[0].text, /\*\*Heino\*\* mit \+60 Punkten \(\+40 LP, 3 Games\)/); // 40 LP + 2 new champs + 1 penta
  assert.match(h[2].text, /\*\*Smette\*\* hat 60 LP gespendet/);
  assert.match(h[3].text, /Diamond 1 → Master\+ 30 LP/);
  assert.match(h[4].text, /15\/1\/7 auf Ekko/);
});

test('day 2: new leader, promotion, win streak', () => {
  const h = reviewDay(squad(), CH, WIN, ...DAY2);
  assert.deepEqual(h.map((x) => x.icon), ['📈', '👑', '⬆️', '🎯', '🚀']); // "didn't play" is cut by the limit of 5
  assert.match(h[0].text, /\*\*Kolbe\*\* mit \+105 Punkten/); // 100 LP + 1 new champ
  assert.match(h[1].text, /Kolbe/);
  assert.match(h[4].text, /5 Games in Folge gewonnen/);
});

test('players who did not play are named on a quiet day', () => {
  const players = [player('A', [], [['2026-10-01T10:00:00Z', 'Lux', false]]), player('B', [], []), player('C', [], [])];
  const h = reviewDay(players, CH, WIN, ...DAY2);
  assert.match(h.at(-1).text, /Kein einziges Game: \*\*B\*\*, \*\*C\*\*/);
});

test('reviews only for finished days, existing ones kept', () => {
  const players = squad();
  assert.equal(buildReviews(players, CH, WIN, at('2026-09-30T21:59:00Z')).length, 0); // day 1 not over yet
  const two = buildReviews(players, CH, WIN, at('2026-10-02T10:00:00Z'));
  assert.deepEqual(two.map((r) => r.date), ['2026-09-30', '2026-10-01']);
  assert.equal(two[0].startMs, WIN.startMs); // first day starts at the challenge start, not midnight
  const kept = [{ date: '2026-09-30', startMs: 0, endMs: 0, highlights: [{ icon: 'x', text: 'old' }] }];
  assert.equal(buildReviews(players, CH, WIN, at('2026-10-02T10:00:00Z'), kept)[0].highlights[0].text, 'old');
});

test('a day without games', () => {
  const quiet = [player('A', [], []), player('B', [], [])];
  assert.deepEqual(reviewDay(quiet, CH, WIN, ...DAY2).map((x) => x.icon), ['😴']);
});
