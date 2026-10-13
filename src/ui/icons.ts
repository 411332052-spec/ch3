// 固定的圖示（都是寫死的 SVG，不含任何使用者輸入）。
const PATHS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2M18.5 2v4h-4M5.5 22v-4h4"/>',
  retry: '<path d="M3 12a9 9 0 0 1 15.5-6.2M18.5 2v4h-4"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16, extraClass = ''): SVGElement {
  const template = document.createElement('template');
  template.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `class="${extraClass}">${PATHS[name]}</svg>`;
  return template.content.firstElementChild as SVGElement;
}
