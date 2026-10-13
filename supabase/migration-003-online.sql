create table if not exists public.online_users (
  client_id uuid primary key,
  user_id uuid not null default auth.uid(),
  nickname text not null check (nickname ~ '^[A-Za-z0-9]{1,12}$'),
  room text not null default 'lobby' references public.rooms (id),
  typing boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create unique index if not exists online_users_nickname_key on public.online_users (lower(nickname));

create index if not exists online_users_last_seen_idx on public.online_users (last_seen);

alter table public.online_users enable row level security;

drop policy if exists "online read" on public.online_users;

drop policy if exists "online insert own" on public.online_users;

drop policy if exists "online update own" on public.online_users;

drop policy if exists "online delete own" on public.online_users;

create policy "online read" on public.online_users
  for select to authenticated using (true);

create policy "online insert own" on public.online_users
  for insert to authenticated with check (user_id = auth.uid());

create policy "online update own" on public.online_users
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "online delete own" on public.online_users
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.online_users from anon, authenticated;

grant select on public.online_users to authenticated;

grant insert (client_id, nickname, room) on public.online_users to authenticated;

grant update (room, typing, last_seen) on public.online_users to authenticated;

grant delete on public.online_users to authenticated;

create or replace function public.online_users_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  new.typing := false;
  new.joined_at := now();
  new.last_seen := now();
  delete from public.online_users where last_seen < now() - interval '45 seconds';
  delete from public.online_users
    where user_id = new.user_id
      and lower(nickname) = lower(new.nickname)
      and last_seen < now() - interval '20 seconds';
  return new;
end;
$body$;

drop trigger if exists online_users_before_insert on public.online_users;

create trigger online_users_before_insert
  before insert on public.online_users
  for each row execute function public.online_users_before_insert();

create or replace function public.online_users_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
begin
  new.client_id := old.client_id;
  new.user_id := old.user_id;
  new.nickname := old.nickname;
  new.joined_at := old.joined_at;
  new.last_seen := now();
  return new;
end;
$body$;

drop trigger if exists online_users_before_update on public.online_users;

create trigger online_users_before_update
  before update on public.online_users
  for each row execute function public.online_users_before_update();

create or replace function public.online_now()
returns setof public.online_users
language sql
stable
security invoker
set search_path = public
as $body$
  select * from public.online_users where last_seen > now() - interval '45 seconds' order by joined_at;
$body$;

revoke all on function public.online_now() from public, anon;

grant execute on function public.online_now() to authenticated;

do $body$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'online_users'
  ) then
    alter publication supabase_realtime add table public.online_users;
  end if;
end;
$body$;
