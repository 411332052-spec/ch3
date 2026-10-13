// 左側（手機是浮層）：聊天室清單、私訊清單、目前聊天室的線上名單。
import type { ChatStore } from '../chat/store';
import { dmConv, roomConv } from '../chat/rules';
import { h } from './dom';

export interface Sidebar {
  el: HTMLElement;
  render(): void;
  /** 目前聊天室的線上人數 */
  onlineCount(): number;
  /** 其他對話的未讀總數（手機版用來在按鈕上顯示小紅點） */
  otherUnread(): number;
}

export function createSidebar(store: ChatStore, onNavigate: () => void): Sidebar {
  const el = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': '聊天室、私訊與線上名單' });

  function badge(count: number): Node | null {
    return count > 0 ? h('span', { class: 'badge', 'aria-label': `${count} 則未讀` }, count > 99 ? '99+' : String(count)) : null;
  }

  function onlineCount(): number {
    const { state } = store;
    return state.members.filter((m) => m.room === state.room).length;
  }

  function otherUnread(): number {
    const { state } = store;
    return Object.entries(state.unread).reduce((sum, [conv, n]) => (conv === state.current ? sum : sum + n), 0);
  }

  function render() {
    const { state } = store;
    const sections: Node[] = [];

    // ---- 聊天室 ----
    sections.push(
      h(
        'section',
        { class: 'side-section' },
        h('h2', { class: 'side-title' }, '聊天室'),
        h(
          'ul',
          { class: 'side-list' },
          ...state.rooms.map((room) => {
            const conv = roomConv(room.id);
            const online = state.members.filter((m) => m.room === room.id).length;
            return h(
              'li',
              {},
              h(
                'button',
                {
                  class: 'conv-item',
                  type: 'button',
                  'aria-current': conv === state.current ? 'true' : null,
                  onClick: () => {
                    void store.switchTo(conv);
                    onNavigate();
                  },
                },
                h('span', { class: 'conv-name' }, `# ${room.name}`),
                h('span', { class: 'conv-sub' }, `${online} 人`),
                badge(state.unread[conv] ?? 0),
              ),
            );
          }),
        ),
      ),
    );

    // ---- 私訊 ----
    if (state.features.dm) {
      sections.push(
        h(
          'section',
          { class: 'side-section' },
          h('h2', { class: 'side-title' }, '私訊'),
          state.peers.length === 0
            ? h('p', { class: 'side-empty' }, '點下面線上名單裡的代號，就能傳私訊給對方。')
            : h(
                'ul',
                { class: 'side-list' },
                ...state.peers.map((peer) => {
                  const conv = dmConv(peer.userId);
                  return h(
                    'li',
                    {},
                    h(
                      'button',
                      {
                        class: 'conv-item',
                        type: 'button',
                        'aria-current': conv === state.current ? 'true' : null,
                        onClick: () => {
                          void store.switchTo(conv);
                          onNavigate();
                        },
                      },
                      h('span', { class: 'conv-name' }, `@ ${peer.nickname}`),
                      badge(state.unread[conv] ?? 0),
                    ),
                  );
                }),
              ),
        ),
      );
    }

    // ---- 線上名單 ----
    const room = state.rooms.find((r) => r.id === state.room);
    const here = state.members
      .filter((m) => m.room === state.room)
      .sort((a, b) => {
        if (a.userId === state.userId) return -1;
        if (b.userId === state.userId) return 1;
        return a.nickname.localeCompare(b.nickname);
      });
    sections.push(
      h(
        'section',
        { class: 'side-section' },
        h('h2', { class: 'side-title' }, `線上 ${here.length} 人${room ? `（${room.name}）` : ''}`),
        h(
          'ul',
          { class: 'side-list members-list' },
          ...here.map((member) => {
            const me = member.userId === state.userId;
            const content: Node[] = [
              h('span', { class: 'dot' }),
              h('span', { class: 'member-name' }, member.nickname),
            ];
            if (me) content.push(h('span', { class: 'tag' }, '你'));
            if (member.typing && !me) content.push(h('span', { class: 'tag' }, '輸入中'));
            if (me || !state.features.dm) {
              return h('li', { class: me ? 'member me' : 'member' }, ...content);
            }
            return h(
              'li',
              {},
              h(
                'button',
                {
                  class: 'member member-btn',
                  type: 'button',
                  title: `傳私訊給 ${member.nickname}`,
                  onClick: () => {
                    void store.openDm(member.userId, member.nickname);
                    onNavigate();
                  },
                },
                ...content,
              ),
            );
          }),
        ),
      ),
    );

    el.replaceChildren(...sections);
  }

  return { el, render, onlineCount, otherUnread };
}
