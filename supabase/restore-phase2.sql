drop policy if exists "anyone can read" on public.messages;

drop policy if exists "anyone can insert" on public.messages;

create policy "anyone can read" on public.messages
  for select to anon using (true);

create policy "anyone can insert" on public.messages
  for insert to anon with check (true);

revoke all on public.messages from anon;

grant select on public.messages to anon;

grant insert (client_msg_id, nickname, body) on public.messages to anon;

alter table public.messages drop constraint if exists messages_nickname_check;

alter table public.messages add constraint messages_nickname_check check (nickname ~ '^[A-Za-z0-9]{1,12}$');

alter table public.messages drop constraint if exists messages_body_check;

alter table public.messages add constraint messages_body_check check (char_length(btrim(body)) > 0 and char_length(body) <= 2000);

drop policy if exists "rooms insert" on public.rooms;

drop policy if exists "blocked words read" on public.blocked_words;

revoke all on public.rooms from anon, authenticated;

revoke all on public.blocked_words from anon, authenticated;
