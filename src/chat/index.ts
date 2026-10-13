// 畫面取得資料來源的唯一入口。
// 階段二接上 Supabase 時，只要把這裡改成回傳 Supabase 的實作即可。
import { createMockClient } from './mock';
import type { ChatClient } from './types';

export function createChatClient(): ChatClient {
  return createMockClient();
}
