// Emoji 選擇器：輸入框插入表情、對訊息加表情回應都用它。
import { h } from './dom';

const GROUPS: { name: string; list: string[] }[] = [
  {
    name: '表情',
    list: [...'😀😃😄😁😆😅😂🤣🙂😉😊😍😘😋😎🤔😐😴😢😭😡😱🥳🥺😇🤗🙄😬🤩😏'],
  },
  {
    name: '手勢',
    list: [...'👍👎👏🙌🙏💪👌✌🤞👋🤝👀'],
  },
  {
    name: '愛心與符號',
    list: [...'❤🧡💛💚💙💜🖤💔💯🔥✨🎉⭐✅❌❓❗💡🎵'],
  },
  {
    name: '動物與食物',
    list: [...'🐶🐱🐭🐰🦊🐻🐼🐸🐵🐔🍎🍌🍉🍕🍔🍟🍜🍣🍰🍺☕🍩'],
  },
];

/** 快速回應常用的三個 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂'];

export function createEmojiPicker(onPick: (emoji: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'emoji-picker', role: 'dialog', 'aria-label': '選擇表情符號' },
    ...GROUPS.map((group) =>
      h(
        'section',
        { class: 'emoji-group' },
        h('h3', {}, group.name),
        h(
          'div',
          { class: 'emoji-grid' },
          ...group.list.map((emoji) =>
            h('button', { class: 'emoji-btn', type: 'button', onClick: () => onPick(emoji) }, emoji),
          ),
        ),
      ),
    ),
  );
}
