// 一則訊息的畫面：泡泡、引用、圖片、@提及高亮、表情回應、操作列。
// 所有文字都用 textContent／文字節點，不使用 innerHTML，使用者輸入的內容不會被當成網頁語法執行。
import { MENTION_PATTERN, mentionsNickname } from '../chat/rules';
import type { Message } from '../chat/types';
import { h } from './dom';
import { QUICK_REACTIONS } from './emoji';
import { icon } from './icons';

// 只有 https 開頭、副檔名是常見圖片格式的網址，才會顯示成圖片
const IMAGE_URL = /https:\/\/[^\s]+?\.(?:jpe?g|png|gif|webp)(?=\s|$)/gi;

export interface MessageActions {
  reply(msg: Message): void;
  react(msg: Message, emoji: string): void;
  openPicker(msg: Message): void;
  edit(msg: Message): void;
  remove(msg: Message): void;
  retry(msg: Message): void;
  openDm(userId: string, nickname: string): void;
  jumpTo(messageId: number): void;
  onImageLoad(): void;
}

export interface MessageEnv {
  me: () => { nickname: string; userId: string };
  imageUrl: (path: string) => string;
  dmEnabled: () => boolean;
  actions: MessageActions;
}

function parseBody(body: string): { text: string; urls: string[] } {
  const urls = body.match(IMAGE_URL) ?? [];
  const text = body.replace(IMAGE_URL, '').replace(/[ \t]+\n/g, '\n').trim();
  return { text, urls };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 把文字裡的 @代號 標成醒目的樣式；被標記的是自己時更明顯 */
function renderText(text: string, myNickname: string): HTMLElement {
  const box = h('div', { class: 'text' });
  let last = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) box.append(text.slice(last, start));
    const self = match[1].toLowerCase() === myNickname.toLowerCase();
    box.append(h('span', { class: self ? 'mention me' : 'mention' }, match[0]));
    last = start + match[0].length;
  }
  if (last < text.length) box.append(text.slice(last));
  return box;
}

function isMine(msg: Message, env: MessageEnv): boolean {
  const me = env.me();
  return msg.userId !== null && msg.userId === me.userId;
}

export function createMessageEl(msg: Message, env: MessageEnv): HTMLElement {
  const el = h(
    'div',
    { class: 'msg', 'data-key': msg.clientMsgId },
    h('div', { class: 'meta' }),
    h('div', { class: 'bubble' }),
    h('div', { class: 'reactions' }),
    h('div', { class: 'status' }),
    h('div', { class: 'actions' }),
  );
  updateMessageEl(el, msg, env);
  return el;
}

