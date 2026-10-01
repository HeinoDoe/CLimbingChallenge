// Challenge rules: dates, per-match stats, LP earned, achievements and end awards.
// Pure functions only (no network, no files), so scripts/update.mjs and the tests
// in scripts/challenge.test.mjs use exactly the same scoring.

// Bump this whenever addMatch() starts tracking something new. update.mjs then
// resets every player's match stats and re-processes all challenge matches
// (puuid and rank history are kept).
export const STATS_VERSION = 4;

// Each ranked queue is its own competition with its own LP, achievements and awards.
export const MODES = { 420: 'solo', 440: 'flex' };
// recent = last 20 games for the feed; log = every challenge game, compact, for the daily review.
export const emptyMode = () => ({ stats: emptyStats(), champions: {}, recent: [], log: [] });

// ---------- Dates ----------
// "start" and "end" are calendar days in the challenge time zone. The end day is
// included, so 2026-10-01 .. 2026-10-14 runs from 1 Oct 00:00 to 15 Oct 00:00.
// Full ISO timestamps are accepted too and used as they are.
function tzOffsetMs(t, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}
export function zonedMidnight(date, timeZone, addDays = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + addDays);
  let t = guess - tzOffsetMs(guess, timeZone);
  t = guess - tzOffsetMs(t, timeZone); // second pass settles DST edges
  return t;
}
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Calendar day ("YYYY-MM-DD") of a timestamp in the challenge time zone.
export const dayOf = (t, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

export function challengeWindow(ch) {
  const tz = ch.timeZone || 'Europe/Berlin';
  const startMs = DATE_ONLY.test(ch.start) ? zonedMidnight(ch.start, tz) : Date.parse(ch.start);
  const endMs = DATE_ONLY.test(ch.end) ? zonedMidnight(ch.end, tz, 1) : Date.parse(ch.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error(`challenge.start / challenge.end must be dates like "2026-10-01" (got "${ch.start}" / "${ch.end}").`);
  if (endMs <= startMs) throw new Error('challenge.end must be after challenge.start.');
  return { startMs, endMs };
}

// The window the script scores right now. Before the real start, an optional trial
// run (challenge.preview.start) counts from its own start until the real start. When
// the real challenge begins the window changes, which resets every stat and the LP
// baseline automatically.
export function activeWindow(ch, now) {
  const real = challengeWindow(ch);
  if (!ch.preview?.start || now >= real.startMs) return real;
  const trial = challengeWindow({ ...ch, start: ch.preview.start, end: new Date(real.startMs).toISOString() });
  return { ...trial, preview: true, realStartMs: real.startMs, realEndMs: real.endMs };
}

// ---------- Match stats ----------
export const emptyStats = () => ({
  games: 0, wins: 0, kills: 0, deaths: 0, assists: 0,
  doubleKills: 0, tripleKills: 0, quadraKills: 0, pentaKills: 0,
  firstBloods: 0, soloKills: 0, visionScore: 0, timePlayed: 0, damage: 0,
  curStreak: 0, bestWinStreak: 0, worstLoseStreak: 0,
  maxKills: 0, maxKillsChamp: null,
});

// Riot's multikill counters are cumulative: a pentakill also adds 1 to quadraKills
// (and to tripleKills/doubleKills). Checked on real matches EUW1_7991476648 and
// EUW1_7941807484 (quadraKills=1, pentaKills=1, and the timeline shows the only
// quadra became the penta). So the quadras that stayed quadras are the difference.
export const pureQuadras = (me) => Math.max(0, (me.quadraKills || 0) - (me.pentaKills || 0));

// Adds one finished match to a mode's stats / champions / recent / log (p = emptyMode()).
export function addMatch(p, m, me) {
  const s = p.stats;
  const quadras = pureQuadras(me);
  const win = Boolean(me.win);
  s.games++; if (win) s.wins++;
  s.kills += me.kills; s.deaths += me.deaths; s.assists += me.assists;
  s.doubleKills += me.doubleKills || 0;
  s.tripleKills += me.tripleKills || 0;
  s.quadraKills += quadras;
  s.pentaKills += me.pentaKills || 0;
  if (me.firstBloodKill) s.firstBloods++;
  s.soloKills += me.challenges?.soloKills || 0;
  s.visionScore += me.visionScore || 0;
  s.timePlayed += me.timePlayed || m.info.gameDuration || 0;
  s.damage += me.totalDamageDealtToChampions || 0;
  s.curStreak = win ? Math.max(s.curStreak, 0) + 1 : Math.min(s.curStreak, 0) - 1;
  s.bestWinStreak = Math.max(s.bestWinStreak, s.curStreak);
  s.worstLoseStreak = Math.max(s.worstLoseStreak, -s.curStreak);
  if (me.kills > s.maxKills) { s.maxKills = me.kills; s.maxKillsChamp = me.championName; }

  const c = (p.champions[me.championName] ??= { games: 0, wins: 0 });
  c.games++; if (win) c.wins++;

  p.recent.push({
    id: m.metadata.matchId,
    t: m.info.gameEndTimestamp || m.info.gameCreation,
    win, champ: me.championName,
    k: me.kills, d: me.deaths, a: me.assists,
    queue: m.info.queueId, duration: m.info.gameDuration,
    multi: me.pentaKills ? 'Pentakill' : quadras ? 'Quadrakill' : null,
  });
  if (p.recent.length > 20) p.recent = p.recent.slice(-20);
  (p.log ??= []).push({
    t: m.info.gameEndTimestamp || m.info.gameCreation, win, champ: me.championName,
    k: me.kills, d: me.deaths, a: me.assists, penta: me.pentaKills || 0, quadra: quadras,
  });
}

// ---------- LP earned ----------
// Net LP in one queue from the first ranked snapshot at/after the start to the
// latest snapshot (or, once the challenge is over, the last one before the end).
export function lpEarned(history, queue, { startMs, endMs }, now) {
  const ranked = (history || []).filter((h) => h[queue] != null).map((h) => ({ t: Date.parse(h.t), v: h[queue] }));
  const base = ranked.find((h) => h.t >= startMs && h.t < endMs && h.t <= now);
  if (!base) return null;
  const pool = ranked.filter((h) => h.t >= base.t && h.t <= now && (now < endMs || h.t < endMs));
  const last = pool.at(-1);
  return {
    lp: last.v - base.v,
    baseScore: base.v, baseT: new Date(base.t).toISOString(),
    endScore: last.v, endT: new Date(last.t).toISOString(),
    frozen: now >= endMs,
  };
}

// ---------- Awards ----------
const EPS = 1e-9;
const kda = (s) => (s.kills + s.assists) / Math.max(1, s.deaths);
function bestOneTrick(p, minGames) {
  let best = null;
  for (const [champ, c] of Object.entries(p.champions || {})) {
    if (c.games < minGames) continue;
    const wr = c.wins / c.games;
    if (!best || wr > best.value + EPS || (Math.abs(wr - best.value) < EPS && c.games > best.games)) best = { value: wr, champ, games: c.games };
  }
  return best;
}

// value(p, ch) returns { value, detail? } or null when the player doesn't qualify.
export const AWARDS = [
  { key: 'mostGames', title: 'Most games', desc: 'Most ranked games played', dir: 1,
    value: (p) => p.stats.games > 0 ? { value: p.stats.games } : null },
  { key: 'highestWinRate', title: 'Highest win rate', desc: 'min. {min} games', dir: 1, needsMin: true,
    value: (p) => ({ value: p.stats.wins / p.stats.games }) },
  { key: 'highestKda', title: 'Highest KDA', desc: '(Kills + assists) / deaths, min. {min} games', dir: 1, needsMin: true,
    value: (p) => ({ value: kda(p.stats) }) },
  { key: 'lowestKda', title: 'Lowest KDA', desc: 'min. {min} games', dir: -1, needsMin: true,
    value: (p) => ({ value: kda(p.stats) }) },
  { key: 'bestVision', title: 'Best vision', desc: 'Vision score per minute, min. {min} games', dir: 1, needsMin: true,
    value: (p) => p.stats.timePlayed ? { value: p.stats.visionScore / (p.stats.timePlayed / 60) } : null },
  { key: 'longestWinStreak', title: 'Longest win streak', desc: 'Most wins in a row', dir: 1,
    value: (p) => p.stats.bestWinStreak > 0 ? { value: p.stats.bestWinStreak } : null },
  { key: 'longestLoseStreak', title: 'Longest losing streak', desc: 'Most losses in a row', dir: 1,
    value: (p) => p.stats.worstLoseStreak > 0 ? { value: p.stats.worstLoseStreak } : null },
  { key: 'mostDeathsPerGame', title: 'Most deaths per game', desc: 'min. {min} games', dir: 1, needsMin: true,
    value: (p) => ({ value: p.stats.deaths / p.stats.games }) },
  { key: 'oneTrick', title: 'One-trick', desc: 'Best win rate on one champion ({oneTrickMin}+ games). Top 2 get the points.', dir: 1, winners: 2,
    value: (p, ch) => { const b = bestOneTrick(p, ch.oneTrickMinGames ?? 10); return b && { value: b.value, detail: { champ: b.champ, games: b.games } }; } },
];

// ---------- Points ----------
// Writes p.points on every entry ({ key, stats, champions, history }) and returns the
// award summary for data.json. ch.lpQueue picks which queue's LP counts.
export function computePoints(players, ch, win, now) {
  const pts = ch.points || {};
  const minGames = ch.minGames ?? 20;
  const final = now >= win.endMs;

  for (const p of players) {
    p.stats ??= emptyStats();
    const s = p.stats;
    const lpInfo = lpEarned(p.history, ch.lpQueue || 'solo', win, now);
    const item = (count, key) => ({ count, per: pts[key] ?? 0, points: count * (pts[key] ?? 0) });
    const achievements = {
      uniqueChampions: item(Object.keys(p.champions || {}).length, 'uniqueChampion'),
      pentakills: item(s.pentaKills, 'pentakill'),
      quadrakills: item(s.quadraKills, 'quadrakill'),
    };
    p.points = {
      lp: lpInfo ? lpInfo.lp : null,
      lpInfo,
      achievements,
      achievementsTotal: Object.values(achievements).reduce((n, a) => n + a.points, 0),
      awards: {},
      awardsProvisional: 0,
      awardsTotal: 0,
      awardsFinal: final,
      total: 0,
    };
  }

  const awards = AWARDS.map((a) => {
    const points = pts[a.key] ?? 0;
    const rows = players.map((p) => {
      if (a.needsMin && p.stats.games < minGames) return { p, v: null, why: `${p.stats.games}/${minGames} games` };
      const r = a.value(p, ch);
      return r && Number.isFinite(r.value) ? { p, v: r.value, detail: r.detail } : { p, v: null };
    });
    const ranked = rows.filter((r) => r.v != null).sort((x, y) => a.dir * (y.v - x.v));
    let winners = [];
    if (ranked.length) {
      const cut = ranked[Math.min((a.winners || 1) - 1, ranked.length - 1)].v;
      winners = ranked.filter((r) => a.dir * (r.v - cut) >= -EPS);
    }
    const winnerKeys = new Set(winners.map((r) => r.p.key));
    for (const r of rows) {
      const lead = winnerKeys.has(r.p.key);
      r.p.points.awards[a.key] = { value: r.v, detail: r.detail ?? null, qualifies: r.v != null, note: r.why ?? null, leader: lead, points: final && lead ? points : 0 };
      if (lead) r.p.points.awardsProvisional += points;
    }
    return {
      key: a.key, title: a.title,
      desc: a.desc.replace('{min}', minGames).replace('{oneTrickMin}', ch.oneTrickMinGames ?? 10),
      points, final, lowerIsBetter: a.dir < 0,
      leaders: winners.map((r) => ({ key: r.p.key, value: r.v, detail: r.detail ?? null })),
      ranking: ranked.slice(0, 5).map((r) => ({ key: r.p.key, value: r.v, detail: r.detail ?? null })),
    };
  });

  for (const p of players) {
    const P = p.points;
    P.awardsTotal = final ? P.awardsProvisional : 0;
    P.total = (P.lp ?? 0) + P.achievementsTotal + P.awardsTotal;
  }
  // Place = 1 + number of players with a strictly higher total (ties share a place).
  for (const p of players) p.points.place = 1 + players.filter((o) => o.points.total > p.points.total).length;
  return awards;
}

// Scores every mode (solo, flex) separately. Players carry p.modes[mode] =
// { stats, champions, recent }; the result lands in p.points[mode] and the
// returned object is { solo: awards, flex: awards }.
export function scoreModes(players, ch, win, now) {
  const awards = {};
  for (const mode of Object.values(MODES)) {
    const views = players.map((p) => ({ key: p.key, history: p.history, ...(p.modes?.[mode] ?? emptyMode()) }));
    awards[mode] = computePoints(views, { ...ch, lpQueue: mode }, win, now);
    players.forEach((p, i) => { (p.points ??= {})[mode] = views[i].points; });
  }
  return awards;
}
