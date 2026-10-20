// Worlds betting game ("Justus Bucks"): the #worlds tab.
// Everything is stored in Supabase (supabase/worlds.sql) and reached only through its wb_*
// functions; the odds come from Polymarket via scripts/worlds.mjs. The connection (project
// URL + publishable key, both public) is in squad.config.json → data.json → data.worlds.
const WB = { st: null, me: null, slip: null, msg: null, histMine: true, timer: null, busy: false };
const WB_TZ = 'Europe/Berlin';

try { WB.me = JSON.parse(localStorage.getItem('wb-auth') || 'null'); } catch { WB.me = null; }
const wbSaveMe = me => { WB.me = me; try { me ? localStorage.setItem('wb-auth', JSON.stringify(me)) : localStorage.removeItem('wb-auth'); } catch {} };

const wbCfg = () => (typeof data !== 'undefined' && data?.worlds?.url && data?.worlds?.key) ? data.worlds : null;
const wbMoney = n => '$' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const wbOdds = n => Number(n).toFixed(2);
const wbDay = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
const wbTime = t => new Date(t).toLocaleTimeString('de-DE', { timeZone: WB_TZ, hour: '2-digit', minute: '2-digit' });
const wbStage = s => (s || '').replace(/^Worlds\s*/, '').replace('Group Stage', 'Swiss Stage');

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

// ---------- Rendering ----------

function renderWorlds() {
  const el = document.getElementById('tab-worlds');
  if (!el) return;
  if (!wbCfg()) {
    el.innerHTML = `<h2>Worlds Wetten</h2><div class="gd-empty">Das Wettspiel wird gerade eingerichtet. Schau später nochmal vorbei.</div>`;
    return;
  }
  const st = WB.st;
  if (!st) { el.innerHTML = `<h2>Worlds Wetten</h2><p class="meta">${WB.msg ? esc(WB.msg) : 'Lade Quoten…'}</p>`; return; }
  const s = st.settings;
  el.innerHTML = `
    <div class="wb-top">
      <div>
        <h2>Worlds Wetten 🏆</h2>
        <p class="lede">Wette mit <b>Justus Bucks</b> (kein echtes Geld) auf die Spiele der Worlds. Jeder startet mit ${wbMoney(s.start_balance)} und bekommt jeden Tag ${wbMoney(s.daily)} dazu, bis zum Finale am ${new Date(s.end_day + 'T12:00:00Z').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}. Die Quoten kommen live von Polymarket. Wer am Ende das meiste Geld hat, gewinnt.</p>
      </div>
      <div class="wb-acct" id="wb-acct">${wbAccount()}</div>
    </div>
    <div class="wb-grid">
      <section style="margin-top:0"><h3 class="wb-h">Nächste Spiele</h3>${wbMatches()}</section>
      <div>
        <section style="margin-top:0"><h3 class="wb-h">Rangliste</h3>${wbBoard()}</section>
        <section><h3 class="wb-h">Gratis-Tipps</h3>${wbPicks()}</section>
      </div>
    </div>
    <div class="wb-grid">
      <section><h3 class="wb-h">Ergebnisse</h3>${wbResults()}</section>
      <section><h3 class="wb-h">Wetten</h3>${wbHistory()}</section>
    </div>
    <details class="dig"><summary>Regeln</summary><ul class="brules">
      <li>Start: ${wbMoney(s.start_balance)}. Jeden Tag um Mitternacht kommen ${wbMoney(s.daily)} dazu, auch wenn du später einsteigst (zählt ab ${new Date(s.start_day + 'T12:00:00Z').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}).</li>
      <li>Die Quote ist 1 ÷ Polymarket-Preis, ohne Buchmacher-Marge. Deine Quote wird beim Wetten festgeschrieben; Gewinn = Einsatz × Quote.</li>
      <li>Wetten schließen, wenn das Match laut Zeitplan beginnt. Es gibt nur Wetten, für die Polymarket gerade einen echten Preis hat; Spezialwetten tauchen oft erst kurz vor dem Spiel auf.</li>
      <li>Abgerechnet wird automatisch, sobald Polymarket das Ergebnis hat (meist 1–3 Stunden nach dem Spiel). Wird ein Spiel nicht gespielt (z. B. Spiel 4 bei 3:0), gibt es den Einsatz zurück.</li>
      <li>Gratis-Tipps kosten nichts: richtiger Weltmeister +${wbMoney(s.winner_bonus)}, jeder richtige Finalist +${wbMoney(s.finalist_bonus)}. Änderbar bis ${wbDay(s.picks_lock)}, ${wbTime(s.picks_lock)}.</li>
      <li>Rangliste = freies Geld + Geld in offenen Wetten. PIN vergessen? Sag Heino Bescheid.</li>
    </ul></details>`;
  wbWire(el);
}

