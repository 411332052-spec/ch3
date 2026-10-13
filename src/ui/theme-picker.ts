// 「自訂顏色」按鈕與面板：幾個預設主色、一個自選色、恢復預設。
import { DEFAULT_ACCENT, PRESETS, getAccent, setAccent } from '../theme';
import { h } from './dom';
import { icon } from './icons';

export function createThemePicker(extraClass = ''): HTMLElement {
  const panel = h('div', { class: 'theme-panel', id: 'theme-panel', hidden: true });
  const toggle = h(
    'button',
    {
      class: 'theme-toggle',
      type: 'button',
      'aria-label': '自訂顏色',
      'aria-expanded': 'false',
      'aria-controls': 'theme-panel',
    },
    icon('palette', 20),
  );
  const wrap = h('div', { class: `theme ${extraClass}`.trim() }, toggle, panel);

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

  function refresh() {
    const current = getAccent() ?? DEFAULT_ACCENT;
    PRESETS.forEach((preset, i) => {
      swatches[i].setAttribute('aria-pressed', String(preset.hex === current));
    });
  }

  custom.addEventListener('input', () => {
    setAccent(custom.value);
    refresh();
  });

  panel.append(
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
      '恢復預設',
    ),
    h('p', { class: 'theme-note' }, '只會記在這個瀏覽器，別人看不到你的選擇。'),
  );

  function setOpen(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
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
