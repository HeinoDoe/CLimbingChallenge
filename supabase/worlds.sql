-- Worlds Tippspiel (like Kicktipp): everyone tips every Worlds match, points for the right
-- winner or the exact series score, plus bonus questions (world champion, finalists, ...).
-- Run it in the Supabase SQL editor, or:
--   npx supabase db query --linked --project-ref <ref> -f supabase/worlds.sql
-- Running it again is safe.
--
-- The website talks to the database only through the wb_* functions below (publishable
-- key); the tables themselves are closed. scripts/worlds.mjs (GitHub Action, secret key)
-- copies the schedule, odds and results from Polymarket with wb_sync().

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Remove the first version (betting with Justus Bucks) ----------
drop function if exists public.wb_bet(uuid, text, int, numeric, numeric);
drop function if exists public.wb_cash(bigint);
drop function if exists public.wb_bonus(bigint);
drop function if exists public.wb_odds(numeric);
drop function if exists public.wb_settle(text, int);
drop function if exists public.wb_state();
drop function if exists public.wb_today();
drop table if exists public.wb_bets;
drop table if exists public.wb_markets;
alter table if exists public.wb_settings drop column if exists start_balance, drop column if exists daily,
  drop column if exists winner_bonus, drop column if exists finalist_bonus, drop column if exists picks_lock;
alter table if exists public.wb_teams drop column if exists win_price, drop column if exists final_price,
  drop column if exists won, drop column if exists finalist;
alter table if exists public.wb_picks drop constraint if exists wb_picks_kind_check, drop constraint if exists wb_picks_slot_check;

-- ---------- Tables ----------

create table if not exists public.wb_settings (
  id int primary key default 1 check (id = 1),
  start_day date not null default '2026-10-20',
  end_day date not null default '2026-11-14',
  synced_at timestamptz
);
alter table public.wb_settings add column if not exists pts_bo1 int not null default 2,
  add column if not exists pts_winner int not null default 2, add column if not exists pts_exact int not null default 4;
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

-- One row per Worlds match (a Polymarket event). price_a = chance of team A to win the
-- series; fav_a:fav_b = the auto-tip for players without a tip (the favourite's most
-- likely score). Both freeze when the match starts.
create table if not exists public.wb_matches (
  id text primary key,
  title text not null,
  team_a text not null,
  team_b text not null,
  stage text,
  best_of int not null default 1 check (best_of in (1, 3, 5)),
  starts_at timestamptz not null,
  price_a numeric,
  fav_a int,
  fav_b int,
  status text not null default 'open' check (status in ('open', 'done', 'void')),
  score_a int,
  score_b int,
  updated_at timestamptz not null default now()
);

create table if not exists public.wb_tips (
  player_id bigint not null references public.wb_players on delete cascade,
  match_id text not null references public.wb_matches on delete cascade,
  a int not null,
  b int not null,
  placed_at timestamptz not null default now(),
  primary key (player_id, match_id)
);