function wbAccount() {
  const me = WB.me && wbPlayer(WB.me.name);
  if (WB.me && me) {
    return `<p class="wb-hi">Eingeloggt als <b>${esc(me.name)}</b> · <button type="button" class="linkish" data-wb="logout">Ausloggen</button></p>
      <p class="wb-cash">${wbMoney(me.cash)}</p>
      <p class="hint">frei zum Wetten${Number(me.open) ? ` · ${wbMoney(me.open)} in offenen Wetten` : ''}</p>`;
  }
  return `<form class="wb-login" autocomplete="on">
      <p class="wb-hi"><b>Mitspielen</b>: Name und PIN (4–8 Ziffern) ausdenken und registrieren, oder einloggen.</p>
      <div class="wb-fields">
        <input name="name" placeholder="Name" maxlength="20" autocomplete="username" required>
        <input name="pin" placeholder="PIN" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" type="password" autocomplete="current-password" required>
      </div>
      <div class="wb-btns"><button class="btn" data-wb="login">Einloggen</button><button class="btn wb-ghost" data-wb="register">Registrieren</button></div>
      ${WB.msg ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
    </form>`;
}

function wbMatches() {
  const mls = WB.st.markets.filter(m => m.kind === 'moneyline' && m.status === 'open' && Date.parse(m.starts_at) > Date.now() - 8 * 3600e3);
  if (!mls.length) return '<div class="gd-empty">Gerade keine offenen Spiele. Neue Spiele tauchen auf, sobald Polymarket sie anbietet.</div>';
  let day = '';
  return mls.map(m => {
    const head = wbDay(m.starts_at) !== day ? `<h4 class="wb-day">${esc(day = wbDay(m.starts_at))}</h4>` : '';
    return head + wbMatch(m);
  }).join('');
}

function wbMatch(ml) {
  const all = WB.st.markets.filter(m => m.event_id === ml.event_id);
  const extra = all.filter(m => m !== ml && (wbOpen(m) || wbBetsOf(m.id).length));
  const live = Date.parse(ml.starts_at) <= Date.now();
  const score = /\|(\d+)-(\d+)\|/.exec(ml.score || '');
  const teams = ml.event_title.split(' vs ');
  return `<article class="wb-match">
    <div class="wb-mhead"><span><b>${wbTime(ml.starts_at)}</b> · ${esc(wbStage(ml.stage))}${ml.best_of ? ` · BO${ml.best_of}` : ''}</span>
      ${live ? `<span class="wb-live">${score ? `${score[1]}:${score[2]} · ` : ''}läuft / wartet auf Ergebnis</span>` : ''}</div>
    ${live ? `<p class="wb-teams">${esc(teams[0])} <span class="wb-vs">vs</span> ${esc(teams[1] || '')}</p>` : `<div class="wb-odds">${wbButtons(ml, true)}</div>`}
    ${wbSlipFor(ml)}
    ${wbWho([ml])}
    ${extra.length ? `<details class="wb-more" ${extra.some(m => WB.slip?.id === m.id) ? 'open' : ''}><summary>${extra.length} weitere ${extra.length === 1 ? 'Wette' : 'Wetten'}</summary>
      ${extra.map(m => `<div class="wb-row"><span class="wb-q">${esc(wbLabel(m))}</span><div class="wb-odds small">${wbOpen(m) ? wbButtons(m) : '<span class="hint">geschlossen</span>'}</div>${wbSlipFor(m)}</div>`).join('')}
      ${wbWho(extra)}</details>` : ''}
  </article>`;
}

