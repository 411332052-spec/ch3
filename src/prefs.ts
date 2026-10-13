// 使用者的個人偏好：深淺色模式、提示音、桌面通知。
// 只記在這個瀏覽器（localStorage），不會傳給別人，也不會碰資料庫。
export type ThemeMode = 'auto' | 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不了就只在這次有效
  }
}

const THEME_KEY = 'chat.theme';
const SOUND_KEY = 'chat.sound';
const NOTIFY_KEY = 'chat.notify';

export function getThemeMode(): ThemeMode {
  const saved = read(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'auto';
}

/** 套用深淺色模式：auto 代表跟隨裝置設定 */
export function applyThemeMode(mode: ThemeMode = getThemeMode()) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

export function setThemeMode(mode: ThemeMode) {
  write(THEME_KEY, mode);
  applyThemeMode(mode);
}

export const getSoundEnabled = (): boolean => read(SOUND_KEY) !== 'off';
export const setSoundEnabled = (on: boolean) => write(SOUND_KEY, on ? 'on' : 'off');

export const getNotifyEnabled = (): boolean => read(NOTIFY_KEY) === 'on';
export const setNotifyEnabled = (on: boolean) => write(NOTIFY_KEY, on ? 'on' : 'off');
