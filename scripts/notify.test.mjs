// Tests for the Discord posts, Prime League result detection and the ▲/▼ places.
// Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifications, leaderboardText, dailyEmbed } from './notify.mjs';
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

test('only the daily post: pentakills, a new leader or bounty changes are not posted on their own', () => {
  const penta = { t: 5, champ: 'Katarina', k: 15, d: 2, a: 4, penta: 1 };
  const bounty = (status) => ({ id: 'b1', title: 'T', desc: 'D', target: 10, points: 20, startMs: 0, endMs: 9e15, status, winners: status === 'won' ? ['b'] : [], progress: [] });
  const prev = { ...data([player('a', 'A', 1, 50), player('b', 'B', 2, 40)]), bounties: [] };
  const next = { ...data([player('a', 'A', 2, 50), player('b', 'B', 1, 70, [penta])]), bounties: [bounty('won')] };
  assert.equal(buildNotifications(prev, next).length, 0);
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

import { scoreBounties } from './challenge.mjs';

const BOUNTY = { id: 'b1', type: 'distinctChampionWins', queue: 'solo', title: '10 verschiedene Champions', desc: 'd', target: 3, points: 20, start: '2026-10-01', end: '2026-10-04' };
const t = (iso) => Date.parse(iso);
const bp = (key, total, games) => ({ key, name: key.toUpperCase(), points: { solo: { total, place: 0 }, flex: { total: 0, place: 0 } },
  modes: { solo: { log: games.map(([iso, champ, win]) => ({ t: t(iso), champ, win })) }, flex: { log: [] } } });

test('bounty: first to N different winning champions gets the points and moves up', () => {
  const a = bp('a', 50, [['2026-10-01T10:00Z', 'Ahri', true], ['2026-10-01T11:00Z', 'Ahri', true], ['2026-10-01T12:00Z', 'Zed', false],
    ['2026-10-02T10:00Z', 'Zed', true], ['2026-10-03T10:00Z', 'Lux', true]]);                     // 3rd champ on 3 Oct
  const b = bp('b', 60, [['2026-09-30T10:00Z', 'Jinx', true],                                        // before the bounty
    ['2026-10-01T10:00Z', 'Ezreal', true], ['2026-10-02T09:00Z', 'Caitlyn', true], ['2026-10-03T20:00Z', 'Varus', true]]); // 3rd later
  const [s] = scoreBounties([a, b], { bounties: [BOUNTY] }, t('2026-10-03T22:00Z'));
  assert.equal(s.status, 'won');
  assert.deepEqual(s.winners, ['a']);
  assert.equal(a.points.solo.total, 70);
  assert.deepEqual([a.points.solo.place, b.points.solo.place], [1, 2]);
  assert.deepEqual(a.points.solo.bounties.b1, { progress: 3, target: 3, points: 20 });
  assert.equal(b.points.solo.bounties.b1.points, 0);
});

test('bounty: open while nobody has it, shared when reached in the same game, expired after the end', () => {
  const x = bp('x', 0, [['2026-10-01T10:00Z', 'Ahri', true]]);
  assert.equal(scoreBounties([x], { bounties: [BOUNTY] }, t('2026-10-02T10:00Z'))[0].status, 'open');
  assert.equal(scoreBounties([bp('x', 0, [])], { bounties: [BOUNTY] }, t('2026-10-05T10:00Z'))[0].status, 'expired');
  const g = [['2026-10-01T10:00Z', 'Ahri', true], ['2026-10-01T11:00Z', 'Zed', true], ['2026-10-01T12:00Z', 'Lux', true]];
  const [s] = scoreBounties([bp('d1', 0, g), bp('d2', 0, g)], { bounties: [BOUNTY] }, t('2026-10-02T10:00Z'));
  assert.deepEqual(s.winners, ['d1', 'd2']);
});

test("daily post: bounty status and that day's Prime League games", () => {
  const day = review('2026-10-04');
  day.endMs = day.startMs + 86_400_000;
  const players = [player('a', 'A', 1, 10)];
  const b = { id: 'b1', title: '10 verschiedene Champions', points: 20, target: 10, startMs: 0, endMs: day.endMs, status: 'open', winners: [], progress: [{ key: 'a', value: 4 }] };
  const results = { days: { 1: { games: [
    { t: day.startMs + 19 * 3600_000, win: true, us: [{ champ: 'Trundle' }, { champ: 'MonkeyKing' }] },
    { t: day.startMs - 3600_000, win: false, us: [{ champ: 'Ahri' }] }, // the day before: not in this post
  ] } } };
  const e = dailyEmbed(day, { players, bounties: [b] }, { results, gamedays: [{ day: 1, opponent: { name: 'BS eSports' } }] });
  assert.deepEqual(e.fields.map((f) => f.name), ['🏆 Leaderboard Solo/Duo', '🎯 Wochen-Bounty: 10 verschiedene Champions (+20)', '⚔️ Prime League']);
  assert.match(e.fields[1].value, /\*\*A\*\* 4\/10 · läuft bis Sonntag, 4\.10\./);
  assert.equal(e.fields[2].value, '✅ Sieg · Spieltag 1 vs BS eSports · Trundle, Wukong');
  const won = dailyEmbed(day, { players, bounties: [{ ...b, status: 'won', winners: ['a'] }] });
  assert.equal(won.fields[1].value, 'Geschafft von **A**!');
});
