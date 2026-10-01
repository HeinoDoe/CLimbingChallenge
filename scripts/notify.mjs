// Discord: one post per day. update.mjs queues the daily post in notify.json once a day
// is finished; the last step of the update workflow runs this file, which sends it with
// the DISCORD_WEBHOOK_URL secret (without the secret nothing is sent).
//
//   node scripts/notify.mjs          send everything in notify.json, then empty it
//   node scripts/notify.mjs --test   send one test post built from the current data.json
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { champName } from './review.mjs';

const QUEUE = new URL('../notify.json', import.meta.url);
export const COLOR = 0xF08A3A; // ember, like the site
const MEDALS = ['🥇', '🥈', '🥉'];

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

// The one Discord post per day: the Tagesrückblick with the leaderboard, the bounty that
// ran that day and our Prime League games of that day (from docs/prime/results.json).
// Pentakills and a new leader are already highlights of the review, so nothing else is
// posted on its own.
export function dailyEmbed(r, data, { siteUrl = '', timeZone = 'Europe/Berlin', results = null, gamedays = [] } = {}) {
  const names = new Map((data.players || []).map((p) => [p.key, p.name]));
  const fields = [{ name: '🏆 Leaderboard Solo/Duo', value: leaderboardText(data.players || [], 'solo') }];
  const b = (data.bounties || []).filter((x) => x.startMs < r.endMs && x.endMs > r.startMs).sort((x, y) => y.startMs - x.startMs)[0];
  if (b) {
    const lead = b.progress.filter((x) => x.value > 0).slice(0, 3).map((x) => `**${names.get(x.key)}** ${x.value}/${b.target}`).join(' · ');
    fields.push({
      name: `🎯 Wochen-Bounty: ${b.title} (+${b.points})`,
      value: b.status === 'won' ? `Geschafft von ${b.winners.map((k) => `**${names.get(k)}**`).join(' und ')}!`
        : b.status === 'expired' ? 'Vorbei, niemand hat es geschafft.'
        : `${lead || 'Noch niemand dran.'} · läuft bis ${dayLabel(b.endMs - 1, timeZone)}`,
    });
  }
  const opponent = (day) => gamedays.find((g) => String(g.day) === String(day))?.opponent?.name;
  const games = Object.entries(results?.days || {}).flatMap(([day, d]) => (d.games || []).filter((g) => g.t >= r.startMs && g.t < r.endMs).map((g) => ({ day, g })));
  if (games.length) {
    fields.push({
      name: '⚔️ Prime League',
      value: games.map(({ day, g }) => `${g.win ? '✅ Sieg' : '❌ Niederlage'} · Spieltag ${day}${opponent(day) ? ` vs ${opponent(day)}` : ''} · ${g.us.map((x) => champName(x.champ)).join(', ')}`).join('\n'),
    });
  }
  return {
    title: `📰 Tagesrückblick · ${dayLabel(r.startMs, timeZone)}`, url: siteUrl, color: COLOR,
    description: r.highlights.map((h) => `${h.icon} ${h.text}`).join('\n'), fields,
  };
}

// Posts for a new data.json: one daily post per newly finished day, nothing else.
// Nothing after a reset (different reviewsKey), when every game is counted again.
export function buildNotifications(prev, next, opts = {}) {
  if (!prev?.reviewsKey || prev.reviewsKey !== next.reviewsKey) return [];
  const had = new Set((prev.reviews || []).map((r) => r.date));
  return (next.reviews || []).filter((r) => !had.has(r.date)).map((r) => dailyEmbed(r, next, opts));
}

export async function queue(embeds) {
  if (!embeds.length) return;
  let list = [];
  try { list = JSON.parse(await readFile(QUEUE, 'utf8')); } catch { /* empty queue */ }
  await writeFile(QUEUE, JSON.stringify([...list, ...embeds]));
  console.log(`Queued ${embeds.length} Discord post(s).`);
}

// A labelled sample in the real format: the latest daily post with today's data.
export function testEmbed(data, opts = {}) {
  const r = [...(data.reviews || [])].sort((a, b) => b.startMs - a.startMs)[0];
  if (!r) return { title: '🧪 Test · Climbing Challenge', url: opts.siteUrl, color: COLOR, description: 'Noch kein Tagesrückblick.', fields: [{ name: '🏆 Leaderboard Solo/Duo', value: leaderboardText(data.players || [], 'solo') }] };
  const e = dailyEmbed(r, data, opts);
  return { ...e, title: `🧪 Test · ${e.title}`, footer: { text: 'Testnachricht: so sieht der tägliche Post aus. Er kommt einmal am Tag, kurz nach Mitternacht.' } };
}

async function send(test = false) {
  const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
  let embeds;
  if (test) {
    const data = JSON.parse(await readFile(new URL('../docs/data.json', import.meta.url), 'utf8'));
    const results = await readFile(new URL('../docs/prime/results.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
    const gamedays = await readFile(new URL('../docs/prime/gamedays.json', import.meta.url), 'utf8').then((t) => JSON.parse(t).gamedays).catch(() => []);
    embeds = [testEmbed(data, { siteUrl: cfg.siteUrl, timeZone: cfg.challenge?.timeZone, results, gamedays })];
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
