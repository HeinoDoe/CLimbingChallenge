// Pulls ranks and match stats for every player in squad.config.json, scores the
// challenge (see scripts/challenge.mjs) and writes everything to docs/data.json.
// Runs on GitHub Actions (see .github/workflows/update.yml) or locally with
// `npm run update`. Needs Node 18+.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { STATS_VERSION, MODES, activeWindow, emptyMode, addMatch, isRemake, scoreModes, scoreBounties, trackPlaces, dayOf, zonedMidnight } from './challenge.mjs';
import { buildReviews } from './review.mjs';
import { buildNotifications, queue } from './notify.mjs';
import { matchFacts, mightHaveElder, teamKilledElder, scoreBingo } from './bingo.mjs';

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

const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
const CH = cfg.challenge;
if (!CH?.start || !CH?.end) {
  console.error('squad.config.json needs a "challenge" block with "start" and "end" dates (see README).');
  process.exit(1);
}
let WIN;
try { WIN = activeWindow(CH, Date.now()); } catch (e) { console.error(e.message); process.exit(1); }
const DATA_URL = new URL('../docs/data.json', import.meta.url);

let previous = {};
try { previous = JSON.parse(await readFile(DATA_URL, 'utf8')); } catch { /* first run */ }
const oldPlayers = new Map((previous.players || []).map((p) => [p.key, p]));

const PLATFORM = cfg.platform || 'euw1';
const REGION = cfg.region || 'europe';
// Solo/Duo (420) and Flex (440) are separate competitions; other queues are ignored.
const QUEUES = (cfg.queues || [420, 440]).filter((q) => MODES[q]);
const CAP = cfg.maxNewMatchesPerPlayerPerRun ?? 60;
// Match stats reset when the scoring code or the challenge dates/queues change.
const WINDOW_KEY = `${WIN.startMs}|${WIN.endMs}|${QUEUES.join(',')}`;
const STATS_KEY = `${STATS_VERSION}|${WINDOW_KEY}`;

// Weekly bingo window (challenge.bingo); games inside it get the extra checks below.
const BINGO = CH.bingo ? (() => {
  const tz = CH.timeZone || 'Europe/Berlin';
  const edge = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? zonedMidnight(v, tz, end ? 1 : 0) : Date.parse(v));
  return { id: CH.bingo.id, startMs: edge(CH.bingo.start, false), endMs: edge(CH.bingo.end, true) };
})() : null;
// Everyone's puuid, for "Duo-Sieg mit einem Challenge-Mitspieler".
const squadPuuids = new Set((previous.players || []).map((p) => p.puuid).filter(Boolean));
let champById = null; // Data Dragon champion ids -> names, loaded when the mastery snapshot needs it
const soloScores = new Map(); // puuid -> current Solo/Duo score, cached per run

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

const matchNum = (id) => Number(id.split('_')[1]) || 0;
const keyOf = (riotId) => riotId.toLowerCase().replace(/\s+/g, '');

// Current Solo/Duo score of any player (for "Sieg gegen höher gerankten Lane-Gegner").
async function soloScore(puuid) {
  if (!soloScores.has(puuid)) {
    const entries = (await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`)) || [];
    soloScores.set(puuid, score(entries.find((e) => e.queueType === 'RANKED_SOLO_5x5')));
  }
  return soloScores.get(puuid);
}

// Extra checks for Solo/Duo games inside the bingo window: Elder Drake (from the timeline,
// only when it could have happened) and, for wins, whether the lane opponent ranks higher.
async function bingoContext(m, me, p) {
  const ctx = { squadPuuids };
  const t = m.info.gameEndTimestamp || m.info.gameCreation;
  if (!BINGO || MODES[m.info.queueId] !== 'solo' || t < BINGO.startMs || t >= BINGO.endMs) return ctx;
  ctx.elder = mightHaveElder(m, me)
    ? teamKilledElder(await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${m.metadata.matchId}/timeline`), me.teamId)
    : false;
  const opp = me.teamPosition && m.info.participants.find((x) => x.teamId !== me.teamId && x.teamPosition === me.teamPosition);
  if (me.win && opp) {
    const theirs = await soloScore(opp.puuid), ours = p.ranks?.solo?.score ?? null;
    if (theirs != null && ours != null) ctx.higher = theirs > ours;
  }
  return ctx;
}

// Top-20 mastery at the bingo start, frozen for the whole bingo week.
async function snapshotMastery(p) {
  if (!BINGO || Date.now() < BINGO.startMs || p.bingoMastery?.id === BINGO.id) return;
  if (!champById) {
    const version = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    const data = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)).json()).data;
    champById = Object.fromEntries(Object.values(data).map((c) => [Number(c.key), c.id]));
  }
  const top = (await riot(`https://${PLATFORM}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/top?count=20`)) || [];
  p.bingoMastery = { id: BINGO.id, at: new Date().toISOString(), champs: top.map((x) => champById[x.championId]).filter(Boolean) };
}

