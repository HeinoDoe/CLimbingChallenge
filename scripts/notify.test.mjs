// Tests for the Discord posts, Prime League result detection and the ▲/▼ places.
// Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifications, leaderboardText, resultEmbed } from './notify.mjs';
import { extractGame } from './results.mjs';
import { trackPlaces } from './challenge.mjs';

const player = (key, name, place, total, log = [], prevPlace = null) => ({
  key, name, points: { solo: { place, total, prevPlace }, flex: { place: 1, total: 0 } },
  modes: { solo: { log }, flex: { log: [] } },
});
const review = (date) => ({ date, startMs: Date.parse(`${date}T00:00:00+02:00`), highlights: [{ icon: '📈', text: 'Tagessieger: **A**' }] });
const data = (players, reviews = [], key = 'k1') => ({ reviewsKey: key, reviews, players });

test('new daily review is posted with the leaderboard', () => {
  const prev = data([player('a', 'A', 1, 50), player('b', 'B', 2, 20)], [review('2026-10-01')]);
  const next = data([player('a', 'A', 1, 60, [], 1), player('b', 'B', 2, 30, [], 2)], [review('2026-10-01'), review('2026-10-02')]);
  const out = buildNotifications(prev, next, { siteUrl: 'https://x/' });
  assert.equal(out.length, 1);
  assert.match(out[0].title, /Tagesrückblick · Freitag, 2\.10\./);
  assert.match(out[0].fields[0].value, /🥇 \*\*A\*\* · 60 Punkte/);
});

test('new pentakill and new leader are posted once', () => {
  const penta = { t: 5, champ: 'Katarina', k: 15, d: 2, a: 4, penta: 1 };
  const prev = data([player('a', 'A', 1, 50), player('b', 'B', 2, 40)]);
  const next = data([player('a', 'A', 2, 50), player('b', 'B', 1, 70, [penta])]);
  const out = buildNotifications(prev, next);
  assert.deepEqual(out.map((e) => e.title), ['💥 PENTAKILL!', '👑 Neuer Spitzenreiter']);
  assert.match(out[0].description, /\*\*B\*\* hat auf Katarina/);
  assert.match(out[1].description, /\*\*B\*\* führt jetzt mit 70 Punkten, vor \*\*A\*\*/);
  assert.equal(buildNotifications(next, next).length, 0); // nothing new the next run
});

test('nothing is posted after a reset or on the first run', () => {
  const next = data([player('a', 'A', 1, 50)], [review('2026-10-01')], 'k2');
  assert.equal(buildNotifications(data([], [], 'k1'), next).length, 0);
  assert.equal(buildNotifications({}, next).length, 0);
});

test('leaderboard text: top 3 with arrows, plus last place', () => {
  const ps = [player('a', 'A', 1, 90, [], 2), player('b', 'B', 2, 80, [], 1), player('c', 'C', 3, 10), player('d', 'D', 4, -5, [], 4)];
  assert.equal(leaderboardText(ps), '🥇 **A** · 90 Punkte ▲1\n🥈 **B** · 80 Punkte ▼1\n🥉 **C** · 10 Punkte\n🤡 4. **D** · -5 Punkte');
});

test('tournament match: finds our side, lineups by position, bans and opponent', () => {
  const p = (name, tag, teamId, pos, champ, win) => ({ riotIdGameName: name, riotIdTagline: tag, teamId, teamPosition: pos, championName: champ, kills: 1, deaths: 2, assists: 3, win });
  const m = {
    metadata: { matchId: 'EUW1_1' },
    info: {
      gameEndTimestamp: 1000, gameDuration: 1800,
      participants: [
        p('Smette', 'xDD', 200, 'JUNGLE', 'MonkeyKing', true), p('Jack The Dripper', '1608', 200, 'TOP', 'Trundle', true),
        p('HeinoDoe', '213', 200, 'MIDDLE', 'Ekko', true), p('MENTALITY MEN', 'xdd', 200, 'BOTTOM', 'Caitlyn', true), p('HennenG', 'YEET', 200, 'UTILITY', 'Nautilus', true),
        p('Ruvex', 'Fool', 100, 'TOP', 'KSante', false), p('Señor Flausch', 'EUW', 100, 'JUNGLE', 'XinZhao', false),
        p('WoFu Ven', 'EUW', 100, 'MIDDLE', 'Anivia', false), p('Sub', '1', 100, 'BOTTOM', 'Varus', false), p('LordSteve', 'EUW', 100, 'UTILITY', 'Nami', false),
      ],
      teams: [{ teamId: 100, bans: [{ championId: 1 }] }, { teamId: 200, bans: [{ championId: 2 }, { championId: -1 }] }],
    },
  };
  const ours = [{ name: 'Kolbe', riotId: 'Jack The Dripper#1608' }, { name: 'Smette', riotId: 'Smette#xDD' }, { name: 'Heino', riotId: 'HeinoDoe#213' }];
  const theirs = [{ name: 'Ruvex', riotId: 'Ruvex#Fool' }, { name: 'Señor Flausch', riotId: 'Señor Flausch#EUW' }];
  const g = extractGame(m, ours, theirs, { 1: 'Braum', 2: 'JarvanIV' });
  assert.equal(g.win, true);
  assert.equal(g.side, 'red');
  assert.deepEqual(g.us.map((x) => x.champ), ['Trundle', 'MonkeyKing', 'Ekko', 'Caitlyn', 'Nautilus']);
  assert.deepEqual(g.us.slice(0, 2).map((x) => x.name), ['Kolbe', 'Smette']);
  assert.deepEqual([g.ourBans, g.theirBans], [['JarvanIV'], ['Braum']]);
  assert.equal(g.vsOpponent, true);
  assert.match(resultEmbed(1, 'BS eSports', g).title, /✅ Sieg · Spieltag 1 vs BS eSports/);
  // A tournament game without 3 of us on one team is ignored.
  assert.equal(extractGame(m, ours.slice(0, 2), theirs), null);
});

test('places: movement against the last snapshot of an earlier day', () => {
  const ps = [{ key: 'a', points: { solo: { place: 1 }, flex: { place: 2 } } }, { key: 'b', points: { solo: { place: 2 }, flex: { place: 1 } } }];
  let snaps = trackPlaces(ps, {}, '2026-10-01');
  assert.equal(ps[0].points.solo.prevPlace, null); // first day: nothing to compare
  ps[0].points.solo.place = 2; ps[1].points.solo.place = 1;
  snaps = trackPlaces(ps, snaps, '2026-10-02');
  assert.deepEqual([ps[0].points.solo.prevPlace, ps[1].points.solo.prevPlace], [1, 2]);
  snaps = trackPlaces(ps, snaps, '2026-10-02'); // later run the same day still compares with yesterday
  assert.equal(ps[0].points.solo.prevPlace, 1);
  assert.deepEqual(Object.keys(snaps), ['2026-10-01', '2026-10-02']);
});