function wbButtons(m, big) {
  if (!wbOpen(m)) return '<span class="hint">Gerade keine Quote</span>';
  return m.outcomes.map((o, i) => `${big && i ? '<span class="wb-vs">vs</span>' : ''}<button type="button" class="wb-odd ${WB.slip?.id === m.id && WB.slip.o === i ? 'on' : ''}" data-m="${esc(m.id)}" data-o="${i}">
    <span>${esc(wbOutcome(m, i))}</span><b>${wbOdds(m.odds[i])}</b></button>`).join('');
}

function wbSlipFor(m) {
  const s = WB.slip;
  if (!s || s.id !== m.id) return '';
  const me = WB.me && wbPlayer(WB.me.name);
  const odds = m.odds[s.o];
  if (!me) return `<div class="wb-slip"><p><b>${esc(wbOutcome(m, s.o))}</b> @ ${wbOdds(odds)}</p><p>Zum Wetten erst oben <a href="#worlds" data-wb="focus-login">einloggen oder registrieren</a>.</p></div>`;
  const stake = s.stake ?? Math.min(10, Math.floor(me.cash));
  return `<form class="wb-slip" data-m="${esc(m.id)}">
    <p class="wb-slip-what">${m.kind === 'moneyline' ? '' : esc(wbLabel(m)) + ' · '}<b>${esc(wbOutcome(m, s.o))}</b> @ <b>${wbOdds(odds)}</b></p>
    <div class="wb-stake"><label>Einsatz $ <input name="stake" type="number" min="1" step="0.01" max="${Math.floor(me.cash * 100) / 100}" value="${stake}" required></label>
      ${[5, 10, 25].filter(x => x <= me.cash).map(x => `<button type="button" class="chip" data-stake="${x}">${x}</button>`).join('')}
      <button type="button" class="chip" data-stake="${Math.floor(me.cash * 100) / 100}">All-in</button></div>
    <p>Möglicher Gewinn: <b class="wb-win">${wbMoney(Math.round(stake * odds * 100) / 100)}</b> <span class="hint">(du hast ${wbMoney(me.cash)})</span></p>
    <div class="wb-btns"><button class="btn" ${WB.busy ? 'disabled' : ''}>Wette setzen</button><button type="button" class="btn wb-ghost" data-wb="cancel">Abbrechen</button></div>
    ${WB.msg ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
  </form>`;
}

// Who bet what on these markets.
function wbWho(ms) {
  const rows = ms.flatMap(m => wbBetsOf(m.id).map(b => ({ m, b })));
  if (!rows.length) return '';
  return `<p class="wb-who">${rows.map(({ m, b }) => `<span class="${b.name === WB.me?.name ? 'me' : ''}">${esc(b.name)} <b>${wbMoney(b.stake)}</b> auf ${esc(m.kind === 'moneyline' ? wbOutcome(m, b.outcome) : wbLabel(m) + ' ' + wbOutcome(m, b.outcome))} @ ${wbOdds(b.odds)}</span>`).join('')}</p>`;
}

function wbBoard() {
  const ps = WB.st.players;
  if (!ps.length) return '<div class="gd-empty">Noch niemand dabei. Sei der Erste!</div>';
  return `<ol class="wb-board">${ps.map((p, i) => {
    const total = Number(p.cash) + Number(p.open);
    return `<li class="${p.name === WB.me?.name ? 'me' : ''}"><span class="wb-rank">${i + 1}</span><span class="wb-name">${esc(p.name)}<small>${p.won}–${p.lost}${Number(p.open) ? ` · ${wbMoney(p.open)} offen` : ''}${Number(p.bonus) ? ` · +${wbMoney(p.bonus)} Tipps` : ''}</small></span><b>${wbMoney(total)}</b></li>`;
  }).join('')}</ol>`;
}

