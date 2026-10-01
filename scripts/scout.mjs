// Scouts both rosters of a Prime League game day for the draft plan: rank, recent
// ranked games (champions, roles, KDA), top champion mastery and earlier tournament
// games (Prime League games are tournament-code games, so their team drafts show up).
// Reads docs/prime/gamedays.json, writes docs/prime/scout-day<N>.json.
//
//   node scripts/scout.mjs 1        scout game day 1
// Runs on GitHub Actions (.github/workflows/scout.yml) with the RIOT_API_KEY secret.
import { readFile, writeFile } from 'node:fs/promises';

try {
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env, e.g. on GitHub Actions */ }

const KEY = process.env.RIOT_API_KEY;
const DAY = Number(process.argv[2]);
if (!KEY) { console.error('Missing RIOT_API_KEY.'); process.exit(1); }
if (!DAY) { console.error('Usage: node scripts/scout.mjs <game day number>'); process.exit(1); }

const FILE = new URL('../docs/prime/gamedays.json', import.meta.url);
const cfg = JSON.parse(await readFile(FILE, 'utf8'));
const gameday = cfg.gamedays.find((g) => g.day === DAY);
if (!gameday?.opponent?.players?.length) { console.error(`Game day ${DAY} has no opponent players in docs/prime/gamedays.json.`); process.exit(1); }

const RANKED = 30;   // recent ranked games per player
const TOURNEY = 15;  // recent tournament games per player

// ---------- Riot API with the same limits as update.mjs (100 requests / 2 min) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamps = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 121_000) stamps.shift();
    if (stamps.length < 95 && stamps.filter((s) => now - s < 1_050).length < 18) { stamps.push(now); return; }
    await sleep(stamps.length >= 95 ? 121_000 - (now - stamps[0]) + 50 : 1_100);
  }
}
let calls = 0;
async function riot(url, attempt = 0) {
  await throttle();
  calls++;
  const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
  if (res.status === 429 && attempt < 6) { await sleep((Number(res.headers.get('retry-after')) || 10) * 1000 + 250); return riot(url, attempt + 1); }
  if (res.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); return riot(url, attempt + 1); }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`Riot refused the API key (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

// Champion ids -> names for mastery (Data Dragon).
const version = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
const champs = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)).json()).data;
const champById = Object.fromEntries(Object.values(champs).map((c) => [Number(c.key), c.id]));

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const rankText = (e) => (e ? (TIERS.includes(e.tier) ? `${e.tier[0]}${e.tier.slice(1).toLowerCase()} ${e.rank} ${e.leaguePoints} LP` : `${e.tier[0]}${e.tier.slice(1).toLowerCase()} ${e.leaguePoints} LP`) : 'Unranked');

const matchCache = new Map();
const getMatch = async (id) => {
  if (!matchCache.has(id)) matchCache.set(id, await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/${id}`));
  return matchCache.get(id);
};

function summarize(games) {
  const byChamp = {}, roles = {};
  for (const g of games) {
    const c = (byChamp[g.champ] ??= { champ: g.champ, games: 0, wins: 0, k: 0, d: 0, a: 0, roles: {} });
    c.games++; if (g.win) c.wins++; c.k += g.k; c.d += g.d; c.a += g.a;
    if (g.pos) { c.roles[g.pos] = (c.roles[g.pos] || 0) + 1; roles[g.pos] = (roles[g.pos] || 0) + 1; }
  }
  const champions = Object.values(byChamp)
    .map((c) => ({ ...c, kda: +((c.k + c.a) / Math.max(1, c.d)).toFixed(2), winRate: +(c.wins / c.games).toFixed(2) }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins);
  return { games: games.length, wins: games.filter((g) => g.win).length, roles, champions };
}

const tourneyGames = new Map(); // match id -> team drafts, collected across all players

async function scoutPlayer(pl, side) {
  const [name, tag] = pl.riotId.split('#').map((s) => s.trim());
  console.log(`Scouting ${pl.riotId} (${side} ${pl.role})`);
  const acc = await riot(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!acc) return { ...pl, error: 'Riot ID not found' };
  const puuid = acc.puuid;
  const entries = (await riot(`https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`)) || [];
  const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5'), flex = entries.find((e) => e.queueType === 'RANKED_FLEX_SR');
  const mastery = ((await riot(`https://euw1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=12`)) || [])
    .map((m) => ({ champ: champById[m.championId] || String(m.championId), level: m.championLevel, points: m.championPoints, lastPlayed: new Date(m.lastPlayTime).toISOString().slice(0, 10) }));

  const games = [];
  const ids = (await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?type=ranked&start=0&count=${RANKED}`)) || [];
  for (const id of ids) {
    const m = await getMatch(id);
    const me = m?.info.participants.find((x) => x.puuid === puuid);
    if (!me || me.gameEndedInEarlySurrender || m.info.gameDuration < 300) continue;
    games.push({ t: m.info.gameEndTimestamp, queue: m.info.queueId, champ: me.championName, pos: me.teamPosition || null, win: me.win, k: me.kills, d: me.deaths, a: me.assists });
  }

  const tIds = (await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?type=tourney&start=0&count=${TOURNEY}`)) || [];
  const tourney = [];
  for (const id of tIds) {
    const m = await getMatch(id);
    const me = m?.info.participants.find((x) => x.puuid === puuid);
    if (!me) continue;
    tourney.push({ id, t: m.info.gameEndTimestamp, champ: me.championName, pos: me.teamPosition || null, win: me.win, k: me.kills, d: me.deaths, a: me.assists });
    if (!tourneyGames.has(id)) {
      const team = m.info.participants.filter((x) => x.teamId === me.teamId);
      const enemy = m.info.participants.filter((x) => x.teamId !== me.teamId);
      const bans = (tid) => (m.info.teams.find((t) => t.teamId === tid)?.bans || []).map((b) => champById[b.championId]).filter(Boolean);
      const lineup = (ps) => ps.map((x) => ({ riotId: `${x.riotIdGameName}#${x.riotIdTagline}`, champ: x.championName, pos: x.teamPosition || null, k: x.kills, d: x.deaths, a: x.assists }));
      tourneyGames.set(id, {
        id, t: m.info.gameEndTimestamp, duration: m.info.gameDuration, side, win: me.win,
        team: lineup(team), teamBans: bans(me.teamId), enemy: lineup(enemy), enemyBans: bans(enemy[0]?.teamId),
      });
    }
  }

  return {
    ...pl,
    solo: rankText(solo), flex: rankText(flex),
    soloWinRate: solo ? +(solo.wins / Math.max(1, solo.wins + solo.losses)).toFixed(2) : null,
    mastery, ranked: summarize(games), recent: games.slice(0, 10).map((g) => `${g.champ}${g.win ? ' W' : ' L'}`),
    tourney: summarize(tourney),
  };
}

const us = [], them = [];
for (const pl of cfg.ourTeam) us.push(await scoutPlayer(pl, 'us'));
for (const pl of gameday.opponent.players) them.push(await scoutPlayer(pl, 'them'));

const out = {
  day: DAY, generatedAt: new Date().toISOString(), patch: version,
  us, them,
  tourneyGames: [...tourneyGames.values()].sort((a, b) => b.t - a.t),
};
await writeFile(new URL(`../docs/prime/scout-day${DAY}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(`Done: ${calls} API calls, ${matchCache.size} matches.`);
