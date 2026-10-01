// Builds docs/data.sample.json (shown with ?demo=1): a made-up squad halfway through
// a 14-day challenge, scored with the real scoring code. Run with `npm run sample`.
// The page shifts all demo timestamps so the sample always looks "live".
import { readFile, writeFile } from 'node:fs/promises';
import { challengeWindow, emptyMode, addMatch, scoreModes } from './challenge.mjs';
import { buildReviews } from './review.mjs';

const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
const { preview, ...rest } = cfg.challenge;
const CH = { ...rest, start: '2026-09-21', end: '2026-10-04' };
const WIN = challengeWindow(CH);
const NOW = WIN.startMs + 7.4 * 86_400_000;

// Small seeded random generator so the sample is the same on every run.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const POS = { Top: 'TOP', Jungle: 'JUNGLE', Mid: 'MIDDLE', ADC: 'BOTTOM', Support: 'UTILITY' };
const SQUAD = [
  // name, role, start score (null = unranked at start), games, win chance, champion pool, notes
  { name: 'Climbo', role: 'Mid', score: 1850, games: 34, wr: 0.72, pool: ['Ahri', 'Ekko', 'Sylas', 'Orianna', 'Katarina', 'Yone'] },
  { name: 'Tiltmaster', role: 'Jungle', score: 2240, games: 29, wr: 0.38, pool: ['LeeSin', 'Belveth', 'Viego', 'Khazix'] },
  { name: 'Wardbot', role: 'Support', score: 1620, games: 24, wr: 0.54, pool: ['Nautilus', 'Thresh', 'Leona', 'Lulu', 'Braum'] },
  { name: 'OneTrickPony', role: 'Top', score: 1990, games: 26, wr: 0.6, pool: ['Fiora'], offRole: 0 },
  { name: 'Placementman', role: 'ADC', score: null, games: 18, wr: 0.56, pool: ['Jinx', 'Caitlyn', 'Ezreal', 'Varus'] }, // unranked at start, < 20 games
  { name: 'Grinder', role: 'ADC', score: 2810, games: 41, wr: 0.49, pool: ['Kaisa', 'Ezreal', 'Jhin', 'Caitlyn', 'Smolder', 'Varus', 'Xayah'] },
];

const players = SQUAD.map((d, idx) => {
  const p = { key: d.name.toLowerCase(), name: d.name, riotId: `${d.name}#DEMO`, role: d.role, profileIconId: 4000 + idx * 7, summonerLevel: 150 + idx * 41,
    modes: { solo: emptyMode(), flex: emptyMode() }, history: [], statsKey: 'sample' };
  let score = d.score ?? 1400, flex = 1500 + idx * 90, wins = 80 + idx * 13, losses = 78 + idx * 11;
  // A week before the challenge, then the challenge games.
  for (let t = WIN.startMs - 7 * 86_400_000; t < WIN.startMs; t += 86_400_000) {
    p.history.push({ t: new Date(t).toISOString(), solo: d.score == null ? null : score - Math.round(rnd() * 60), flex });
  }
  p.history.push({ t: new Date(WIN.startMs + 40 * 60_000).toISOString(), solo: d.score == null ? null : score, flex });
  const step = (NOW - WIN.startMs) / (d.games + 1);
  for (let g = 0; g < d.games; g++) {
    const t = WIN.startMs + step * (g + 1);
    const win = rnd() < d.wr;
    const champ = d.pool.length === 1 ? d.pool[0] : rnd() < 0.45 ? d.pool[0] : pick(d.pool);
    const offRole = d.offRole !== 0 && rnd() < 0.12;
    const pos = offRole ? pick(Object.values(POS).filter((x) => x !== POS[d.role])) : POS[d.role];
    const k = Math.round(rnd() * (win ? 12 : 7)), dth = Math.round(rnd() * (win ? 5 : 10)) + (d.name === 'Tiltmaster' ? 3 : 0);
    const penta = d.name === 'Climbo' && g === 20 ? 1 : 0;
    const quadra = penta || (rnd() < 0.04 ? 1 : 0);
    const me = { championName: champ, win, kills: k + penta * 5, deaths: dth, assists: Math.round(rnd() * 14), teamPosition: pos,
      visionScore: Math.round((d.role === 'Support' ? 55 : 22) + rnd() * 20), timePlayed: 1500 + Math.round(rnd() * 900),
      pentaKills: penta, quadraKills: quadra, doubleKills: Math.round(rnd() * 2) };
    const queueId = rnd() < 0.7 ? 420 : 440;
    addMatch(p.modes[queueId === 420 ? 'solo' : 'flex'], { metadata: { matchId: `DEMO_${idx}_${g}` }, info: { gameDuration: me.timePlayed, gameEndTimestamp: Math.round(t), queueId } }, me);
    if (queueId === 440) { flex += win ? 21 : -19; p.history.push({ t: new Date(t + 60_000).toISOString(), solo: p.history.at(-1).solo, flex }); continue; }
    if (d.score == null && g === 9) { score = 1480; } // finished placements on game 10
    else if (d.score != null || g > 9) score += win ? 18 + Math.round(rnd() * 8) : -(17 + Math.round(rnd() * 8));
    if (win) wins++; else losses++;
    if (d.score != null || g >= 9) p.history.push({ t: new Date(t + 60_000).toISOString(), solo: score, flex });
  }
  const tier = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
  const i = Math.floor(score / 400);
  p.ranks = {
    solo: score >= 2800 ? { tier: 'MASTER', rank: 'I', lp: score - 2800, wins, losses, score }
      : { tier: tier[i], rank: ['IV', 'III', 'II', 'I'][Math.floor((score % 400) / 100)], lp: score % 100, wins, losses, score },
    flex: { tier: ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'][Math.floor(flex / 400)], rank: ['IV', 'III', 'II', 'I'][Math.floor((flex % 400) / 100)], lp: flex % 100, wins: 30, losses: 28, score: flex },
  };
  return p;
});

const awards = scoreModes(players, CH, WIN, NOW);
const data = {
  squadName: 'Demo squad', platform: 'euw1', queues: [420, 440],
  challenge: { ...CH, startMs: WIN.startMs, endMs: WIN.endMs },
  awards, reviews: buildReviews(players, CH, WIN, NOW), updatedAt: new Date(NOW).toISOString(), players,
};
await writeFile(new URL('../docs/data.sample.json', import.meta.url), JSON.stringify(data));
for (const mode of ['solo', 'flex']) {
  console.log(mode);
  for (const p of [...players].sort((a, b) => a.points[mode].place - b.points[mode].place)) {
    const P = p.points[mode];
    console.log(`  ${P.place}. ${p.name.padEnd(13)} LP ${String(P.lp).padStart(5)}  ach ${String(P.achievementsTotal).padStart(3)}  awards(prov) ${P.awardsProvisional}  total ${P.total}  games ${p.modes[mode].stats.games}`);
  }
}
