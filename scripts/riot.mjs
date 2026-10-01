// Small Riot API client shared by scout.mjs and results.mjs: reads RIOT_API_KEY (from
// the environment or a local .env), stays under the personal-key limits
// (20 requests/s, 100 requests/2 min) and retries 429s and 5xx errors.
import { readFile } from 'node:fs/promises';

try {
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env, e.g. on GitHub Actions */ }

export const KEY = process.env.RIOT_API_KEY;

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

export const stats = { calls: 0 };
export async function riot(url, attempt = 0) {
  await throttle();
  stats.calls++;
  const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
  if (res.status === 429 && attempt < 6) { await sleep((Number(res.headers.get('retry-after')) || 10) * 1000 + 250); return riot(url, attempt + 1); }
  if (res.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); return riot(url, attempt + 1); }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`Riot refused the API key (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

export const puuidOf = async (riotId) => {
  const [name, tag] = riotId.split('#').map((s) => s.trim());
  return (await riot(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`))?.puuid ?? null;
};
// Riot IDs compared without case and spaces ("MENTALITY MEN#xdd" = "mentalitymen#xdd").
export const idKey = (riotId) => riotId.toLowerCase().replace(/\s+/g, '');
