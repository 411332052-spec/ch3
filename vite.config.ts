import { defineConfig } from 'vite';

// GitHub Pages 的網址是 https://<帳號>.github.io/<repo 名稱>/，
// 所以正式建置時網頁的資源路徑要以 /<repo 名稱>/ 開頭。本機開發則用根路徑。
const REPO_NAME = 'ch3';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? `/${REPO_NAME}/` : '/',
}));
