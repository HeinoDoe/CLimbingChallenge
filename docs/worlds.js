// Worlds Tippspiel (like Kicktipp): the #worlds tab, "Summoner's Cup" look.
// Everything is stored in Supabase (supabase/worlds.sql) and reached only through its wb_*
// functions; schedule, odds and results come from Polymarket via scripts/worlds.mjs. The
// connection (project URL + publishable key, both public) is in squad.config.json →
// data.json → data.worlds.
const WB = { st: null, me: null, msg: null, timer: null, busy: false, day: null, kind: null, boardAll: false, teamsAll: false };
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
  Cloud9: 'C9', 'FURIA Esports': 'FUR', FURIA: 'FUR', 'MVK Esports': 'MVK',
};
const wbAbbr = t => WB_ABBR[t] || (t || '').split(/\s+/).map(w => w[0]).join('').slice(0, 4).toUpperCase();

try { WB.me = JSON.parse(localStorage.getItem('wb-auth') || 'null'); } catch { WB.me = null; }
const wbSaveMe = me => { WB.me = me; try { me ? localStorage.setItem('wb-auth', JSON.stringify(me)) : localStorage.removeItem('wb-auth'); } catch {} };

const wbCfg = () => (typeof data !== 'undefined' && data?.worlds?.url && data?.worlds?.key) ? data.worlds : null;
const wbDayKey = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: WB_TZ });
const wbDay = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'long', day: 'numeric', month: 'numeric' });
const wbDayShort = t => new Date(t).toLocaleDateString('de-DE', { timeZone: WB_TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const wbTime = t => new Date(t).toLocaleTimeString('de-DE', { timeZone: WB_TZ, hour: '2-digit', minute: '2-digit' });
const wbDateShort = d => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
const wbStage = s => (s || '').replace(/^Worlds\s*/, '').replace('Group Stage', 'Swiss');
const wbPct = p => `${Math.round(p * 1000) / 10} %`.replace('.', ',');
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
const wbRows = () => WB.st.players.map((p, i, all) => ({ ...p, rank: i && all[i - 1].points === p.points && all[i - 1].exact === p.exact ? null : i + 1 }))
  .map((p, i, all) => ({ ...p, rank: p.rank ?? all.slice(0, i).reverse().find(x => x.rank)?.rank }));
// All possible results of a match, [a, b]: BO1 1:0 0:1, BO3 2:0 2:1 1:2 0:2, BO5 3:0 … 0:3.
function wbScores(bo) {
  if (bo === 1) return [[1, 0], [0, 1]];
  const need = (bo + 1) / 2, out = [];
  for (let k = 0; k < need; k++) out.push([need, k], [k, need]);
  return out;
}
// "GEN 2:1" — the winner first; BO1 just the team.
const wbScoreText = (m, a, b) => m.best_of === 1 ? (a > b ? m.team_a : m.team_b)
  : a > b ? `${wbAbbr(m.team_a)} ${a}:${b}` : `${wbAbbr(m.team_b)} ${b}:${a}`;
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
  const s = st.settings, missing = wbMissing();
  el.innerHTML = `<div class="wb">
    <div class="wb-bar">${wbAccount()}</div>
    ${missing.length ? `<p class="wb-banner"><b>${missing.length === 1 ? 'Dir fehlt noch 1 Tipp' : `Dir fehlen noch ${missing.length} Tipps`}.</b> Ohne Tipp wird automatisch der Favorit getippt. <button type="button" class="wb-link" data-wb="jump-missing">Zum nächsten</button></p>` : ''}
    <section class="wb-hero">
      <div class="wb-hero-text">
        <p class="wb-eyebrow">${esc(wbEyebrow())}</p>
        <h1 class="wb-title">Tipp jedes<br>Worlds-Spiel.</h1>
        <p class="wb-lede">Wie Kicktipp: richtiger Sieger ${wbPts(s.pts_bo1)}, bei BO3 und BO5 das genaue Ergebnis ${wbPts(s.pts_exact)}. Dazu Bonusfragen. Wer am ${wbDateShort(s.end_day)} vorne liegt, gewinnt.</p>
        <ol class="wb-stages" aria-label="Turnier">${WB_STAGES.map(x => `<li class="${wbStageState(x)}">${x.name} · ${x.text}</li>`).join('')}</ol>
      </div>
      ${wbNext()}
    </section>
    <section class="wb-sec" aria-label="Spiele" id="wb-games">${wbMatches()}</section>
    <div class="wb-row">
      <section class="wb-panel" aria-label="Rangliste"><h2 class="wb-h">Rangliste</h2>${wbBoard()}</section>
      <section class="wb-panel" aria-label="Bonusfragen">${wbBonus()}</section>
    </div>
    <details class="wb-rules"><summary>Regeln</summary><ul>
      <li>Getippt wird jedes Worlds-Spiel ab ${wbDateShort(s.start_day)}: bei BO1 der Sieger, bei BO3 und BO5 das genaue Ergebnis (z. B. 2:1 oder 3:1).</li>
      <li>Punkte: BO1 richtiger Sieger ${wbPts(s.pts_bo1)}. BO3/BO5: genaues Ergebnis ${wbPts(s.pts_exact)}, nur der Sieger richtig ${wbPts(s.pts_winner)}.</li>
      <li>Tipps lassen sich bis zum geplanten Spielbeginn ändern. Danach sieht jeder, was die anderen getippt haben.</li>
      <li>Kein Tipp abgegeben? Dann zählt automatisch der Favorit laut Polymarket, mit seinem wahrscheinlichsten Ergebnis (markiert mit „auto“). Das gilt auch für Spiele vor deiner Anmeldung.</li>
      <li>Bonusfragen: ${st.pick_types.map(pt => `${esc(pt.title)} ${pt.slots > 1 ? `je Team ${wbPts(pt.points)}` : wbPts(pt.points)} (bis ${wbDayShort(pt.lock_at)} ${wbTime(pt.lock_at)})`).join(', ')}. Die Antworten der anderen sind ab dann sichtbar.</li>
      <li>Ergebnisse kommen automatisch von Polymarket, meist 1–3 Stunden nach dem Spiel. Gleichstand in der Rangliste: mehr genaue Ergebnisse gewinnt. PIN vergessen? Sag Heino Bescheid.</li>
    </ul></details>
  </div>`;
  wbWire(el);
}

function wbStageState(x) {
  const today = wbDayKey(Date.now());
  return today > x.to ? 'done' : today >= x.from || WB_STAGES.find(y => today <= y.to) === x ? 'now' : '';
}
function wbEyebrow() {
  const next = WB.st.matches.find(wbOpen);
  return next ? `${wbStage(next.stage)} · nächstes Spiel ${wbDayShort(next.starts_at)} ${wbTime(next.starts_at)}`.toUpperCase() : 'WORLDS 2026';
}

function wbAccount() {
  const me = WB.me && wbPlayer(WB.me.name);
  if (WB.me && me) {
    const row = wbRows().find(p => p.name === me.name);
    return `<p class="wb-muted">Platz <b>${row.rank}</b> von ${WB.st.players.length} · ${me.exact}× genau · ${me.hits} Treffer${me.bonus ? ` · +${me.bonus} Bonus` : ''}</p>
      <div class="wb-wallet">
        <span class="wb-avatar" aria-hidden="true">${esc(me.name[0] || '?')}</span>
        <span class="wb-wallet-txt"><span class="wb-k">${esc(me.name)}</span><b>${wbPts(me.points)}</b></span>
        <button type="button" class="wb-link" data-wb="logout">Ausloggen</button>
      </div>`;
  }
  return `<p class="wb-muted"><b>Mitspielen:</b> Name und PIN (4–8 Ziffern) ausdenken und registrieren, oder einloggen.</p>
    <form class="wb-login" autocomplete="on">
      <label class="wb-sr" for="wb-name">Name</label><input id="wb-name" name="name" placeholder="Name" maxlength="20" autocomplete="username" required>
      <label class="wb-sr" for="wb-pin">PIN</label><input id="wb-pin" name="pin" placeholder="PIN" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" type="password" autocomplete="current-password" required>
      <button class="wb-btn gold" data-wb="login">Einloggen</button><button class="wb-btn" data-wb="register">Registrieren</button>
      ${WB.msg ? `<p class="wb-err">${esc(WB.msg)}</p>` : ''}
    </form>`;
}

// The next match, big, with its tip buttons.
function wbNext() {
  const m = WB.st.matches.find(wbOpen);
  if (!m) return `<article class="wb-top wb-empty">Gerade keine offenen Spiele. Neue tauchen auf, sobald Polymarket sie anbietet.</article>`;
  return `<article class="wb-top" aria-label="Nächstes Spiel">
    <div class="wb-top-head"><span class="wb-eyebrow">Nächstes Spiel</span><span class="wb-muted">${wbDay(m.starts_at)} ${wbTime(m.starts_at)} · BO${m.best_of}</span></div>
    <div class="wb-versus">
      <div><span class="wb-crest big a">${esc(wbAbbr(m.team_a))}</span><b>${esc(m.team_a)}</b></div>
      <span class="wb-vs">VS</span>
      <div><span class="wb-crest big b">${esc(wbAbbr(m.team_b))}</span><b>${esc(m.team_b)}</b></div>
    </div>
    ${wbChanceBar(m, true)}
    ${wbTipButtons(m)}
    <p class="wb-muted wb-small">${wbTipLine(m)}</p>
  </article>`;
}

function wbChanceBar(m, labels) {
  if (m.price_a == null) return '';
  const pa = Number(m.price_a);
  return `<div class="wb-chance ${labels ? '' : 'thin'}" title="Siegchance laut Polymarket: ${wbPct(pa)} : ${wbPct(1 - pa)}"><i class="a" style="width:${pa * 100}%"></i><i class="b" style="width:${(1 - pa) * 100}%"></i></div>
    ${labels ? `<div class="wb-chance-txt"><span class="a">${wbPct(pa)} Siegchance</span><span class="b">${wbPct(1 - pa)} Siegchance</span></div>` : ''}`;
}

function wbTipButtons(m) {
  const mine = m.mine, scores = wbScores(m.best_of);
  return `<div class="wb-tips bo${m.best_of}" role="group" aria-label="Dein Tipp">${scores.map(([a, b]) => {
    const on = mine && mine.a === a && mine.b === b, fav = m.fav_a === a && m.fav_b === b;
    return `<button type="button" class="wb-tip ${a > b ? 'a' : 'b'} ${on ? 'on' : ''}" data-tip="${esc(m.id)}" data-a="${a}" data-b="${b}" aria-pressed="${!!on}">
      ${esc(wbScoreText(m, a, b))}${fav && !mine ? '<small>auto</small>' : ''}</button>`;
  }).join('')}</div>`;
}

function wbTipLine(m) {
  const total = WB.st.players.length;
  const auto = m.fav_a != null ? `sonst Auto-Tipp ${esc(wbScoreText(m, m.fav_a, m.fav_b))}` : 'sonst Auto-Tipp Favorit';
  const mine = m.mine ? `Dein Tipp: <b>${esc(wbScoreText(m, m.mine.a, m.mine.b))}</b>` : WB.me ? `Noch nicht getippt, ${auto}` : 'Zum Tippen oben einloggen';
  return `${mine} · ${m.tipped}/${total} getippt`;
}

function wbMatches() {
  const ms = WB.st.matches;
  const head = '<h2 class="wb-h">Spiele</h2>';
  if (!ms.length) return `${head}<div class="wb-panel wb-empty">Noch keine Spiele. Sie tauchen auf, sobald Polymarket sie anbietet.</div>`;
  const days = [...new Set(ms.map(m => wbDayKey(m.starts_at)))];
  if (!days.includes(WB.day)) WB.day = wbDayKey((ms.find(m => m.status === 'open') || ms.at(-1)).starts_at);
  const list = ms.filter(m => wbDayKey(m.starts_at) === WB.day);
  return `<div class="wb-sec-head">${head}
      <div class="wb-seg wb-days" role="tablist" aria-label="Spieltag">${days.map(d => {
        const dm = ms.filter(m => wbDayKey(m.starts_at) === d);
        const done = dm.every(m => m.status !== 'open'), todo = WB.me && dm.some(m => wbOpen(m) && !m.mine);
        return `<button type="button" role="tab" data-day="${d}" aria-selected="${d === WB.day}">${wbDayShort(dm[0].starts_at)}${done ? ' ✓' : todo ? ' •' : ''}</button>`;
      }).join('')}</div></div>
    <div class="wb-tiles">${list.map(wbTile).join('')}</div>`;
}

function wbTile(m) {
  const open = wbOpen(m), done = m.status === 'done', live = wbLive(m);
  const status = done ? `ENDE · ${m.score_a}:${m.score_b}` : m.status === 'void' ? 'ABGESAGT' : live ? 'LÄUFT · WARTET AUF ERGEBNIS' : `BO${m.best_of} · ${esc(wbStage(m.stage)).toUpperCase()}`;
  const team = (name, i) => {
    const won = done && (i ? m.score_b > m.score_a : m.score_a > m.score_b);
    return `<div class="wb-team ${done && !won ? 'lost' : ''}"><span class="wb-crest ${i ? 'b' : 'a'}">${esc(wbAbbr(name))}</span><span class="wb-name">${esc(name)}</span>${done ? `<b class="wb-score">${i ? m.score_b : m.score_a}</b>` : ''}</div>`;
  };
  return `<article class="wb-tile ${live ? 'live' : ''} ${open && WB.me && !m.mine ? 'todo' : ''}" id="wb-m-${esc(m.id)}">
    <div class="wb-tile-top"><b>${wbTime(m.starts_at)}</b><span>${status}</span></div>
    ${team(m.team_a, 0)}
    ${wbChanceBar(m, false) || '<div class="wb-chance thin"></div>'}
    ${team(m.team_b, 1)}
    ${open ? `${wbTipButtons(m)}<p class="wb-tile-foot">${wbTipLine(m)}</p>` : wbOthers(m)}
  </article>`;
}

// After the start: everyone's tip, with points once the result is in.
function wbOthers(m) {
  const tips = m.tips || [];
  if (!tips.length) return '<p class="wb-tile-foot">Noch keine Mitspieler.</p>';
  const done = m.status === 'done';
  return `<ul class="wb-who" aria-label="Tipps">${tips.map(t => `<li class="${t.name === WB.me?.name ? 'me' : ''} ${done ? (t.pts > 0 ? 'up' : 'down') : ''}">
      ${esc(t.name)} <b>${t.a == null ? '–' : esc(wbScoreText(m, t.a, t.b))}</b>${t.auto ? ' <small>auto</small>' : ''}${done ? ` <em>+${t.pts}</em>` : ''}</li>`).join('')}</ul>`;
}

function wbBoard() {
  const rows = wbRows();
  if (!rows.length) return '<p class="wb-muted">Noch niemand dabei. Sei der Erste!</p>';
  const meName = WB.me?.name;
  const sub = p => `${p.exact}× genau · ${p.hits} Treffer${p.bonus ? ` · +${p.bonus} Bonus` : ''}`;
  const pod = [rows[1], rows[0], rows[2]].filter(Boolean);
  const rest = rows.slice(3), shown = WB.boardAll ? rest : rest.slice(0, 7);
  return `<div class="wb-podium" style="grid-template-columns:repeat(${pod.length},minmax(0,1fr))">${pod.map((p, i) => `<div class="wb-pod r${[2, 1, 3][pod.length === 1 ? 1 : i]} ${p.name === meName ? 'me' : ''}">
      <b class="wb-pod-name">${esc(p.name)}</b><span class="wb-pod-money">${wbPts(p.points)}</span><small>${sub(p)}</small>
      <div class="wb-pod-step">${p.rank}</div></div>`).join('')}</div>
    ${shown.length ? `<ol class="wb-list">${shown.map(p => `<li class="${p.name === meName ? 'me' : ''}"><span><b class="wb-rank">${p.rank}</b>${esc(p.name)} <small>${sub(p)}</small></span><span class="wb-money">${p.points}</span></li>`).join('')}</ol>` : ''}
    ${rest.length > 7 ? `<button type="button" class="wb-link" data-wb="board-all">${WB.boardAll ? 'Weniger anzeigen' : `Alle ${rows.length} anzeigen`}</button>` : ''}`;
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
  return `<div class="wb-sec-head"><h2 class="wb-h">Bonusfragen</h2><span class="wb-muted">${locked ? 'gesperrt seit' : 'änderbar bis'} ${wbDayShort(pt.lock_at)} ${wbTime(pt.lock_at)}</span></div>
    <div class="wb-seg wb-kinds" role="tablist" aria-label="Bonusfrage">${types.map(t => `<button type="button" role="tab" data-kind="${esc(t.kind)}" aria-selected="${t.kind === pt.kind}">${esc(t.title)}</button>`).join('')}</div>
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
    WB.day = wbDayKey(m.starts_at); renderWorlds();
    document.getElementById('wb-m-' + m.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  el.querySelector('[data-wb="board-all"]')?.addEventListener('click', () => { WB.boardAll = !WB.boardAll; renderWorlds(); });
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