function wbPicks() {
  const s = WB.st.settings, teams = WB.st.teams;
  const locked = Date.now() >= Date.parse(s.picks_lock);
  const me = WB.me && wbPlayer(WB.me.name);
  const pct = p => p == null ? '' : ` (${Math.round(p * 1000) / 10} %)`;
  const sel = (kind, slot, price) => {
    const cur = me?.picks?.[kind + slot] || '';
    return `<select data-pick="${kind}" data-slot="${slot}" ${locked ? 'disabled' : ''}><option value="">– Team wählen –</option>
      ${teams.filter(t => !t.out || t.team === cur).map(t => `<option value="${esc(t.team)}" ${t.team === cur ? 'selected' : ''}>${esc(t.team)}${pct(t[price])}</option>`).join('')}</select>`;
  };
  const mark = (t, key) => { const x = teams.find(y => y.team === t); return x?.[key] ? ' ✓' : x?.[key] === false || x?.out ? ' ✗' : ''; };
  const others = WB.st.players.filter(p => p.picks);
  return `<p class="hint" style="margin-top:0">Kostet nichts. Richtiger Weltmeister <b>+${wbMoney(s.winner_bonus)}</b>, jeder richtige Finalist <b>+${wbMoney(s.finalist_bonus)}</b>. ${locked ? 'Gesperrt seit' : 'Änderbar bis'} ${wbDay(s.picks_lock)}, ${wbTime(s.picks_lock)}. In Klammern: Chance laut Polymarket.</p>
    ${me ? `<div class="wb-picks">
      <label>🏆 Weltmeister ${sel('winner', 1, 'win_price')}</label>
      <label>Finalist 1 ${sel('finalist', 1, 'final_price')}</label>
      <label>Finalist 2 ${sel('finalist', 2, 'final_price')}</label></div>` : '<p class="hint">Einloggen, um zu tippen.</p>'}
    ${others.length ? `<table class="wb-ptable"><thead><tr><th>Spieler</th><th>Weltmeister</th><th>Finalisten</th></tr></thead><tbody>
      ${others.map(p => `<tr class="${p.name === WB.me?.name ? 'me' : ''}"><td>${esc(p.name)}</td><td>${p.picks.winner1 ? esc(p.picks.winner1) + mark(p.picks.winner1, 'won') : '–'}</td>
        <td>${[p.picks.finalist1, p.picks.finalist2].filter(Boolean).map(t => esc(t) + mark(t, 'finalist')).join(', ') || '–'}</td></tr>`).join('')}</tbody></table>` : ''}`;
}

function wbResults() {
  const done = WB.st.markets.filter(m => m.kind === 'moneyline' && m.status !== 'open').reverse().slice(0, 12);
  if (!done.length) return '<div class="gd-empty">Noch keine Ergebnisse.</div>';
  return `<ul class="wb-res">${done.map(m => {
    const score = /\|(\d+)-(\d+)\|/.exec(m.score || '');
    const [a, b] = m.event_title.split(' vs ');
    const bets = WB.st.markets.filter(x => x.event_id === m.event_id).flatMap(x => wbBetsOf(x.id));
    const net = {};
    for (const x of bets) if (x.status !== 'open') net[x.name] = (net[x.name] || 0) + Number(x.payout) - Number(x.stake);
    return `<li><div><span class="${m.result === 0 ? 'w' : ''}">${esc(a)}</span> ${score ? `<b>${score[1]}:${score[2]}</b>` : 'vs'} <span class="${m.result === 1 ? 'w' : ''}">${esc(b || '')}</span>
      <small>${wbDay(m.starts_at)}${m.status === 'void' ? ' · abgesagt, Einsätze zurück' : ''}</small></div>
      ${Object.keys(net).length ? `<p class="wb-who">${Object.entries(net).sort((x, y) => y[1] - x[1]).map(([n, v]) => `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${esc(n)} ${v > 0 ? '+' : v < 0 ? '−' : '±'}${wbMoney(Math.abs(v))}</span>`).join('')}</p>` : ''}</li>`;
  }).join('')}</ul>`;
}

