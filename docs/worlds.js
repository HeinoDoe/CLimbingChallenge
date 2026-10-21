// Worlds Tippspiel (like Kicktipp): the #worlds tab, "Summoner's Cup" look.
// Everything is stored in Supabase (supabase/worlds.sql) and reached only through its wb_*
// functions; schedule, odds and results come from Polymarket via scripts/worlds.mjs. The
// connection (project URL + publishable key, both public) is in squad.config.json →
// data.json → data.worlds.
//
// Layout: one game day at a time as a compact table (time, match with your tip buttons,
// one column per player), a small sidebar with account and leaderboard, bonus questions below.
const WB = { st: null, me: null, msg: null, timer: null, busy: false, day: null, kind: null, teamsAll: false };
const WB_TZ = 'Europe/Berlin';
const WB_ABBR = {
  'Gen.G': 'GEN', T1: 'T1', 'Hanwha Life Esports': 'HLE', 'Dplus KIA': 'DK', 'Bilibili Gaming': 'BLG', 'Top Esports': 'TES',
  'Invictus Gaming': 'IG', "Anyone's Legend": 'AL', 'G2 Esports': 'G2', 'Karmine Corp': 'KC', 'Movistar KOI': 'MKOI',
  'Team Liquid': 'TL', 'CTBC Flying Oyster': 'CFO', 'Team Secret Whales': 'TSW', LYON: 'LYON', LOS: 'LOS',
  Cloud9: 'C9', 'FURIA Esports': 'FUR', FURIA: 'FUR', 'MVK Esports': 'MVK',
};
const wbAbbr = t => WB_ABBR[t] || (t || '').split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();

try { WB.me = JSON.parse(localStorage.getItem('wb-auth') || 'null'); } catch { WB.me = null; }
const wbSaveMe = me => { WB.me = me; try { me ? localStorage.setItem('wb-auth', JSON.stringify(me)) : localStorage.removeItem('wb-auth'); } catch {} };

const wbCfg = () => (typeof data !== 'undefined' && data?.worlds?.url && data?.worlds?.key) ? data.worlds : null;
const wbDayKey = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: WB_TZ });
const wbWeekday = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'short' }).replace('.', '');
const wbDayShort = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const wbGameDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'numeric' });
const wbTime = t => new Date(t).toLocaleTimeString('de-DE', { timeZone: WB_TZ, hour: '2-digit', minute: '2-digit' });
const wbDateShort = d => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
const wbStage = s => (s || '').replace(/^Worlds\s*/, '').replace('Group Stage', 'Swiss Stage');
const wbPct = p => `${Math.round(p * 100)} %`;
const wbPts = n => `${n} ${Number(n) === 1 ? 'Punkt' : 'Punkte'}`;