create table if not exists public.wb_teams (
  team text primary key,
  out boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Bonus questions ("winner", "finalist", "swiss30", ...): how many teams, points per right
-- team, and when they lock. Copied from squad.config.json on every sync.
create table if not exists public.wb_pick_types (
  kind text primary key,
  title text not null,
  slots int not null check (slots between 1 and 16),
  points int not null,
  lock_at timestamptz not null,
  sort int not null default 0
);

-- Per bonus question and team: Polymarket's chance and, once known, whether it came true.
create table if not exists public.wb_team_odds (
  kind text not null references public.wb_pick_types on delete cascade,
  team text not null,
  price numeric,
  hit boolean,
  updated_at timestamptz not null default now(),
  primary key (kind, team)
);

create table if not exists public.wb_picks (
  player_id bigint not null references public.wb_players on delete cascade,
  kind text not null,
  slot int not null,
  team text not null references public.wb_teams,
  primary key (player_id, kind, slot)
);

alter table public.wb_settings enable row level security;
alter table public.wb_players enable row level security;
alter table public.wb_sessions enable row level security;
alter table public.wb_matches enable row level security;
alter table public.wb_tips enable row level security;
alter table public.wb_teams enable row level security;
alter table public.wb_pick_types enable row level security;
alter table public.wb_team_odds enable row level security;
alter table public.wb_picks enable row level security;
revoke all on public.wb_settings, public.wb_players, public.wb_sessions, public.wb_matches, public.wb_tips,
  public.wb_teams, public.wb_pick_types, public.wb_team_odds, public.wb_picks from anon, authenticated;

-- ---------- Helpers ----------

create or replace function public.wb_player(p_token uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select player_id from wb_sessions where token = p_token
$$;

-- A possible series result: BO1 1:0/0:1, BO3 2:0 2:1 1:2 0:2, BO5 3:0 … 0:3.
create or replace function public.wb_valid(bo int, a int, b int) returns boolean
language sql immutable as $$
  select coalesce(case when bo = 1 then (a = 1 and b = 0) or (a = 0 and b = 1)
                       else greatest(a, b) = (bo + 1) / 2 and least(a, b) between 0 and (bo + 1) / 2 - 1 end, false)
$$;

-- Kicktipp points for a tip: right winner, or the exact score in a BO3/BO5.
create or replace function public.wb_points(bo int, ta int, tb int, ra int, rb int) returns int
language sql stable security definer set search_path = public as $$
  select case when ta is null or tb is null or ra is null or rb is null then 0
              when sign(ta - tb) <> sign(ra - rb) then 0
              when bo = 1 then s.pts_bo1
              when ta = ra and tb = rb then s.pts_exact
              else s.pts_winner end
  from wb_settings s where s.id = 1
$$;

-- ---------- Website calls (publishable key) ----------

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

-- Tip a match until it starts. p_a/p_b null removes the tip (then the auto-tip counts).
create or replace function public.wb_tip(p_token uuid, p_match text, p_a int, p_b int) returns json
language plpgsql security definer set search_path = public as $$
declare pid bigint := wb_player(p_token); m wb_matches;
begin
  if pid is null then return json_build_object('error', 'Bitte neu einloggen.', 'relogin', true); end if;
  select * into m from wb_matches where id = p_match;
  if m.id is null then return json_build_object('error', 'Dieses Spiel gibt es nicht.'); end if;
  if m.status <> 'open' or m.starts_at <= now() then return json_build_object('error', 'Das Spiel hat schon angefangen.'); end if;
  if p_a is null and p_b is null then
    delete from wb_tips where player_id = pid and match_id = m.id;
    return json_build_object('ok', true);
  end if;
  if not wb_valid(m.best_of, p_a, p_b) then return json_build_object('error', 'Dieses Ergebnis gibt es nicht.'); end if;
  insert into wb_tips (player_id, match_id, a, b) values (pid, m.id, p_a, p_b)
    on conflict (player_id, match_id) do update set a = excluded.a, b = excluded.b, placed_at = now();
  return json_build_object('ok', true);
end $$;

-- Bonus question: tap a team to choose it, tap again to remove it. With one slot a new team
-- replaces the old one; with more slots they fill up in order.
drop function if exists public.wb_pick(uuid, text, int, text);
create or replace function public.wb_pick(p_token uuid, p_kind text, p_team text) returns json
language plpgsql security definer set search_path = public as $$
declare pid bigint := wb_player(p_token); pt wb_pick_types; t wb_teams; n int;
begin
  if pid is null then return json_build_object('error', 'Bitte neu einloggen.', 'relogin', true); end if;
  select * into pt from wb_pick_types where kind = p_kind;
  if pt.kind is null then return json_build_object('error', 'Diese Bonusfrage gibt es nicht.'); end if;
  if now() >= pt.lock_at then return json_build_object('error', 'Diese Bonusfrage ist schon gesperrt.'); end if;
  perform 1 from wb_players where id = pid for update;  -- one change at a time per player
  if exists (select 1 from wb_picks where player_id = pid and kind = p_kind and team = p_team) then
    delete from wb_picks where player_id = pid and kind = p_kind and team = p_team;
    -- close the gap: slots stay 1..n
    update wb_picks set slot = slot + 100 where player_id = pid and kind = p_kind;
    update wb_picks k set slot = r.n from (
      select team, row_number() over (order by slot) as n from wb_picks where player_id = pid and kind = p_kind) r
    where k.player_id = pid and k.kind = p_kind and k.team = r.team;
    return json_build_object('ok', true, 'picked', false);
  end if;
  select * into t from wb_teams where team = p_team;
  if t.team is null or t.out then return json_build_object('error', 'Dieses Team ist nicht mehr dabei.'); end if;
  if pt.slots = 1 then delete from wb_picks where player_id = pid and kind = p_kind; end if;
  select count(*) into n from wb_picks where player_id = pid and kind = p_kind;
  if n >= pt.slots then
    return json_build_object('error', format('Du hast schon %s Teams gewählt. Tipp eins an, um es abzuwählen.', pt.slots));
  end if;
  insert into wb_picks (player_id, kind, slot, team) values (pid, p_kind, n + 1, p_team);
  return json_build_object('ok', true, 'picked', true);
end $$;

-- Everything the page shows, in one call. With a token it also holds your own tips;
-- other players' tips appear once a match has started, their bonus answers once locked.
create or replace function public.wb_state(p_token uuid default null) returns json
language sql stable security definer set search_path = public as $$
  with me as (select wb_player(p_token) as id),
  s as (select * from wb_settings where id = 1),
  ms as (select m.* from wb_matches m, s where m.starts_at >= (s.start_day::timestamp at time zone 'Europe/Berlin')),
  -- every player's tip on every started match: their own, else the favourite (auto-tip)
  board as (
    select p.id as player_id, p.name, m.id as match_id, m.best_of, m.status, m.score_a, m.score_b,
      coalesce(t.a, m.fav_a) as a, coalesce(t.b, m.fav_b) as b, t.player_id is null as auto,
      case when m.status = 'done' then wb_points(m.best_of, coalesce(t.a, m.fav_a), coalesce(t.b, m.fav_b), m.score_a, m.score_b) end as pts
    from wb_players p cross join ms m
    left join wb_tips t on t.player_id = p.id and t.match_id = m.id
    where m.starts_at <= now() or m.status <> 'open'
  ),
  bonus as (
    select k.player_id, sum(pt.points) as pts
    from wb_picks k join wb_pick_types pt on pt.kind = k.kind join wb_team_odds o on o.kind = k.kind and o.team = k.team
    where o.hit group by k.player_id
  ),
  totals as (
    select p.id, p.name,
      coalesce((select sum(b.pts) from board b where b.player_id = p.id), 0) as match_points,
      coalesce((select bo.pts from bonus bo where bo.player_id = p.id), 0) as bonus,
      (select count(*) from board b where b.player_id = p.id and b.status = 'done' and b.best_of > 1 and b.a = b.score_a and b.b = b.score_b) as exact,
      (select count(*) from board b where b.player_id = p.id and b.status = 'done' and b.pts > 0) as hits,
      (select count(*) from board b where b.player_id = p.id and b.status = 'done' and b.auto) as auto
    from wb_players p
  )
  select json_build_object(
    'now', now(),
    'me', (select name from wb_players where id = (select id from me)),
    'settings', (select json_build_object('start_day', start_day, 'end_day', end_day, 'pts_bo1', pts_bo1,
                   'pts_winner', pts_winner, 'pts_exact', pts_exact, 'synced_at', synced_at) from s),
    'players', coalesce((select json_agg(json_build_object('name', x.name, 'points', x.match_points + x.bonus,
        'match_points', x.match_points, 'bonus', x.bonus, 'exact', x.exact, 'hits', x.hits, 'auto', x.auto,
        'picks', (select json_object_agg(z.kind, z.teams) from (
            select k.kind, json_agg(k.team order by k.slot) as teams from wb_picks k join wb_pick_types pt on pt.kind = k.kind
            where k.player_id = x.id and (now() >= pt.lock_at or k.player_id = (select id from me)) group by k.kind) z))
      order by x.match_points + x.bonus desc, x.exact desc, x.name) from totals x), '[]'::json),
    'matches', coalesce((select json_agg(j order by j.starts_at, j.id) from (
        select m.id, m.title, m.team_a, m.team_b, m.stage, m.best_of, m.starts_at, m.price_a, m.fav_a, m.fav_b,
          m.status, m.score_a, m.score_b,
          (select json_build_object('a', t.a, 'b', t.b) from wb_tips t where t.match_id = m.id and t.player_id = (select id from me)) as mine,
          (select count(*) from wb_tips t where t.match_id = m.id) as tipped,
          (select json_agg(json_build_object('name', b.name, 'a', b.a, 'b', b.b, 'auto', b.auto, 'pts', b.pts)
                  order by b.pts desc nulls last, b.name) from board b where b.match_id = m.id) as tips
        from ms m) j), '[]'::json),
    'pick_types', coalesce((select json_agg(pt order by pt.sort, pt.kind) from wb_pick_types pt), '[]'::json),
    'team_odds', coalesce((select json_agg(json_build_object('kind', o.kind, 'team', o.team, 'price', o.price, 'hit', o.hit)) from wb_team_odds o), '[]'::json),
    'teams', coalesce((select json_agg(json_build_object('team', t.team, 'out', t.out) order by t.team) from wb_teams t), '[]'::json)
  )
$$;

-- ---------- GitHub Action (secret key) ----------

-- p: { settings, pick_types, matches, teams, team_odds } as built by scripts/worlds.mjs.
-- A match with "result": [a, b] is finished, "void": true means it was not played.
-- Returns the open matches that should have ended by now, so the script can look them up.
create or replace function public.wb_sync(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare m jsonb; t jsonb; done int := 0;
begin
  if p ? 'settings' then
    update wb_settings set
      start_day = coalesce((p #>> '{settings,start_day}')::date, start_day),
      end_day = coalesce((p #>> '{settings,end_day}')::date, end_day),
      pts_bo1 = coalesce((p #>> '{settings,pts_bo1}')::int, pts_bo1),
      pts_winner = coalesce((p #>> '{settings,pts_winner}')::int, pts_winner),
      pts_exact = coalesce((p #>> '{settings,pts_exact}')::int, pts_exact),
      synced_at = now()
    where id = 1;
  end if;

  for t in select * from jsonb_array_elements(coalesce(p -> 'pick_types', '[]')) loop
    insert into wb_pick_types (kind, title, slots, points, lock_at, sort)
    values (t ->> 'kind', t ->> 'title', (t ->> 'slots')::int, (t ->> 'points')::int, (t ->> 'lock_at')::timestamptz, coalesce((t ->> 'sort')::int, 0))
    on conflict (kind) do update set title = excluded.title, slots = excluded.slots, points = excluded.points,
      lock_at = excluded.lock_at, sort = excluded.sort;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p -> 'teams', '[]')) loop
    insert into wb_teams (team, out, updated_at) values (t ->> 'team', coalesce((t ->> 'out')::boolean, false), now())
    on conflict (team) do update set out = excluded.out, updated_at = now();
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p -> 'team_odds', '[]')) loop
    insert into wb_team_odds (kind, team, price, hit, updated_at)
    values (t ->> 'kind', t ->> 'team', (t ->> 'price')::numeric, (t ->> 'hit')::boolean, now())
    on conflict (kind, team) do update set price = excluded.price, hit = coalesce(excluded.hit, wb_team_odds.hit), updated_at = now();
  end loop;

  for m in select * from jsonb_array_elements(coalesce(p -> 'matches', '[]')) loop
    insert into wb_matches (id, title, team_a, team_b, stage, best_of, starts_at, price_a, fav_a, fav_b, updated_at)
    values (m ->> 'id', m ->> 'title', m ->> 'team_a', m ->> 'team_b', m ->> 'stage', coalesce((m ->> 'best_of')::int, 1),
            (m ->> 'starts_at')::timestamptz, (m ->> 'price_a')::numeric, (m ->> 'fav_a')::int, (m ->> 'fav_b')::int, now())
    on conflict (id) do update set
      title = excluded.title, team_a = excluded.team_a, team_b = excluded.team_b, stage = excluded.stage, best_of = excluded.best_of,
      starts_at = case when wb_matches.status = 'open' then excluded.starts_at else wb_matches.starts_at end,
      -- odds and the auto-tip freeze at the start
      price_a = case when wb_matches.status = 'open' and wb_matches.starts_at > now() then coalesce(excluded.price_a, wb_matches.price_a) else wb_matches.price_a end,
      fav_a = case when wb_matches.status = 'open' and wb_matches.starts_at > now() then coalesce(excluded.fav_a, wb_matches.fav_a) else wb_matches.fav_a end,
      fav_b = case when wb_matches.status = 'open' and wb_matches.starts_at > now() then coalesce(excluded.fav_b, wb_matches.fav_b) else wb_matches.fav_b end,
      updated_at = now();
    if coalesce((m ->> 'void')::boolean, false) then
      update wb_matches set status = 'void' where id = m ->> 'id' and status = 'open';
      if found then done := done + 1; end if;
    elsif jsonb_typeof(m -> 'result') = 'array' then
      update wb_matches set status = 'done', score_a = (m #>> '{result,0}')::int, score_b = (m #>> '{result,1}')::int
      where id = m ->> 'id' and status = 'open' and wb_valid(best_of, (m #>> '{result,0}')::int, (m #>> '{result,1}')::int);
      if found then done := done + 1; end if;
    end if;
  end loop;

  return json_build_object('finished', done, 'pending', coalesce((
    select json_agg(m.id) from wb_matches m, wb_settings s
    where m.status = 'open' and m.starts_at < now() - interval '30 minutes'
      and m.starts_at >= (s.start_day::timestamp at time zone 'Europe/Berlin')), '[]'::json));
end $$;

-- ---------- Who may call what ----------
revoke execute on function public.wb_sync(jsonb), public.wb_player(uuid), public.wb_points(int, int, int, int, int)
  from public, anon, authenticated;
grant execute on function public.wb_state(uuid), public.wb_register(text, text), public.wb_login(text, text),
  public.wb_logout(uuid), public.wb_tip(uuid, text, int, int), public.wb_pick(uuid, text, text),
  public.wb_valid(int, int, int) to anon, authenticated;
grant execute on function public.wb_sync(jsonb) to service_role;
