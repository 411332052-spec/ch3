// 聊天室畫面：頂部列、側邊欄（聊天室／私訊／線上名單）、搜尋、訊息列表、輸入區。
import type { ChangeHint, ChatStore, Item } from '../chat/store';
import type { Message } from '../chat/types';
import { createComposer } from './composer';
import { h } from './dom';
import { createEmojiPicker } from './emoji';
import { icon } from './icons';
import { createMessageEl, updateMessageEl, type MessageEnv } from './message';
import { createSettings } from './settings';
import { createSidebar } from './sidebar';

const NEAR_BOTTOM_PX = 80;
const TOAST_MS = 3_500;

function noticeText(item: Extract<Item, { kind: 'notice' }>): string {
  if (item.type === 'welcome') return `你已進入聊天室，目前有 ${item.count} 人在線上`;
  return `${item.nickname} ${item.type === 'join' ? '加入了聊天室' : '離開了聊天室'}`;
}

export function mountChat(root: HTMLElement, store: ChatStore) {
  const { state } = store;
  let keepBottom = true;
  const elements = new Map<string, HTMLElement>();

  // ---- 頂部列 ----
  const title = h('h1', { class: 'conv-title' });
  const whoami = h('span', { class: 'whoami' }, '你的代號：', h('strong', {}, state.nickname));
  const searchToggle = h(
    'button',
    { class: 'theme-toggle', type: 'button', 'aria-label': '搜尋訊息', 'aria-expanded': 'false' },
    icon('search', 20),
  );
  const onlineLabel = h('span', { class: 'online-label' });
  const unreadDot = h('span', { class: 'unread-dot', hidden: true, 'aria-label': '其他對話有未讀訊息' });
  const onlineButton = h(
    'button',
    { class: 'online-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'sidebar' },
    h('span', { class: 'dot' }),
    onlineLabel,
    icon('chevronDown', 16, 'chev'),
    unreadDot,
  );
  const banner = h('div', { class: 'banner', role: 'status', hidden: true }, icon('refresh', 16), '連線中斷，重新連線中…');

  // ---- 搜尋 ----
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜尋目前對話的訊息',
    'aria-label': '搜尋訊息',
  });
  const searchInfo = h('span', { class: 'search-info', 'aria-live': 'polite' });
  const searchMore = h(
    'button',
    { class: 'link-btn', type: 'button', hidden: true, onClick: () => void store.loadOlder() },
    '載入更早的訊息再找',
  );
  const searchbar = h(
    'div',
    { class: 'searchbar', hidden: true },
    h('div', { class: 'search-row' }, searchInput, h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '關閉搜尋', onClick: () => setSearchOpen(false) }, icon('close', 16))),
    h('div', { class: 'search-row' }, searchInfo, searchMore),
  );

  // ---- 訊息區 ----
  const topStatus = h('div', { class: 'top-status', role: 'status' });
  const list = h('div', { class: 'list' });
  const scroll = h('div', { class: 'scroll' }, topStatus, list);
  const newMsgButton = h('button', { class: 'new-msg', type: 'button', hidden: true }, '有新訊息', icon('arrowDown', 16));
  const toastEl = h('div', { class: 'toast', role: 'status', hidden: true });

  // ---- Emoji 選擇器（輸入框和表情回應共用同一個）----
  let pickerOwner: string | null = null;
  let pickHandler: ((emoji: string) => void) | null = null;
  const picker = h(
    'div',
    { class: 'picker-pop', hidden: true },
    createEmojiPicker((emoji) => {
      const handler = pickHandler;
      closePicker();
      handler?.(emoji);
    }),
  );
  function closePicker() {
    picker.hidden = true;
    pickerOwner = null;
    pickHandler = null;
  }
  function togglePicker(owner: string, handler: (emoji: string) => void) {
    if (!picker.hidden && pickerOwner === owner) return closePicker();
    pickerOwner = owner;
    pickHandler = handler;
    picker.hidden = false;
  }
  document.addEventListener('click', (event) => {
    if (!picker.hidden && !picker.contains(event.target as Node)) closePicker();
  });

  // ---- 輸入區與側邊欄 ----
  const composer = createComposer(store, () => togglePicker('composer', (emoji) => composer.insertEmoji(emoji)));
  const sidebar = createSidebar(store, () => setSidebarOpen(false));

  const main = h(
    'main',
    { class: 'main' },
    h('header', { class: 'topbar' }, title, h('div', { class: 'topbar-right' }, whoami, searchToggle, createSettings({ extended: true }), onlineButton)),
    searchbar,
    banner,
    scroll,
    newMsgButton,
    picker,
    composer.el,
    toastEl,
  );
  const backdrop = h('div', { class: 'backdrop' });
  const chat = h('div', { class: 'chat' }, sidebar.el, main, backdrop);
  root.replaceChildren(chat);

  // ---- 訊息操作 ----
  const env: MessageEnv = {
    me: () => ({ nickname: state.nickname, userId: state.userId }),
    imageUrl: (path) => store.imageUrl(path),
    dmEnabled: () => state.features.dm,
    actions: {
      reply: (msg) => {
        clearSelection();
        composer.setReply(msg);
      },
      react: (msg, emoji) => void store.react(msg, emoji),
      openPicker: (msg) => togglePicker(`msg:${msg.clientMsgId}`, (emoji) => void store.react(msg, emoji)),
      edit: (msg) => {
        clearSelection();
        composer.startEdit(msg);
      },
      remove: (msg) => void store.remove(msg),
      retry: (msg) => void store.retry(msg.clientMsgId),
      openDm: (userId, nickname) => void store.openDm(userId, nickname),
      jumpTo: (messageId) => jumpTo(messageId),
      onImageLoad: () => {
        if (keepBottom) scrollToBottom();
      },
    },
  };

  function jumpTo(messageId: number) {
    const target: Message | undefined = store.findById(messageId);
    const el = target ? elements.get(target.clientMsgId) : undefined;
    if (!el || el.hidden) {
      store.toast('找不到這則訊息，可能還沒載入，往上捲動可以載入更早的訊息');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1_500);
  }

  // ---- 點一下訊息：顯示操作列 ----
  function clearSelection() {
    list.querySelectorAll('.msg.selected').forEach((el) => el.classList.remove('selected'));
  }
  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input')) return;
    const msgEl = target.closest('.msg');
    const wasSelected = msgEl?.classList.contains('selected') ?? false;
    clearSelection();
    if (msgEl && !wasSelected && (msgEl.querySelector('.actions')?.childElementCount ?? 0) > 0) {
      msgEl.classList.add('selected');
    }
  });

  // ---- 側邊欄（手機是浮層）----
  function setSidebarOpen(open: boolean) {
    chat.classList.toggle('members-open', open);
    onlineButton.setAttribute('aria-expanded', String(open));
    onlineButton.querySelector('.chev')?.replaceWith(icon(open ? 'chevronUp' : 'chevronDown', 16, 'chev'));
  }
  onlineButton.addEventListener('click', () => setSidebarOpen(!chat.classList.contains('members-open')));
  backdrop.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setSidebarOpen(false);
      closePicker();
    }
  });

  // ---- 搜尋：只過濾「已載入」的訊息 ----
  function setSearchOpen(open: boolean) {
    searchbar.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) searchInput.focus();
    else searchInput.value = '';
    applySearch();
  }
  function applySearch() {
    const query = searchInput.value.trim().toLowerCase();
    let found = 0;
    for (const item of state.items) {
      const el = elements.get(item.key);
      if (!el) continue;
      if (!query) {
        el.hidden = false;
      } else if (item.kind === 'msg') {
        const match = item.msg.deletedAt === null && `${item.msg.nickname} ${item.msg.body}`.toLowerCase().includes(query);
        el.hidden = !match;
        if (match) found += 1;
      } else {
        el.hidden = true;
      }
    }
    searchInfo.textContent = query ? `在已載入的訊息中找到 ${found} 則` : '';
    searchMore.hidden = !(query && state.hasMore);
  }
  searchToggle.addEventListener('click', () => setSearchOpen(Boolean(searchbar.hidden)));
  searchInput.addEventListener('input', applySearch);

  // ---- 訊息列表（以 key 對應元素，只更新有變的部分，避免圖片重新載入）----
  function syncList(refreshAll: boolean) {
    const live = new Set<string>();
    let previous: Node | null = null;
    for (const item of state.items) {
      live.add(item.key);
      let el = elements.get(item.key);
      if (!el) {
        el =
          item.kind === 'msg'
            ? createMessageEl(item.msg, env)
            : h('div', { class: 'notice' }, noticeText(item));
        elements.set(item.key, el);
      } else if (item.kind === 'msg' && refreshAll) {
        updateMessageEl(el, item.msg, env);
      }
      const expected: ChildNode | null = previous ? previous.nextSibling : list.firstChild;
      if (el !== expected) list.insertBefore(el, expected);
      previous = el;
    }
    for (const [key, el] of elements) {
      if (!live.has(key)) {
        el.remove();
        elements.delete(key);
      }
    }
  }

  function renderTopStatus() {
    if (state.loadingConv) {
      topStatus.replaceChildren(icon('spinner', 14, 'spin'), '載入中…');
      topStatus.hidden = false;
    } else if (state.loadingOlder) {
      topStatus.replaceChildren(icon('spinner', 14, 'spin'), '載入更早的訊息…');
      topStatus.hidden = false;
    } else if (!state.hasMore) {
      topStatus.replaceChildren(state.items.some((i) => i.kind === 'msg') ? '已經是最早的訊息' : '還沒有訊息，來說第一句話吧');
      topStatus.hidden = false;
    } else {
      topStatus.replaceChildren();
      topStatus.hidden = true;
    }
  }

  // ---- 捲動 ----
  function isNearBottom(): boolean {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < NEAR_BOTTOM_PX;
  }
  function scrollToBottom() {
    keepBottom = true;
    scroll.scrollTop = scroll.scrollHeight;
    newMsgButton.hidden = true;
  }
  scroll.addEventListener('scroll', () => {
    keepBottom = isNearBottom();
    if (keepBottom) newMsgButton.hidden = true;
    if (scroll.scrollTop < 40) void store.loadOlder();
  });
  newMsgButton.addEventListener('click', scrollToBottom);

  // ---- 提示（toast）----
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  store.onToast((text) => {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, TOAST_MS);
  });

  // ---- 狀態變動 ----
  function render(hint: ChangeHint) {
    const wasNearBottom = isNearBottom();
    const heightBefore = scroll.scrollHeight;

    if (hint === 'switch' || hint === 'init') {
      list.replaceChildren();
      elements.clear();
      searchInput.value = '';
      composer.reset();
      closePicker();
    }

    title.textContent = store.titleOf(state.current);
    banner.hidden = state.status === 'connected';
    sidebar.render();
    onlineLabel.textContent = `線上 ${sidebar.onlineCount()} 人`;
    unreadDot.hidden = sidebar.otherUnread() === 0;
    renderTopStatus();
    syncList(hint !== 'other' && hint !== 'append-notice');
    applySearch();
    composer.refresh();

    switch (hint) {
      case 'init':
      case 'switch':
      case 'append-own':
        scrollToBottom();
        break;
      case 'append-other':
        if (wasNearBottom) scrollToBottom();
        else newMsgButton.hidden = false;
        break;
      case 'append-notice':
      case 'update':
        if (wasNearBottom) scrollToBottom();
        break;
      case 'prepend':
        scroll.scrollTop += scroll.scrollHeight - heightBefore;
        break;
      default:
        break;
    }
  }

  render('init');
  store.subscribe((_state, hint) => render(hint));
  // 內容不足一頁時捲不動，先主動補一頁舊訊息
  if (scroll.scrollHeight <= scroll.clientHeight) void store.loadOlder();
}
