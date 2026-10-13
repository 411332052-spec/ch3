// 讀取環境變數。階段一不會用到；階段二接 Supabase 時才使用。
// 這兩個都是公開值（專案網址與 anon key）。service_role key 絕不能出現在這裡。
export const config = {
  supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '',
  supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
};
