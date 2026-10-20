// Tests for the Worlds betting sync: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, pricesOf, resultOf, marketsOf, isWorldsMatch, teamsOf, settingsOf } from './worlds.mjs';

const market = (o) => ({ id: 1, sportsMarketType: 'moneyline', outcomes: '["Gen.G", "Invictus Gaming"]', outcomePrices: '["0.775", "0.225"]',
  bestBid: 0.77, bestAsk: 0.78, closed: false, acceptingOrders: true, ...o });
const event = (o) => ({ id: '1214238', slug: 'lol-gen-ig1-2026-10-23', title: 'LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage',
  startTime: '2026-10-23T17:00:00Z', score: null, markets: [market({})], ...o });

test('titles split into teams, best-of and stage', () => {
  assert.deepEqual(parseTitle('LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage'), { title: 'Gen.G vs Invictus Gaming', bestOf: 1, stage: 'Worlds Group Stage' });
  assert.deepEqual(parseTitle('LoL: Karmine Corp vs MVK Esports (BO5) - Worlds Play-In'), { title: 'Karmine Corp vs MVK Esports', bestOf: 5, stage: 'Worlds Play-In' });
});

test('prices only for real markets', () => {
  assert.deepEqual(pricesOf(market({})), [0.775, 0.225]);
  assert.equal(pricesOf(market({ bestBid: 0.03, bestAsk: 0.97, outcomePrices: '["0.5", "0.5"]' })), null); // empty book
  assert.equal(pricesOf(market({ bestBid: undefined, bestAsk: 1 })), null);
  assert.deepEqual(pricesOf(market({ bestBid: 0.4, bestAsk: 0.5, outcomePrices: '["0.45", "0.55"]' })), [0.45, 0.55]); // 10 cent spread is fine
  assert.equal(pricesOf(market({ outcomePrices: '["0.995", "0.005"]', bestBid: 0.99, bestAsk: 1 })), null); // decided, odds would be silly
  assert.equal(pricesOf(market({ closed: true })), null);
  assert.equal(pricesOf(market({ acceptingOrders: false })), null);
});

test('results: winner, void, or still open', () => {
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["1", "0"]' })), 0);
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["0", "1"]' })), 1);
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["0.5", "0.5"]' })), -1);
  assert.equal(resultOf(market({ closed: false, outcomePrices: '["1", "0"]' })), null);
  assert.equal(resultOf(market({ closed: true, outcomePrices: '["0.98", "0.02"]' })), null);
});

test('an event becomes market rows', () => {
  const e = event({ markets: [
    market({ id: 11 }),
    market({ id: 12, sportsMarketType: 'lol_penta_kill', question: 'Game 1: Any Player Penta Kill?', outcomes: '["Yes", "No"]', outcomePrices: '["0.5", "0.5"]', bestBid: 0.01, bestAsk: 0.99 }),
    market({ id: 13, sportsMarketType: 'totals', groupItemTitle: 'O/U 3.5 Games', question: 'Games Total: O/U 3.5', outcomes: '["Over", "Under"]', outcomePrices: '["0.41", "0.59"]', bestBid: 0.4, bestAsk: 0.42 }),
    market({ id: 14, sportsMarketType: 'something_new' }),
  ] });
  const rows = marketsOf(e);
  assert.deepEqual(rows.map((r) => r.id), ['11', '12', '13']);
  assert.deepEqual(rows[0], { id: '11', event_id: '1214238', event_title: 'Gen.G vs Invictus Gaming', stage: 'Worlds Group Stage', best_of: 1,
    kind: 'moneyline', label: 'Match Winner', outcomes: ['Gen.G', 'Invictus Gaming'], prices: [0.775, 0.225], starts_at: '2026-10-23T17:00:00.000Z', score: null, result: null });
  assert.equal(rows[1].prices, null);
  assert.equal(rows[1].label, 'Game 1: Any Player Penta Kill?');
  assert.equal(rows[2].label, 'O/U 3.5 Games');
  // falls back to the market's start time
  assert.equal(marketsOf(event({ startTime: undefined, markets: [market({ gameStartTime: '2026-10-23 17:00:00+00' })] }))[0].starts_at, '2026-10-23T17:00:00.000Z');
  assert.deepEqual(marketsOf(event({ markets: [market({ sportsMarketType: 'totals' })] })), []); // no match winner, no rows
});

test('only Worlds matches count', () => {
  assert.ok(isWorldsMatch(event({})));
  assert.ok(!isWorldsMatch(event({ title: 'LoL: Vitality Rising Bees vs G2 HEL (BO5) - LGC Rising Playoffs' })));
  assert.ok(!isWorldsMatch(event({ slug: 'worlds-2026-winner' })));
  assert.ok(!isWorldsMatch(event({ markets: [market({ sportsMarketType: 'totals' })] })));
});

test('teams for the picks, with results once known', () => {
  const yesNo = (team, yes, o = {}) => ({ groupItemTitle: team, outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), bestBid: yes - 0.005, bestAsk: yes + 0.005, closed: false, ...o });
  const winner = { markets: [yesNo('Gen.G', 0.315), yesNo('Cloud9', 0, { closed: true }), yesNo('Other', 0.5, { bestBid: 0, bestAsk: 1 }),
    yesNo('Team I', 0.5, { bestBid: 0, bestAsk: 1 }), yesNo('T1', 1, { closed: true }), yesNo('LOS', 0.0005, { bestBid: undefined, bestAsk: 0.001 })] };
  const final = { markets: [yesNo('Gen.G', 0, { closed: true }), yesNo('T1', 1, { closed: true })] };
  const teams = teamsOf(winner, final);
  assert.deepEqual(teams.map((t) => t.team), ['Gen.G', 'Cloud9', 'T1', 'LOS']);
  assert.deepEqual(teams[0], { team: 'Gen.G', win_price: 0.315, final_price: 0, out: false, won: null, finalist: false });
  assert.equal(teams[1].out, true);
  assert.equal(teams[2].won, true); assert.equal(teams[2].finalist, true); assert.equal(teams[2].out, false);
  assert.deepEqual(teamsOf(undefined, undefined), []);
});

test('config becomes database settings', () => {
  assert.deepEqual(settingsOf({ start: '2026-10-20', end: '2026-11-14', startBalance: 100, daily: 10, winnerBonus: 20, finalistBonus: 10, picksLock: '2026-11-03T12:00:00+01:00' }),
    { start_day: '2026-10-20', end_day: '2026-11-14', start_balance: 100, daily: 10, winner_bonus: 20, finalist_bonus: 10, picks_lock: '2026-11-03T12:00:00+01:00' });
});