function wbHistory() {
  const mine = WB.me && WB.histMine;
  const bets = WB.st.bets.filter(b => !mine || b.name === WB.me.name).slice(0, 40);
  const byId = new Map(WB.st.markets.map(m => [m.id, m]));
  const st = { open: 'offen', won: 'gewonnen', lost: 'verloren', void: 'zurück' };
  return `${WB.me ? `<div class="wtabs"><button type="button" data-hist="mine" aria-pressed="${!!mine}">Meine</button><button type="button" data-hist="all" aria-pressed="${!mine}">Alle</button></div>` : ''}
    ${bets.length ? `<ul class="wb-hist">${bets.map(b => {
      const m = byId.get(b.market_id);
      const what = m ? `${m.kind === 'moneyline' ? '' : esc(wbLabel(m)) + ' '}<b>${esc(wbOutcome(m, b.outcome))}</b>` : '?';
      const res = b.status === 'won' ? `<span class="up">+${wbMoney(b.payout - b.stake)}</span>` : b.status === 'lost' ? `<span class="down">−${wbMoney(b.stake)}</span>` : `<span class="hint">${st[b.status]}</span>`;
      return `<li><div>${mine ? '' : `<b>${esc(b.name)}</b> · `}${m ? esc(m.event_title) : ''}<br>${what} @ ${wbOdds(b.odds)} · ${wbMoney(b.stake)}</div>${res}</li>`;
    }).join('')}</ul>` : `<p class="hint">${mine ? 'Du hast noch nicht gewettet.' : 'Noch keine Wetten.'}</p>`}`;
}

// ---------- Actions ----------

function wbWire(el) {
  el.querySelectorAll('.wb-odd').forEach(b => b.addEventListener('click', () => {
    const same = WB.slip?.id === b.dataset.m && WB.slip.o === Number(b.dataset.o);
    WB.slip = same ? null : { id: b.dataset.m, o: Number(b.dataset.o) };
    WB.msg = null; renderWorlds();
    if (WB.slip) el.querySelector('.wb-slip input')?.focus({ preventScroll: true });
  }));
  el.querySelectorAll('[data-wb="cancel"]').forEach(b => b.addEventListener('click', () => { WB.slip = null; WB.msg = null; renderWorlds(); }));
  el.querySelectorAll('[data-wb="focus-login"]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault(); const f = document.querySelector('.wb-login input'); f?.scrollIntoView({ behavior: 'smooth', block: 'center' }); f?.focus({ preventScroll: true });
  }));
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
  el.querySelectorAll('form.wb-slip').forEach(form => {
    const input = form.querySelector('input[name="stake"]'), win = form.querySelector('.wb-win');
    const m = WB.st.markets.find(x => x.id === form.dataset.m);
    const update = () => { WB.slip.stake = input.value; win.textContent = wbMoney(Math.round((Number(input.value) || 0) * m.odds[WB.slip.o] * 100) / 100); };
    input.addEventListener('input', update);
    form.querySelectorAll('[data-stake]').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.stake; update(); }));
    form.addEventListener('submit', async e => {
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
  });
  el.querySelectorAll('select[data-pick]').forEach(s => s.addEventListener('change', async () => {
    try {
      const r = await wbCall('wb_pick', { p_token: WB.me.token, p_kind: s.dataset.pick, p_slot: Number(s.dataset.slot), p_team: s.value || null });
      if (r.relogin) wbSaveMe(null);
      if (r.error) alert(r.error); else wbToast('Tipp gespeichert');
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
  // Keep a half-typed stake while the page refreshes in the background.
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
