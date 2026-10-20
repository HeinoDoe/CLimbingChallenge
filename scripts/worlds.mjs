// Worlds Tippspiel: copies the Worlds schedule, odds and results from Polymarket into the
// Supabase database (supabase/worlds.sql). Runs in the "Update squad data" workflow.
//
//   SUPABASE_SECRET_KEY   GitHub secret (Supabase → Project Settings → API Keys → secret key)
//   squad.config.json     "worlds": { supabaseUrl, start, end, points, bonus: [...] }
//
// Polymarket has one event per match. Its "Match Winner" price gives the chance bar and the
// auto-tip for players who forget to tip (the favourite's most likely score); the per-game
// winner markets give the exact series score once the match is over.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_SPREAD = 0.1;

const num = (v) => (v == null || v === '' ? null : Number(v));
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const isoOf = (v) => (v ? new Date(String(v).replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString() : null);
const yesPrice = (m) => num(parse(m.outcomePrices || '[]')[0]);

// "LoL: Gen.G vs Invictus Gaming (BO1) - Worlds Group Stage"
export function parseTitle(title) {
  const m = /^LoL:\s*(.+?)\s*(?:\(BO(\d)\))?\s*-\s*(.+)$/i.exec(title || '');
  return m ? { title: m[1], bestOf: m[2] ? Number(m[2]) : null, stage: m[3] } : { title: title || '', bestOf: null, stage: null };
}

// Polymarket's price for the first outcome while it is a real market (spread ≤ 10 cents).
export function priceOf(m) {
  if (!m || m.closed) return null;
  const bid = num(m.bestBid), ask = num(m.bestAsk);
  if (bid == null || ask == null || ask - bid > MAX_SPREAD + 1e-9) return null;
  const p = yesPrice(m);
  return p > 0 && p < 1 ? Math.round(p * 10000) / 10000 : null;
}

// Winning outcome once Polymarket has settled a market; -1 = not played (50/50).
export function resultOf(m) {
  if (!m?.closed) return null;
  const p = parse(m.outcomePrices || '[]').map(Number);
  if (p.length !== 2) return null;
  if (p[0] === 1 && p[1] === 0) return 0;
  if (p[0] === 0 && p[1] === 1) return 1;
  if (p[0] === 0.5 && p[1] === 0.5) return -1;
  return null;
}

// Chance to win one game, from the chance to win the series (games independent).
export function gameChance(series, bo) {
  const need = (bo + 1) / 2;
  const win = (p) => { // P(first to `need` wins)
    let s = 0;
    for (let lost = 0; lost < need; lost++) s += binom(need - 1 + lost, lost) * p ** need * (1 - p) ** lost;
    return s;
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (win(mid) < series) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };

// The auto-tip: the favourite's most likely series score, [a, b].
export function favourite(priceA, bo) {
  if (priceA == null) return null;
  const aFav = priceA >= 0.5, need = (bo + 1) / 2;
  let loser = 0;
  if (bo > 1) {
    // P(need:k) ∝ C(need-1+k, k)·q^k; the next score is likelier while that ratio > 1
    const q = 1 - gameChance(Math.max(priceA, 1 - priceA), bo);
    while (loser < need - 1 && (need + loser) / (loser + 1) * q > 1) loser++;
  }
  return aFav ? [need, loser] : [loser, need];
}

// Final series score [a, b] once the match is over; null while unknown.
export function seriesScore(e, bo, winner) {
  const need = (bo + 1) / 2;
  if (bo === 1) return winner === 0 ? [1, 0] : [0, 1];
  const wins = [0, 0];
  for (const m of e.markets || []) if (m.sportsMarketType === 'child_moneyline') { const r = resultOf(m); if (r === 0 || r === 1) wins[r]++; }
  if (wins[winner] === need && wins[1 - winner] < need) return wins;
  const s = /\|(\d+)-(\d+)\|/.exec(e.score || '');
  if (s) {
    const sc = [Number(s[1]), Number(s[2])];
    if (sc[winner] === need && sc[1 - winner] < need) return sc;
  }
  return null;
}

export const isWorldsMatch = (e, word = 'Worlds') => /^lol-/.test(e.slug || '') && (e.title || '').includes(word)
  && (e.markets || []).some((m) => m.sportsMarketType === 'moneyline');

// One Polymarket match event → a wb_matches row (with result once it is over).
export function matchOf(e) {
  const ml = (e.markets || []).find((m) => m.sportsMarketType === 'moneyline');
  if (!ml) return null;
  const head = parseTitle(e.title);
  const [teamA, teamB] = parse(ml.outcomes || '[]');
  const startsAt = isoOf(e.startTime) || isoOf(ml.gameStartTime);
  if (!teamA || !teamB || !startsAt) return null;
  const bo = [1, 3, 5].includes(head.bestOf) ? head.bestOf : 1;
  const priceA = priceOf(ml);
  const fav = favourite(priceA, bo);
  const row = { id: String(e.id), title: head.title, team_a: teamA, team_b: teamB, stage: head.stage, best_of: bo,
    starts_at: startsAt, price_a: priceA, fav_a: fav?.[0] ?? null, fav_b: fav?.[1] ?? null };
  const winner = resultOf(ml);
  if (winner === -1) row.void = true;
  else if (winner != null) { const sc = seriesScore(e, bo, winner); if (sc) row.result = sc; }
  return row;
}

const real = (m) => m.groupItemTitle && m.groupItemTitle !== 'Other' && (m.closed || (num(m.bestAsk) ?? 1) - (num(m.bestBid) ?? 0) < 0.9);

// One bonus question's Polymarket event → [{kind, team, price, hit}].
export function teamOddsOf(kind, event) {
  return (event?.markets || []).filter(real).map((m) => {
    const spread = (num(m.bestAsk) ?? 1) - (num(m.bestBid) ?? 0);
    return { kind, team: m.groupItemTitle, price: m.closed ? yesPrice(m) : spread <= 0.3 ? yesPrice(m) : null,
      hit: m.closed ? yesPrice(m) === 1 : null };
  });
}

// All teams of the bonus questions; a team is out once it can no longer win or reach the knockouts.
export function teamsOf(odds) {
  const teams = new Map();
  for (const o of odds) {
    const t = teams.get(o.team) || { team: o.team, out: false };
    if ((o.kind === 'winner' || o.kind === 'knockout') && o.hit === false) t.out = true;
    teams.set(o.team, t);
  }
  return [...teams.values()];
}

export function settingsOf(w) {
  return { start_day: w.start, end_day: w.end, pts_bo1: w.points?.bo1, pts_winner: w.points?.winner, pts_exact: w.points?.exact };
}
export const pickTypesOf = (w) => (w.bonus || []).map((b, i) => ({ kind: b.kind, title: b.title, slots: b.slots, points: b.points, lock_at: b.lock, sort: i + 1 }));

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
  if (!w || !url || !key) {
    console.log('Worlds Tippspiel: no Supabase URL or SUPABASE_SECRET_KEY yet, skipping.');
    return;
  }
  const events = new Map();
  for (const closed of [false, true]) {
    for (let offset = 0; offset < (closed ? 100 : 400); offset += 100) {
      const order = closed ? '&order=endDate&ascending=false' : '';
      const page = await get(`/events?tag_slug=league-of-legends&closed=${closed}&limit=100&offset=${offset}${order}`);
      for (const e of page) if (isWorldsMatch(e, w.match || 'Worlds')) events.set(String(e.id), e);
      if (page.length < 100) break;
    }
  }
  const matches = [...events.values()].map(matchOf).filter(Boolean);
  const odds = [];
  for (const b of w.bonus || []) {
    if (!b.event) continue;
    const [e] = await get(`/events?slug=${encodeURIComponent(b.event)}`);
    odds.push(...teamOddsOf(b.kind, e));
  }
  const out = await rpc(url, key, 'wb_sync', { p: { settings: settingsOf(w), pick_types: pickTypesOf(w), teams: teamsOf(odds), team_odds: odds, matches } });
  console.log(`Worlds Tippspiel: ${matches.length} matches (${matches.filter((m) => m.price_a != null).length} with odds), ${odds.length} bonus answers, ${out.finished} matches finished.`);

  // Started matches that were not in the lists above: look them up one by one.
  const late = [];
  for (const id of (out.pending || []).filter((id) => !events.has(id))) {
    const row = matchOf(await get(`/events/${encodeURIComponent(id)}`));
    if (row && (row.result || row.void)) late.push(row);
  }
  if (late.length) {
    const r = await rpc(url, key, 'wb_sync', { p: { matches: late } });
    console.log(`Worlds Tippspiel: ${r.finished} more matches finished.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
