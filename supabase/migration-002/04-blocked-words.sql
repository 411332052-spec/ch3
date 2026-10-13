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
