// Worlds betting game ("Justus Bucks"): the #worlds tab, "Summoner's Cup" look.
// Everything is stored in Supabase (supabase/worlds.sql) and reached only through its wb_*
// functions; the odds come from Polymarket via scripts/worlds.mjs. The connection (project
// URL + publishable key, both public) is in squad.config.json → data.json → data.worlds.
const WB = { st: null, me: null, slip: null, msg: null, histMine: true, timer: null, busy: false,
  day: null, open: new Set(), pickMode: 'winner', boardAll: false, teamsAll: false };
const WB_TZ = 'Europe/Berlin';
// Worlds 2026 schedule, for the timeline in the header.
const WB_STAGES = [
  { name: 'Swiss', from: '2026-10-23', to: '2026-10-31', text: '23.–31.10.' },
  { name: 'Viertelfinale', from: '2026-11-03', to: '2026-11-06', text: '3.–6.11.' },
  { name: 'Halbfinale', from: '2026-11-07', to: '2026-11-08', text: '7.–8.11.' },
  { name: 'Finale', from: '2026-11-14', to: '2026-11-14', text: '14.11.' },
];
const WB_ABBR = {
  'Gen.G': 'GEN', T1: 'T1', 'Hanwha Life Esports': 'HLE', 'Dplus KIA': 'DK', 'Bilibili Gaming': 'BLG', 'Top Esports': 'TES',
  'Invictus Gaming': 'IG', "Anyone's Legend": 'AL', 'G2 Esports': 'G2', 'Karmine Corp': 'KC', 'Movistar KOI': 'MKOI',
  'Team Liquid': 'TL', 'CTBC Flying Oyster': 'CFO', 'Team Secret Whales': 'TSW', LYON: 'LYON', LOS: 'LOS',
  Cloud9: 'C9', 'FURIA Esports': 'FUR', 'MVK Esports': 'MVK',
};
const wbAbbr = t => WB_ABBR[t] || (t || '').split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();

try { WB.me = JSON.parse(localStorage.getItem('wb-auth') || 'null'); } catch { WB.me = null; }
const wbSaveMe = me => { WB.me = me; try { me ? localStorage.setItem('wb-auth', JSON.stringify(me)) : localStorage.removeItem('wb-auth'); } catch {} };

const wbCfg = () => (typeof data !== 'undefined' && data?.worlds?.url && data?.worlds?.key) ? data.worlds : null;
const wbMoney = n => '$' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const wbOdds = n => Number(n).toFixed(2);
const wbDayKey = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: WB_TZ });
const wbDay = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
const wbDayShort = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const wbTime = t => new Date(t).toLocaleTimeString('de-DE', { timeZone: WB_TZ, hour: '2-digit', minute: '2-digit' });
const wbStage = s => (s || '').replace(/^Worlds\s*/, '').replace('Group Stage', 'Swiss');
const wbPct = p => `${Math.round(p * 1000) / 10} %`.replace('.', ',');

