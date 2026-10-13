// 聊天室畫面：頂部列、線上名單、訊息區、輸入區。
import type { ChangeHint, ChatStore, Item } from '../chat/store';
import type { Message } from '../chat/types';
import { MAX_BODY, bodyLength } from '../chat/rules';
import { h } from './dom';
import { icon } from './icons';

const NEAR_BOTTOM_PX = 80;
const COUNTER_FROM = 100;
const COMPOSER_MAX_HEIGHT = 140;

// 只有 https 開頭、副檔名是常見圖片格式的網址，才會顯示成圖片
const IMAGE_URL = /https:\/\/[^\s]+?\.(?:jpe?g|png|gif|webp)(?=\s|$)/gi;

function parseBody(body: string): { text: string; urls: string[] } {
  const urls = body.match(IMAGE_URL) ?? [];
  const text = body.replace(IMAGE_URL, '').replace(/[ \t]+\n/g, '\n').trim();
  return { text, urls };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function mountChat(root: HTMLElement, store: ChatStore) {
  const me = store.state.nickname;
  let keepBottom = true;

  // ---- 元素 ----
  const onlineButton = h(
    'button',
    { class: 'online-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'members' },
    h('span', { class: 'dot' }),
    h('span', { class: 'online-label' }),
    icon('chevronDown', 16, 'chev'),
  );
  const banner = h(
    'div',
    { class: 'banner', role: 'status', hidden: true },
    icon('refresh', 16),
    '連線中斷，重新連線中…',
  );

  const membersCount = h('div', { class: 'members-title' });
  const membersList = h('ul', { class: 'members-list' });
  const members = h(
    'aside',
    { class: 'members', id: 'members', 'aria-label': '線上名單' },
    membersCount,
    membersList,
  );
  const backdrop = h('div', { class: 'backdrop' });

  const topStatus = h('div', { class: 'top-status', role: 'status' });
  const list = h('div', { class: 'list' });
  const scroll = h('div', { class: 'scroll' }, topStatus, list);
  const newMsgButton = h(
    'button',
    { class: 'new-msg', type: 'button', hidden: true },
    '有新訊息',
    icon('arrowDown', 16),
  );

  const textarea = h('textarea', {
    class: 'composer-input',
    rows: 1,
    placeholder: '輸入訊息',
    'aria-label': '輸入訊息',
    enterkeyhint: 'enter',
  });
  const counter = h('span', { class: 'counter', hidden: true });
  const sendButton = h('button', { class: 'send', type: 'submit', disabled: true }, '送出');
  const composer = h(
    'form',
    { class: 'composer' },
    h('div', { class: 'composer-row' }, textarea, sendButton),
    counter,
  );

  const main = h(
    'main',
    { class: 'main' },
    h(
      'header',
      { class: 'topbar' },
      h('h1', {}, '匿名聊天室'),
      h('span', { class: 'whoami' }, '你的代號：', h('strong', {}, me)),
      onlineButton,
    ),
    banner,
    scroll,
    newMsgButton,
    composer,
  );
  const chat = h('div', { class: 'chat' }, members, main, backdrop);
  root.replaceChildren(chat);

  // ---- 線上名單 ----
  function setMembersOpen(open: boolean) {
    chat.classList.toggle('members-open', open);
    onlineButton.setAttribute('aria-expanded', String(open));
    onlineButton.querySelector('.chev')?.replaceWith(icon(open ? 'chevronUp' : 'chevronDown', 16, 'chev'));
  }
  onlineButton.addEventListener('click', () => setMembersOpen(!chat.classList.contains('members-open')));
  backdrop.addEventListener('click', () => setMembersOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMembersOpen(false);
  });

  function renderMembers() {
    const sorted = [...store.state.members].sort((a, b) => {
      if (a.nickname === me) return -1;
      if (b.nickname === me) return 1;
      return a.nickname.localeCompare(b.nickname);
    });
    const label = `線上 ${sorted.length} 人`;
    membersCount.textContent = label;
    onlineButton.querySelector('.online-label')!.textContent = label;
    membersList.replaceChildren(
      ...sorted.map((member) =>
        h(
          'li',
          { class: member.nickname === me ? 'member me' : 'member' },
          h('span', { class: 'dot' }),
          member.nickname,
          member.nickname === me && h('span', { class: 'tag' }, '你'),
        ),
      ),
    );
  }

  // ---- 訊息列表（以 key 對應元素，只更新有變的部分，避免圖片重新載入） ----
  const elements = new Map<string, HTMLElement>();

  function createMessage(item: Extract<Item, { kind: 'msg' }>): HTMLElement {
    const { msg } = item;
    const mine = msg.nickname === me;
    const { text, urls } = parseBody(msg.body);
    const bubbleChildren: (Node | string)[] = [];
    if (text) bubbleChildren.push(h('div', { class: 'text' }, text));
    for (const url of urls) {
      const img = h('img', {
        class: 'chat-img',
        src: url,
        alt: '使用者貼的圖片',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
      });
      img.addEventListener('load', () => {
        if (keepBottom) scrollToBottom();
      });
      img.addEventListener('error', () => {
        // 載入失敗：退回顯示網址文字
        img.replaceWith(h('div', { class: 'text url' }, url));
      });
      bubbleChildren.push(img);
    }
    return h(
      'div',
      { class: `msg ${mine ? 'mine' : 'other'}` },
      h('div', { class: 'meta' }),
      h('div', { class: 'bubble' }, ...bubbleChildren),
      h('div', { class: 'status' }),
    );
  }

  function updateMessage(el: HTMLElement, msg: Message) {
    const mine = msg.nickname === me;
    const time = formatTime(msg.createdAt);
    el.querySelector('.meta')!.textContent = mine ? time : `${msg.nickname} · ${time}`;
    el.classList.toggle('sending', msg.sendState === 'sending');
    el.classList.toggle('failed', msg.sendState === 'failed');
    const status = el.querySelector('.status')!;
    if (msg.sendState === 'sending') {
      status.replaceChildren('傳送中…');
    } else if (msg.sendState === 'failed') {
      status.replaceChildren(
        h(
          'button',
          { class: 'retry', type: 'button', onClick: () => void store.retry(msg.clientMsgId) },
          icon('retry', 14),
          '未送出，點一下重送',
        ),
      );
    } else {
      status.replaceChildren();
    }
  }

  function createNotice(item: Extract<Item, { kind: 'notice' }>): HTMLElement {
    const verb = item.type === 'join' ? '加入了聊天室' : '離開了聊天室';
    return h('div', { class: 'notice' }, `${item.nickname} ${verb}`);
  }

  function syncList() {
    const live = new Set<string>();
    let previous: Node | null = null;
    for (const item of store.state.items) {
      live.add(item.key);
      let el = elements.get(item.key);
      if (!el) {
        el = item.kind === 'msg' ? createMessage(item) : createNotice(item);
        elements.set(item.key, el);
      }
      if (item.kind === 'msg') updateMessage(el, item.msg);
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
    const { loadingOlder, hasMore } = store.state;
    if (loadingOlder) {
      topStatus.replaceChildren(icon('spinner', 14, 'spin'), '載入更早的訊息…');
      topStatus.hidden = false;
    } else if (!hasMore) {
      topStatus.replaceChildren('已經是最早的訊息');
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

  // ---- 輸入區 ----
  function updateComposer() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    const length = bodyLength(textarea.value.trim());
    const remaining = MAX_BODY - length;
    const over = remaining < 0;
    sendButton.disabled = length === 0 || over;
    if (over) {
      counter.textContent = `超過上限 ${-remaining} 字，請刪減`;
      counter.hidden = false;
    } else if (remaining <= COUNTER_FROM) {
      counter.textContent = `還能輸入 ${remaining} 字`;
      counter.hidden = false;
    } else {
      counter.hidden = true;
    }
  }
  textarea.addEventListener('input', updateComposer);
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (sendButton.disabled) return;
    const body = textarea.value;
    textarea.value = '';
    updateComposer();
    void store.send(body);
    textarea.focus();
  });

  // ---- 狀態變動 ----
  function render(hint: ChangeHint) {
    const wasNearBottom = isNearBottom();
    const heightBefore = scroll.scrollHeight;

    banner.hidden = store.state.status === 'connected';
    renderMembers();
    renderTopStatus();
    syncList();

    switch (hint) {
      case 'init':
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
