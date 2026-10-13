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