async function wbCall(fn, args = {}) {
  const c = wbCfg();
  const headers = { apikey: c.key, 'content-type': 'application/json' };
  if (c.key.startsWith('eyJ')) headers.authorization = `Bearer ${c.key}`; // legacy anon JWT
  const res = await fetch(`${c.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.message || `Fehler ${res.status}`);
  return out;
}

// Readable names for the Polymarket market types.
const WB_PROPS = {
  lol_both_teams_baron: 'Beide Teams töten Baron?',
  lol_both_teams_dragon: 'Beide Teams holen einen Drachen?',
  lol_both_teams_inhibitors: 'Beide Teams zerstören einen Inhibitor?',
  lol_quadra_kill: 'Ein Quadra Kill?',
  lol_penta_kill: 'Ein Pentakill?',
  lol_odd_even_total_kills: 'Kills gesamt ungerade oder gerade?',
};
const WB_WORDS = { Yes: 'Ja', No: 'Nein', Over: 'Über', Under: 'Unter', Odd: 'Ungerade', Even: 'Gerade' };
function wbLabel(m) {
  const game = /Game (\d)/.exec(m.label)?.[1];
  if (m.kind === 'moneyline') return 'Sieger';
  if (m.kind === 'child_moneyline') return `Spiel ${game}: Sieger`;
  if (m.kind === 'totals') return `Anzahl Spiele (${/[\d.]+/.exec(m.label)?.[0] || ''})`;
  if (m.kind === 'map_handicap') return 'Handicap (Spiele)';
  if (WB_PROPS[m.kind]) return `${game ? `Spiel ${game}: ` : ''}${WB_PROPS[m.kind]}`;
  return m.label;
}
function wbOutcome(m, i) {
  const o = m.outcomes[i];
  if (m.kind === 'totals') return `${WB_WORDS[o] || o} ${/[\d.]+/.exec(m.label)?.[0] || ''}`;
  if (m.kind === 'map_handicap') {
    const h = [...m.label.matchAll(/\(([+-][\d.]+)\)/g)].map(x => x[1].replace('-', '−'));
    return `${o} ${h[i] || ''}`;
  }
  return WB_WORDS[o] || o;
}

const wbOpen = m => m.status === 'open' && Date.parse(m.starts_at) > Date.now() && m.odds?.every(x => x > 1);
const wbPlayer = name => WB.st?.players.find(p => p.name === name);
const wbBetsOf = id => (WB.st?.bets || []).filter(b => b.market_id === id);
const wbChance = m => { const a = 1 / m.odds[0], b = 1 / m.odds[1]; return a / (a + b); };
const wbBoardRows = () => WB.st.players.map((p, i) => ({ ...p, rank: i + 1, total: Number(p.cash) + Number(p.open) }));

// ---------- Rendering ----------

function renderWorlds() {
  const el = document.getElementById('tab-worlds');
  if (!el) return;
  if (!wbCfg()) {
    el.innerHTML = `<div class="wb"><h1 class="wb-title">Worlds Wetten</h1><div class="wb-panel wb-empty">Das Wettspiel wird gerade eingerichtet. Schau später nochmal vorbei.</div></div>`;
    return;
  }
  const st = WB.st;
  if (!st) { el.innerHTML = `<div class="wb"><h1 class="wb-title">Worlds Wetten</h1><p class="wb-muted">${WB.msg ? esc(WB.msg) : 'Lade Quoten…'}</p></div>`; return; }
  const s = st.settings;
  el.innerHTML = `<div class="wb">
    <div class="wb-bar">${wbAccount()}</div>
    <section class="wb-hero">
      <div class="wb-hero-text">
        <p class="wb-eyebrow">${esc(wbEyebrow())}</p>
        <h1 class="wb-title">Setz deine<br>Justus Bucks.</h1>
        <p class="wb-lede">${wbMoney(s.start_balance)} zum Start, jeden Tag ${wbMoney(s.daily)} dazu. Wette auf jedes Worlds-Match zu Polymarket-Quoten. Am ${wbDateShort(s.end_day)} gewinnt, wer das meiste Geld hat.</p>
        <ol class="wb-stages" aria-label="Turnier">${WB_STAGES.map(x => `<li class="${wbStageState(x)}">${x.name} · ${x.text}</li>`).join('')}</ol>
      </div>
      ${wbTop()}
    </section>
    <section class="wb-sec" aria-label="Alle Spiele">${wbMatches()}</section>
    <div class="wb-row">
      <section class="wb-panel" aria-label="Rangliste"><h2 class="wb-h">Rangliste</h2>${wbBoard()}</section>
      <section class="wb-panel" aria-label="Pick'Ems">${wbPicks()}</section>
    </div>
    <div class="wb-row">
      <section class="wb-panel" aria-label="Ergebnisse"><h2 class="wb-h">Ergebnisse</h2>${wbResults()}</section>
      <section class="wb-panel" aria-label="Wetten">${wbHistory()}</section>
    </div>
    <details class="wb-rules"><summary>Regeln</summary><ul>
      <li>Start: ${wbMoney(s.start_balance)}. Jeden Tag um Mitternacht kommen ${wbMoney(s.daily)} dazu, auch wenn du später einsteigst (zählt ab ${wbDateShort(s.start_day)}).</li>
      <li>Die Quote ist 1 ÷ Polymarket-Preis, ohne Buchmacher-Marge. Deine Quote wird beim Wetten festgeschrieben; Gewinn = Einsatz × Quote.</li>
      <li>Wetten schließen, wenn das Match laut Zeitplan beginnt. Es gibt nur Wetten, für die Polymarket gerade einen echten Preis hat; Spezialwetten tauchen oft erst kurz vor dem Spiel auf.</li>
      <li>Abgerechnet wird automatisch, sobald Polymarket das Ergebnis hat (meist 1–3 Stunden nach dem Spiel). Wird ein Spiel nicht gespielt (z. B. Spiel 4 bei 3:0), gibt es den Einsatz zurück.</li>
      <li>Pick'Ems kosten nichts: richtiger Weltmeister +${wbMoney(s.winner_bonus)}, jeder richtige Finalist +${wbMoney(s.finalist_bonus)}. Änderbar bis ${wbDay(s.picks_lock)}, ${wbTime(s.picks_lock)}.</li>
      <li>Rangliste = freies Geld + Geld in offenen Wetten. Kein echtes Geld. PIN vergessen? Sag Heino Bescheid.</li>
    </ul></details>
    ${wbSlip()}
  </div>`;
  wbWire(el);
}

const wbDateShort = d => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
function wbStageState(x) {
  const today = wbDayKey(Date.now());
  return today > x.to ? 'done' : today >= x.from || WB_STAGES.find(y => today <= y.to) === x ? 'now' : '';
}
function wbEyebrow() {
  const next = WB.st.markets.find(m => m.kind === 'moneyline' && wbOpen(m));
  return next ? `${wbStage(next.stage)} · nächstes Spiel ${wbDayShort(next.starts_at)} ${wbTime(next.starts_at)}`.toUpperCase() : 'WORLDS 2026';
}

function wbAccount() {
  const me = WB.me && wbPlayer(WB.me.name);
  if (WB.me && me) {
    const row = wbBoardRows().find(p => p.name === me.name);
    return `<p class="wb-muted">Platz <b>${row.rank}</b> von ${WB.st.players.length} · ${me.won} ${me.won === 1 ? 'Sieg' : 'Siege'}, ${me.lost} ${me.lost === 1 ? 'Niederlage' : 'Niederlagen'}</p>
      <div class="wb-wallet">
        <span class="wb-avatar" aria-hidden="true">${esc(me.name[0] || '?')}</span>
        <span class="wb-wallet-txt"><span class="wb-k">Justus Bucks · ${esc(me.name)}</span><b>${wbMoney(me.cash)}</b></span>
        ${Number(me.open) ? `<span class="wb-wallet-open">${wbMoney(me.open)} in Wetten</span>` : ''}
        <button type="button" class="wb-link" data-wb="logout">Ausloggen</button>
      </div>`;
  }
  return `<p class="wb-muted"><b>Mitspielen:</b> Name und PIN (4–8 Ziffern) ausdenken und registrieren, oder einloggen.</p>
    <form class="wb-login" autocomplete="on">
      <label class="wb-sr" for="wb-name">Name</label><input id="wb-name" name="name" placeholder="Name" maxlength="20" autocomplete="username" required>
      <label class="wb-sr" for="wb-pin">PIN</label><input id="wb-pin" name="pin" placeholder="PIN" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" type="password" autocomplete="current-password" required>
      <button class="wb-btn gold" data-wb="login">Einloggen</button><button class="wb-btn" data-wb="register">Registrieren</button>
      ${WB.msg && !WB.slip ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
    </form>`;
}

// The most open match of the next game day.
function wbTop() {
  const open = WB.st.markets.filter(m => m.kind === 'moneyline' && wbOpen(m));
  if (!open.length) return `<article class="wb-top wb-empty">Gerade keine offenen Spiele. Neue tauchen auf, sobald Polymarket sie anbietet.</article>`;
  const day = wbDayKey(open[0].starts_at);
  const m = open.filter(x => wbDayKey(x.starts_at) === day).sort((a, b) => Math.abs(wbChance(a) - .5) - Math.abs(wbChance(b) - .5))[0];
  const [a, b] = m.event_title.split(' vs '), pa = wbChance(m);
  const btn = i => `<button type="button" class="wb-bigodd ${WB.slip?.id === m.id && WB.slip.o === i ? 'on' : ''}" data-m="${esc(m.id)}" data-o="${i}" aria-label="${esc(m.outcomes[i])} gewinnt, Quote ${wbOdds(m.odds[i])}">${esc(wbAbbr(m.outcomes[i]))} gewinnt <b>${wbOdds(m.odds[i])}</b></button>`;
  return `<article class="wb-top" aria-label="Topspiel">
    <div class="wb-top-head"><span class="wb-eyebrow">Topspiel</span><span class="wb-muted">${wbDay(m.starts_at)} ${wbTime(m.starts_at)}${m.best_of ? ` · BO${m.best_of}` : ''}</span></div>
    <div class="wb-versus">
      <div><span class="wb-crest big a">${esc(wbAbbr(a))}</span><b>${esc(a)}</b></div>
      <span class="wb-vs">VS</span>
      <div><span class="wb-crest big b">${esc(wbAbbr(b))}</span><b>${esc(b || '')}</b></div>
    </div>
    <div class="wb-chance"><i class="a" style="width:${pa * 100}%"></i><i class="b" style="width:${(1 - pa) * 100}%"></i></div>
    <div class="wb-chance-txt"><span class="a">${wbPct(pa)} Siegchance</span><span class="b">${wbPct(1 - pa)} Siegchance</span></div>
    <div class="wb-bigodds">${btn(0)}${btn(1)}</div>
  </article>`;
}

function wbMatches() {
  const mls = WB.st.markets.filter(m => m.kind === 'moneyline' && m.status === 'open' && Date.parse(m.starts_at) > Date.now() - 8 * 3600e3);
  const head = '<h2 class="wb-h">Alle Spiele</h2>';
  if (!mls.length) return `${head}<div class="wb-panel wb-empty">Gerade keine offenen Spiele. Neue tauchen auf, sobald Polymarket sie anbietet.</div>`;
  const days = [...new Set(mls.map(m => wbDayKey(m.starts_at)))].slice(0, 6);
  if (!days.includes(WB.day)) WB.day = days[0];
  const list = mls.filter(m => wbDayKey(m.starts_at) === WB.day);
  return `<div class="wb-sec-head">${head}
      ${days.length > 1 ? `<div class="wb-seg" role="tablist" aria-label="Tag">${days.map(d => {
        const first = mls.find(m => wbDayKey(m.starts_at) === d);
        return `<button type="button" role="tab" data-day="${d}" aria-selected="${d === WB.day}">${wbDayShort(first.starts_at)}</button>`;
      }).join('')}</div>` : ''}</div>
    <div class="wb-tiles">${list.map(wbTile).join('')}</div>`;
}

function wbTile(ml) {
  const all = WB.st.markets.filter(m => m.event_id === ml.event_id);
  const extra = all.filter(m => m !== ml && (wbOpen(m) || wbBetsOf(m.id).length));
  const live = !wbOpen(ml);
  const score = /\|(\d+)-(\d+)\|/.exec(ml.score || '');
  const [a, b] = ml.event_title.split(' vs ');
  const bets = all.flatMap(m => wbBetsOf(m.id).map(x => ({ m, x })));
  const open = WB.open.has(ml.event_id);
  const team = (name, i) => `<div class="wb-team"><span class="wb-crest ${i ? 'b' : 'a'}">${esc(wbAbbr(name))}</span><span class="wb-name">${esc(name || '')}</span>
    ${live ? (score ? `<b class="wb-score">${score[i + 1]}</b>` : '') : wbOddBtn(ml, i)}</div>`;
  const pa = live ? null : wbChance(ml);
  const summary = !bets.length ? 'Noch keine Wetten'
    : bets.length === 1 ? `${esc(bets[0].x.name)} ${wbMoney(bets[0].x.stake)} auf ${esc(wbOutcome(bets[0].m, bets[0].x.outcome))}`
    : `${bets.length} Wetten · ${wbMoney(bets.reduce((n, y) => n + Number(y.x.stake), 0))}`;
  return `<article class="wb-tile ${live ? 'live' : ''}">
    <div class="wb-tile-top"><b>${wbTime(ml.starts_at)}</b><span>${live ? 'LÄUFT · WARTET AUF ERGEBNIS' : `${ml.best_of ? `BO${ml.best_of} · ` : ''}${esc(wbStage(ml.stage)).toUpperCase()}`}</span></div>
    ${team(a, 0)}
    ${pa == null ? '<div class="wb-chance thin"><i class="a" style="width:50%;opacity:.3"></i><i class="b" style="width:50%;opacity:.3"></i></div>'
      : `<div class="wb-chance thin" title="Siegchance ${wbPct(pa)} : ${wbPct(1 - pa)}"><i class="a" style="width:${pa * 100}%"></i><i class="b" style="width:${(1 - pa) * 100}%"></i></div>`}
    ${team(b, 1)}
    <div class="wb-tile-foot"><span>${summary}</span>
      ${extra.length || bets.length ? `<button type="button" class="wb-link" data-more="${esc(ml.event_id)}" aria-expanded="${open}">${open ? 'Weniger' : extra.length ? `+${extra.length} Spezialwetten` : 'Wer hat gewettet?'}</button>` : ''}</div>
    ${open ? `<div class="wb-more">
      ${extra.map(m => `<div class="wb-more-row"><span>${esc(wbLabel(m))}</span><div class="wb-more-odds">${wbOpen(m) ? m.outcomes.map((_, i) => wbOddBtn(m, i, true)).join('') : '<span class="wb-muted">geschlossen</span>'}</div></div>`).join('')}
      ${bets.length ? `<p class="wb-who">${bets.map(({ m, x }) => `<span class="${x.name === WB.me?.name ? 'me' : ''}">${esc(x.name)} <b>${wbMoney(x.stake)}</b> auf ${esc(m.kind === 'moneyline' ? wbOutcome(m, x.outcome) : wbLabel(m) + ' ' + wbOutcome(m, x.outcome))} @ ${wbOdds(x.odds)}</span>`).join('')}</p>` : ''}
    </div>` : ''}
  </article>`;
}

function wbOddBtn(m, i, small) {
  const on = WB.slip?.id === m.id && WB.slip.o === i;
  return `<button type="button" class="wb-odd ${small ? 'small' : ''} ${on ? 'on' : ''}" data-m="${esc(m.id)}" data-o="${i}" aria-pressed="${on}" aria-label="${esc(wbLabel(m))}: ${esc(wbOutcome(m, i))}, Quote ${wbOdds(m.odds[i])}">${small ? `<span>${esc(wbOutcome(m, i))}</span>` : ''}${wbOdds(m.odds[i])}</button>`;
}

function wbSlip() {
  const s = WB.slip;
  const m = s && WB.st.markets.find(x => x.id === s.id);
  if (!m || !wbOpen(m)) return '';
  const me = WB.me && wbPlayer(WB.me.name);
  const odds = m.odds[s.o];
  const what = `<div class="wb-slip-what"><span class="wb-k">Wettschein · ${esc(wbLabel(m))}</span><b>${esc(wbOutcome(m, s.o))} <em>@ ${wbOdds(odds)}</em></b><small>${esc(m.event_title)}</small></div>`;
  if (!me) {
    return `<div class="wb-slip" role="region" aria-label="Wettschein"><div class="wb-slip-in">${what}
      <p class="wb-muted">Zum Wetten oben einloggen oder registrieren.</p>
      <button type="button" class="wb-btn gold" data-wb="focus-login">Einloggen</button>
      <button type="button" class="wb-x" data-wb="cancel" aria-label="Wettschein schließen">×</button></div></div>`;
  }
  const stake = s.stake ?? Math.min(10, Math.floor(me.cash));
  const all = Math.floor(me.cash * 100) / 100;
  return `<div class="wb-slip" role="region" aria-label="Wettschein"><form class="wb-slip-in" data-m="${esc(m.id)}">${what}
    <div class="wb-stake">
      <label for="wb-stake">Einsatz $</label>
      <input id="wb-stake" name="stake" type="number" min="1" step="0.01" max="${all}" value="${stake}" required>
      ${[5, 10, 25].filter(x => x <= me.cash).map(x => `<button type="button" class="wb-chip" data-stake="${x}">$${x}</button>`).join('')}
      <button type="button" class="wb-chip" data-stake="${all}">All-in</button>
    </div>
    <div class="wb-slip-go">
      <div class="wb-payout"><span class="wb-k">Gewinn</span><b class="wb-win">${wbMoney(Math.round(stake * odds * 100) / 100)}</b></div>
      <button class="wb-btn gold big" ${WB.busy ? 'disabled' : ''}>Wetten · <span class="wb-cta">${wbMoney(stake)}</span></button>
    </div>
    <button type="button" class="wb-x" data-wb="cancel" aria-label="Wettschein schließen">×</button>
    ${WB.msg ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
  </form></div>`;
}

function wbBoard() {
  const rows = wbBoardRows();
  if (!rows.length) return '<p class="wb-muted">Noch niemand dabei. Sei der Erste!</p>';
  const meName = WB.me?.name;
  const sub = p => `${p.won}–${p.lost}${Number(p.bonus) ? ` · +${wbMoney(p.bonus)} Pick'Ems` : ''}`;
  const pod = [rows[1], rows[0], rows[2]].filter(Boolean);
  const rest = rows.slice(3), shown = WB.boardAll ? rest : rest.slice(0, 5);
  return `<div class="wb-podium" style="grid-template-columns:repeat(${pod.length},minmax(0,1fr))">${pod.map(p => `<div class="wb-pod r${p.rank} ${p.name === meName ? 'me' : ''}">
      <b class="wb-pod-name">${esc(p.name)}</b><span class="wb-pod-money">${wbMoney(p.total)}</span><small>${sub(p)}</small>
      <div class="wb-pod-step">${p.rank}</div></div>`).join('')}</div>
    ${shown.length ? `<ol class="wb-list">${shown.map(p => `<li class="${p.name === meName ? 'me' : ''}"><span><b class="wb-rank">${p.rank}</b>${esc(p.name)} <small>${sub(p)}</small></span><span class="wb-money">${wbMoney(p.total)}</span></li>`).join('')}</ol>` : ''}
    ${rest.length > 5 ? `<button type="button" class="wb-link" data-wb="board-all">${WB.boardAll ? 'Weniger anzeigen' : `Alle ${rows.length} anzeigen`}</button>` : ''}`;
}

function wbPicks() {
  const s = WB.st.settings, teams = WB.st.teams;
  const locked = Date.now() >= Date.parse(s.picks_lock);
  const me = WB.me && wbPlayer(WB.me.name);
  const mine = me?.picks || {};
  const winner = WB.pickMode === 'winner';
  const chosen = t => winner ? mine.winner1 === t : mine.finalist1 === t || mine.finalist2 === t;
  const price = t => winner ? t.win_price : t.final_price;
  const max = Math.max(...teams.map(t => Number(price(t)) || 0), .01);
  // Favourites first; the long tail only on request (your own picks always stay visible).
  const alive = teams.filter(t => !t.out || chosen(t.team)).sort((a, b) => (Number(price(b)) || 0) - (Number(price(a)) || 0));
  const list = WB.teamsAll ? alive : alive.filter((t, i) => i < 8 || chosen(t.team));
  const mark = (t, key) => { const x = teams.find(y => y.team === t); return x?.[key] ? ' ✓' : x?.[key] === false || x?.out ? ' ✗' : ''; };
  const others = WB.st.players.filter(p => p.picks);
  return `<div class="wb-sec-head"><h2 class="wb-h">Pick'Ems</h2><span class="wb-muted">gratis · ${locked ? 'gesperrt' : `änderbar bis ${wbDayShort(s.picks_lock)}`}</span></div>
    <div class="wb-seg" role="tablist" aria-label="Tipp">
      <button type="button" role="tab" data-pmode="winner" aria-selected="${winner}">Weltmeister +${wbMoney(s.winner_bonus)}</button>
      <button type="button" role="tab" data-pmode="finalist" aria-selected="${!winner}">Finalisten +${wbMoney(s.finalist_bonus)} je</button>
    </div>
    <p class="wb-muted">${winner ? 'Wer wird Weltmeister?' : 'Welche zwei Teams stehen im Finale?'} ${me ? '' : 'Zum Tippen einloggen.'} Balken = Chance laut Polymarket.</p>
    <div class="wb-picks">${list.map(t => `<button type="button" class="wb-pick ${chosen(t.team) ? 'on' : ''}" data-team="${esc(t.team)}" aria-pressed="${chosen(t.team)}" ${!me || locked ? 'disabled' : ''}>
        <span class="wb-dot" aria-hidden="true"></span><span class="wb-name">${esc(t.team)}</span>
        <span class="wb-pbar" aria-hidden="true"><i style="width:${Math.round((Number(price(t)) || 0) / max * 100)}%"></i></span>
        <span class="wb-ppct">${price(t) == null ? '–' : wbPct(Number(price(t)))}</span></button>`).join('')}</div>
    ${alive.length > 8 ? `<button type="button" class="wb-link wb-more-teams" data-wb="teams-all">${WB.teamsAll ? 'Nur Favoriten zeigen' : `Alle ${alive.length} Teams zeigen`}</button>` : ''}
    ${others.length ? `<details class="wb-others"><summary>Tipps der anderen (${others.length})</summary><ul>${others.map(p => `<li class="${p.name === WB.me?.name ? 'me' : ''}"><b>${esc(p.name)}</b>
      <span>Weltmeister: ${p.picks.winner1 ? esc(p.picks.winner1) + mark(p.picks.winner1, 'won') : '–'}</span>
      <span>Finale: ${[p.picks.finalist1, p.picks.finalist2].filter(Boolean).map(t => esc(t) + mark(t, 'finalist')).join(', ') || '–'}</span></li>`).join('')}</ul></details>` : ''}`;
}

function wbResults() {
  const done = WB.st.markets.filter(m => m.kind === 'moneyline' && m.status !== 'open').reverse().slice(0, 10);
  if (!done.length) return '<p class="wb-muted">Noch keine Ergebnisse.</p>';
  return `<ul class="wb-res">${done.map(m => {
    const score = /\|(\d+)-(\d+)\|/.exec(m.score || '');
    const [a, b] = m.event_title.split(' vs ');
    const bets = WB.st.markets.filter(x => x.event_id === m.event_id).flatMap(x => wbBetsOf(x.id));
    const net = {};
    for (const x of bets) if (x.status !== 'open') net[x.name] = (net[x.name] || 0) + Number(x.payout) - Number(x.stake);
    return `<li><div class="wb-res-line"><span class="${m.result === 0 ? 'w' : ''}">${esc(a)}</span><b>${score ? `${score[1]}:${score[2]}` : 'vs'}</b><span class="${m.result === 1 ? 'w' : ''}">${esc(b || '')}</span></div>
      <small class="wb-muted">${wbDay(m.starts_at)}${m.status === 'void' ? ' · abgesagt, Einsätze zurück' : ''}</small>
      ${Object.keys(net).length ? `<p class="wb-who">${Object.entries(net).sort((x, y) => y[1] - x[1]).map(([n, v]) => `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${esc(n)} ${v > 0 ? '+' : v < 0 ? '−' : '±'}${wbMoney(Math.abs(v))}</span>`).join('')}</p>` : ''}</li>`;
  }).join('')}</ul>`;
}

function wbHistory() {
  const mine = WB.me && WB.histMine;
  const bets = WB.st.bets.filter(b => !mine || b.name === WB.me.name).slice(0, 40);
  const byId = new Map(WB.st.markets.map(m => [m.id, m]));
  const st = { open: 'offen', won: 'gewonnen', lost: 'verloren', void: 'zurück' };
  return `<div class="wb-sec-head"><h2 class="wb-h">Wetten</h2>${WB.me ? `<div class="wb-seg" role="tablist" aria-label="Wetten"><button type="button" role="tab" data-hist="mine" aria-selected="${!!mine}">Meine</button><button type="button" role="tab" data-hist="all" aria-selected="${!mine}">Alle</button></div>` : ''}</div>
    ${bets.length ? `<ul class="wb-hist">${bets.map(b => {
      const m = byId.get(b.market_id);
      const what = m ? `${m.kind === 'moneyline' ? '' : esc(wbLabel(m)) + ' '}<b>${esc(wbOutcome(m, b.outcome))}</b>` : '?';
      const res = b.status === 'won' ? `<span class="up">+${wbMoney(b.payout - b.stake)}</span>` : b.status === 'lost' ? `<span class="down">−${wbMoney(b.stake)}</span>` : `<span class="wb-muted">${st[b.status]}</span>`;
      return `<li><div>${mine ? '' : `<b>${esc(b.name)}</b> · `}<span class="wb-muted">${m ? esc(m.event_title) : ''}</span><br>${what} @ ${wbOdds(b.odds)} · ${wbMoney(b.stake)}</div>${res}</li>`;
    }).join('')}</ul>` : `<p class="wb-muted">${mine ? 'Du hast noch nicht gewettet.' : 'Noch keine Wetten.'}</p>`}`;
}

// ---------- Actions ----------

function wbWire(el) {
  el.querySelectorAll('[data-m][data-o]').forEach(b => b.addEventListener('click', () => {
    const same = WB.slip?.id === b.dataset.m && WB.slip.o === Number(b.dataset.o);
    WB.slip = same ? null : { id: b.dataset.m, o: Number(b.dataset.o) };
    WB.msg = null; renderWorlds();
    if (WB.slip) el.querySelector('#wb-stake')?.focus({ preventScroll: true });
  }));
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => { WB.day = b.dataset.day; renderWorlds(); }));
  el.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.more; WB.open.has(id) ? WB.open.delete(id) : WB.open.add(id); renderWorlds();
  }));
  el.querySelectorAll('[data-wb="cancel"]').forEach(b => b.addEventListener('click', () => { WB.slip = null; WB.msg = null; renderWorlds(); }));
  el.querySelectorAll('[data-wb="focus-login"]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault(); const f = el.querySelector('.wb-login input'); f?.scrollIntoView({ behavior: 'smooth', block: 'center' }); f?.focus({ preventScroll: true });
  }));
  el.querySelector('[data-wb="board-all"]')?.addEventListener('click', () => { WB.boardAll = !WB.boardAll; renderWorlds(); });
  el.querySelector('[data-wb="teams-all"]')?.addEventListener('click', () => { WB.teamsAll = !WB.teamsAll; renderWorlds(); });
  el.querySelector('[data-wb="logout"]')?.addEventListener('click', async () => {
    const t = WB.me?.token; wbSaveMe(null); WB.slip = null; WB.msg = null; renderWorlds();
    try { await wbCall('wb_logout', { p_token: t }); } catch {}
  });
  const login = el.querySelector('.wb-login');
  login?.addEventListener('submit', e => e.preventDefault());
  login?.querySelectorAll('[data-wb]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault();
    if (!login.reportValidity()) return;
    const f = new FormData(login);
    try {
      const r = await wbCall(b.dataset.wb === 'register' ? 'wb_register' : 'wb_login', { p_name: f.get('name'), p_pin: f.get('pin') });
      if (r.error) { WB.msg = r.error; renderWorlds(); return; }
      wbSaveMe({ token: r.token, name: r.name }); WB.msg = null;
      await wbLoad(true);
    } catch (err) { WB.msg = err.message; renderWorlds(); }
  }));
  const slip = el.querySelector('form.wb-slip-in');
  if (slip) {
    const input = slip.querySelector('input[name="stake"]'), win = slip.querySelector('.wb-win'), cta = slip.querySelector('.wb-cta');
    const m = WB.st.markets.find(x => x.id === slip.dataset.m);
    const update = () => {
      WB.slip.stake = input.value;
      win.textContent = wbMoney(Math.round((Number(input.value) || 0) * m.odds[WB.slip.o] * 100) / 100);
      cta.textContent = wbMoney(Number(input.value) || 0);
    };
    input.addEventListener('input', update);
    slip.querySelectorAll('[data-stake]').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.stake; update(); }));
    slip.addEventListener('submit', async e => {
      e.preventDefault();
      if (WB.busy) return;
      WB.busy = true;
      const stake = Number(input.value), odds = m.odds[WB.slip.o];
      try {
        const r = await wbCall('wb_bet', { p_token: WB.me.token, p_market: m.id, p_outcome: WB.slip.o, p_stake: stake, p_odds: odds });
        if (r.relogin) wbSaveMe(null);
        if (r.error) { WB.msg = r.error; await wbLoad(true); return; }
        WB.slip = null; WB.msg = null;
        await wbLoad(true);
        wbToast(`Wette gesetzt: ${wbMoney(stake)} @ ${wbOdds(odds)}`);
      } catch (err) { WB.msg = err.message; renderWorlds(); }
      finally { WB.busy = false; }
    });
  }
  el.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => { WB.pickMode = b.dataset.pmode; renderWorlds(); }));
  el.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', async () => {
    const me = wbPlayer(WB.me?.name), mine = me?.picks || {}, team = b.dataset.team;
    let slot = 1, value = team;
    if (WB.pickMode === 'winner') value = mine.winner1 === team ? null : team;
    else if (mine.finalist1 === team) value = null;
    else if (mine.finalist2 === team) { slot = 2; value = null; }
    else if (!mine.finalist1) slot = 1;
    else if (!mine.finalist2) slot = 2;
    else { alert('Du hast schon zwei Finalisten. Tipp erst einen an, um ihn abzuwählen.'); return; }
    try {
      const r = await wbCall('wb_pick', { p_token: WB.me.token, p_kind: WB.pickMode, p_slot: slot, p_team: value });
      if (r.relogin) wbSaveMe(null);
      if (r.error) alert(r.error); else wbToast(value ? `Tipp gespeichert: ${value}` : 'Tipp entfernt');
    } catch (err) { alert(err.message); }
    await wbLoad(true);
  }));
  el.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => { WB.histMine = b.dataset.hist === 'mine'; renderWorlds(); }));
}

function wbToast(text) {
  const t = document.createElement('div');
  t.className = 'wb-toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function wbLoad(force) {
  if (!wbCfg()) { renderWorlds(); return; }
  try {
    WB.st = await wbCall('wb_state');
    if (WB.me && !wbPlayer(WB.me.name)) wbSaveMe(null); // account was removed
  } catch (err) { if (!WB.st) WB.msg = 'Konnte das Wettspiel nicht laden: ' + err.message; }
  // Keep a half-typed stake or login while the page refreshes in the background.
  const typing = !force && document.activeElement?.matches?.('#tab-worlds input, #tab-worlds select');
  if (!typing) renderWorlds();
}

// Called by showTab() whenever the Worlds tab opens; refreshes every minute while visible.
function openWorlds() {
  const start = () => {
    wbLoad();
    clearInterval(WB.timer);
    WB.timer = setInterval(() => { if (!document.getElementById('tab-worlds').hidden && !document.hidden) wbLoad(); }, 60_000);
  };
  if (typeof data !== 'undefined' && data) start();
  else { renderWorlds(); const wait = setInterval(() => { if (typeof data !== 'undefined' && data) { clearInterval(wait); start(); } }, 200); }
}
