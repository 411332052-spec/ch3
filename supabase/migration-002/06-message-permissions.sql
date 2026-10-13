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
