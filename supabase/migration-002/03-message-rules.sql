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
