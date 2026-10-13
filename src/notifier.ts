// 新訊息提醒：分頁標題的未讀數、提示音、桌面通知。
import type { ChatStore } from './chat/store';
import type { Message } from './chat/types';
import { getNotifyEnabled, getSoundEnabled } from './prefs';

const BASE_TITLE = document.title;
let unread = 0;
let audio: AudioContext | null = null;

function isAway(): boolean {
  return document.hidden || !document.hasFocus();
}

function renderTitle() {
  document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

/** 用瀏覽器內建的聲音合成一個短短的「叮」，不需要任何音檔 */
function playBeep() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const now = audio.currentTime;
    const gain = audio.createGain();
    gain.connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    for (const [offset, frequency] of [[0, 880], [0.12, 1175]] as const) {
      const osc = audio.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    }
  } catch {
    // 瀏覽器不允許播放就算了
  }
}

function showDesktopNotification(store: ChatStore, msg: Message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const where = store.titleOf(msg.conversation);
    const text = msg.imagePath && !msg.body ? '傳了一張圖片' : msg.body;
    const notification = new Notification(`${msg.nickname}（${where}）`, {
      body: text.slice(0, 120),
      tag: msg.conversation,
      silent: true, // 提示音由我們自己控制
    });
    notification.onclick = () => {
      window.focus();
      void store.switchTo(msg.conversation);
      notification.close();
    };
  } catch {
    // 有些手機瀏覽器不支援這種通知方式
  }
}

export function startNotifier(store: ChatStore) {
  const reset = () => {
    if (!isAway() && unread > 0) {
      unread = 0;
      renderTitle();
    }
  };
  window.addEventListener('focus', reset);
  document.addEventListener('visibilitychange', reset);

  store.onIncoming((msg, info) => {
    const away = isAway();
    if (away) {
      unread += 1;
      renderTitle();
    }
    // 正在看的聊天室、人也在這個分頁時不吵人；其他情況（不在分頁、別的對話、私訊、被標記）才響
    const loud = away || !info.isCurrent || info.dm || info.mention;
    if (loud && getSoundEnabled()) playBeep();
    if (away && getNotifyEnabled()) showDesktopNotification(store, msg);
  });
}
