-- รันใน Supabase Dashboard → SQL Editor → Run
-- ระบบ username + password โดยตรง (ไม่ใช้ email)

create extension if not exists pgcrypto with schema extensions;

-- ลบของเก่า (รันซ้ำได้)
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.register_player(text, text);
drop function if exists public.login_player(text, text);
drop function if exists public.verify_player(uuid);
drop function if exists public.save_player_score(uuid, integer, integer, integer, integer, text, text);
drop function if exists public.get_leaderboard(integer);
drop table if exists public.scores;
drop table if exists public.profiles;
drop table if exists public.players;

-- ผู้เล่น
create table public.players (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create unique index players_username_lower on public.players (lower(username));

-- คะแนน
create table public.scores (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players (id) on delete cascade,
  username text not null,
  score integer not null check (score >= 0),
  wave integer not null default 0,
  kills integer not null default 0,
  time_seconds integer not null default 0,
  result text not null check (result in ('victory', 'defeat')),
  mode text not null default 'solo',
  created_at timestamptz not null default now()
);

create index scores_score_desc on public.scores (score desc);
create index scores_player_id on public.scores (player_id);

alter table public.players enable row level security;
alter table public.scores enable row level security;

drop policy if exists "players_no_select" on public.players;
drop policy if exists "players_no_insert" on public.players;
drop policy if exists "players_no_update" on public.players;
drop policy if exists "scores_select" on public.scores;
drop policy if exists "scores_no_insert" on public.scores;

create policy "players_no_select" on public.players for select using (false);
create policy "players_no_insert" on public.players for insert with check (false);
create policy "players_no_update" on public.players for update using (false);

create policy "scores_select" on public.scores for select using (true);
create policy "scores_no_insert" on public.scores for insert with check (false);

-- สมัครสมาชิก
create or replace function public.register_player(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := trim(p_username);
  v_id uuid;
begin
  if length(v_name) < 2 then
    return json_build_object('ok', false, 'msg', 'ชื่อผู้ใช้ต้องมีอย่างน้อย 2 ตัวอักษร');
  end if;
  if length(v_name) > 16 then
    return json_build_object('ok', false, 'msg', 'ชื่อผู้ใช้ยาวเกิน 16 ตัวอักษร');
  end if;
  if length(p_password) < 4 then
    return json_build_object('ok', false, 'msg', 'รหัสผ่านต้องมีอย่างน้อย 4 ตัว');
  end if;
  if exists (select 1 from players where lower(username) = lower(v_name)) then
    return json_build_object('ok', false, 'msg', 'ชื่อผู้ใช้นี้มีแล้ว');
  end if;

  insert into players (username, password_hash)
  values (v_name, crypt(p_password, gen_salt('bf')))
  returning id into v_id;

  return json_build_object('ok', true, 'id', v_id, 'username', v_name);
end;
$$;

-- เข้าสู่ระบบ
create or replace function public.login_player(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row players%rowtype;
begin
  select * into v_row
  from players
  where lower(username) = lower(trim(p_username))
    and password_hash = crypt(p_password, password_hash);

  if v_row.id is null then
    return json_build_object('ok', false, 'msg', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  end if;

  return json_build_object('ok', true, 'id', v_row.id, 'username', v_row.username);
end;
$$;

-- ตรวจ session ยังใช้ได้
create or replace function public.verify_player(p_player_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select username into v_name from players where id = p_player_id;
  if v_name is null then
    return json_build_object('ok', false);
  end if;
  return json_build_object('ok', true, 'username', v_name);
end;
$$;

-- บันทึกคะแนน
create or replace function public.save_player_score(
  p_player_id uuid,
  p_score integer,
  p_wave integer,
  p_kills integer,
  p_time_seconds integer,
  p_result text,
  p_mode text default 'solo'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select username into v_name from players where id = p_player_id;
  if v_name is null then
    return json_build_object('ok', false, 'msg', 'ไม่พบผู้เล่น');
  end if;

  insert into scores (player_id, username, score, wave, kills, time_seconds, result, mode)
  values (
    p_player_id,
    v_name,
    greatest(0, coalesce(p_score, 0)),
    greatest(0, coalesce(p_wave, 0)),
    greatest(0, coalesce(p_kills, 0)),
    greatest(0, coalesce(p_time_seconds, 0)),
    case when p_result = 'victory' then 'victory' else 'defeat' end,
    coalesce(nullif(trim(p_mode), ''), 'solo')
  );

  return json_build_object('ok', true);
end;
$$;

-- ตารางอันดับรวมตามผู้เล่น (คะแนนรวม + เวลารวม + จำนวนครั้ง)
create or replace function public.get_leaderboard(p_limit integer default 5)
returns table (
  username text,
  total_score bigint,
  total_time_seconds bigint,
  play_count bigint,
  best_wave integer
)
language sql
security definer
set search_path = public
stable
as $$
  select
    max(s.username)::text as username,
    sum(s.score)::bigint as total_score,
    sum(s.time_seconds)::bigint as total_time_seconds,
    count(*)::bigint as play_count,
    max(s.wave)::integer as best_wave
  from public.scores s
  group by s.player_id
  order by sum(s.score) desc, sum(s.time_seconds) desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

grant usage on schema public to anon, authenticated;
grant execute on function public.register_player(text, text) to anon, authenticated;
grant execute on function public.login_player(text, text) to anon, authenticated;
grant execute on function public.verify_player(uuid) to anon, authenticated;
grant execute on function public.save_player_score(uuid, integer, integer, integer, integer, text, text) to anon, authenticated;
grant execute on function public.get_leaderboard(integer) to anon, authenticated;

-- บังคับให้ API โหลด function ใหม่
notify pgrst, 'reload schema';
