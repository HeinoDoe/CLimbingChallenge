// One-off: prints how Riot flagged a player's short ranked games since the challenge start
// (to tell real remakes from early-surrender wins).  node scripts/inspect.mjs "HeinoDoe#213"
import { readFile } from 'node:fs/promises';
import { riot, puuidOf } from './riot.mjs';
import { challengeWindow } from './challenge.mjs';

const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
const { startMs } = challengeWindow(cfg.challenge);
const puuid = await puuidOf(process.argv[2]);
const ids = (await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?type=ranked&startTime=${Math.floor(startMs / 1000)}&count=100`)) || [];
for (const id of ids) {
  const m = await riot(`https://europe.api.riotgames.com/lol/match/v5/matches/${id}`);
  if (m.info.gameDuration > 900) continue;
  const me = m.info.participants.find((x) => x.puuid === puuid);
  const flags = (x) => `win=${x.win} earlySurr=${x.gameEndedInEarlySurrender} surr=${x.gameEndedInSurrender} teamEarlySurr=${x.teamEarlySurrendered} timePlayed=${x.timePlayed}`;
  console.log(`${id} queue=${m.info.queueId} duration=${m.info.gameDuration}s endResult=${m.info.endOfGameResult} champ=${me.championName}`);
  console.log(`  me:    ${flags(me)}`);
  for (const t of m.info.teams) console.log(`  team ${t.teamId}: win=${t.win}`);
  for (const x of m.info.participants) console.log(`    ${x.teamId} ${x.championName.padEnd(12)} ${flags(x)}`);
}
