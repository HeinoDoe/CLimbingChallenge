// Discord: one post per day, plus a heads-up when someone is one away from a bounty.
// update.mjs queues posts in notify.json; the last step of the update workflow runs this
// file, which sends them with the DISCORD_WEBHOOK_URL secret (without it nothing is sent).
//
//   node scripts/notify.mjs          send everything in notify.json, then empty it
//   node scripts/notify.mjs --test   send one test post built from the current data.json
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { champName } from './review.mjs';
import { CELLS, LINES } from './bingo.mjs';

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
  // A bounty shows while it's open, and on the day it was won.
  const b = (data.bounties || []).filter((x) => x.startMs < r.endMs && x.endMs > r.startMs && (x.status === 'open' || (x.wonAt >= r.startMs && x.wonAt < r.endMs))).sort((x, y) => y.startMs - x.startMs)[0];
  if (b) {
    const lead = b.progress.filter((x) => x.value > 0).slice(0, 3).map((x) => `**${names.get(x.key)}** ${x.value}/${b.target}`).join(' · ');
    fields.push({
      name: `🎯 Wochen-Bounty: ${b.title} (+${b.points})`,
      value: b.status === 'won' ? `Geschafft von ${b.winners.map((k) => `**${names.get(k)}**`).join(' und ')}!`
        : b.status === 'expired' ? 'Vorbei, niemand hat es geschafft.'
        : `${lead || 'Noch niemand dran.'} · läuft bis ${dayLabel(b.endMs - 1, timeZone)}`,
    });
  }
  const bg = data.bingo;
  if (bg && bg.startMs < r.endMs && bg.endMs > r.startMs) {
    const won = bg.players.filter((x) => x.rank).map((x) => `${MEDALS[x.rank - 1]} **${names.get(x.key)}**`);
    const close = bg.players.filter((x) => !x.rank).slice(0, 3).map((x) => `**${names.get(x.key)}** ${x.best}/5`);
    fields.push({
      name: `🎲 Wochen-Bingo (+${bg.points} für die ersten ${bg.winners})`,
      value: [won.length ? `Bingo: ${won.join(' · ')}` : '', close.length ? `Beste Reihe: ${close.join(' · ')}` : ''].filter(Boolean).join('\n') || 'Noch nichts abgehakt.',
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

// Posts for a new data.json: one daily post per newly finished day, plus one alert when a
// player gets within one of a bounty's target (e.g. 9/10). Nothing after a reset
// (different reviewsKey), when every game is counted again.
export function buildNotifications(prev, next, opts = {}) {
  if (!prev?.reviewsKey || prev.reviewsKey !== next.reviewsKey) return [];
  const had = new Set((prev.reviews || []).map((r) => r.date));
  return [
    ...(next.reviews || []).filter((r) => !had.has(r.date)).map((r) => dailyEmbed(r, next, opts)),
    ...bountyAlerts(prev, next, opts),
    ...bingoAlerts(prev, next, opts),
  ];
}

// Bingo: once per player when a line is one field short, and when they get their first bingo.
export function bingoAlerts(prev, next, { siteUrl = '' } = {}) {
  const bg = next.bingo;
  if (!bg || bg.status === 'upcoming') return [];
  const names = new Map((next.players || []).map((p) => [p.key, p.name]));
  const before = new Map((prev.bingo?.id === bg.id ? prev.bingo.players : []).map((x) => [x.key, x]));
  const out = [];
  for (const x of bg.players) {
    const was = before.get(x.key);
    if (x.lines.length && !was?.lines?.length) {
      out.push({ title: '🎲 BINGO!', url: siteUrl, color: COLOR,
        description: `**${names.get(x.key)}** hat eine volle Reihe${x.rank ? ` und holt +${bg.points} Punkte (Platz ${x.rank} von ${bg.winners})` : ', aber die ersten Plätze sind schon weg'}!` });
    } else if (!x.lines.length && x.best >= 4 && (was?.best ?? 0) < 4) {
      const line = LINES.find((l) => l.filter((i) => x.done[i] != null).length === 4);
      const missing = line && CELLS[line.find((i) => x.done[i] == null)].text;
      out.push({ title: '🎲 Noch 1 Feld bis Bingo', url: siteUrl, color: COLOR,
        description: `**${names.get(x.key)}** hat 4/5 in einer Reihe.${missing ? `\nFehlt: ${missing}` : ''}` });
    }
  }
  return out;
}

// "One champion to go": once per player and bounty, when they first reach target - 1.
// Someone who jumps straight to the target in one update gets a "geschafft" post instead.
export function bountyAlerts(prev, next, { siteUrl = '' } = {}) {
  const names = new Map((next.players || []).map((p) => [p.key, p.name]));
  const before = new Map((prev.bounties || []).map((b) => [b.id, new Map((b.progress || []).map((r) => [r.key, r.value]))]));
  const out = [];
  for (const b of next.bounties || []) {
    if (b.status === 'upcoming' || b.status === 'expired') continue;
    const edge = b.target - 1;
    for (const r of b.progress || []) {
      if (r.value < edge || (before.get(b.id)?.get(r.key) ?? 0) >= edge) continue;
      const champs = (r.champs || []).map(champName).join(', ');
      const done = r.value >= b.target;
      out.push({
        title: done ? `🎯 Bounty geschafft: ${b.title}` : `🎯 Noch 1 Champion: ${b.title}`, url: siteUrl, color: COLOR,
        description: done
          ? `**${names.get(r.key)}** hat mit ${r.value} verschiedenen Champions gewonnen${b.winners?.includes(r.key) ? ` und holt +${b.points} Punkte` : ''}!${champs ? `\n${champs}` : ''}`
          : `**${names.get(r.key)}** steht bei ${r.value}/${b.target}: noch ein Sieg mit einem neuen Champion für +${b.points} Punkte.${champs ? `\nSchon geschafft mit: ${champs}` : ''}`,
      });
    }
  }
  return out;
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
