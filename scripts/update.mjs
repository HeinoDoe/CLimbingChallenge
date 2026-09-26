// Pulls ranks, match stats and Riot challenge points for every player in
// squad.config.json and writes them to docs/data.json for the website.
// Runs on GitHub Actions (see .github/workflows/update.yml) or locally with
// `npm run update`. Needs Node 18+.
//
//   node scripts/update.mjs              normal update
//   node scripts/update.mjs --start-now  set startAt in squad.config.json to now, then update
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Locally the key comes from a .env file next to package.json (never committed).
try {
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env, e.g. on GitHub Actions */ }

const KEY = process.env.RIOT_API_KEY;
if (!KEY) {
  console.error('Missing RIOT_API_KEY. Locally, put it in a .env file (see .env.example). On GitHub, add it as a repository secret (see README).');
  process.exit(1);
}

const CONFIG_URL = new URL('../squad.config.json', import.meta.url);
const cfg = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
if (process.argv.includes('--start-now')) {
  cfg.startAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await writeFile(CONFIG_URL, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Start point set to ${cfg.startAt}`);
}
// startAt is the challenge start: LP gains and match stats count from here.
// (trackSince is the older name for the same setting.)
const START = cfg.startAt || cfg.trackSince;
const START_MS = Date.parse(START);
if (Number.isNaN(START_MS)) {
  console.error(`startAt "${START}" in squad.config.json is not a valid date, e.g. "2026-10-01T18:00:00+02:00".`);
  process.exit(1);
}
const DATA_URL = new URL('../docs/data.json', import.meta.url);

let previous = {};
try { previous = JSON.parse(await readFile(DATA_URL, 'utf8')); } catch { /* first run */ }
const oldPlayers = new Map((previous.players || []).map((p) => [p.key, p]));

const PLATFORM = cfg.platform || 'euw1';
const REGION = cfg.region || 'europe';
const SINCE = Math.floor(START_MS / 1000);
const QUEUES = cfg.queues || [420, 440];
const CAP = cfg.maxNewMatchesPerPlayerPerRun ?? 60;

// ---------- Rate limiting (personal/dev keys: 20 req/s, 100 req/2 min) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamps = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 121_000) stamps.shift();
    const lastSecond = stamps.filter((s) => now - s < 1_050).length;
    if (stamps.length < 95 && lastSecond < 18) { stamps.push(now); return; }
    const wait = stamps.length >= 95 ? 121_000 - (now - stamps[0]) + 50 : 1_100;
    await sleep(Math.max(wait, 50));
  }
}

let calls = 0;
class FatalError extends Error {}

async function riot(url, attempt = 0) {
  await throttle();
  calls++;
  const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
  if (res.status === 429 && attempt < 6) {
    const s = Number(res.headers.get('retry-after')) || 10;
    console.log(`  rate limited, waiting ${s}s`);
    await sleep(s * 1000 + 250);
    return riot(url, attempt + 1);
  }
  if (res.status >= 500 && attempt < 3) {
    await sleep(2000 * (attempt + 1));
    return riot(url, attempt + 1);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new FatalError(`Riot refused the API key (HTTP ${res.status}). Development keys expire after 24 hours; update the RIOT_API_KEY secret or use a Personal API Key.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

// ---------- Helpers ----------
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const DIVS = { IV: 0, III: 100, II: 200, I: 300 };

// One number per rank so climbs can be graphed: 400 per tier, 100 per division.
// Master and above sit on a single open-ended scale starting at 2800.
function score(e) {
  if (!e) return null;
  const i = TIERS.indexOf(e.tier);
  return i >= 0 ? i * 400 + (DIVS[e.rank] ?? 0) + e.leaguePoints : 2800 + e.leaguePoints;
}
const rankOf = (e) => (e ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, score: score(e) } : null);

const emptyStats = () => ({
  games: 0, wins: 0, kills: 0, deaths: 0, assists: 0,
  doubleKills: 0, tripleKills: 0, quadraKills: 0, pentaKills: 0,
  firstBloods: 0, soloKills: 0, visionScore: 0, timePlayed: 0, damage: 0,
  curStreak: 0, bestWinStreak: 0, maxKills: 0, maxKillsChamp: null,
});

const matchNum = (id) => Number(id.split('_')[1]) || 0;
const keyOf = (riotId) => riotId.toLowerCase().replace(/\s+/g, '');

function addMatch(p, m, me) {
  const s = p.stats;
  const win = Boolean(me.win);
  s.games++; if (win) s.wins++;
  s.kills += me.kills; s.deaths += me.deaths; s.assists += me.assists;
  s.doubleKills += me.doubleKills || 0;
  s.tripleKills += me.tripleKills || 0;
  s.quadraKills += me.quadraKills || 0;
  s.pentaKills += me.pentaKills || 0;
  if (me.firstBloodKill) s.firstBloods++;
  s.soloKills += me.challenges?.soloKills || 0;
  s.visionScore += me.visionScore || 0;
  s.timePlayed += me.timePlayed || m.info.gameDuration || 0;
  s.damage += me.totalDamageDealtToChampions || 0;
  s.curStreak = win ? Math.max(s.curStreak, 0) + 1 : Math.min(s.curStreak, 0) - 1;
  s.bestWinStreak = Math.max(s.bestWinStreak, s.curStreak);
  if (me.kills > s.maxKills) { s.maxKills = me.kills; s.maxKillsChamp = me.championName; }

  const c = (p.champions[me.championName] ??= { games: 0, wins: 0 });
  c.games++; if (win) c.wins++;

  p.recent.push({
    id: m.metadata.matchId,
    t: m.info.gameEndTimestamp || m.info.gameCreation,
    win, champ: me.championName,
    k: me.kills, d: me.deaths, a: me.assists,
    queue: m.info.queueId, duration: m.info.gameDuration,
    multi: me.pentaKills ? 'Pentakill' : me.quadraKills ? 'Quadrakill' : null,
  });
  if (p.recent.length > 20) p.recent = p.recent.slice(-20);
}

// ---------- Per player ----------
async function updatePlayer(entry) {
  const [gameName, tagLine] = entry.riotId.split('#').map((s) => s.trim());
  const key = keyOf(entry.riotId);
  const old = oldPlayers.get(key);
  let p = old ? { ...old } : { key };

  // Changing startAt in the config restarts the counters and the LP baseline.
  if (p.startAt !== START) {
    Object.assign(p, { startAt: START, start: {}, stats: emptyStats(), champions: {}, recent: [], seen: [] });
    delete p.trackSince;
  }
  p.history ??= [];
  p.start ??= {};
  p.name = entry.name || gameName;
  p.riotId = entry.riotId;
  p.role = entry.role || '';
  p.error = null;

  try {
    if (!p.puuid) {
      const acc = await riot(`https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
      if (!acc) { p.error = `Riot ID not found. Check the spelling and tag in squad.config.json.`; return p; }
      p.puuid = acc.puuid;
    }

    const sum = await riot(`https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${p.puuid}`);
    if (sum) { p.profileIconId = sum.profileIconId; p.summonerLevel = sum.summonerLevel; }

    const entries = (await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${p.puuid}`)) || [];
    p.ranks = {
      solo: rankOf(entries.find((e) => e.queueType === 'RANKED_SOLO_5x5')),
      flex: rankOf(entries.find((e) => e.queueType === 'RANKED_FLEX_SR')),
    };

    try {
      const ch = await riot(`https://${PLATFORM}.api.riotgames.com/lol/challenges/v1/player-data/${p.puuid}`);
      p.challengePoints = ch?.totalPoints
        ? { level: ch.totalPoints.level, current: ch.totalPoints.current, percentile: ch.totalPoints.percentile ?? null }
        : null;
    } catch (e) {
      if (e instanceof FatalError) throw e;
    }

    // Starting point: the first rank seen at or after startAt. Riot has no LP
    // history, so this is recorded on the first update after the start. A queue
    // the player was unranked in gets its baseline once they finish placements.
    if (Date.now() >= START_MS) {
      for (const q of ['solo', 'flex']) {
        const r = p.ranks[q];
        if (!p.start[q] && r) p.start[q] = { ...r, t: new Date().toISOString() };
      }
    }

    // Rank history: a point whenever rank changes, plus one per day for the weekly comparison.
    const snap = { t: new Date().toISOString(), solo: p.ranks.solo?.score ?? null, flex: p.ranks.flex?.score ?? null };
    const last = p.history.at(-1);
    if (!last || last.solo !== snap.solo || last.flex !== snap.flex || Date.now() - Date.parse(last.t) > 86_400_000) {
      p.history.push(snap);
    }
    if (p.history.length > 3000) p.history = p.history.slice(-3000);

    // Matches since trackSince, processed oldest first so streaks stay in order.
    const seen = new Set(p.seen);
    const ids = new Set();
    for (const q of QUEUES) {
      for (let start = 0; ; start += 100) {
        const page = (await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${p.puuid}/ids?queue=${q}&startTime=${SINCE}&start=${start}&count=100`)) || [];
        page.forEach((id) => ids.add(id));
        if (page.length < 100 || page.every((id) => seen.has(id))) break;
      }
    }
    const unseen = [...ids].filter((id) => !seen.has(id)).sort((a, b) => matchNum(a) - matchNum(b));
    const todo = unseen.slice(0, CAP);

    for (const id of todo) {
      const m = await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}`);
      seen.add(id);
      if (!m) continue;
      const me = m.info.participants.find((x) => x.puuid === p.puuid);
      if (!me || me.gameEndedInEarlySurrender || m.info.gameDuration < 300) continue; // skip remakes
      addMatch(p, m, me);
    }
    p.seen = [...seen];
    p.pendingMatches = unseen.length - todo.length;
    console.log(`  ${todo.length} new matches, ${p.pendingMatches} still queued`);
  } catch (e) {
    if (e instanceof FatalError) throw e;
    p.error = e.message;
    console.log(`  error: ${e.message}`);
  }
  return p;
}

// ---------- Main ----------
try {
  const players = [];
  for (const entry of cfg.players) {
    console.log(`Updating ${entry.riotId}`);
    players.push(await updatePlayer(entry));
  }
  const data = {
    squadName: cfg.squadName,
    platform: PLATFORM,
    startAt: START,
    queues: QUEUES,
    updatedAt: new Date().toISOString(),
    players,
  };
  await mkdir(new URL('.', DATA_URL), { recursive: true });
  await writeFile(DATA_URL, JSON.stringify(data));
  console.log(`Done: ${calls} API calls.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
