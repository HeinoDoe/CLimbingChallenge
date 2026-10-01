// Discord posts. update.mjs and results.mjs queue Discord embeds in notify.json; the last
// step of the update workflow runs this file, which sends them with the
// DISCORD_WEBHOOK_URL secret (without the secret nothing is sent).
//
//   node scripts/notify.mjs          send everything in notify.json, then empty it
//   node scripts/notify.mjs --test   send one test post built from the current data.json
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { champName } from './review.mjs';

const QUEUE = new URL('../notify.json', import.meta.url);
export const COLOR = 0xF08A3A; // ember, like the site
const MEDALS = ['🥇', '🥈', '🥉'];
const MODE_NAME = { solo: 'Solo/Duo', flex: 'Flex' };

const dayLabel = (ms, timeZone) => new Date(ms).toLocaleDateString('de-DE', { timeZone, weekday: 'long', day: 'numeric', month: 'numeric' });
const move = (P) => (P.prevPlace == null || P.prevPlace === P.place ? '' : P.prevPlace > P.place ? ` ▲${P.prevPlace - P.place}` : ` ▼${P.place - P.prevPlace}`);

// Top 3 plus the last place, e.g. "🥇 **Smette** · 111 Punkte ▲1".
export function leaderboardText(players, mode = 'solo') {
  const rows = [...players].filter((p) => p.points?.[mode]).sort((a, b) => a.points[mode].place - b.points[mode].place);
  const line = (p, icon) => `${icon} **${p.name}** · ${p.points[mode].total} Punkte${move(p.points[mode])}`;
  const out = rows.filter((p) => p.points[mode].place <= 3).map((p) => line(p, MEDALS[p.points[mode].place - 1]));
  const last = rows.at(-1);
  if (last && last.points[mode].place > 3) out.push(line(last, `🤡 ${last.points[mode].place}.`));
  return out.join('\n') || '–';
}

// Embeds for what changed between two data.json versions: new daily reviews (with the
// leaderboard), new pentakills and a new Solo/Duo leader. Nothing after a reset
// (different reviewsKey), because then every game is counted again from scratch.
export function buildNotifications(prev, next, { siteUrl = '', timeZone = 'Europe/Berlin' } = {}) {
  if (!prev?.reviewsKey || prev.reviewsKey !== next.reviewsKey) return [];
  const embeds = [];

  const had = new Set((prev.reviews || []).map((r) => r.date));
  for (const r of (next.reviews || []).filter((x) => !had.has(x.date))) {
    embeds.push({
      title: `📰 Tagesrückblick · ${dayLabel(r.startMs, timeZone)}`, url: siteUrl, color: COLOR,
      description: r.highlights.map((h) => `${h.icon} ${h.text}`).join('\n'),
      fields: [{ name: '🏆 Leaderboard Solo/Duo', value: leaderboardText(next.players, 'solo') }],
    });
  }

  const before = new Map((prev.players || []).map((p) => [p.key, p]));
  for (const p of next.players || []) {
    for (const mode of ['solo', 'flex']) {
      const seen = new Set((before.get(p.key)?.modes?.[mode]?.log || []).filter((g) => g.penta).map((g) => g.t));
      for (const g of (p.modes?.[mode]?.log || []).filter((x) => x.penta && !seen.has(x.t))) {
        embeds.push({ title: '💥 PENTAKILL!', url: siteUrl, color: COLOR, description: `**${p.name}** hat auf ${champName(g.champ)} alle fünf weggeräumt (${g.k}/${g.d}/${g.a}, ${MODE_NAME[mode]}).` });
      }
    }
  }

  const leader = (d) => { const top = (d.players || []).filter((p) => p.points?.solo?.place === 1); return top.length === 1 && top[0].points.solo.total > 0 ? top[0] : null; };
  const was = leader(prev), now = leader(next);
  if (now && was?.key !== now.key) {
    embeds.push({ title: '👑 Neuer Spitzenreiter', url: siteUrl, color: COLOR, description: `**${now.name}** führt jetzt mit ${now.points.solo.total} Punkten${was ? `, vor **${was.name}**` : ''}.` });
  }
  return embeds;
}

// One embed per Prime League game found by results.mjs.
export function resultEmbed(day, opponent, game, siteUrl = '') {
  const side = (list) => list.map((x) => `${champName(x.champ)} · ${x.name} ${x.k}/${x.d}/${x.a}`).join('\n') || '–';
  return {
    title: `${game.win ? '✅ Sieg' : '❌ Niederlage'} · Spieltag ${day}${opponent ? ` vs ${opponent}` : ''}`,
    url: `${siteUrl}#prime`, color: game.win ? 0x7BD389 : 0xFF7A59,
    description: `${Math.round(game.duration / 60)} Minuten${game.vsOpponent ? '' : ' (Gegner-Roster nicht eindeutig erkannt)'}`,
    fields: [{ name: 'Wir', value: side(game.us), inline: true }, { name: opponent || 'Gegner', value: side(game.them), inline: true }],
  };
}

export async function queue(embeds) {
  if (!embeds.length) return;
  let list = [];
  try { list = JSON.parse(await readFile(QUEUE, 'utf8')); } catch { /* empty queue */ }
  await writeFile(QUEUE, JSON.stringify([...list, ...embeds]));
  console.log(`Queued ${embeds.length} Discord post(s).`);
}

// A labelled sample in the real format: the latest Tagesrückblick and today's leaderboard.
export function testEmbed(data, { siteUrl = '', timeZone = 'Europe/Berlin' } = {}) {
  const r = [...(data.reviews || [])].sort((a, b) => b.startMs - a.startMs)[0];
  return {
    title: `🧪 Test · ${r ? `Tagesrückblick · ${dayLabel(r.startMs, timeZone)}` : 'Climbing Challenge'}`, url: siteUrl, color: COLOR,
    description: r ? r.highlights.map((h) => `${h.icon} ${h.text}`).join('\n') : 'Noch kein Tagesrückblick.',
    fields: [{ name: '🏆 Leaderboard Solo/Duo', value: leaderboardText(data.players || [], 'solo') }],
    footer: { text: 'Testnachricht: so sehen die echten Posts aus. Ab jetzt kommt das nach jedem Tag automatisch.' },
  };
}

async function send(test = false) {
  const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
  let embeds;
  if (test) {
    const data = JSON.parse(await readFile(new URL('../docs/data.json', import.meta.url), 'utf8'));
    embeds = [testEmbed(data, { siteUrl: cfg.siteUrl, timeZone: cfg.challenge?.timeZone })];
  } else {
    try { embeds = JSON.parse(await readFile(QUEUE, 'utf8')); } catch { console.log('Nothing to post.'); return; }
  }
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) {
    console.log(`${embeds.length} post(s) skipped: no DISCORD_WEBHOOK_URL secret.`);
    if (!test) await unlink(QUEUE);
    if (test) process.exitCode = 1;
    return;
  }
  for (let i = 0; i < embeds.length; i += 10) { // Discord takes up to 10 embeds per message
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(hook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cfg.squadName || 'Climbing Challenge', avatar_url: cfg.siteUrl ? `${cfg.siteUrl}img/dive-logo.jpg` : undefined, embeds: embeds.slice(i, i + 10) }),
      });
      if (res.status === 429) {
        const wait = ((await res.json()).retry_after || 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Discord answered HTTP ${res.status}: ${await res.text()}`);
      break;
    }
  }
  if (!test) await unlink(QUEUE);
  console.log(`Posted ${embeds.length} embed(s) to Discord.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  send(process.argv.includes('--test')).catch((e) => { console.error(e.message); process.exit(1); });
}
