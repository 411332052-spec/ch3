-- 匿名聊天室的資料表與安全規則。
-- 使用方式：Supabase 專案 > SQL Editor > New query > 貼上整份 > Run。
-- 只需要執行一次；重複執行會因為資料表已存在而報錯，不會弄壞資料。

create table public.messages (
  id            bigint generated always as identity primary key,
  client_msg_id uuid not null unique,
  nickname      text not null check (nickname ~ '^[A-Za-z0-9]{1,12}$'),
  body          text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 2000),
  created_at    timestamptz not null default now()
);

-- 開啟資料列安全規則（RLS）：沒有明確允許的事，一律不能做
alter table public.messages enable row level security;

create policy "anyone can read"   on public.messages for select to anon using (true);
create policy "anyone can insert" on public.messages for insert to anon with check (true);

-- 匿名訪客只能讀取，並且只能填這三個欄位新增；不能指定 id 和時間，也不能修改或刪除
revoke all on public.messages from anon;
grant select on public.messages to anon;
grant insert (client_msg_id, nickname, body) on public.messages to anon;

-- 開啟即時通知：有新訊息時通知所有在線的人
alter publication supabase_realtime add table public.messages;
