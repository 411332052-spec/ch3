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
