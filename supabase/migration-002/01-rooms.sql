create table if not exists public.rooms (
  id text primary key check (id ~ '^[a-z0-9_-]{1,20}$'),
  name text not null check (char_length(name) between 1 and 20),
  sort int not null default 0
);

insert into public.rooms (id, name, sort) values
  ('lobby', '大廳', 1),
  ('random', '閒聊', 2),
  ('tech', '科技', 3)
on conflict (id) do nothing;

alter table public.rooms enable row level security;

drop policy if exists "rooms readable" on public.rooms;

create policy "rooms readable" on public.rooms
  for select to anon, authenticated using (true);

revoke all on public.rooms from anon, authenticated;

grant select on public.rooms to anon, authenticated;
