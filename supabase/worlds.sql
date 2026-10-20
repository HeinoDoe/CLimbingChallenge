-- Worlds betting game ("Justus Bucks"). Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run). Running it again is safe.
--
-- The website talks to the database only through the wb_* functions below (anon key);
-- the tables themselves are closed. scripts/worlds.mjs (GitHub Action, secret key)
-- copies odds and results from Polymarket with wb_sync().

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.wb_settings (
  id int primary key default 1 check (id = 1),
  start_day date not null default '2026-10-20',
  end_day date not null default '2026-11-14',
  start_balance numeric(12,2) not null default 100,
  daily numeric(12,2) not null default 10,
  winner_bonus numeric(12,2) not null default 20,
  finalist_bonus numeric(12,2) not null default 10,
  picks_lock timestamptz not null default '2026-11-03T12:00:00+01:00',
  synced_at timestamptz
);
insert into public.wb_settings (id) values (1) on conflict do nothing;

create table if not exists public.wb_players (
  id bigint generated always as identity primary key,
  name text not null,
  pin_hash text not null,
  failed int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists wb_players_name on public.wb_players (lower(name));

create table if not exists public.wb_sessions (
  token uuid primary key default gen_random_uuid(),
  player_id bigint not null references public.wb_players on delete cascade,
  created_at timestamptz not null default now()
);

-- One row per Polymarket market (match winner, game winner, handicap, props, ...).
create table if not exists public.wb_markets (
  id text primary key,
  event_id text not null,
  event_title text not null,
  stage text,
  best_of int,
  kind text not null,
  label text not null,
  outcomes jsonb not null,
  prices jsonb,                          -- null = no real price right now, no betting
  starts_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'settled', 'void')),
  result int,
  score text,
  updated_at timestamptz not null default now()
);
create index if not exists wb_markets_event on public.wb_markets (event_id);

create table if not exists public.wb_bets (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.wb_players on delete cascade,
  market_id text not null references public.wb_markets,
  outcome int not null,
  stake numeric(12,2) not null check (stake >= 1),
  odds numeric(8,2) not null check (odds > 1),
  placed_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'void')),
  payout numeric(12,2) not null default 0
);
create index if not exists wb_bets_player on public.wb_bets (player_id);
create index if not exists wb_bets_market on public.wb_bets (market_id);

-- Teams for the free picks, with their outright chances and, once known, the result.
create table if not exists public.wb_teams (
  team text primary key,
  win_price numeric,
  final_price numeric,
  out boolean not null default false,
  won boolean,
  finalist boolean,
  updated_at timestamptz not null default now()
);

create table if not exists public.wb_picks (
  player_id bigint not null references public.wb_players on delete cascade,
  kind text not null check (kind in ('winner', 'finalist')),
  slot int not null check (slot in (1, 2)),
  team text not null references public.wb_teams,
  primary key (player_id, kind, slot)
);

alter table public.wb_settings enable row level security;
alter table public.wb_players enable row level security;
alter table public.wb_sessions enable row level security;
alter table public.wb_markets enable row level security;
alter table public.wb_bets enable row level security;
alter table public.wb_teams enable row level security;
alter table public.wb_picks enable row level security;
revoke all on public.wb_settings, public.wb_players, public.wb_sessions, public.wb_markets,
  public.wb_bets, public.wb_teams, public.wb_picks from anon, authenticated;

-- ---------- Helpers ----------

create or replace function public.wb_today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Berlin')::date $$;

-- Fair decimal odds from a market price (1 / probability), the way Polymarket prices it.
create or replace function public.wb_odds(price numeric) returns numeric
language sql immutable as $$ select round(1 / price, 2) $$;

create or replace function public.wb_player(p_token uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select player_id from wb_sessions where token = p_token
$$;

-- Bonus from the free picks, once the result is known.
create or replace function public.wb_bonus(p bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when k.kind = 'winner' and t.won then s.winner_bonus
                           when k.kind = 'finalist' and t.finalist then s.finalist_bonus else 0 end), 0)
  from wb_picks k join wb_teams t using (team) cross join wb_settings s
  where k.player_id = p
$$;

