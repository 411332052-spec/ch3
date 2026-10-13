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
