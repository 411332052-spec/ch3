import './styles/main.css';
import { createChatClient } from './chat';
import { ChatStore } from './chat/store';
import { mountChat } from './ui/chat';
import { mountDevPanel } from './ui/dev';
import { mountEntry } from './ui/entry';

const NICKNAME_KEY = 'chat.nickname';

function loadNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveNickname(nickname: string) {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    // 無痕模式等情況存不了，不影響使用
  }
}

const root = document.getElementById('app') as HTMLElement;
const client = createChatClient();
const store = new ChatStore(client);

let shown: 'entry' | 'chat' | null = null;
function render() {
  const phase = store.state.phase;
  if (phase === shown) return;
  shown = phase;
  if (phase === 'entry') {
    mountEntry(root, {
      initialNickname: loadNickname(),
      onSubmit: async (nickname) => {
        const result = await store.enter(nickname);
        if (result.ok) saveNickname(nickname);
        return result;
      },
    });
  } else {
    mountChat(root, store);
    mountDevPanel(root, client);
  }
}

store.subscribe(render);
render();

// 關掉分頁時通知資料來源，讓其他人的名單更新
window.addEventListener('pagehide', () => client.leave());
