// Tests for the Worlds Tippspiel sync: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, gameDay, priceOf, resultOf, gameChance, favourite, seriesScore, matchOf, isWorldsMatch, teamOddsOf, teamsOf, settingsOf, pickTypesOf } from './worlds.mjs';

const market = (o) => ({ id: 1, sportsMarketType: 'moneyline', outcomes: '["Gen.G", "Invictus Gaming"]', outcomePrices: '["0.775", "0.225"]',
  bestBid: 0.77, bestAsk: 0.78, closed: false, ...o });
const event = (o) => ({ id: '1214238', slug: 'lol-gen-ig1-2026-10-23', title: 'LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage',
  startTime: '2026-10-23T17:00:00Z', score: null, markets: [market({})], ...o });
const game = (n, winner) => market({ id: 100 + n, sportsMarketType: 'child_moneyline', closed: winner != null,
  outcomePrices: winner === 0 ? '["1", "0"]' : winner === 1 ? '["0", "1"]' : winner === -1 ? '["0.5", "0.5"]' : '["0.6", "0.4"]' });

test('titles split into teams, best-of and stage', () => {
  assert.deepEqual(parseTitle('LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage'), { title: 'Gen.G vs Invictus Gaming', bestOf: 1, stage: 'Worlds Group Stage' });
  assert.deepEqual(parseTitle('LoL: Karmine Corp vs MVK Esports (BO5) - Worlds Play-In'), { title: 'Karmine Corp vs MVK Esports', bestOf: 5, stage: 'Worlds Play-In' });
});

test('prices only from real markets', () => {
  assert.equal(priceOf(market({})), 0.775);
  assert.equal(priceOf(market({ bestBid: 0.03, bestAsk: 0.97 })), null);
  assert.equal(priceOf(market({ closed: true })), null);
  assert.equal(priceOf(undefined), null);
});

test('results: winner, not played, or still open', () => {
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["1", "0"]' })), 0);
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["0", "1"]' })), 1);
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["0.5", "0.5"]' })), -1);
  assert.equal(resultOf(market({ closed: false, outcomePrices: '["1", "0"]' })), null);
});

test('game chance from series chance', () => {
  // BO3: p²(3−2p); BO5: p³(10−15p+6p²)
  const p3 = gameChance(0.648, 3); assert.ok(Math.abs(p3 * p3 * (3 - 2 * p3) - 0.648) < 1e-6);
  const p5 = gameChance(0.8, 5); assert.ok(Math.abs(p5 ** 3 * (10 - 15 * p5 + 6 * p5 * p5) - 0.8) < 1e-6);
  assert.ok(Math.abs(gameChance(0.5, 5) - 0.5) < 1e-6);
});

test('auto-tip: the favourite with its most likely score', () => {
  assert.deepEqual(favourite(0.775, 1), [1, 0]);
  assert.deepEqual(favourite(0.3, 1), [0, 1]);
  assert.deepEqual(favourite(0.7, 3), [2, 0]);                // BO3 favourite: 2:0 is always likelier than 2:1
  assert.deepEqual(favourite(0.2, 3), [0, 2]);
  assert.deepEqual(favourite(0.95, 5), [3, 0]);               // big favourite: 3:0
  assert.deepEqual(favourite(0.65, 5), [3, 1]);               // close match: 3:1
  assert.deepEqual(favourite(0.35, 5), [1, 3]);
  assert.equal(favourite(null, 3), null);
});

test('series score from the game winners, else from the score line', () => {
  assert.deepEqual(seriesScore({ markets: [] }, 1, 1), [0, 1]);
  assert.deepEqual(seriesScore({ markets: [game(1, 0), game(2, 1), game(3, 0)] }, 3, 0), [2, 1]);
  assert.deepEqual(seriesScore({ markets: [game(1, 1), game(2, 1), game(3, 0), game(4, 1), game(5, -1)] }, 5, 1), [1, 3]);
  assert.equal(seriesScore({ markets: [game(1, 0), game(2, null)] }, 3, 0), null);            // game 2 not settled yet
  assert.deepEqual(seriesScore({ markets: [game(1, 0)], score: '000-000|3-0|Bo5' }, 5, 0), [3, 0]);
  assert.equal(seriesScore({ markets: [], score: '000-000|3-0|Bo5' }, 5, 1), null);           // score line disagrees with the winner
});

