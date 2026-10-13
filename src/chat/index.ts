// 畫面取得資料來源的唯一入口。
// 有設定 Supabase 的網址與公開金鑰就用真的；沒有設定（例如剛 clone 下來、還沒建 .env.local）
// 就退回階段一的模擬資料，方便本機開發。
import { config } from '../config';
import { createMockClient } from './mock';
import { createSupabaseClient } from './supabase';
import type { ChatClient } from './types';

export function createChatClient(): ChatClient {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    return createSupabaseClient(config.supabaseUrl, config.supabaseAnonKey);
  }
  console.warn('沒有設定 VITE_SUPABASE_URL／VITE_SUPABASE_ANON_KEY，改用模擬資料。');
  return createMockClient();
}
