// 輸入區：文字框、Emoji、圖片附件、回覆與編輯、@提及提示、「正在輸入」。
import type { ChatStore } from '../chat/store';
import { MAX_BODY, bodyLength, isDm } from '../chat/rules';
import type { Message } from '../chat/types';
import { h } from './dom';
import { icon } from './icons';

const COUNTER_FROM = 100;
const COMPOSER_MAX_HEIGHT = 140;
const TYPING_IDLE_MS = 3_000;
const MENTION_LIMIT = 5;

export interface Composer {
  el: HTMLElement;
  setReply(msg: Message): void;
  startEdit(msg: Message): void;
  /** 對話切換時重設輸入區 */
  reset(): void;
  /** 狀態變動時更新（正在輸入的提示、按鈕可不可以按） */
  refresh(): void;
  insertEmoji(emoji: string): void;
}

export function createComposer(store: ChatStore, openEmoji: () => void): Composer {
  let replyTo: Message | null = null;
  let editing: Message | null = null;
  let attachment: { path: string; previewUrl: string } | null = null;
  let uploading = false;
  let typingOn = false;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;

  const typingLine = h('div', { class: 'typing', 'aria-live': 'polite' });
  const bar = h('div', { class: 'ctx-bar', hidden: true });
  const textarea = h('textarea', {
    class: 'composer-input',
    rows: 1,
    placeholder: '輸入訊息',
    'aria-label': '輸入訊息',
    enterkeyhint: 'enter',
  });
  const counter = h('span', { class: 'counter', hidden: true });
  const sendButton = h('button', { class: 'send', type: 'submit', disabled: true }, '送出');
  const mentionList = h('div', { class: 'mention-list', role: 'listbox', hidden: true });

  const emojiButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '插入表情符號',
      onClick: (event: Event) => {
        event.stopPropagation();
        openEmoji();
      },
    },
    icon('smile', 22),
  );
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/gif,image/webp',
    hidden: true,
    tabindex: '-1',
  });
  const attachButton = h(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '上傳圖片', onClick: () => fileInput.click() },
    icon('image', 22),
  );

  const form = h(
    'form',
    { class: 'composer' },
    typingLine,
    bar,
    h(
      'div',
      { class: 'composer-row' },
      emojiButton,
      attachButton,
      fileInput,
      h('div', { class: 'input-wrap' }, mentionList, textarea),
      sendButton,
    ),
    counter,
  );

  // ---- 正在輸入 ----
  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingOn) {
      typingOn = false;
      store.setTyping(false);
    }
  }
  function bumpTyping() {
    if (!textarea.value.trim()) return stopTyping();
    if (!typingOn) {
      typingOn = true;
      store.setTyping(true);
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  }
  textarea.addEventListener('blur', stopTyping);

  // ---- 回覆、編輯、附件的提示列 ----
  function renderBar() {
    const rows: Node[] = [];
    if (replyTo) {
      rows.push(
        h(
          'div',
          { class: 'ctx-row' },
          icon('reply', 16),
          h('span', { class: 'ctx-text' }, `回覆 ${replyTo.nickname}：${replyTo.body || '圖片'}`),
          h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '取消回覆', onClick: () => { replyTo = null; renderBar(); } }, icon('close', 16)),
        ),
      );
    }
    if (editing) {
      rows.push(
        h(
          'div',
          { class: 'ctx-row' },
          icon('edit', 16),
          h('span', { class: 'ctx-text' }, '編輯訊息'),
          h('button', { class: 'icon-btn small', type: 'button', 'aria-label': '取消編輯', onClick: cancelEdit }, icon('close', 16)),
        ),
      );
    }
    if (uploading) {
      rows.push(h('div', { class: 'ctx-row' }, icon('spinner', 16, 'spin'), h('span', { class: 'ctx-text' }, '圖片上傳中…')));
    }
    if (attachment) {
      const current = attachment;
      rows.push(
        h(
          'div',
          { class: 'ctx-row' },
          h('img', { class: 'attach-thumb', src: current.previewUrl, alt: '要送出的圖片預覽' }),
          h('span', { class: 'ctx-text' }, '圖片已準備好，按「送出」發出'),
          h(
            'button',
            {
              class: 'icon-btn small',
              type: 'button',
              'aria-label': '移除圖片',
              onClick: () => {
                URL.revokeObjectURL(current.previewUrl);
                attachment = null;
                renderBar();
                updateUi();
              },
            },
            icon('close', 16),
          ),
        ),
      );
    }
    bar.replaceChildren(...rows);
    bar.hidden = rows.length === 0;
    updateUi();
  }

  function cancelEdit() {
    editing = null;
    textarea.value = '';
    renderBar();
  }

  // ---- 按鈕與字數 ----
  function updateUi() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    const length = bodyLength(textarea.value.trim());
    const remaining = MAX_BODY - length;
    const over = remaining < 0;
    const empty = length === 0 && (editing !== null || attachment === null);
    sendButton.disabled = empty || over || uploading;
    sendButton.textContent = editing ? '儲存' : '送出';
    if (over) {
      counter.textContent = `超過上限 ${-remaining} 字，請刪減`;
      counter.hidden = false;
    } else if (remaining <= COUNTER_FROM) {
      counter.textContent = `還能輸入 ${remaining} 字`;
      counter.hidden = false;
    } else {
      counter.hidden = true;
    }
    attachButton.hidden = !store.state.features.upload || editing !== null;
  }

  function refreshTyping() {
    const { state } = store;
    const names = isDm(state.current)
      ? []
      : state.members
          .filter((m) => m.typing && m.room === state.room && m.userId !== state.userId)
          .map((m) => m.nickname);
    typingLine.textContent =
      names.length === 0
        ? ''
        : names.length <= 2
          ? `${names.join('、')} 正在輸入…`
          : `${names.length} 人正在輸入…`;
  }

  // ---- @提及提示 ----
  function updateMentions() {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const match = /(^|\s)@([A-Za-z0-9]{0,12})$/.exec(textarea.value.slice(0, caret));
    if (!match) return hideMentions();
    const prefix = match[2].toLowerCase();
    const { state } = store;
    const pool = isDm(state.current)
      ? state.peers.filter((p) => state.current === `dm:${p.userId}`).map((p) => p.nickname)
      : state.members.filter((m) => m.room === state.room && m.userId !== state.userId).map((m) => m.nickname);
    const names = [...new Set(pool)].filter((n) => n.toLowerCase().startsWith(prefix)).slice(0, MENTION_LIMIT);
    if (names.length === 0) return hideMentions();
    mentionList.replaceChildren(
      ...names.map((name) =>
        h('button', { class: 'mention-item', type: 'button', role: 'option', onClick: () => pickMention(name) }, `@${name}`),
      ),
    );
    mentionList.hidden = false;
  }
  function hideMentions() {
    mentionList.hidden = true;
  }
  function pickMention(name: string) {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret).replace(/@[A-Za-z0-9]{0,12}$/, `@${name} `);
    textarea.value = before + textarea.value.slice(caret);
    textarea.setSelectionRange(before.length, before.length);
    hideMentions();
    textarea.focus();
    updateUi();
  }

  textarea.addEventListener('input', () => {
    updateUi();
    updateMentions();
    bumpTyping();
  });
  textarea.addEventListener('click', updateMentions);
  textarea.addEventListener('keydown', (event) => {
    if (mentionList.hidden) return;
    if (event.key === 'Escape') {
      hideMentions();
      event.stopPropagation();
    } else if (event.key === 'Tab') {
      const first = mentionList.querySelector('button');
      if (first) {
        event.preventDefault();
        pickMention((first.textContent ?? '').slice(1));
      }
    }
  });

  // ---- 圖片附件 ----
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || uploading) return;
    uploading = true;
    renderBar();
    const result = await store.uploadImage(file);
    uploading = false;
    if (result.ok) {
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
      attachment = { path: result.path, previewUrl: URL.createObjectURL(file) };
    } else {
      store.toast(
        result.reason === 'type'
          ? '只支援 JPG、PNG、GIF、WebP 圖片'
          : result.reason === 'size'
            ? '圖片太大了，請選小於 2 MB 的圖片'
            : '圖片上傳失敗，請稍後再試',
      );
    }
    renderBar();
  });

  // ---- 送出 ----
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sendButton.disabled) return;
    stopTyping();
    hideMentions();
    if (editing) {
      const target = editing;
      sendButton.disabled = true;
      const ok = await store.edit(target, textarea.value);
      if (ok) {
        editing = null;
        textarea.value = '';
      }
      renderBar();
      return;
    }
    const body = textarea.value;
    const reply = replyTo;
    const image = attachment;
    textarea.value = '';
    replyTo = null;
    attachment = null;
    void store.send({ body, replyTo: reply, imagePath: image?.path ?? null });
    if (image) URL.revokeObjectURL(image.previewUrl);
    renderBar();
    textarea.focus();
  });

  updateUi();

  return {
    el: form,
    setReply(msg) {
      editing = null;
      replyTo = msg;
      renderBar();
      textarea.focus();
    },
    startEdit(msg) {
      replyTo = null;
      editing = msg;
      textarea.value = msg.body;
      renderBar();
      textarea.focus();
    },
    reset() {
      stopTyping();
      hideMentions();
      replyTo = null;
      editing = null;
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
      attachment = null;
      textarea.value = '';
      renderBar();
    },
    refresh() {
      refreshTyping();
      updateUi();
    },
    insertEmoji(emoji) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + emoji + textarea.value.slice(end);
      const caret = start + emoji.length;
      textarea.setSelectionRange(caret, caret);
      textarea.focus();
      updateUi();
      bumpTyping();
    },
  };
}
