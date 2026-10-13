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
