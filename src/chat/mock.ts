// 階段一使用的「模擬資料來源」：假的歷史訊息、假的其他使用者，全部在瀏覽器裡自己演。
// 與 Supabase 實作遵守同一份介面（types.ts）。
// 支援：多聊天室、回覆、表情回應、編輯與刪除自己的訊息。
// 不支援：私訊、圖片上傳、「正在輸入」（features 為 false，畫面會隱藏對應按鈕）。
import { PAGE_SIZE, isValidNickname, roomConv, snippetOf } from './rules';
import type {
  ChatClient,
  ChatEventMap,
  ConnectionStatus,
  ConversationId,
  DevControls,
  Draft,
  JoinResult,
  Member,
  Message,
  MessageResult,
  OpResult,
  Page,
  Reaction,
  Room,
} from './types';

const ROOMS: Room[] = [
  { id: 'lobby', name: '大廳' },
  { id: 'random', name: '閒聊' },
  { id: 'tech', name: '科技' },
];
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
const clone = (m: Message): Message => ({
  ...m,
  reactions: m.reactions.map((r) => ({ ...r })),
  replyTo: m.replyTo ? { ...m.replyTo } : null,
});

export function createMockClient(): ChatClient {
  const clientId = uid();
  const userId = clientId;
  const handlers: { [K in keyof ChatEventMap]: Set<(p: ChatEventMap[K]) => void> } = {
    'message:new': new Set(),
    'message:update': new Set(),
    'reaction:add': new Set(),
    'reaction:remove': new Set(),
    'presence:sync': new Set(),
    'presence:join': new Set(),
    'presence:leave': new Set(),
    'connection:status': new Set(),
  };
  function emit<K extends keyof ChatEventMap>(event: K, payload: ChatEventMap[K]) {
    for (const handler of [...handlers[event]]) handler(payload);
  }

  // ---- 假的歷史訊息（只有大廳有）----
  const lobby = roomConv('lobby');
  const history = new Map<ConversationId, Message[]>(ROOMS.map((r) => [roomConv(r.id), []]));
  let nextId = 1;
  const make = (partial: Partial<Message> & Pick<Message, 'nickname' | 'body' | 'conversation'>): Message => ({
    id: nextId++,
    clientMsgId: uid(),
    userId: `bot-${partial.nickname}`,
    toNickname: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
    replyTo: null,
    imagePath: null,
    reactions: [],
    sendState: 'sent',
    ...partial,
  });
  const start = Date.now() - TOTAL_HISTORY * 4 * 60_000;
  for (let i = 1; i <= TOTAL_HISTORY; i++) {
    let body = PHRASES[i % PHRASES.length];
    if (i % 17 === 0) body = IMAGE_URL;
    else if (i % 41 === 0) body = `這張連結壞掉了 ${BROKEN_IMAGE_URL}`;
    history.get(lobby)!.push(
      make({
        conversation: lobby,
        nickname: BOTS[(i * 7) % BOTS.length],
        body,
        createdAt: new Date(start + i * 4 * 60_000).toISOString(),
        reactions: i % 9 === 0 ? [{ emoji: '👍', userId: 'bot-x' }, { emoji: '👍', userId: 'bot-y' }] : [],
      }),
    );
  }
  history.get(roomConv('random'))!.push(
    make({ conversation: roomConv('random'), nickname: 'Zoe', body: '這裡是閒聊區，隨便聊' }),
  );

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
        userId: `bot-${nickname}`,
        joinedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        room: 'lobby',
        typing: false,
      });
    });
  };
  resetBots();

  const timers: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  const present = () => [...members.values()];
  const syncMembers = () => emit('presence:sync', present());
  const findMessage = (id: number): Message | undefined => {
    for (const list of history.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  };

  function botSay() {
    const bots = present().filter((m) => m.clientId !== clientId);
    if (bots.length === 0) return;
    const bot = pick(bots);
    const message = make({
      conversation: lobby,
      nickname: bot.nickname,
      body: Math.random() < 0.12 ? IMAGE_URL : pick(PHRASES),
    });
    history.get(lobby)!.push(message);
    // 斷線期間訊息仍然存在，只是這個瀏覽器沒收到；重連後會用 loadAfter 補上
    if (joined && status === 'connected') emit('message:new', clone(message));
  }

  function botReact() {
    if (!joined || status !== 'connected') return;
    const mine = [...history.get(lobby)!].reverse().find((m) => m.userId === userId && m.deletedAt === null);
    if (!mine || mine.id === null) return;
    const reaction: Reaction = { emoji: pick(['👍', '❤️', '😂']), userId: `bot-${pick(BOTS)}` };
    if (mine.reactions.some((r) => r.emoji === reaction.emoji && r.userId === reaction.userId)) return;
    mine.reactions.push(reaction);
    emit('reaction:add', { messageId: mine.id, ...reaction });
  }

  function blip(kind: 'short' | 'long') {
    if (!joined || status !== 'connected') return;
    const bots = present().filter((m) => m.clientId !== clientId);
    if (bots.length === 0) return;
    const bot = pick(bots);
    members.delete(bot.clientId);
    emit('presence:leave', bot);
    syncMembers();
    timers.push(
      setTimeout(
        () => {
          if (!joined) return;
          const back = { ...bot, joinedAt: new Date().toISOString() };
          members.set(back.clientId, back);
          if (status === 'connected') {
            emit('presence:join', back);
            syncMembers();
          }
        },
        kind === 'short' ? SHORT_LEAVE_MS : LONG_LEAVE_MS,
      ),
    );
  }

  function newcomerJoin() {
    if (!joined || status !== 'connected') return;
    const nickname = `Guest${Math.floor(Math.random() * 900 + 100)}`;
    const m: Member = {
      nickname,
      clientId: uid(),
      userId: `bot-${nickname}`,
      joinedAt: new Date().toISOString(),
      room: 'lobby',
      typing: false,
    };
    members.set(m.clientId, m);
    emit('presence:join', m);
    syncMembers();
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
      { label: '別人對我的最新訊息按表情', run: botReact },
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

  function page(list: Message[], from: number, to: number): Page {
    return { messages: list.slice(from, to).map(clone), hasMore: from > 0 };
  }

  return {
    clientId,
    get userId() {
      return userId;
    },
    features: { dm: false, upload: false, typing: false },
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
      self = { nickname, clientId, userId, joinedAt: new Date().toISOString(), room: 'lobby', typing: false };
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

    setPresence(update) {
      if (!self) return;
      if (update.room !== undefined) self.room = update.room;
      if (update.typing !== undefined) self.typing = update.typing;
      syncMembers();
    },

    async loadRooms() {
      return ROOMS.map((r) => ({ ...r }));
    },

    async loadDmPeers() {
      return [];
    },

    async loadLatest(conversation): Promise<Page> {
      await delay(300);
      const list = history.get(conversation) ?? [];
      return page(list, Math.max(0, list.length - PAGE_SIZE), list.length);
    },

    async loadOlder(conversation, beforeId): Promise<Page> {
      await delay(600);
      const list = history.get(conversation) ?? [];
      const end = list.findIndex((m) => (m.id ?? 0) >= beforeId);
      const to = end === -1 ? list.length : end;
      return page(list, Math.max(0, to - PAGE_SIZE), to);
    },

    async loadAfter(conversation, afterId) {
      await delay(300);
      return (history.get(conversation) ?? []).filter((m) => (m.id ?? 0) > afterId).map(clone);
    },

    async loadReactions(ids) {
      const result = new Map<number, Reaction[]>();
      for (const id of ids) {
        const m = findMessage(id);
        if (m) result.set(id, m.reactions.map((r) => ({ ...r })));
      }
      return result;
    },

    async send(draft: Draft): Promise<OpResult> {
      await delay(600);
      if (status !== 'connected' || !joined || !self) return { ok: false, reason: 'offline' };
      if (failNext) {
        failNext = false;
        return { ok: false, reason: 'error' };
      }
      const list = history.get(draft.conversation);
      if (!list) return { ok: false, reason: 'error' };
      // 同一個 clientMsgId 重送時不會產生第二則
      if (!list.some((m) => m.clientMsgId === draft.clientMsgId)) {
        const original = draft.replyToId === null ? undefined : findMessage(draft.replyToId);
        const message = make({
          clientMsgId: draft.clientMsgId,
          conversation: draft.conversation,
          userId,
          nickname: self.nickname,
          body: draft.body,
          replyTo: original
            ? {
                id: original.id!,
                nickname: original.nickname,
                snippet: original.deletedAt ? null : snippetOf(original.body),
              }
            : null,
        });
        list.push(message);
        emit('message:new', clone(message));
      }
      return { ok: true };
    },

    async edit(messageId, body): Promise<MessageResult> {
      await delay(300);
      const m = findMessage(messageId);
      if (!m || m.userId !== userId || m.deletedAt) return { ok: false, reason: 'error' };
      m.body = body;
      m.editedAt = new Date().toISOString();
      emit('message:update', clone(m));
      return { ok: true, message: clone(m) };
    },

    async remove(messageId): Promise<MessageResult> {
      await delay(300);
      const m = findMessage(messageId);
      if (!m || m.userId !== userId || m.deletedAt) return { ok: false, reason: 'error' };
      m.body = '[已刪除]';
      m.deletedAt = new Date().toISOString();
      m.imagePath = null;
      emit('message:update', clone(m));
      return { ok: true, message: clone(m) };
    },

    async react(messageId, emoji, on): Promise<OpResult> {
      await delay(200);
      const m = findMessage(messageId);
      if (!m) return { ok: false, reason: 'error' };
      const index = m.reactions.findIndex((r) => r.emoji === emoji && r.userId === userId);
      if (on && index === -1) {
        m.reactions.push({ emoji, userId });
        emit('reaction:add', { messageId, emoji, userId });
      } else if (!on && index !== -1) {
        m.reactions.splice(index, 1);
        emit('reaction:remove', { messageId, emoji, userId });
      }
      return { ok: true };
    },

    async uploadImage() {
      return { ok: false, reason: 'error' } as const;
    },

    imageUrl(path) {
      return path;
    },
  };
}
