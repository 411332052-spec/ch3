// 進入畫面：輸入代號。
import type { JoinResult } from '../chat/types';
import { isValidNickname } from '../chat/rules';
import { h } from './dom';
import { icon } from './icons';
import { createSettings } from './settings';

interface EntryOptions {
  initialNickname: string;
  onSubmit: (nickname: string) => Promise<JoinResult>;
}

export function mountEntry(root: HTMLElement, { initialNickname, onSubmit }: EntryOptions) {
  const input = h('input', {
    id: 'nickname',
    class: 'field',
    type: 'text',
    value: initialNickname,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-describedby': 'nickname-help',
  });
  const error = h('span', { class: 'error', id: 'nickname-error', role: 'alert' });
  const help = h('span', { class: 'hint', id: 'nickname-help' }, '只能英文和數字，最多 12 個字');
  const submit = h('button', { class: 'primary', type: 'submit' }, '進入聊天室');

  function showError(message: string) {
    error.textContent = message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', message ? 'nickname-error nickname-help' : 'nickname-help');
  }

  function setBusy(busy: boolean) {
    submit.disabled = busy;
    input.readOnly = busy;
    submit.replaceChildren(
      ...(busy ? [icon('spinner', 20, 'spin'), '處理中…'] : ['進入聊天室']),
    );
  }

  // 輸入的當下就提示，不要等到按「進入」才發現不行
  input.addEventListener('input', () => {
    const value = input.value;
    if (/[^A-Za-z0-9]/.test(value)) showError('代號只能用英文和數字');
    else if (value.length > 12) showError('代號最多 12 個字');
    else showError('');
  });

  const form = h(
    'form',
    {
      class: 'entry-form',
      novalidate: true,
      onSubmit: async (event: Event) => {
        event.preventDefault();
        if (submit.disabled) return;
        const nickname = input.value.trim();
        if (nickname === '') return showError('請輸入代號');
        if (!isValidNickname(nickname)) return showError('代號只能用英文和數字，最多 12 個字');
        showError('');
        setBusy(true);
        const result = await onSubmit(nickname);
        if (result.ok) return; // 畫面會切換到聊天室
        setBusy(false);
        if (result.reason === 'taken') showError('這個代號有人用了，請換一個');
        else if (result.reason === 'invalid') showError('代號只能用英文和數字，最多 12 個字');
        else if (result.reason === 'rate_limited') showError('短時間內嘗試進入的次數太多，請等幾分鐘再試');
        else if (result.reason === 'auth') showError('無法建立匿名身分，請稍後再試（管理者請確認 Supabase 已開啟匿名登入）');
        else showError('連線失敗，請稍後再試');
        input.focus();
        input.select();
      },
    },
    h('div', { class: 'field-group' }, h('label', { for: 'nickname' }, '你的代號'), input, error, help),
    submit,
  );

  root.replaceChildren(
    h(
      'main',
      { class: 'entry' },
      createSettings({ extended: false, extraClass: 'theme-fixed' }),
      h(
        'div',
        { class: 'entry-card' },
        h(
          'div',
          { class: 'entry-head' },
          h('div', { class: 'logo' }, icon('chat', 26)),
          h('h1', {}, '匿名聊天室'),
          h('p', {}, '不用註冊，取一個代號就能進來和大家聊天。'),
        ),
        form,
        h('p', { class: 'note' }, '所有訊息都是公開的，請不要在這裡分享個人資料。'),
      ),
    ),
  );
  input.focus();
}