// ---------- Per player ----------
async function updatePlayer(entry) {
  const [gameName, tagLine] = entry.riotId.split('#').map((s) => s.trim());
  const key = keyOf(entry.riotId);
  const old = oldPlayers.get(key);
  const p = old ? { ...old } : { key };
  p.name = entry.name || gameName;
  p.riotId = entry.riotId;
  p.role = entry.role || '';
  p.error = null;
  for (const k of ['startAt', 'start', 'trackSince', 'statsRole', 'stats', 'champions', 'recent']) delete p[k]; // older layouts

  // New scoring code or new dates: re-process every match (history and puuid stay).
  if (p.statsKey !== STATS_KEY) {
    Object.assign(p, { statsKey: STATS_KEY, modes: Object.fromEntries(Object.values(MODES).map((m) => [m, emptyMode()])), seen: [] });
  }
  p.history ??= [];

  try {
    // Look the PUUID up every run: Riot encrypts it per API key's app, so a
    // stored one stops working when you switch keys (e.g. dev -> personal).
    const acc = await riot(`https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    if (!acc) { p.error = 'Riot ID not found. Check the spelling and tag in squad.config.json.'; return p; }
    p.puuid = acc.puuid;
    squadPuuids.add(p.puuid);

    const sum = await riot(`https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${p.puuid}`);
    if (sum) { p.profileIconId = sum.profileIconId; p.summonerLevel = sum.summonerLevel; }

    const entries = (await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${p.puuid}`)) || [];
    p.ranks = {
      solo: rankOf(entries.find((e) => e.queueType === 'RANKED_SOLO_5x5')),
      flex: rankOf(entries.find((e) => e.queueType === 'RANKED_FLEX_SR')),
    };
    await snapshotMastery(p);

    // Rank history: a point whenever rank changes, once a day, and on the first run
    // after the challenge starts or ends (the LP baseline and the frozen final LP).
    const now = Date.now();
    const snap = { t: new Date(now).toISOString(), solo: p.ranks.solo?.score ?? null, flex: p.ranks.flex?.score ?? null };
    const last = p.history.at(-1);
    const lastT = last ? Date.parse(last.t) : 0;
    const crossed = (edge) => lastT < edge && now >= edge;
    if (!last || last.solo !== snap.solo || last.flex !== snap.flex || now - lastT > 86_400_000 || crossed(WIN.startMs) || crossed(WIN.endMs)) {
      p.history.push(snap);
    }
    if (p.history.length > 3000) p.history = p.history.slice(-3000);

    // Challenge matches, processed oldest first so streaks stay in order.
    if (now >= WIN.startMs) {
      const from = Math.floor(WIN.startMs / 1000), to = Math.floor(WIN.endMs / 1000);
      const seen = new Set(p.seen);
      const ids = new Set();
      for (const q of QUEUES) {
        for (let start = 0; ; start += 100) {
          const page = (await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${p.puuid}/ids?queue=${q}&startTime=${from}&endTime=${to}&start=${start}&count=100`)) || [];
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
        if (!me || isRemake(me)) continue;
        const mode = p.modes[MODES[m.info.queueId]];
        if (mode) addMatch(mode, m, me, matchFacts(m, me, await bingoContext(m, me, p)));
      }
      p.seen = [...seen];
      p.pendingMatches = unseen.length - todo.length;
      console.log(`  ${todo.length} new matches, ${p.pendingMatches} still queued`);
    } else {
      p.pendingMatches = 0;
      console.log('  challenge has not started yet, ranks only');
    }
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
  const awards = scoreModes(players, CH, WIN, Date.now());
  const bounties = scoreBounties(players, CH, Date.now()); // adds bounty points and re-ranks
  const bingo = scoreBingo(players, CH, Date.now());        // adds bingo points and re-ranks
  // Daily reviews: kept between runs; a new day is only written once every game is in.
  const kept = previous.reviewsKey === STATS_KEY ? previous.reviews || [] : [];
  const complete = players.every((p) => !p.error && !p.pendingMatches);
  const reviews = complete ? buildReviews(players, CH, WIN, Date.now(), kept) : kept;
  // Places at the end of each day, for the ▲/▼ since yesterday in the leaderboard.
  const tz = CH.timeZone || 'Europe/Berlin';
  // Kept across a STATS_VERSION re-count (same challenge window), so ▲/▼ survive it.
  const samePlaces = previous.placesKey === WINDOW_KEY || previous.placesKey?.endsWith(`|${WINDOW_KEY}`); // older data keyed by STATS_KEY
  const places = trackPlaces(players, samePlaces ? previous.places || {} : {}, dayOf(Date.now(), tz));
  const data = {
    squadName: cfg.squadName,
    platform: PLATFORM,
    queues: QUEUES,
    challenge: { ...CH, ...WIN },
    awards,
    bounties,
    bingo,
    reviews,
    reviewsKey: STATS_KEY,
    places,
    placesKey: WINDOW_KEY,
    updatedAt: new Date().toISOString(),
    players,
  };
  await mkdir(new URL('.', DATA_URL), { recursive: true });
  await writeFile(DATA_URL, JSON.stringify(data));
  // Discord: the daily post once a day is finished (sent by the workflow's last step).
  try {
    const results = await readFile(new URL('../docs/prime/results.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
    const gamedays = await readFile(new URL('../docs/prime/gamedays.json', import.meta.url), 'utf8').then((t) => JSON.parse(t).gamedays).catch(() => []);
    await queue(buildNotifications(previous, data, { siteUrl: cfg.siteUrl, timeZone: tz, results, gamedays }));
  } catch (e) { console.log(`Discord queue: ${e.message}`); }
  console.log(`Done: ${calls} API calls.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
