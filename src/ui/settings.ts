// 「外觀與通知」按鈕與面板：深淺色模式、主色，以及（聊天室裡）提示音與桌面通知。
// 所有選擇都只記在這個瀏覽器，別人看不到。
import { DEFAULT_ACCENT, PRESETS, getAccent, setAccent } from '../theme';
import {
  getNotifyEnabled,
  getSoundEnabled,
  getThemeMode,
  setNotifyEnabled,
  setSoundEnabled,
  setThemeMode,
  type ThemeMode,
} from '../prefs';
import { h } from './dom';
import { icon } from './icons';

const MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'auto', label: '跟隨裝置' },
  { mode: 'light', label: '淺色' },
  { mode: 'dark', label: '深色' },
];

export function createSettings(options: { extended: boolean; extraClass?: string }): HTMLElement {
  const panel = h('div', { class: 'theme-panel', id: 'theme-panel', hidden: true });
  const toggle = h(
    'button',
    {
      class: 'theme-toggle',
      type: 'button',
      'aria-label': '外觀與通知設定',
      'aria-expanded': 'false',
      'aria-controls': 'theme-panel',
    },
    icon('settings', 20),
  );
  const wrap = h('div', { class: `theme ${options.extraClass ?? ''}`.trim() }, toggle, panel);

  // ---- 深淺色 ----
  const modeButtons = MODES.map(({ mode, label }) =>
    h(
      'button',
      {
        class: 'seg-btn',
        type: 'button',
        'aria-pressed': 'false',
        onClick: () => {
          setThemeMode(mode);
          refresh();
        },
      },
      label,
    ),
  );

  // ---- 主色 ----
  const custom = h('input', {
    class: 'theme-custom-input',
    id: 'theme-custom',
    type: 'color',
    value: getAccent() ?? DEFAULT_ACCENT,
  });
  const swatches = PRESETS.map((preset) =>
    h(
      'button',
      {
        class: 'swatch',
        type: 'button',
        'aria-label': preset.name,
        'aria-pressed': 'false',
        style: `--swatch:${preset.hex}`,
        onClick: () => {
          setAccent(preset.hex === DEFAULT_ACCENT ? null : preset.hex);
          custom.value = preset.hex;
          refresh();
        },
      },
      h('span', { class: 'swatch-dot' }),
    ),
  );
  custom.addEventListener('input', () => {
    setAccent(custom.value);
    refresh();
  });

  // ---- 提示音與通知 ----
  const sound = h('input', { type: 'checkbox', id: 'opt-sound' });
  const notify = h('input', { type: 'checkbox', id: 'opt-notify' });
  const hint = h('p', { class: 'theme-note', role: 'status' });
  sound.addEventListener('change', () => setSoundEnabled(sound.checked));
  notify.addEventListener('change', async () => {
    hint.textContent = '';
    if (!notify.checked) {
      setNotifyEnabled(false);
      return;
    }
    if (!('Notification' in window)) {
      notify.checked = false;
      hint.textContent = '這個瀏覽器不支援桌面通知。';
      return;
    }
    const permission =
      Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted') {
      setNotifyEnabled(true);
    } else {
      notify.checked = false;
      setNotifyEnabled(false);
      hint.textContent = '瀏覽器沒有允許通知。請到網址列旁的網站設定，把這個網站的通知改成「允許」。';
    }
  });

  function refresh() {
    const mode = getThemeMode();
    MODES.forEach((m, i) => modeButtons[i].setAttribute('aria-pressed', String(m.mode === mode)));
    const current = getAccent() ?? DEFAULT_ACCENT;
    PRESETS.forEach((preset, i) => swatches[i].setAttribute('aria-pressed', String(preset.hex === current)));
    sound.checked = getSoundEnabled();
    notify.checked = getNotifyEnabled() && 'Notification' in window && Notification.permission === 'granted';
  }

  panel.append(
    h('div', { class: 'theme-title', id: 'mode-title' }, '深淺色'),
    h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'mode-title' }, ...modeButtons),
    h('div', { class: 'theme-title', id: 'theme-title' }, '主色'),
    h('div', { class: 'swatches', role: 'group', 'aria-labelledby': 'theme-title' }, ...swatches),
    h('div', { class: 'theme-custom' }, h('label', { for: 'theme-custom' }, '自選顏色'), custom),
    h(
      'button',
      {
        class: 'theme-reset',
        type: 'button',
        onClick: () => {
          setAccent(null);
          custom.value = DEFAULT_ACCENT;
          refresh();
        },
      },
      '主色恢復預設',
    ),
    ...(options.extended
      ? [
          h('div', { class: 'theme-title' }, '提醒'),
          h('label', { class: 'check', for: 'opt-sound' }, sound, '收到新訊息時播放提示音'),
          h('label', { class: 'check', for: 'opt-notify' }, notify, '不在這個分頁時顯示桌面通知'),
          hint,
        ]
      : []),
    h('p', { class: 'theme-note' }, '只會記在這個瀏覽器，別人看不到你的選擇。'),
  );

  function setOpen(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) refresh();
  }
  toggle.addEventListener('click', () => setOpen(Boolean(panel.hidden)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !wrap.contains(event.target as Node)) setOpen(false);
  });

  refresh();
  return wrap;
}
