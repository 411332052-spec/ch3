select 'column' as kind,
  table_name || '.' || column_name || ' : ' || data_type
  || ' / nullable=' || is_nullable
  || ' / default=' || coalesce(column_default, '') as info
from information_schema.columns
where table_schema = 'public'
  and table_name in ('messages', 'rooms', 'reactions', 'blocked_words')
union all
select 'policy',
  schemaname || '.' || tablename || ' : ' || policyname
  || ' / ' || cmd || ' / ' || array_to_string(roles, ',')
from pg_policies
where schemaname = 'storage'
  or (schemaname = 'public'
    and tablename in ('messages', 'rooms', 'reactions', 'blocked_words'))
union all
select 'trigger',
  event_object_table || ' : ' || trigger_name
  || ' / ' || action_timing || ' ' || event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
union all
select 'function', routine_name
from information_schema.routines
where routine_schema = 'public'
order by 1, 2;
