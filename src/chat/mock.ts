// 階段一使用的「模擬資料來源」：假的歷史訊息、假的其他使用者，全部在瀏覽器裡自己演。
// 與階段二的 Supabase 實作遵守同一份介面（types.ts）。
import { PAGE_SIZE, isValidNickname } from './rules';
import type {
  ChatClient,
  ChatEventMap,
  ConnectionStatus,
  DevControls,
  JoinResult,
  Member,
  Message,
  Page,
  SendResult,
} from './types';

const BOTS = ['Ben', 'kai2024', 'Mika', 'Zoe'];
const PHRASES = [
  '大家午安，今天好熱',
  '剛剛看到一個很有趣的新聞',
  '有人要一起訂飲料嗎？',
  '我覺得週末可以出去走走',
  '哈哈哈哈這個太好笑了',
  '好喔，我等一下就到',
  '有推薦的電影嗎？最近想看點輕鬆的',
  '晚餐吃什麼好煩惱',
  '收到，謝謝你！',
  '今天的天空很漂亮',
];
const IMAGE_URL = 'https://picsum.photos/id/1015/480/320.jpg';
const BROKEN_IMAGE_URL = 'https://example.invalid/missing-photo.png';
const TOTAL_HISTORY = 120;
const SHORT_LEAVE_MS = 3_000;
const LONG_LEAVE_MS = 15_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function createMockClient(): ChatClient {
  const clientId = uid();
  const handlers: { [K in keyof ChatEventMap]: Set<(p: ChatEventMap[K]) => void> } = {
    'message:new': new Set(),
    'presence:sync': new Set(),
    'presence:join': new Set(),
    'presence:leave': new Set(),
    'connection:status': new Set(),
  };
  function emit<K extends keyof ChatEventMap>(event: K, payload: ChatEventMap[K]) {
    for (const handler of [...handlers[event]]) handler(payload);
  }

  // ---- 假的歷史訊息 ----
  const history: Message[] = [];
  const start = Date.now() - TOTAL_HISTORY * 4 * 60_000;
  for (let i = 1; i <= TOTAL_HISTORY; i++) {
    let body = `${PHRASES[i % PHRASES.length]}`;
    if (i % 17 === 0) body = `${IMAGE_URL}`;
    else if (i % 41 === 0) body = `這張連結壞掉了 ${BROKEN_IMAGE_URL}`;
    history.push({
      id: i,
      clientMsgId: `seed-${i}`,
      nickname: BOTS[(i * 7) % BOTS.length],
      body,
      createdAt: new Date(start + i * 4 * 60_000).toISOString(),
      sendState: 'sent',
    });
  }
  let nextId = TOTAL_HISTORY + 1;

  // ---- 狀態 ----
  let status: ConnectionStatus = 'connected';
  let joined = false;
  let self: Member | null = null;
  let failNext = false;
  const members = new Map<string, Member>();
  const resetBots = () => {
    members.clear();
    BOTS.forEach((nickname, i) => {
      members.set(`bot-${i}`, {
        nickname,
        clientId: `bot-${i}`,
        joinedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      });
    });
  };
  resetBots();

  const timers: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  function present(): Member[] {
    return [...members.values()];
  }
  function syncMembers() {
    emit('presence:sync', present());
  }

  function botSay() {
    const bots = present().filter((m) => m.clientId !== clientId);
    if (bots.length === 0) return;
    const bot = pick(bots);
    const message: Message = {
      id: nextId++,
      clientMsgId: uid(),
      nickname: bot.nickname,
      body: Math.random() < 0.12 ? IMAGE_URL : pick(PHRASES),
      createdAt: new Date().toISOString(),
      sendState: 'sent',
    };
    history.push(message);
    // 斷線期間訊息仍然存在，只是這個瀏覽器沒收到；重連後會用 loadAfter 補上
    if (joined && status === 'connected') emit('message:new', { ...message });
  }

  function blip(kind: 'short' | 'long') {
    if (!joined || status !== 'connected') return;
    const bots = present().filter((m) => m.clientId !== clientId);
    if (bots.length === 0) return;
    const bot = pick(bots);
    members.delete(bot.clientId);
    emit('presence:leave', bot);
    timers.push(
      setTimeout(
        () => {
          if (!joined) return;
          const back = { ...bot, joinedAt: new Date().toISOString() };
          members.set(back.clientId, back);
          if (status === 'connected') emit('presence:join', back);
        },
        kind === 'short' ? SHORT_LEAVE_MS : LONG_LEAVE_MS,
      ),
    );
  }

  function newcomerJoin() {
    if (!joined || status !== 'connected') return;
    const m: Member = {
      nickname: `Guest${Math.floor(Math.random() * 900 + 100)}`,
      clientId: uid(),
      joinedAt: new Date().toISOString(),
    };
    members.set(m.clientId, m);
    emit('presence:join', m);
  }

  function setStatus(next: ConnectionStatus) {
    if (status === next) return;
    status = next;
    emit('connection:status', next);
    if (next === 'connected' && joined) syncMembers();
  }

  function startSimulation() {
    intervals.push(setInterval(botSay, 9_000));
    intervals.push(setInterval(() => blip('short'), 37_000));
    intervals.push(setInterval(() => blip('long'), 83_000));
  }
  function stopSimulation() {
    timers.splice(0).forEach(clearTimeout);
    intervals.splice(0).forEach(clearInterval);
  }

  const dev: DevControls = {
    label: '測試工具（只在階段一出現）',
    actions: [
      { label: '模擬斷線', run: () => setStatus('reconnecting') },
      { label: '恢復連線', run: () => setStatus('connected') },
      { label: '別人發一則訊息', run: botSay },
      { label: '有人短暫離開再回來', run: () => blip('short') },
      { label: '有人離開超過 10 秒', run: () => blip('long') },
      { label: '有新人加入', run: newcomerJoin },
      {
        label: '讓下一則送出失敗',
        run: () => {
          failNext = true;
        },
      },
    ],
  };

  function page(from: number, to: number): Page {
    return {
      messages: history.slice(from, to).map((m) => ({ ...m })),
      hasMore: from > 0,
    };
  }

  return {
    clientId,
    dev,

    on(event, handler) {
      const set = handlers[event] as Set<typeof handler>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    async join(nickname): Promise<JoinResult> {
      await delay(500);
      if (!isValidNickname(nickname)) return { ok: false, reason: 'invalid' };
      const lower = nickname.toLowerCase();
      if (present().some((m) => m.nickname.toLowerCase() === lower)) {
        return { ok: false, reason: 'taken' };
      }
      self = { nickname, clientId, joinedAt: new Date().toISOString() };
      members.set(clientId, self);
      joined = true;
      status = 'connected';
      startSimulation();
      syncMembers();
      return { ok: true };
    },

    leave() {
      if (!joined) return;
      joined = false;
      members.delete(clientId);
      stopSimulation();
      resetBots();
      self = null;
    },

    async loadLatest() {
      await delay(300);
      return page(Math.max(0, history.length - PAGE_SIZE), history.length);
    },

    async loadOlder(beforeId) {
      await delay(600);
      const end = history.findIndex((m) => (m.id ?? 0) >= beforeId);
      const to = end === -1 ? history.length : end;
      return page(Math.max(0, to - PAGE_SIZE), to);
    },

    async loadAfter(afterId) {
      await delay(300);
      return history.filter((m) => (m.id ?? 0) > afterId).map((m) => ({ ...m }));
    },

    async send(body, clientMsgId): Promise<SendResult> {
      await delay(600);
      if (status !== 'connected' || !joined || !self) return { ok: false, reason: 'offline' };
      if (failNext) {
        failNext = false;
        return { ok: false, reason: 'error' };
      }
      // 同一個 clientMsgId 重送時不會產生第二則
      if (!history.some((m) => m.clientMsgId === clientMsgId)) {
        const message: Message = {
          id: nextId++,
          clientMsgId,
          nickname: self.nickname,
          body,
          createdAt: new Date().toISOString(),
          sendState: 'sent',
        };
        history.push(message);
        emit('message:new', { ...message });
      }
      return { ok: true };
    },
  };
}
