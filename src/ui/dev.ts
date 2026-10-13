// 階段一專用的「測試工具」面板：用按鈕模擬斷線、別人發言、有人離開等情境。
// 階段二的資料來源沒有 dev 欄位，這個面板就不會出現。
import type { ChatClient } from '../chat/types';
import { h } from './dom';

export function mountDevPanel(root: HTMLElement, client: ChatClient) {
  const dev = client.dev;
  if (!dev) return;

  const menu = h(
    'div',
    { class: 'dev-menu', hidden: true },
    h('div', { class: 'dev-title' }, dev.label),
    ...dev.actions.map((action) =>
      h('button', { type: 'button', class: 'dev-action', onClick: action.run }, action.label),
    ),
  );
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'dev-toggle',
      'aria-expanded': 'false',
      onClick: () => {
        menu.hidden = !menu.hidden;
        toggle.setAttribute('aria-expanded', String(!menu.hidden));
      },
    },
    '測試工具',
  );
  root.append(h('div', { class: 'dev-panel' }, menu, toggle));
}