async function wbCall(fn, args = {}) {
  const c = wbCfg();
  const headers = { apikey: c.key, 'content-type': 'application/json' };
  if (c.key.startsWith('eyJ')) headers.authorization = `Bearer ${c.key}`; // legacy anon JWT
  const res = await fetch(`${c.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.message || `Fehler ${res.status}`);
  return out;
}

const wbOpen = m => m.status === 'open' && Date.parse(m.starts_at) > Date.now();
const wbLive = m => m.status === 'open' && !wbOpen(m);
const wbPlayer = name => WB.st?.players.find(p => p.name === name);
// Leaderboard with shared places for equal points and exact scores.
const wbRows = () => {
  let rank = 0;
  return WB.st.players.map((p, i, all) => {
    if (!i || all[i - 1].points !== p.points || all[i - 1].exact !== p.exact) rank = i + 1;
    return { ...p, rank };
  });
};
// All possible results of a match, [a, b]: BO1 1:0 0:1, BO3 2:0 2:1 1:2 0:2, BO5 3:0 … 0:3.
function wbScores(bo) {
  if (bo === 1) return [[1, 0], [0, 1]];
  const need = (bo + 1) / 2, a = [], b = [];
  for (let k = 0; k < need; k++) { a.push([need, k]); b.unshift([k, need]); }
  return [...a, ...b]; // A's wins from clearest, then B's wins ending with the clearest
}
// "GEN 2:1" — the winner first; BO1 just the team.
const wbScoreText = (m, a, b) => m.best_of === 1 ? (a > b ? m.team_a : m.team_b)
  : a > b ? `${wbAbbr(m.team_a)} ${a}:${b}` : `${wbAbbr(m.team_b)} ${b}:${a}`;
// Short form for the player columns: BO1 the team, BO3/BO5 the score as A:B.
const wbCellText = (m, a, b) => m.best_of === 1 ? wbAbbr(a > b ? m.team_a : m.team_b) : `${a}:${b}`;
const wbMissing = () => WB.me ? WB.st.matches.filter(m => wbOpen(m) && !m.mine) : [];

// ---------- Rendering ----------

function renderWorlds() {
  const el = document.getElementById('tab-worlds');
  if (!el) return;
  if (!wbCfg()) {
    el.innerHTML = `<div class="wb"><h1 class="wb-title">Worlds Tippspiel</h1><div class="wb-panel wb-empty">Das Tippspiel wird gerade eingerichtet. Schau später nochmal vorbei.</div></div>`;
    return;
  }
  const st = WB.st;
  if (!st) { el.innerHTML = `<div class="wb"><h1 class="wb-title">Worlds Tippspiel</h1><p class="wb-muted">${WB.msg ? esc(WB.msg) : 'Lade Spiele…'}</p></div>`; return; }
  const s = st.settings;
  const days = [...new Set(st.matches.map(m => m.day))];
  if (!days.includes(WB.day)) WB.day = (st.matches.find(m => m.status === 'open') || st.matches.at(-1))?.day ?? null;
  const list = st.matches.filter(m => m.day === WB.day);
  el.innerHTML = `<div class="wb">
    <header class="wb-head">
      <div>
        <h1 class="wb-title">Worlds Tippspiel</h1>
        <p class="wb-muted">${list.length ? `${esc(wbStage(list[0].stage))} · ${list.length} ${list.length === 1 ? 'Spiel' : 'Spiele'} · Zeiten in deutscher Zeit · ` : ''}BO1: Sieger ${wbPts(s.pts_bo1)} · BO3/BO5: genaues Ergebnis ${wbPts(s.pts_exact)}, Sieger ${wbPts(s.pts_winner)} · <a href="#wb-rules" data-wb="rules">Regeln</a></p>
      </div>
      ${days.length > 1 ? `<div class="wb-seg wb-days" role="tablist" aria-label="Spieltag">${days.map(d => {
        const dm = st.matches.filter(m => m.day === d);
        const done = dm.every(m => m.status !== 'open'), todo = WB.me && dm.some(m => wbOpen(m) && !m.mine);
        return `<button type="button" role="tab" data-day="${d}" aria-selected="${d === WB.day}" title="${dm.length} Spiele${todo ? ', noch nicht alle getippt' : ''}">${wbGameDay(d)}${done ? ' ✓' : todo ? ' •' : ''}</button>`;
      }).join('')}</div>` : ''}
    </header>
    <div class="wb-main">
      <section class="wb-games" aria-label="Spiele">${wbTable(list)}</section>
      <aside class="wb-side">${wbAccount()}${wbBoard()}${wbBonusTeaser()}</aside>
    </div>
    <section class="wb-panel wb-bonus" id="wb-bonus" aria-label="Bonusfragen">${wbBonus()}</section>
    <details class="wb-rules" id="wb-rules"><summary>Regeln</summary><ul>
      <li>Getippt wird jedes Worlds-Spiel ab ${wbDateShort(s.start_day)}: bei BO1 der Sieger, bei BO3 und BO5 das genaue Ergebnis (z. B. 2:1 oder 3:1). Ein Spieltag ist ein Turniertag in Nordamerika, darum laufen manche Spiele in deutscher Zeit bis nach Mitternacht.</li>
      <li>Punkte: BO1 richtiger Sieger ${wbPts(s.pts_bo1)}. BO3/BO5: genaues Ergebnis ${wbPts(s.pts_exact)}, nur der Sieger richtig ${wbPts(s.pts_winner)}.</li>
      <li>Tipps lassen sich bis zum geplanten Spielbeginn ändern. Vorher siehst du nur, wer schon getippt hat (✓), ab dem Start auch was.</li>
      <li>Kein Tipp abgegeben? Dann zählt automatisch der Favorit laut Polymarket, mit seinem wahrscheinlichsten Ergebnis (grau, „auto“). Das gilt auch für Spiele vor deiner Anmeldung.</li>
      <li>Bonusfragen: ${st.pick_types.map(pt => `${esc(pt.title)} ${pt.slots > 1 ? `je Team ${wbPts(pt.points)}` : wbPts(pt.points)} (bis ${wbDayShort(pt.lock_at)} ${wbTime(pt.lock_at)})`).join(', ')}. Die Antworten der anderen sind ab dann sichtbar.</li>
      <li>Ergebnisse kommen automatisch von Polymarket, meist 1–3 Stunden nach dem Spiel. Gleichstand in der Rangliste: mehr genaue Ergebnisse gewinnt. PIN vergessen? Sag Heino Bescheid.</li>
    </ul></details>
  </div>`;
  wbWire(el);
}

// The day's games: one row each, then one column per player (you first).
function wbTable(list) {
  if (!list.length) return '<div class="wb-panel wb-empty">Noch keine Spiele. Sie tauchen auf, sobald Polymarket sie anbietet.</div>';
  const meName = WB.me && wbPlayer(WB.me.name) ? WB.me.name : null;
  const cols = [...(meName ? [meName] : []), ...wbRows().map(p => p.name).filter(n => n !== meName)];
  return `<div class="wb-tablewrap"><table class="wb-table">
    <thead><tr><th class="wb-c-time">Zeit</th><th class="wb-c-match">Spiel${WB.me ? ' · dein Tipp' : ''}</th>
      ${cols.map(n => `<th class="wb-c-p ${n === meName ? 'me' : ''}" title="${esc(n)}">${n === meName ? 'Du' : esc(n.length > 8 ? n.slice(0, 7) + '…' : n)}</th>`).join('')}</tr></thead>
    <tbody>${list.map(m => wbRow(m, cols, meName)).join('')}</tbody>
  </table></div>
  ${!cols.length ? '<p class="wb-muted wb-small">Noch niemand angemeldet. Die Tipps der anderen erscheinen hier als Spalten.</p>' : ''}`;
}

function wbRow(m, cols, meName) {
  const open = wbOpen(m), done = m.status === 'done', live = wbLive(m);
  const nextDay = wbDayKey(m.starts_at) !== m.day;
  const time = `<b>${wbTime(m.starts_at)}</b><small>${nextDay ? wbWeekday(m.starts_at) + ' · ' : ''}BO${m.best_of}</small>`;
  const state = done ? `<span class="wb-state">Ende</span>` : m.status === 'void' ? '<span class="wb-state">abgesagt</span>' : live ? '<span class="wb-state live">läuft</span>' : '';
  const team = (name, i) => {
    const won = done && (i ? m.score_b > m.score_a : m.score_a > m.score_b);
    return `<span class="wb-team ${i ? 'b' : 'a'} ${done && !won ? 'lost' : ''}"><span class="wb-crest ${i ? 'b' : 'a'}">${esc(wbAbbr(name))}</span><span class="wb-tname">${esc(name)}</span>${done ? `<b class="wb-score">${i ? m.score_b : m.score_a}</b>` : ''}</span>`;
  };
  let match;
  if (open && m.best_of === 1) {
    match = `<div class="wb-bo1">${[0, 1].map(i => wbTipBtn(m, i ? 0 : 1, i ? 1 : 0, `<span class="wb-crest ${i ? 'b' : 'a'}">${esc(wbAbbr(i ? m.team_b : m.team_a))}</span><span class="wb-tname">${esc(i ? m.team_b : m.team_a)}</span>${m.price_a != null ? `<small>${wbPct(i ? 1 - m.price_a : m.price_a)}</small>` : ''}`, 'team')).join('<span class="wb-vs">vs</span>')}</div>`;
  } else if (open) {
    const sc = wbScores(m.best_of), half = sc.length / 2;
    match = `<div class="wb-series">${team(m.team_a, 0)}<span class="wb-scorebtns">${sc.slice(0, half).map(([a, b]) => wbTipBtn(m, a, b, `${a}:${b}`, 'a')).join('')}<i></i>${sc.slice(half).map(([a, b]) => wbTipBtn(m, a, b, `${a}:${b}`, 'b')).join('')}</span>${team(m.team_b, 1)}</div>
      ${m.price_a != null ? `<div class="wb-chance thin" title="Siegchance laut Polymarket: ${wbPct(m.price_a)} : ${wbPct(1 - m.price_a)}"><i class="a" style="width:${m.price_a * 100}%"></i><i class="b" style="width:${(1 - m.price_a) * 100}%"></i></div>` : ''}`;
  } else {
    match = `<div class="wb-series">${team(m.team_a, 0)}<span class="wb-vs">${done ? ':' : 'vs'}</span>${team(m.team_b, 1)}</div>`;
  }
  const tips = new Map((m.tips || []).map(t => [t.name, t]));
  const tipped = new Set(m.tipped_by || []);
  const cell = n => {
    const t = tips.get(n);
    if (t) {
      const cls = done ? (t.pts > 0 ? 'up' : 'down') : '';
      return `<td class="wb-c-p ${n === meName ? 'me' : ''} ${cls} ${t.auto ? 'auto' : ''}" data-name="${esc(n)}" title="${esc(n)}: ${t.a == null ? 'kein Tipp' : esc(wbScoreText(m, t.a, t.b))}${t.auto ? ' (auto)' : ''}${done ? `, ${wbPts(t.pts)}` : ''}">
        <span>${t.a == null ? '–' : esc(wbCellText(m, t.a, t.b))}</span>${done ? `<small>+${t.pts}</small>` : ''}</td>`;
    }
    if (n === meName) {
      return `<td class="wb-c-p me" data-name="Du" title="${m.mine ? 'Dein Tipp' : 'Noch nicht getippt, sonst Auto-Tipp Favorit'}">${m.mine ? `<span>${esc(wbCellText(m, m.mine.a, m.mine.b))}</span>` : `<span class="wb-miss">${m.fav_a != null ? esc(wbCellText(m, m.fav_a, m.fav_b)) : '?'}</span><small>auto</small>`}</td>`;
    }
    return `<td class="wb-c-p ${tipped.has(n) ? 'ok' : ''}" data-name="${esc(n)}" title="${esc(n)}: ${tipped.has(n) ? 'hat getippt (sichtbar ab Spielbeginn)' : 'noch kein Tipp'}">${tipped.has(n) ? '✓' : '·'}</td>`;
  };
  return `<tr class="${open && WB.me && !m.mine ? 'todo' : ''} ${live ? 'live' : ''}" id="wb-m-${esc(m.id)}">
    <td class="wb-c-time">${time}${state}</td>
    <td class="wb-c-match">${match}</td>
    ${cols.map(cell).join('')}
  </tr>`;
}

function wbTipBtn(m, a, b, inner, kind) {
  const on = m.mine && m.mine.a === a && m.mine.b === b, fav = m.fav_a === a && m.fav_b === b;
  return `<button type="button" class="wb-tip ${kind} ${on ? 'on' : ''} ${fav && !m.mine ? 'fav' : ''}" data-tip="${esc(m.id)}" data-a="${a}" data-b="${b}" aria-pressed="${!!on}"
    aria-label="Tipp ${esc(wbScoreText(m, a, b))}${fav ? ' (Favorit)' : ''}" title="${esc(wbScoreText(m, a, b))}${fav && !m.mine ? ' · ohne Tipp zählt dieser automatisch' : ''}">${inner}</button>`;
}

function wbAccount() {
  const me = WB.me && wbPlayer(WB.me.name);
  if (WB.me && me) {
    const row = wbRows().find(p => p.name === me.name), missing = wbMissing().length;
    return `<div class="wb-card wb-acct">
      <div class="wb-acct-top"><span class="wb-avatar" aria-hidden="true">${esc(me.name[0] || '?')}</span>
        <span><b>${esc(me.name)}</b><small>Platz ${row.rank} von ${WB.st.players.length} · ${wbPts(me.points)}</small></span></div>
      ${missing ? `<p class="wb-warn">${missing === 1 ? '1 Tipp fehlt' : `${missing} Tipps fehlen`} <button type="button" class="wb-link" data-wb="jump-missing">zeigen</button></p>` : '<p class="wb-ok">Alles getippt ✓</p>'}
      <button type="button" class="wb-link" data-wb="logout">Ausloggen</button>
    </div>`;
  }
  return `<form class="wb-card wb-login" autocomplete="on">
      <b>Mitspielen</b><small class="wb-muted">Name und PIN (4–8 Ziffern) ausdenken.</small>
      <label class="wb-sr" for="wb-name">Name</label><input id="wb-name" name="name" placeholder="Name" maxlength="20" autocomplete="username" required>
      <label class="wb-sr" for="wb-pin">PIN</label><input id="wb-pin" name="pin" placeholder="PIN" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" type="password" autocomplete="current-password" required>
      <div class="wb-btns"><button class="wb-btn gold" data-wb="login">Einloggen</button><button class="wb-btn" data-wb="register">Registrieren</button></div>
      ${WB.msg ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
    </form>`;
}

function wbBoard() {
  const rows = wbRows(), meName = WB.me?.name;
  return `<div class="wb-card"><h2 class="wb-h">Rangliste</h2>
    ${rows.length ? `<ol class="wb-list">${rows.map(p => `<li class="${p.name === meName ? 'me' : ''} ${p.rank === 1 && p.points > 0 ? 'top' : ''}">
        <span class="wb-rank">${p.rank}</span><span class="wb-lname">${esc(p.name)}<small>${p.exact}× genau · ${p.hits} Treffer${p.bonus ? ` · +${p.bonus} Bonus` : ''}</small></span><b>${p.points}</b></li>`).join('')}</ol>`
      : '<p class="wb-muted wb-small">Noch niemand dabei. Sei der Erste!</p>'}
  </div>`;
}

function wbBonusTeaser() {
  const types = WB.st.pick_types;
  if (!types.length) return '';
  const me = WB.me && wbPlayer(WB.me.name);
  const open = types.filter(t => Date.now() < Date.parse(t.lock_at));
  const next = open.sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at))[0];
  const answered = me ? types.filter(t => (me.picks?.[t.kind] || []).length >= t.slots).length : 0;
  return `<div class="wb-card"><h2 class="wb-h">Bonusfragen</h2>
    <p class="wb-muted wb-small">${me ? `${answered} von ${types.length} beantwortet.` : `${types.length} Fragen, z. B. ${esc(types[0].title)} (+${types[0].points}).`}
      ${next ? `Nächste Sperre ${wbDayShort(next.lock_at)} ${wbTime(next.lock_at)}.` : 'Alle gesperrt.'}</p>
    <a href="#wb-bonus" class="wb-btn wb-btn-link" data-wb="to-bonus">Zu den Bonusfragen ↓</a>
  </div>`;
}

function wbBonus() {
  const types = WB.st.pick_types;
  if (!types.length) return '<h2 class="wb-h">Bonusfragen</h2><p class="wb-muted">Kommen gleich.</p>';
  // start on the question that locks next
  const next = types.filter(t => Date.now() < Date.parse(t.lock_at)).sort((a, b) => Date.parse(a.lock_at) - Date.parse(b.lock_at) || a.sort - b.sort)[0];
  if (!types.some(t => t.kind === WB.kind)) WB.kind = (next || types[0]).kind;
  const pt = types.find(t => t.kind === WB.kind);
  const locked = Date.now() >= Date.parse(pt.lock_at);
  const me = WB.me && wbPlayer(WB.me.name);
  const mine = me?.picks?.[pt.kind] || [];
  const odds = new Map(WB.st.team_odds.filter(o => o.kind === pt.kind).map(o => [o.team, o]));
  const out = new Set(WB.st.teams.filter(t => t.out).map(t => t.team));
  const alive = WB.st.teams.map(t => t.team).filter(t => !out.has(t) || mine.includes(t) || odds.get(t)?.hit)
    .sort((a, b) => (Number(odds.get(b)?.price) || 0) - (Number(odds.get(a)?.price) || 0));
  const list = WB.teamsAll ? alive : alive.filter((t, i) => i < 8 || mine.includes(t));
  const max = Math.max(...alive.map(t => Number(odds.get(t)?.price) || 0), .01);
  const pickers = t => WB.st.players.filter(p => p.name !== WB.me?.name && p.picks?.[pt.kind]?.includes(t)).map(p => p.name);
  return `<div class="wb-sec-head"><h2 class="wb-h">Bonusfragen</h2><span class="wb-muted wb-small">${locked ? 'gesperrt seit' : 'änderbar bis'} ${wbDayShort(pt.lock_at)} ${wbTime(pt.lock_at)}</span></div>
    <div class="wb-seg wb-kinds" role="tablist" aria-label="Bonusfrage">${types.map(t => {
      const n = (me?.picks?.[t.kind] || []).length;
      return `<button type="button" role="tab" data-kind="${esc(t.kind)}" aria-selected="${t.kind === pt.kind}">${esc(t.title)}${me ? ` <small>${n}/${t.slots}</small>` : ''}</button>`;
    }).join('')}</div>
    <p class="wb-muted wb-q">${pt.slots === 1 ? 'Wähle 1 Team' : `Wähle ${pt.slots} Teams`}, ${pt.slots > 1 ? `je richtiges Team ${wbPts(pt.points)}` : wbPts(pt.points)}.
      ${me ? `<b>${mine.length}/${pt.slots} gewählt.</b>` : 'Zum Tippen einloggen.'} Balken = Chance laut Polymarket.${locked ? '' : ' Was die anderen gewählt haben, siehst du ab der Sperre.'}</p>
    <div class="wb-picks">${list.map(t => {
      const o = odds.get(t), on = mine.includes(t), who = locked ? pickers(t) : [];
      const res = o?.hit === true ? '<span class="wb-hit up">✓</span>' : o?.hit === false ? '<span class="wb-hit down">✗</span>' : '';
      return `<button type="button" class="wb-pick ${on ? 'on' : ''}" data-team="${esc(t)}" aria-pressed="${on}" ${!me || locked ? 'disabled' : ''}>
        <span class="wb-dot" aria-hidden="true"></span>
        <span class="wb-name">${esc(t)}${res}${who.length ? `<small>${who.map(esc).join(', ')}</small>` : ''}</span>
        <span class="wb-pbar" aria-hidden="true"><i style="width:${Math.round((Number(o?.price) || 0) / max * 100)}%"></i></span>
        <span class="wb-ppct">${o?.price == null ? '–' : wbPct(Number(o.price))}</span></button>`;
    }).join('')}</div>
    ${alive.length > 8 ? `<button type="button" class="wb-link wb-more-teams" data-wb="teams-all">${WB.teamsAll ? 'Nur Favoriten zeigen' : `Alle ${alive.length} Teams zeigen`}</button>` : ''}`;
}

// ---------- Actions ----------

function wbWire(el) {
  el.querySelectorAll('[data-tip]').forEach(b => b.addEventListener('click', async () => {
    if (!WB.me) { WB.msg = 'Zum Tippen erst einloggen oder registrieren.'; renderWorlds(); el.querySelector('.wb-login input')?.focus(); return; }
    if (WB.busy) return;
    WB.busy = true;
    const m = WB.st.matches.find(x => x.id === b.dataset.tip), a = Number(b.dataset.a), bb = Number(b.dataset.b);
    try {
      const r = await wbCall('wb_tip', { p_token: WB.me.token, p_match: m.id, p_a: a, p_b: bb });
      if (r.relogin) wbSaveMe(null);
      if (r.error) alert(r.error); else wbToast(`Tipp gespeichert: ${wbScoreText(m, a, bb)}`);
    } catch (err) { alert(err.message); }
    finally { WB.busy = false; }
    await wbLoad(true);
  }));
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => { WB.day = b.dataset.day; renderWorlds(); }));
  el.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { WB.kind = b.dataset.kind; renderWorlds(); }));
  el.querySelector('[data-wb="jump-missing"]')?.addEventListener('click', () => {
    const m = wbMissing()[0]; if (!m) return;
    WB.day = m.day; renderWorlds();
    document.getElementById('wb-m-' + m.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  el.querySelectorAll('[data-wb="to-bonus"], [data-wb="rules"]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const target = document.getElementById(a.dataset.wb === 'rules' ? 'wb-rules' : 'wb-bonus');
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el.querySelector('[data-wb="teams-all"]')?.addEventListener('click', () => { WB.teamsAll = !WB.teamsAll; renderWorlds(); });
  el.querySelector('[data-wb="logout"]')?.addEventListener('click', async () => {
    const t = WB.me?.token; wbSaveMe(null); WB.msg = null;
    await wbLoad(true);
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
  el.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', async () => {
    const team = b.dataset.team;
    try {
      const r = await wbCall('wb_pick', { p_token: WB.me.token, p_kind: WB.kind, p_team: team });
      if (r.relogin) wbSaveMe(null);
      if (r.error) alert(r.error); else wbToast(r.picked ? `Gewählt: ${team}` : `Abgewählt: ${team}`);
    } catch (err) { alert(err.message); }
    await wbLoad(true);
  }));
}

function wbToast(text) {
  const t = document.createElement('div');
  t.className = 'wb-toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

async function wbLoad(force) {
  if (!wbCfg()) { renderWorlds(); return; }
  try {
    WB.st = await wbCall('wb_state', WB.me ? { p_token: WB.me.token } : {});
    if (WB.me && WB.st.me !== WB.me.name) wbSaveMe(null); // session gone or account removed
  } catch (err) { if (!WB.st) WB.msg = 'Konnte das Tippspiel nicht laden: ' + err.message; }
  // Keep a half-typed login while the page refreshes in the background.
  const typing = !force && document.activeElement?.matches?.('#tab-worlds input');
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