test('an event becomes a match row', () => {
  assert.deepEqual(matchOf(event({})), { id: '1214238', title: 'Gen.G vs Invictus Gaming', team_a: 'Gen.G', team_b: 'Invictus Gaming',
    stage: 'Worlds Group Stage', best_of: 1, starts_at: '2026-10-23T17:00:00.000Z', day: '2026-10-23', price_a: 0.775, fav_a: 1, fav_b: 0 });
  const bo5 = matchOf(event({ title: 'LoL: KC vs MVK (BO5) - Worlds Play-In', markets: [market({ closed: true, outcomePrices: '["1", "0"]' }),
    game(1, 0), game(2, 0), game(3, 1), game(4, 0), game(5, -1)] }));
  assert.deepEqual(bo5.result, [3, 1]); assert.equal(bo5.price_a, null); assert.equal(bo5.fav_a, null);
  assert.equal(matchOf(event({ markets: [market({ closed: true, outcomePrices: '["0.5", "0.5"]' })] })).void, true);
  assert.equal(matchOf(event({ startTime: undefined, markets: [market({ gameStartTime: '2026-10-23 17:00:00+00' })] })).starts_at, '2026-10-23T17:00:00.000Z');
  assert.equal(matchOf(event({ markets: [market({ sportsMarketType: 'totals' })] })), null);
});

test('game day: the event date, else US Central time', () => {
  // 02:00 in Germany on the 24th is still the 23rd's game day in North America
  assert.equal(gameDay({ eventDate: '2026-10-23' }, '2026-10-24T00:00:00Z'), '2026-10-23');
  assert.equal(gameDay({}, '2026-10-24T00:00:00Z'), '2026-10-23');
  assert.equal(gameDay({ eventDate: 'soon' }, '2026-10-23T17:00:00Z'), '2026-10-23');
});

test('only Worlds matches count', () => {
  assert.ok(isWorldsMatch(event({})));
  assert.ok(!isWorldsMatch(event({ title: 'LoL: Vitality Rising Bees vs G2 HEL (BO5) - LGC Rising Playoffs' })));
  assert.ok(!isWorldsMatch(event({ slug: 'worlds-2026-winner' })));
});

test('bonus questions: chances, results and who is out', () => {
  const yesNo = (team, yes, o = {}) => ({ groupItemTitle: team, outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), bestBid: yes - 0.01, bestAsk: yes + 0.01, closed: false, ...o });
  const winner = teamOddsOf('winner', { markets: [yesNo('Gen.G', 0.315), yesNo('Cloud9', 0, { closed: true }), yesNo('Other', 0.5, { bestBid: 0, bestAsk: 1 }),
    yesNo('Team I', 0.5, { bestBid: 0, bestAsk: 1 }), yesNo('LOS', 0.0005, { bestBid: undefined, bestAsk: 0.001 }), yesNo('T1', 0.3, { bestBid: 0.01, bestAsk: 0.6 })] });
  assert.deepEqual(winner, [
    { kind: 'winner', team: 'Gen.G', price: 0.315, hit: null },
    { kind: 'winner', team: 'Cloud9', price: 0, hit: false },
    { kind: 'winner', team: 'LOS', price: 0.0005, hit: null },
    { kind: 'winner', team: 'T1', price: null, hit: null },          // spread too wide for a chance
  ]);
  const swiss = teamOddsOf('swiss30', { markets: [yesNo('Gen.G', 0, { closed: true }), yesNo('FURIA', 0, { closed: true })] });
  const ko = teamOddsOf('knockout', { markets: [yesNo('FURIA', 0, { closed: true })] });
  assert.deepEqual(teamsOf([...winner, ...swiss, ...ko]), [
    { team: 'Gen.G', out: false },                                   // missing 3:0 is not out
    { team: 'Cloud9', out: true }, { team: 'LOS', out: false }, { team: 'T1', out: false },
    { team: 'FURIA', out: true },                                    // missed the knockouts
  ]);
});

test('config becomes settings and bonus questions', () => {
  const w = { start: '2026-10-20', end: '2026-11-14', points: { bo1: 2, winner: 2, exact: 4 },
    bonus: [{ kind: 'winner', title: 'Weltmeister', slots: 1, points: 10, lock: '2026-11-03T12:00:00+01:00', event: 'worlds-2026-winner' }] };
  assert.deepEqual(settingsOf(w), { start_day: '2026-10-20', end_day: '2026-11-14', pts_bo1: 2, pts_winner: 2, pts_exact: 4 });
  assert.deepEqual(pickTypesOf(w), [{ kind: 'winner', title: 'Weltmeister', slots: 1, points: 10, lock_at: '2026-11-03T12:00:00+01:00', sort: 1 }]);
});
