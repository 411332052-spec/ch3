do $body$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where (schemaname = 'public' and tablename in ('messages', 'rooms', 'reactions', 'blocked_words'))
      or (schemaname = 'storage' and tablename = 'objects' and policyname like 'chat images%')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;

  for r in
    select conname from pg_constraint
    where conrelid = 'public.messages'::regclass and contype in ('c', 'f')
  loop
    execute format('alter table public.messages drop constraint if exists %I', r.conname);
  end loop;

  if to_regclass('public.rooms') is not null
    and not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'rooms' and column_name = 'sort') then
    drop table public.rooms cascade;
  end if;

  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'blocked_words' and column_name = 'id') then
    drop table public.blocked_words cascade;
  end if;

  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'room' and data_type <> 'text') then
    alter table public.messages drop column room cascade;
  end if;

  if to_regclass('public.reactions') is not null
    and not exists (select 1 from pg_trigger where tgname = 'reactions_before_insert' and not tgisinternal) then
    drop table public.reactions cascade;
  end if;
end;
$body$;

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

alter table public.messages add column if not exists user_id uuid;

alter table public.messages add column if not exists room text;

alter table public.messages add column if not exists recipient_id uuid;

alter table public.messages add column if not exists to_nickname text;

alter table public.messages add column if not exists reply_to bigint;

alter table public.messages add column if not exists reply_nickname text;

alter table public.messages add column if not exists reply_snippet text;

alter table public.messages add column if not exists image_path text;

alter table public.messages add column if not exists edited_at timestamptz;

alter table public.messages add column if not exists deleted_at timestamptz;

update public.messages set room = 'lobby' where recipient_id is null and (room is null or room not in (select id from public.rooms));

alter table public.messages alter column room set default 'lobby';

alter table public.messages alter column user_id set default auth.uid();

alter table public.messages drop constraint if exists messages_room_fkey;

alter table public.messages add constraint messages_room_fkey foreign key (room) references public.rooms (id);

alter table public.messages drop constraint if exists messages_reply_to_fkey;

alter table public.messages add constraint messages_reply_to_fkey foreign key (reply_to) references public.messages (id);

alter table public.messages drop constraint if exists messages_nickname_check;

alter table public.messages add constraint messages_nickname_check check (nickname ~ '^[A-Za-z0-9]{1,12}$');

alter table public.messages drop constraint if exists messages_target_check;

alter table public.messages add constraint messages_target_check check ((recipient_id is null and room is not null) or (recipient_id is not null and room is null));

alter table public.messages drop constraint if exists messages_to_nickname_check;

alter table public.messages add constraint messages_to_nickname_check check (to_nickname is null or to_nickname ~ '^[A-Za-z0-9]{1,12}$');

alter table public.messages drop constraint if exists messages_image_path_check;

alter table public.messages add constraint messages_image_path_check check (image_path is null or image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](jpg|png|gif|webp)$');

alter table public.messages drop constraint if exists messages_body_check;

alter table public.messages add constraint messages_body_check check ((char_length(btrim(body)) > 0 or image_path is not null) and char_length(body) <= 2000);

create index if not exists messages_room_id_idx on public.messages (room, id desc);

create index if not exists messages_recipient_id_idx on public.messages (recipient_id, id desc);

create index if not exists messages_user_time_idx on public.messages (user_id, created_at desc);

create table if not exists public.blocked_words (
  word text primary key check (char_length(word) between 1 and 40)
);

alter table public.blocked_words enable row level security;

revoke all on public.blocked_words from anon, authenticated;

insert into public.blocked_words (word) values
  ('fuck'), ('shit'), ('bitch'), ('幹你娘'), ('操你媽'), ('去死')
on conflict (word) do nothing;

create or replace function public.mask_blocked_words(input text)
returns text
language plpgsql
security definer
set search_path = public
as $body$
declare
  w record;
  result text := input;
