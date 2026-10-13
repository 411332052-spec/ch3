// 使用者自訂「主色」（自己的訊息泡泡、送出與進入按鈕等）。
// 只記在這個瀏覽器（localStorage），不會傳給別人，也不會碰資料庫。
const STORAGE_KEY = 'chat.accent';
const HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_ACCENT = '#0f766e';

export const PRESETS: { name: string; hex: string }[] = [
  { name: '青綠（預設）', hex: DEFAULT_ACCENT },
  { name: '藍色', hex: '#1d4ed8' },
  { name: '紫色', hex: '#7e22ce' },
  { name: '玫瑰紅', hex: '#be123c' },
  { name: '橘色', hex: '#c2410c' },
  { name: '石板灰', hex: '#334155' },
];

function luminance(hex: string): number {
  const channel = (start: number) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** 在主色上的文字用白色或深色，挑對比較高的那個，任何顏色都看得清楚 */
function readableOn(hex: string): string {
  const l = luminance(hex);
  const withWhite = 1.05 / (l + 0.05);
  const withDark = (l + 0.05) / 0.05;
  return withWhite >= withDark ? '#ffffff' : '#14211f';
}

export function getAccent(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && HEX.test(saved) ? saved.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 套用主色並記住；傳入 null 代表恢復預設 */
export function setAccent(hex: string | null) {
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (hex && HEX.test(hex)) {
    const value = hex.toLowerCase();
    root.style.setProperty('--mine', value);
    root.style.setProperty('--on-mine', readableOn(value));
    meta?.setAttribute('content', value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // 存不了就只在這次有效
    }
  } else {
    root.style.removeProperty('--mine');
    root.style.removeProperty('--on-mine');
    meta?.setAttribute('content', DEFAULT_ACCENT);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 同上
    }
  }
}

/** 網頁一打開就套用上次的選擇 */
export function applySavedAccent() {
  const saved = getAccent();
  if (saved) setAccent(saved);
}