-- Money a player can bet right now: start + daily bucks - stakes + payouts + pick bonus.
create or replace function public.wb_cash(p bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select s.start_balance
       + s.daily * greatest(0, least(wb_today(), s.end_day) - s.start_day)
       - coalesce((select sum(stake) from wb_bets where player_id = p), 0)
       + coalesce((select sum(payout) from wb_bets where player_id = p), 0)
       + wb_bonus(p)
  from wb_settings s
$$;

-- ---------- Website calls (anon key) ----------

create or replace function public.wb_register(p_name text, p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')); pid bigint; tok uuid;
begin
  if n !~ '^[[:alnum:] ._-]{2,20}$' or n ~ '^[ ._-]|[ ._-]$' then
    return json_build_object('error', 'Name: 2–20 Zeichen, Buchstaben, Zahlen, Leerzeichen, . _ -');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4,8}$' then
    return json_build_object('error', 'PIN: 4–8 Ziffern');
  end if;
  if exists (select 1 from wb_players where lower(name) = lower(n)) then
    return json_build_object('error', 'Den Namen gibt es schon. Einloggen?');
  end if;
  insert into wb_players (name, pin_hash) values (n, crypt(p_pin, gen_salt('bf'))) returning id into pid;
  insert into wb_sessions (player_id) values (pid) returning token into tok;
  return json_build_object('token', tok, 'name', n);
end $$;

create or replace function public.wb_login(p_name text, p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare pl wb_players; tok uuid;
begin
  select * into pl from wb_players where lower(name) = lower(btrim(coalesce(p_name, ''))) for update;
  if pl.id is null then
    return json_build_object('error', 'Name nicht gefunden. Registrieren?');
  end if;
  if pl.locked_until > now() then
    return json_build_object('error', 'Zu viele falsche PINs. Versuch es in ein paar Minuten nochmal.');
  end if;
  if pl.pin_hash <> crypt(coalesce(p_pin, ''), pl.pin_hash) then
    update wb_players set failed = case when failed >= 4 then 0 else failed + 1 end,
      locked_until = case when failed >= 4 then now() + interval '15 minutes' else locked_until end
    where id = pl.id;
    return json_build_object('error', 'Falscher PIN.');
  end if;
  update wb_players set failed = 0, locked_until = null where id = pl.id;
  insert into wb_sessions (player_id) values (pl.id) returning token into tok;
  return json_build_object('token', tok, 'name', pl.name);
end $$;

create or replace function public.wb_logout(p_token uuid) returns json
language sql security definer set search_path = public as $$
  delete from wb_sessions where token = p_token;
  select json_build_object('ok', true);
$$;

create or replace function public.wb_bet(p_token uuid, p_market text, p_outcome int, p_stake numeric, p_odds numeric) returns json
language plpgsql security definer set search_path = public as $$
declare pid bigint := wb_player(p_token); m wb_markets; cur numeric; cash numeric; stake numeric := round(p_stake, 2); bid bigint;
begin
  if pid is null then return json_build_object('error', 'Bitte neu einloggen.', 'relogin', true); end if;
  perform 1 from wb_players where id = pid for update;  -- one bet at a time per player
  select * into m from wb_markets where id = p_market;
  if m.id is null then return json_build_object('error', 'Diese Wette gibt es nicht.'); end if;
  if m.status <> 'open' or m.starts_at <= now() then return json_build_object('error', 'Das Match hat schon angefangen.'); end if;
  if m.prices is null or m.updated_at < now() - interval '45 minutes' then
    return json_build_object('error', 'Für diese Wette gibt es gerade keine aktuelle Quote.');
  end if;
  if p_outcome is null or p_outcome < 0 or p_outcome >= jsonb_array_length(m.outcomes) then
    return json_build_object('error', 'Ungültige Auswahl.');
  end if;
  if (m.prices ->> p_outcome)::numeric not between 0.01 and 0.99 then
    return json_build_object('error', 'Für diese Wette gibt es gerade keine aktuelle Quote.');
  end if;
  cur := wb_odds((m.prices ->> p_outcome)::numeric);
  if p_odds is null or cur <> round(p_odds, 2) then
    return json_build_object('error', format('Die Quote hat sich geändert, jetzt %s.', cur), 'odds', cur);
  end if;
  if stake is null or stake < 1 then return json_build_object('error', 'Mindesteinsatz: $1.'); end if;
  cash := wb_cash(pid);
  if stake > cash then return json_build_object('error', format('Nicht genug Justus Bucks (du hast $%s).', cash)); end if;
  insert into wb_bets (player_id, market_id, outcome, stake, odds) values (pid, m.id, p_outcome, stake, cur) returning id into bid;
  return json_build_object('ok', true, 'id', bid, 'cash', cash - stake);
end $$;

-- Free picks: Worlds winner (slot 1) and the two finalists (slots 1 and 2). p_team null clears.
create or replace function public.wb_pick(p_token uuid, p_kind text, p_slot int, p_team text) returns json
language plpgsql security definer set search_path = public as $$
declare pid bigint := wb_player(p_token); t wb_teams;
begin
  if pid is null then return json_build_object('error', 'Bitte neu einloggen.', 'relogin', true); end if;
  if now() >= (select picks_lock from wb_settings) then return json_build_object('error', 'Die Tipps sind schon gesperrt.'); end if;
  if p_kind not in ('winner', 'finalist') or p_slot not in (1, 2) or (p_kind = 'winner' and p_slot <> 1) then
    return json_build_object('error', 'Ungültiger Tipp.');
  end if;
  if p_team is null then
    delete from wb_picks where player_id = pid and kind = p_kind and slot = p_slot;
    return json_build_object('ok', true);
  end if;
  select * into t from wb_teams where team = p_team;
  if t.team is null or t.out then return json_build_object('error', 'Dieses Team ist nicht mehr dabei.'); end if;
  if p_kind = 'finalist' and exists (select 1 from wb_picks where player_id = pid and kind = 'finalist' and slot <> p_slot and team = p_team) then
    return json_build_object('error', 'Das Team hast du schon als anderen Finalisten.');
  end if;
  insert into wb_picks (player_id, kind, slot, team) values (pid, p_kind, p_slot, p_team)
    on conflict (player_id, kind, slot) do update set team = excluded.team;
  return json_build_object('ok', true);
end $$;

-- Everything the page shows, in one call.
create or replace function public.wb_state() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'now', now(),
    'settings', (select row_to_json(s) from wb_settings s),
    'players', coalesce((select json_agg(x order by x.cash + x.open desc, x.name) from (
      select p.name, wb_cash(p.id) as cash,
        coalesce((select sum(stake) from wb_bets where player_id = p.id and status = 'open'), 0) as open,
        wb_bonus(p.id) as bonus,
        (select count(*) from wb_bets where player_id = p.id and status = 'won') as won,
        (select count(*) from wb_bets where player_id = p.id and status = 'lost') as lost,
        (select json_object_agg(kind || slot, team) from wb_picks where player_id = p.id) as picks
      from wb_players p) x), '[]'::json),
    'markets', coalesce((select json_agg(m order by m.starts_at, m.event_id, m.id) from (
      select id, event_id, event_title, stage, best_of, kind, label, outcomes, starts_at, status, result, score,
        case when status = 'open' then (select json_agg(case when x::numeric > 0 then wb_odds(x::numeric) end)
                                        from jsonb_array_elements_text(mk.prices) x) end as odds
      from wb_markets mk
      where kind = 'moneyline' or exists (select 1 from wb_bets b where b.market_id = mk.id)
         or (status = 'open' and prices is not null and starts_at > now())) m), '[]'::json),
    'bets', coalesce((select json_agg(b order by b.placed_at desc) from (
      select b.id, p.name, b.market_id, b.outcome, b.stake, b.odds, b.status, b.payout, b.placed_at
      from wb_bets b join wb_players p on p.id = b.player_id) b), '[]'::json),
    'teams', coalesce((select json_agg(t order by t.out, t.win_price desc nulls last) from wb_teams t), '[]'::json)
  )
$$;

-- ---------- GitHub Action (secret key) ----------

-- Pays out every bet of a market. p_result = winning outcome, or -1 = void (stakes back).
create or replace function public.wb_settle(p_market text, p_result int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update wb_markets set status = case when p_result < 0 then 'void' else 'settled' end,
    result = case when p_result < 0 then null else p_result end
  where id = p_market and status = 'open';
  if not found then return 0; end if;
  update wb_bets set
    status = case when p_result < 0 then 'void' when outcome = p_result then 'won' else 'lost' end,
    payout = case when p_result < 0 then stake when outcome = p_result then round(stake * odds, 2) else 0 end
  where market_id = p_market and status = 'open';
  get diagnostics n = row_count;
  return n;
end $$;

-- p: { settings: {...}, markets: [...], teams: [...], results: [{id, result}] } as built by
-- scripts/worlds.mjs. Returns the open markets that should have ended by now but got no
-- result in this call, so the script can look them up one by one.
create or replace function public.wb_sync(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m jsonb; t jsonb; settled int := 0;
begin
  for m in select * from jsonb_array_elements(coalesce(p -> 'results', '[]')) loop
    settled := settled + wb_settle(m ->> 'id', (m ->> 'result')::int);
  end loop;

  if p ? 'settings' then
    update wb_settings set
      start_day = coalesce((p #>> '{settings,start_day}')::date, start_day),
      end_day = coalesce((p #>> '{settings,end_day}')::date, end_day),
      start_balance = coalesce((p #>> '{settings,start_balance}')::numeric, start_balance),
      daily = coalesce((p #>> '{settings,daily}')::numeric, daily),
      winner_bonus = coalesce((p #>> '{settings,winner_bonus}')::numeric, winner_bonus),
      finalist_bonus = coalesce((p #>> '{settings,finalist_bonus}')::numeric, finalist_bonus),
      picks_lock = coalesce((p #>> '{settings,picks_lock}')::timestamptz, picks_lock),
      synced_at = now()
    where id = 1;
  end if;

  for m in select * from jsonb_array_elements(coalesce(p -> 'markets', '[]')) loop
    insert into wb_markets (id, event_id, event_title, stage, best_of, kind, label, outcomes, prices, starts_at, score, updated_at)
    values (m ->> 'id', m ->> 'event_id', m ->> 'event_title', m ->> 'stage', (m ->> 'best_of')::int, m ->> 'kind',
            m ->> 'label', m -> 'outcomes', nullif(m -> 'prices', 'null'), (m ->> 'starts_at')::timestamptz, m ->> 'score', now())
    on conflict (id) do update set
      event_title = excluded.event_title, stage = excluded.stage, best_of = excluded.best_of, label = excluded.label,
      outcomes = case when wb_markets.status = 'open' then excluded.outcomes else wb_markets.outcomes end,
      prices = case when wb_markets.status = 'open' then excluded.prices else wb_markets.prices end,
      starts_at = case when wb_markets.status = 'open' then excluded.starts_at else wb_markets.starts_at end,
      score = coalesce(excluded.score, wb_markets.score), updated_at = now();
    if m ? 'result' and m -> 'result' <> 'null' then
      settled := settled + wb_settle(m ->> 'id', (m ->> 'result')::int);
    end if;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p -> 'teams', '[]')) loop
    insert into wb_teams (team, win_price, final_price, out, won, finalist, updated_at)
    values (t ->> 'team', (t ->> 'win_price')::numeric, (t ->> 'final_price')::numeric, coalesce((t ->> 'out')::boolean, false),
            (t ->> 'won')::boolean, (t ->> 'finalist')::boolean, now())
    on conflict (team) do update set win_price = excluded.win_price, final_price = excluded.final_price,
      out = excluded.out, won = coalesce(excluded.won, wb_teams.won), finalist = coalesce(excluded.finalist, wb_teams.finalist), updated_at = now();
  end loop;

  return json_build_object('settled', settled, 'pending', coalesce((
    select json_agg(id) from wb_markets mk
    where status = 'open' and starts_at < now() - interval '30 minutes'
      and (kind = 'moneyline' or exists (select 1 from wb_bets b where b.market_id = mk.id))), '[]'::json));
end $$;

-- ---------- Who may call what ----------
revoke execute on function public.wb_settle(text, int), public.wb_sync(jsonb), public.wb_cash(bigint),
  public.wb_bonus(bigint), public.wb_player(uuid) from public, anon, authenticated;
grant execute on function public.wb_state(), public.wb_register(text, text), public.wb_login(text, text),
  public.wb_logout(uuid), public.wb_bet(uuid, text, int, numeric, numeric), public.wb_pick(uuid, text, int, text),
  public.wb_today(), public.wb_odds(numeric) to anon, authenticated;
grant execute on function public.wb_settle(text, int), public.wb_sync(jsonb) to service_role;