begin
  for w in select word from public.blocked_words order by char_length(word) desc loop
    result := regexp_replace(
      result,
      regexp_replace(w.word, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'),
      repeat('*', char_length(w.word)),
      'gi'
    );
  end loop;
  return result;
end;
$body$;

revoke all on function public.mask_blocked_words(text) from public, anon, authenticated;

create or replace function public.messages_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
declare
  recent int;
  ref record;
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if new.recipient_id = new.user_id then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  select count(*) into recent from public.messages
    where user_id = new.user_id and created_at > now() - interval '10 seconds';
  if recent >= 5 then
    raise exception 'rate_limit' using errcode = 'P0001';
  end if;
  select count(*) into recent from public.messages
    where user_id = new.user_id and created_at > now() - interval '1 minute';
  if recent >= 20 then
    raise exception 'rate_limit' using errcode = 'P0001';
  end if;
  new.body := public.mask_blocked_words(new.body);
  new.created_at := now();
  new.edited_at := null;
  new.deleted_at := null;
  new.reply_nickname := null;
  new.reply_snippet := null;
  if new.reply_to is not null then
    select m.nickname, left(m.body, 80) as snippet, m.deleted_at, m.room, m.recipient_id
      into ref
      from public.messages m
      where m.id = new.reply_to
        and (m.recipient_id is null or m.user_id = new.user_id or m.recipient_id = new.user_id);
    if found and (new.recipient_id is not null or (ref.recipient_id is null and ref.room = new.room)) then
      new.reply_nickname := ref.nickname;
      if ref.deleted_at is null then
        new.reply_snippet := ref.snippet;
      end if;
    else
      new.reply_to := null;
    end if;
  end if;
  return new;
end;
$body$;

drop trigger if exists messages_before_insert on public.messages;

create trigger messages_before_insert
  before insert on public.messages
  for each row execute function public.messages_before_insert();

create or replace function public.messages_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
begin
  if old.deleted_at is not null then
    raise exception 'already_deleted' using errcode = '42501';
  end if;
  new.id := old.id;
  new.client_msg_id := old.client_msg_id;
  new.user_id := old.user_id;
  new.nickname := old.nickname;
  new.room := old.room;
  new.recipient_id := old.recipient_id;
  new.to_nickname := old.to_nickname;
  new.reply_to := old.reply_to;
  new.reply_nickname := old.reply_nickname;
  new.reply_snippet := old.reply_snippet;
  new.image_path := old.image_path;
  new.created_at := old.created_at;
  if new.deleted_at is not null then
    new.deleted_at := now();
    new.body := '[已刪除]';
    new.image_path := null;
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body then
    new.body := public.mask_blocked_words(new.body);
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end;
$body$;

drop trigger if exists messages_before_update on public.messages;

create trigger messages_before_update
  before update on public.messages
  for each row execute function public.messages_before_update();

drop policy if exists "anyone can read" on public.messages;

drop policy if exists "anyone can insert" on public.messages;

drop policy if exists "read public or own dm" on public.messages;

drop policy if exists "insert as self" on public.messages;

drop policy if exists "update own" on public.messages;

create policy "read public or own dm" on public.messages
  for select to anon, authenticated
  using (recipient_id is null or user_id = auth.uid() or recipient_id = auth.uid());

create policy "insert as self" on public.messages
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "update own" on public.messages
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.messages from anon, authenticated;

grant select on public.messages to anon, authenticated;

grant insert (client_msg_id, nickname, body, room, recipient_id, to_nickname, reply_to, image_path) on public.messages to authenticated;

grant update (body, deleted_at) on public.messages to authenticated;

create table if not exists public.reactions (
  message_id bigint not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid(),
  emoji text not null check (char_length(emoji) between 1 and 16 and emoji !~ '[A-Za-z0-9<>&" '']'),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists reactions_message_idx on public.reactions (message_id);

alter table public.reactions enable row level security;

drop policy if exists "reactions read" on public.reactions;

drop policy if exists "reactions insert" on public.reactions;

drop policy if exists "reactions delete own" on public.reactions;

create policy "reactions read" on public.reactions
  for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id));

create policy "reactions insert" on public.reactions
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null));

create policy "reactions delete own" on public.reactions
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.reactions from anon, authenticated;

grant select on public.reactions to authenticated;

grant insert (message_id, emoji) on public.reactions to authenticated;

grant delete on public.reactions to authenticated;

create or replace function public.reactions_before_insert()
returns trigger
language plpgsql
as $body$
begin
  new.user_id := auth.uid();
  if (select count(*) from public.reactions where message_id = new.message_id and user_id = new.user_id) >= 6 then
    raise exception 'too_many_reactions' using errcode = 'P0001';
  end if;
  return new;
end;
$body$;

drop trigger if exists reactions_before_insert on public.reactions;

create trigger reactions_before_insert
  before insert on public.reactions
  for each row execute function public.reactions_before_insert();

do $body$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reactions'
  ) then
    alter publication supabase_realtime add table public.reactions;
  end if;
end;
$body$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', true, 2097152, array['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

drop policy if exists "chat images upload to own folder" on storage.objects;

create policy "chat images upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-images' and (storage.foldername(name))[1] = auth.uid()::text);

