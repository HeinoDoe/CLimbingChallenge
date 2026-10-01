// Prime League results: once a game day has started, looks for our tournament games in
// a window around its start time and saves both lineups (with KDA), bans and the result
// to docs/prime/results.json. A day is checked every run until 12 hours after its start.
// Runs in the hourly update workflow after update.mjs; the day's games go into the daily Discord post.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { KEY, riot, puuidOf, idKey, stats } from './riot.mjs';

const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const BEFORE = 2 * 3600_000;   // games can start a bit early
const AFTER = 10 * 3600_000;   // ...and a series can run late
const FINAL_AFTER = 12 * 3600_000;

// One tournament match -> our game, or null if 3+ of our players aren't on one team.
export function extractGame(m, ourTeam, theirTeam, champById = {}) {
  const ours = new Map(ourTeam.map((p) => [idKey(p.riotId), p.name]));
  const theirs = new Map((theirTeam || []).map((p) => [idKey(p.riotId), p.name]));
  const rid = (x) => idKey(`${x.riotIdGameName}#${x.riotIdTagline}`);
  const team = (id) => m.info.participants.filter((x) => x.teamId === id);
  const ids = [...new Set(m.info.participants.map((x) => x.teamId))];
  const usId = ids.find((id) => team(id).filter((x) => ours.has(rid(x))).length >= 3);
  if (usId == null) return null;
  const themId = ids.find((id) => id !== usId);
  const lineup = (id, names) => team(id)
    .sort((a, b) => POS.indexOf(a.teamPosition) - POS.indexOf(b.teamPosition))
    .map((x) => ({ name: names.get(rid(x)) || x.riotIdGameName, champ: x.championName, pos: x.teamPosition || null, k: x.kills, d: x.deaths, a: x.assists }));
  const bans = (id) => (m.info.teams.find((t) => t.teamId === id)?.bans || []).map((b) => champById[b.championId]).filter(Boolean);
  const me = team(usId)[0];
  return {
    id: m.metadata.matchId, t: m.info.gameEndTimestamp || m.info.gameCreation, duration: m.info.gameDuration,
    win: Boolean(me.win), side: usId === 100 ? 'blue' : 'red',
    us: lineup(usId, ours), them: lineup(themId, theirs),
    ourBans: bans(usId), theirBans: bans(themId),
    vsOpponent: team(themId).filter((x) => theirs.has(rid(x))).length >= 2,
  };
}

async function main() {
  if (!KEY) { console.log('No RIOT_API_KEY, skipping Prime League results.'); return; }
  const cfg = JSON.parse(await readFile(new URL('../docs/prime/gamedays.json', import.meta.url), 'utf8'));
  const FILE = new URL('../docs/prime/results.json', import.meta.url);
  let results = { days: {} };
  try { results = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* first result */ }

  const now = Date.now();
  const due = cfg.gamedays.filter((g) => g.date && g.opponent?.players?.length && now >= Date.parse(g.date) && !results.days[g.day]?.final);
  if (!due.length) { console.log('No game day to check.'); return; }

  const version = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
  const champs = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)).json()).data;
  const champById = Object.fromEntries(Object.values(champs).map((c) => [Number(c.key), c.id]));

  for (const g of due) {
    const start = Date.parse(g.date);
    const day = (results.days[g.day] ??= { final: false, games: [] });
    const ids = new Set();
    for (const pl of cfg.ourTeam) {
      const puuid = await puuidOf(pl.riotId);
      if (!puuid) continue;
      const from = Math.floor((start - BEFORE) / 1000), to = Math.floor(Math.min(start + AFTER, now) / 1000);
      ((await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?type=tourney&startTime=${from}&endTime=${to}&count=10`)) || []).forEach((id) => ids.add(id));
    }
    for (const id of ids) {
      if (day.games.some((x) => x.id === id)) continue;
      const m = await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/${id}`);
      const game = m && extractGame(m, cfg.ourTeam, g.opponent.players, champById);
      if (!game) continue;
      day.games.push(game);
      console.log(`Game day ${g.day}: ${game.win ? 'win' : 'loss'} (${id})`);
    }
    day.games.sort((a, b) => a.t - b.t);
    day.checkedAt = new Date(now).toISOString();
    if (now > start + FINAL_AFTER) day.final = true;
  }
  await writeFile(FILE, JSON.stringify(results, null, 1));
  console.log(`Results checked: ${stats.calls} API calls.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
