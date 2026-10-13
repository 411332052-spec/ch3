// 固定的圖示（都是寫死的 SVG，不含任何使用者輸入）。
const PATHS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2M18.5 2v4h-4M5.5 22v-4h4"/>',
  retry: '<path d="M3 12a9 9 0 0 1 15.5-6.2M18.5 2v4h-4"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  settings:
    '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/>' +
    '<circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  smile:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.5 2.4 2.2 4 2.2s3-.7 4-2.2"/>' +
    '<path d="M9 9.5h.01M15 9.5h.01"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
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
