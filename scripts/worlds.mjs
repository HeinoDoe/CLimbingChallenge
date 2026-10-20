// Worlds betting game: copies Worlds odds and results from Polymarket into the Supabase
// database (supabase/worlds.sql). Runs in the "Update squad data" workflow.
//
//   SUPABASE_SECRET_KEY   GitHub secret (Supabase → Project Settings → API Keys → secret key)
//   squad.config.json     "worlds": { supabaseUrl, start, end, ... }
//
// Bets are only possible on markets with a real price: Polymarket shows the midpoint of
// the order book when the spread is at most 10 cents, so we do the same and skip the rest.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_SPREAD = 0.1;
const MIN_PRICE = 0.02, MAX_PRICE = 0.98; // odds between 1.02 and 50

const num = (v) => (v == null || v === '' ? null : Number(v));
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const isoOf = (v) => (v ? new Date(String(v).replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString() : null);

// "LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage"
export function parseTitle(title) {
  const m = /^LoL:\s*(.+?)\s*(?:\(BO(\d)\))?\s*-\s*(.+)$/i.exec(title || '');
  return m ? { title: m[1], bestOf: m[2] ? Number(m[2]) : null, stage: m[3] } : { title: title || '', bestOf: null, stage: null };
}

// Fair prices of both outcomes, or null when there is no real market right now.
export function pricesOf(m) {
  if (m.closed || m.acceptingOrders === false) return null;
  const bid = num(m.bestBid), ask = num(m.bestAsk);
  if (bid == null || ask == null || ask - bid > MAX_SPREAD + 1e-9) return null;
  const p = parse(m.outcomePrices || '[]').map(Number);
  if (p.length !== 2 || !(p[0] >= MIN_PRICE && p[0] <= MAX_PRICE)) return null;
  const p0 = Math.round(p[0] * 10000) / 10000;
  return [p0, Math.round((1 - p0) * 10000) / 10000];
}

// Winning outcome once Polymarket has settled the market; -1 = void (e.g. game 4 not played).
export function resultOf(m) {
  if (!m.closed) return null;
  const p = parse(m.outcomePrices || '[]').map(Number);
  if (p.length !== 2) return null;
  if (p[0] === 1 && p[1] === 0) return 0;
  if (p[0] === 0 && p[1] === 1) return 1;
  if (p[0] === 0.5 && p[1] === 0.5) return -1;
  return null;
}

const KINDS = new Set(['moneyline', 'child_moneyline', 'totals', 'map_handicap', 'lol_both_teams_baron', 'lol_both_teams_dragon',
  'lol_both_teams_inhibitors', 'lol_quadra_kill', 'lol_penta_kill', 'lol_odd_even_total_kills']);

// One Polymarket match event → rows for wb_markets.
export function marketsOf(e) {
  const head = parseTitle(e.title);
  const ml = (e.markets || []).find((m) => m.sportsMarketType === 'moneyline');
  if (!ml) return [];
  const startsAt = isoOf(e.startTime) || isoOf(ml.gameStartTime);
  if (!startsAt) return [];
  return (e.markets || []).filter((m) => KINDS.has(m.sportsMarketType)).map((m) => ({
    id: String(m.id),
    event_id: String(e.id),
    event_title: head.title,
    stage: head.stage,
    best_of: head.bestOf,
    kind: m.sportsMarketType,
    label: m.sportsMarketType === 'moneyline' ? 'Match Winner'
      : ['child_moneyline', 'totals'].includes(m.sportsMarketType) ? (m.groupItemTitle || m.question) : m.question,
    outcomes: parse(m.outcomes || '[]'),
    prices: pricesOf(m),
    starts_at: startsAt,
    score: e.score || null,
    result: resultOf(m),
  }));
}

export const isWorldsMatch = (e, word = 'Worlds') => /^lol-/.test(e.slug || '') && (e.title || '').includes(word)
  && (e.markets || []).some((m) => m.sportsMarketType === 'moneyline');

// Teams for the free picks, from the "Worlds winner" and "make the grand final" events.
export function teamsOf(winnerEvent, finalEvent) {
  const yes = (m) => num(parse(m.outcomePrices || '[]')[0]);
  const real = (m) => m.closed || (num(m.bestAsk) ?? 1) - (num(m.bestBid) ?? 0) < 0.9; // skip empty placeholders ("Other")
  const finals = new Map((finalEvent?.markets || []).map((m) => [m.groupItemTitle, m]));
  return (winnerEvent?.markets || []).filter((m) => m.groupItemTitle && m.groupItemTitle !== 'Other' && real(m)).map((m) => {
    const f = finals.get(m.groupItemTitle);
    const won = m.closed ? yes(m) === 1 : null;
    const finalist = f?.closed ? yes(f) === 1 : null;
    return {
      team: m.groupItemTitle,
      win_price: yes(m),
      final_price: f ? yes(f) : null,
      out: Boolean(m.closed && yes(m) === 0 && finalist !== true),
      won,
      finalist,
    };
  });
}

export function settingsOf(w) {
  return {
    start_day: w.start, end_day: w.end, start_balance: w.startBalance, daily: w.daily,
    winner_bonus: w.winnerBonus, finalist_bonus: w.finalistBonus, picks_lock: w.picksLock,
  };
}

// ---------- I/O ----------

async function get(path) {
  const res = await fetch(GAMMA + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Polymarket ${res.status} for ${path}`);
  return res.json();
}

async function rpc(url, key, fn, body) {
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`; // legacy service_role JWT
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${fn}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const cfg = JSON.parse(await readFile(new URL('../squad.config.json', import.meta.url), 'utf8'));
  const w = cfg.worlds;
  const key = process.env.SUPABASE_SECRET_KEY;
  const url = process.env.SUPABASE_URL || w?.supabaseUrl; // env only for local testing
  if (!url || !key) {
    console.log('Worlds betting: no Supabase URL or SUPABASE_SECRET_KEY yet, skipping.');
    return;
  }
  const events = new Map();
  for (const closed of [false, true]) {
    for (let offset = 0; offset < (closed ? 100 : 400); offset += 100) {
      const order = closed ? '&order=endDate&ascending=false' : '';
      const page = await get(`/events?tag_slug=league-of-legends&closed=${closed}&limit=100&offset=${offset}${order}`);
      for (const e of page) if (isWorldsMatch(e, w.match || 'Worlds')) events.set(e.id, e);
      if (page.length < 100) break;
    }
  }
  const markets = [...events.values()].flatMap(marketsOf);
  const [winner] = w.winnerEvent ? await get(`/events?slug=${w.winnerEvent}`) : [];
  const [final] = w.finalistEvent ? await get(`/events?slug=${w.finalistEvent}`) : [];
  const teams = teamsOf(winner, final);
  const out = await rpc(url, key, 'wb_sync', { p: { settings: settingsOf(w), markets, teams } });
  console.log(`Worlds betting: ${events.size} matches, ${markets.length} markets (${markets.filter((m) => m.prices).length} with odds), ${teams.length} teams, ${out.settled} bets settled.`);

  // Started markets that were not in the lists above: look them up one by one.
  const known = new Set(markets.map((m) => m.id));
  const missing = (out.pending || []).filter((id) => !known.has(id));
  const results = [];
  for (let i = 0; i < missing.length; i += 20) {
    const list = await get(`/markets?${missing.slice(i, i + 20).map((id) => `id=${id}`).join('&')}`);
    for (const m of list) {
      const result = resultOf(m);
      if (result != null) results.push({ id: String(m.id), result });
    }
  }
  if (results.length) {
    const r = await rpc(url, key, 'wb_sync', { p: { results } });
    console.log(`Worlds betting: ${r.settled} more bets settled from ${results.length} finished markets.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