export function updateMessageEl(el: HTMLElement, msg: Message, env: MessageEnv) {
  const mine = isMine(msg, env);
  const me = env.me();
  const deleted = msg.deletedAt !== null;
  el.classList.toggle('mine', mine);
  el.classList.toggle('other', !mine);
  el.classList.toggle('sending', msg.sendState === 'sending');
  el.classList.toggle('failed', msg.sendState === 'failed');
  el.classList.toggle('deleted', deleted);
  el.classList.toggle('mentions-me', !mine && !deleted && mentionsNickname(msg.body, me.nickname));

  // ---- 代號與時間 ----
  const meta = el.querySelector('.meta') as HTMLElement;
  const parts: (Node | string)[] = [];
  if (!mine) {
    if (msg.userId && env.dmEnabled()) {
      const userId = msg.userId;
      parts.push(
        h(
          'button',
          {
            class: 'nick-btn',
            type: 'button',
            title: `傳私訊給 ${msg.nickname}`,
            onClick: () => env.actions.openDm(userId, msg.nickname),
          },
          msg.nickname,
        ),
        ' · ',
      );
    } else {
      parts.push(`${msg.nickname} · `);
    }
  }
  parts.push(formatTime(msg.createdAt));
  if (msg.editedAt && !deleted) parts.push('（已編輯）');
  meta.replaceChildren(...parts);

  // ---- 泡泡內容（內容沒變就不重畫，避免圖片重新載入）----
  const bubble = el.querySelector('.bubble') as HTMLElement;
  const signature = [
    msg.body,
    msg.deletedAt,
    msg.imagePath,
    msg.replyTo?.id,
    msg.replyTo?.snippet,
    me.nickname,
  ].join('\u0000');
  if (el.dataset.sig !== signature) {
    el.dataset.sig = signature;
    bubble.replaceChildren(...buildBubble(msg, env, deleted));
  }

  // ---- 表情回應 ----
  const reactions = el.querySelector('.reactions') as HTMLElement;
  const groups = new Map<string, { count: number; mine: boolean }>();
  for (const r of msg.reactions) {
    const g = groups.get(r.emoji) ?? { count: 0, mine: false };
    g.count += 1;
    if (r.userId === me.userId) g.mine = true;
    groups.set(r.emoji, g);
  }
  reactions.replaceChildren(
    ...[...groups].map(([emoji, g]) =>
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(g.mine),
          'aria-label': `${emoji} ${g.count} 人`,
          disabled: msg.id === null || deleted,
          onClick: () => env.actions.react(msg, emoji),
        },
        h('span', {}, emoji),
        h('span', { class: 'chip-count' }, String(g.count)),
      ),
    ),
  );

  // ---- 傳送狀態 ----
  const status = el.querySelector('.status') as HTMLElement;
  if (msg.sendState === 'sending') {
    status.replaceChildren('傳送中…');
  } else if (msg.sendState === 'failed') {
    status.replaceChildren(
      h(
        'button',
        { class: 'retry', type: 'button', onClick: () => env.actions.retry(msg) },
        icon('retry', 14),
        '未送出，點一下重送',
      ),
    );
  } else {
    status.replaceChildren();
  }

  // ---- 操作列（點一下訊息才會出現）----
  const actions = el.querySelector('.actions') as HTMLElement;
  if (msg.id === null || msg.sendState !== 'sent' || deleted) {
    actions.replaceChildren();
    el.classList.remove('selected');
    return;
  }
  const items: Node[] = QUICK_REACTIONS.map((emoji) =>
    h(
      'button',
      { class: 'act', type: 'button', 'aria-label': `用 ${emoji} 回應`, onClick: () => env.actions.react(msg, emoji) },
      emoji,
    ),
  );
  items.push(
    h(
      'button',
      {
        class: 'act',
        type: 'button',
        'aria-label': '更多表情',
        onClick: (event: Event) => {
          event.stopPropagation();
          env.actions.openPicker(msg);
        },
      },
      icon('plus', 16),
    ),
    h('button', { class: 'act text-act', type: 'button', onClick: () => env.actions.reply(msg) }, icon('reply', 16), '回覆'),
  );
  if (mine) {
    items.push(
      h('button', { class: 'act text-act', type: 'button', onClick: () => env.actions.edit(msg) }, icon('edit', 16), '編輯'),
    );
    const del = h('button', { class: 'act text-act danger', type: 'button' }, icon('trash', 16), '刪除');
    let armed: ReturnType<typeof setTimeout> | undefined;
    del.addEventListener('click', () => {
      if (armed === undefined) {
        // 第一次按：要求再按一次確認，3 秒內沒按就取消
        del.replaceChildren(icon('trash', 16), '再按一次確認');
        armed = setTimeout(() => {
          armed = undefined;
          del.replaceChildren(icon('trash', 16), '刪除');
        }, 3000);
      } else {
        clearTimeout(armed);
        armed = undefined;
        env.actions.remove(msg);
      }
    });
    items.push(del);
  }
  actions.replaceChildren(...items);
}

function buildBubble(msg: Message, env: MessageEnv, deleted: boolean): Node[] {
  if (deleted) return [h('div', { class: 'text deleted-text' }, '此訊息已刪除')];
  const nodes: Node[] = [];
  const me = env.me();

  if (msg.replyTo) {
    const ref = msg.replyTo;
    nodes.push(
      h(
        'button',
        { class: 'quote', type: 'button', onClick: () => env.actions.jumpTo(ref.id) },
        icon('reply', 14),
        h('span', { class: 'quote-text' }, `${ref.nickname ?? '?'}：${ref.snippet ?? '原訊息已刪除或看不到'}`),
      ),
    );
  }

  const { text, urls } = parseBody(msg.body);
  if (text) nodes.push(renderText(text, me.nickname));

  const sources = urls.map((url) => ({ src: url, link: url }));
  if (msg.imagePath) {
    const src = env.imageUrl(msg.imagePath);
    sources.unshift({ src, link: src });
  }
  for (const { src, link } of sources) {
    const img = h('img', {
      class: 'chat-img',
      src,
      alt: '使用者貼的圖片',
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('load', () => env.actions.onImageLoad());
    img.addEventListener('error', () => {
      // 載入失敗：退回顯示網址文字
      img.closest('a')?.replaceWith(h('div', { class: 'text url' }, link));
    });
    nodes.push(h('a', { class: 'img-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, img));
  }
  return nodes;
}
