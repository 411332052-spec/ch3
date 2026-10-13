// 階段二使用的「Supabase 資料來源」。與 mock.ts 遵守同一份介面（types.ts）。
//   身分           → Supabase 匿名登入（不用註冊，每個瀏覽器自動取得一個匿名身分）
//   訊息、回覆、私訊 → 資料表 messages（權限與頻率限制、字詞遮蔽都在資料庫端）
//   即時收新訊息、編輯、表情回應 → Realtime（Postgres Changes）
//   誰在線上、正在輸入、在哪個聊天室 → 資料表 online_users（每人一列，定時更新「最後在線時間」）
//   圖片           → Storage 的 chat-images
// 只使用公開的專案網址與 anon（publishable）key；金鑰從 config.ts 傳進來。
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import {
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  PAGE_SIZE,
  convTarget,
  isDm,
  isValidNickname,
  roomConv,
} from './rules';
import type {
  ChatClient,
  ChatEventMap,
  ConversationId,
  Draft,
  FailReason,
  JoinResult,
  Member,
  Message,
  MessageResult,
  OpResult,
  Page,
  Peer,
  Reaction,
  Room,
  UploadResult,
} from './types';

/** 訊息、編輯、表情回應、線上名單的即時通道 */
const DB_CHANNEL = 'chat:db';
/** 每隔這麼久更新一次自己的「最後在線時間」 */
const HEARTBEAT_MS = 12_000;
/** 每隔這麼久向資料庫重新確認一次完整的線上名單，補上即時通知漏掉的變動 */
const REFRESH_MS = 30_000;
/** 超過這麼久沒有任何動靜的人，視為已經離線（要比 HEARTBEAT_MS 大很多） */
const STALE_MS = 45_000;
const EXPIRY_CHECK_MS = 10_000;
const BUCKET = 'chat-images';
const SUBSCRIBE_TIMEOUT_MS = 10_000;
/** 切到背景超過這麼久再回來，就視同一次重連並補訊息 */
const BACKGROUND_RESYNC_MS = 3_000;
const BACKFILL_LIMIT = 1_000;
const SELECT_MESSAGE = '*, reactions(emoji, user_id)';
const UUID = /^[0-9a-f-]{36}$/i;

interface MessageRow {
  id: number;
  client_msg_id: string;
  user_id: string | null;
  nickname: string;
  room: string | null;
  recipient_id: string | null;
  to_nickname: string | null;
  body: string;
  reply_to: number | null;
  reply_nickname: string | null;
  reply_snippet: string | null;
  image_path: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reactions?: { emoji: string; user_id: string }[];
}

interface OnlineRow {
  client_id: string;
  user_id: string;
  nickname: string;
  room: string;
  typing: boolean;
  joined_at: string;
}

interface ReactionRow {
  message_id: number;
  user_id: string;
  emoji: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function failReason(error: { message?: string; code?: string } | null): FailReason {
  const text = `${error?.message ?? ''} ${error?.code ?? ''}`;
  if (text.includes('rate_limit')) return 'rate_limited';
  if (error?.code === '23514') return 'invalid';
  return 'error';
}

export function createSupabaseClient(url: string, anonKey: string): ChatClient {
  const clientId = uid();
  let myUserId = '';
  const supabase = createClient(url, anonKey, {
    // 匿名身分要記在這個瀏覽器，下次打開才是同一個人（才能編輯、刪除自己以前的訊息）
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

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

  let dbChannel: RealtimeChannel | null = null;
  /** 目前在線的人；seenAt 是「我最後一次收到他的動靜」的時間（用自己的時鐘，不受時差影響） */
  const online = new Map<string, { member: Member; seenAt: number }>();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  let accessToken = '';
  let self: Member | null = null;
  let joined = false;
  let hiddenAt: number | null = null;

  function toMessage(row: MessageRow): Message {
    const conversation: ConversationId = row.recipient_id
      ? `dm:${row.user_id === myUserId ? row.recipient_id : row.user_id}`
      : roomConv(row.room ?? 'lobby');
    return {
      id: row.id,
      clientMsgId: row.client_msg_id,
      conversation,
      userId: row.user_id,
      nickname: row.nickname,
      toNickname: row.to_nickname,
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      replyTo:
        row.reply_to === null
          ? null
          : { id: row.reply_to, nickname: row.reply_nickname, snippet: row.reply_snippet },
      imagePath: row.image_path,
      reactions: (row.reactions ?? []).map((r) => ({ emoji: r.emoji, userId: r.user_id })),
      sendState: 'sent',
    };
  }

  function toMember(row: OnlineRow): Member {
    return {
      nickname: row.nickname,
      clientId: row.client_id,
      userId: row.user_id,
      joinedAt: row.joined_at,
      room: row.room,
      typing: row.typing,
    };
  }

  function snapshot(): Member[] {
    return [...online.values()].map((entry) => ({ ...entry.member }));
  }
  const emitSync = () => emit('presence:sync', snapshot());

  // ---- 線上名單：資料表 online_users 的變動 ----
  function onOnlineInsert(row: OnlineRow) {
    if (!joined) return;
    const member = toMember(row);
    const isNew = !online.has(member.clientId);
    online.set(member.clientId, { member, seenAt: Date.now() });
    if (isNew && member.clientId !== clientId) emit('presence:join', { ...member });
    emitSync();
  }

  function onOnlineUpdate(row: OnlineRow) {
    if (!joined) return;
    const existing = online.get(row.client_id);
    if (!existing) return onOnlineInsert(row);
    const next = toMember(row);
    const changed = next.room !== existing.member.room || next.typing !== existing.member.typing;
    existing.member = next;
    existing.seenAt = Date.now();
    if (changed) emitSync();
  }

  function dropOnline(id: string) {
    const existing = online.get(id);
    if (!existing) return;
    online.delete(id);
    if (id !== clientId) emit('presence:leave', { ...existing.member });
    emitSync();
  }

  /** 向資料庫要「現在真的在線」的完整名單（由資料庫用它自己的時鐘判斷誰已經離線） */
  async function refreshOnline() {
    if (!joined) return;
    const { data, error } = await supabase.rpc('online_now');
    if (error || !data) return;
    const rows = data as OnlineRow[];
    const alive = new Set(rows.map((row) => row.client_id));
    for (const row of rows) onOnlineUpdate(row);
    for (const id of [...online.keys()]) {
      if (id !== clientId && !alive.has(id)) dropOnline(id);
    }
  }

  async function heartbeat() {
    if (!joined || !self) return;
    const { data, error } = await supabase
      .from('online_users')
      .update({ typing: self.typing, room: self.room })
      .eq('client_id', clientId)
      .select('client_id');
    if (error) return;
    if ((data ?? []).length === 0) {
      // 自己那一列不見了（例如斷線太久被清掉）：重新登記
      await supabase.from('online_users').insert({ client_id: clientId, nickname: self.nickname, room: self.room });
    }
  }

  function startTimers() {
    stopTimers();
    heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
    refreshTimer = setInterval(() => void refreshOnline(), REFRESH_MS);
    expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of [...online]) {
        if (id !== clientId && now - entry.seenAt > STALE_MS) dropOnline(id);
      }
    }, EXPIRY_CHECK_MS);
  }

  function stopTimers() {
    clearInterval(heartbeatTimer);
    clearInterval(refreshTimer);
    clearInterval(expiryTimer);
  }

  /** 關掉分頁時用：瀏覽器即將離開，所以要用 keepalive 讓這個請求能在背景送完 */
  function sendLeaveBeacon() {
    if (!joined || !accessToken) return;
    try {
      void fetch(`${url}/rest/v1/online_users?client_id=eq.${clientId}`, {
        method: 'DELETE',
        keepalive: true,
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // 送不出去就等 45 秒後被視為離線
    }
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? '';
  });

  async function teardown() {
    const wasJoined = joined;
    joined = false;
    stopTimers();
    online.clear();
    const channel = dbChannel;
    dbChannel = null;
    if (wasJoined || self) {
      try {
        await supabase.from('online_users').delete().eq('client_id', clientId);
      } catch {
        // 刪不掉就等 45 秒後被視為離線
      }
    }
    self = null;
    if (channel) await supabase.removeChannel(channel);
  }

  /** 某個對話的查詢條件：公開聊天室，或「我和某人」之間的私訊 */
  function conversationQuery(conversation: ConversationId) {
    const query = supabase.from('messages').select(SELECT_MESSAGE);
    const target = convTarget(conversation);
    if (isDm(conversation)) {
      if (!UUID.test(target)) throw new Error('invalid conversation');
      return query.or(
        `and(user_id.eq.${myUserId},recipient_id.eq.${target}),and(user_id.eq.${target},recipient_id.eq.${myUserId})`,
      );
    }
    return query.eq('room', target).is('recipient_id', null);
  }

  async function fetchPage(conversation: ConversationId, beforeId: number | null): Promise<Page> {
    let query = conversationQuery(conversation);
    if (beforeId !== null) query = query.lt('id', beforeId);
    const { data, error } = await query.order('id', { ascending: false }).limit(PAGE_SIZE + 1);
    if (error) throw error;
    const rows = data as unknown as MessageRow[];
    return {
      messages: rows.slice(0, PAGE_SIZE).reverse().map(toMessage),
      hasMore: rows.length > PAGE_SIZE,
    };
  }

  // ---- 網路與前景／背景（架構文件 6.4）----
  window.addEventListener('offline', () => {
    if (joined) emit('connection:status', 'offline');
  });
  window.addEventListener('online', () => {
    if (joined && dbChannel?.state === 'joined') emit('connection:status', 'connected');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (!joined || !dbChannel || !self || away < BACKGROUND_RESYNC_MS) return;
    if (dbChannel.state !== 'joined') return; // 連線已經斷了，等函式庫自己重連
    // 手機從背景回來可能漏了訊息：走一次「重連」流程，讓畫面補上漏掉的訊息
    emit('connection:status', 'reconnecting');
    void heartbeat().then(refreshOnline);
    setTimeout(() => {
      if (joined) emit('connection:status', 'connected');
    }, 300);
  });

  return {
    clientId,
    get userId() {
      return myUserId;
    },
    features: { dm: true, upload: true, typing: true },

    on(event, handler) {
      const set = handlers[event] as Set<typeof handler>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    async join(nickname): Promise<JoinResult> {
      if (!isValidNickname(nickname)) return { ok: false, reason: 'invalid' };
      await teardown();

      // 取得（或沿用）這個瀏覽器的匿名身分
      let { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        const signedIn = await supabase.auth.signInAnonymously();
        if (signedIn.error || !signedIn.data.session) {
          console.error('匿名登入失敗：', signedIn.error);
          const limited =
            signedIn.error?.status === 429 || /rate limit/i.test(signedIn.error?.message ?? '');
          return { ok: false, reason: limited ? 'rate_limited' : 'auth' };
        }
        sessionData = { session: signedIn.data.session };
      }
      myUserId = sessionData.session!.user.id;

      myUserId = sessionData.session!.user.id;
      accessToken = sessionData.session!.access_token;

      // ---- 訊息通道：新訊息、編輯、表情回應、線上名單的變動 ----
      const db = supabase.channel(DB_CHANNEL);
      dbChannel = db;
      db.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        if (joined) emit('message:new', toMessage(payload.new as MessageRow));
      })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
          if (joined) emit('message:update', toMessage(payload.new as MessageRow));
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, (payload) => {
          const row = payload.new as ReactionRow;
          if (joined) emit('reaction:add', { messageId: row.message_id, emoji: row.emoji, userId: row.user_id });
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, (payload) => {
          const row = payload.old as Partial<ReactionRow>;
          if (joined && row.message_id !== undefined && row.emoji && row.user_id) {
            emit('reaction:remove', { messageId: row.message_id, emoji: row.emoji, userId: row.user_id });
          }
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'online_users' }, (payload) => {
          onOnlineInsert(payload.new as OnlineRow);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'online_users' }, (payload) => {
          onOnlineUpdate(payload.new as OnlineRow);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'online_users' }, (payload) => {
          const row = payload.old as Partial<OnlineRow>;
          if (row.client_id) dropOnline(row.client_id);
        });

      let dbEverSubscribed = false;
      const dbSubscribed = new Promise<boolean>((resolve) => {
        db.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (!dbEverSubscribed) {
              dbEverSubscribed = true;
              resolve(true);
            } else if (joined) {
              // 斷線後自動重連成功：確認自己還在線、更新名單，並通知畫面補上漏掉的訊息
              void heartbeat().then(refreshOnline);
              emit('connection:status', 'connected');
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (!dbEverSubscribed) resolve(false);
            else if (joined) emit('connection:status', 'reconnecting');
          }
        });
      });
      const dbReady = await Promise.race([dbSubscribed, delay(SUBSCRIBE_TIMEOUT_MS).then(() => false)]);
      if (!dbReady) {
        await teardown();
        return { ok: false, reason: 'error' };
      }

      // ---- 登記為在線者：代號重複由資料庫一次擋下（不分大小寫）----
      const me: Member = {
        nickname,
        clientId,
        userId: myUserId,
        joinedAt: new Date().toISOString(),
        room: 'lobby',
        typing: false,
      };
      let inserted = await supabase
        .from('online_users')
        .insert({ client_id: clientId, nickname, room: me.room });
      if (inserted.error?.code === '23505' && /pkey/.test(inserted.error.message)) {
        // 上一次嘗試進入時留下的自己那一列：刪掉再登記一次
        await supabase.from('online_users').delete().eq('client_id', clientId);
        inserted = await supabase.from('online_users').insert({ client_id: clientId, nickname, room: me.room });
      }
      if (inserted.error) {
        console.warn('登記在線失敗：', inserted.error.message);
        await teardown();
        return { ok: false, reason: inserted.error.code === '23505' ? 'taken' : 'error' };
      }

      self = me;
      joined = true;
      online.set(clientId, { member: { ...me }, seenAt: Date.now() });
      await refreshOnline();
      startTimers();
      emit('connection:status', 'connected');
      emitSync();
      return { ok: true };
    },

    leave() {
      sendLeaveBeacon();
      void teardown();
    },

    setPresence(update) {
      if (!self) return;
      if (update.room !== undefined) self.room = update.room;
      if (update.typing !== undefined) self.typing = update.typing;
      const mine = online.get(clientId);
      if (mine) mine.member = { ...self };
      emitSync();
      void supabase
        .from('online_users')
        .update({ room: self.room, typing: self.typing })
        .eq('client_id', clientId)
        .then(() => undefined);
    },

    async loadRooms(): Promise<Room[]> {
      const { data, error } = await supabase.from('rooms').select('id, name').order('sort');
      if (error) throw error;
      return data as Room[];
    },

    async loadDmPeers(): Promise<Peer[]> {
      const { data, error } = await supabase
        .from('messages')
        .select('user_id, nickname, recipient_id, to_nickname')
        .not('recipient_id', 'is', null)
        .order('id', { ascending: false })
        .limit(300);
      if (error) throw error;
      const peers = new Map<string, Peer>();
      for (const row of data as Pick<MessageRow, 'user_id' | 'nickname' | 'recipient_id' | 'to_nickname'>[]) {
        const mine = row.user_id === myUserId;
        const userId = mine ? row.recipient_id : row.user_id;
        const nickname = mine ? row.to_nickname : row.nickname;
        if (userId && nickname && !peers.has(userId)) peers.set(userId, { userId, nickname });
      }
      return [...peers.values()];
    },

    loadLatest(conversation) {
      return fetchPage(conversation, null);
    },

    loadOlder(conversation, beforeId) {
      return fetchPage(conversation, beforeId);
    },

    async loadAfter(conversation, afterId): Promise<Message[]> {
      const { data, error } = await conversationQuery(conversation)
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(BACKFILL_LIMIT);
      if (error) throw error;
      return (data as unknown as MessageRow[]).map(toMessage);
    },

    async loadReactions(messageIds): Promise<Map<number, Reaction[]>> {
      const result = new Map<number, Reaction[]>(messageIds.map((id) => [id, []]));
      if (messageIds.length === 0) return result;
      const { data, error } = await supabase
        .from('reactions')
        .select('message_id, emoji, user_id')
        .in('message_id', messageIds);
      if (error) throw error;
      for (const row of data as ReactionRow[]) {
        result.get(row.message_id)?.push({ emoji: row.emoji, userId: row.user_id });
      }
      return result;
    },

    async send(draft: Draft): Promise<OpResult> {
      if (!joined || !self) return { ok: false, reason: 'offline' };
      if (navigator.onLine === false) return { ok: false, reason: 'offline' };
      const dm = isDm(draft.conversation);
      const target = convTarget(draft.conversation);
      try {
        const { error } = await supabase.from('messages').insert({
          client_msg_id: draft.clientMsgId,
          nickname: self.nickname,
          body: draft.body,
          room: dm ? null : target,
          recipient_id: dm ? target : null,
          to_nickname: dm ? draft.toNickname : null,
          reply_to: draft.replyToId,
          image_path: draft.imagePath,
        });
        // 23505 = 同一個 clientMsgId 已經存在：代表上一次其實已經送成功，重送不會變兩則
        if (!error || error.code === '23505') return { ok: true };
        return { ok: false, reason: failReason(error) };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    async edit(messageId, body): Promise<MessageResult> {
      try {
        const { data, error } = await supabase
          .from('messages')
          .update({ body })
          .eq('id', messageId)
          .select(SELECT_MESSAGE)
          .single();
        if (error) return { ok: false, reason: failReason(error) };
        return { ok: true, message: toMessage(data as unknown as MessageRow) };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    async remove(messageId): Promise<MessageResult> {
      try {
        const { data, error } = await supabase
          .from('messages')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', messageId)
          .select(SELECT_MESSAGE)
          .single();
        if (error) return { ok: false, reason: failReason(error) };
        return { ok: true, message: toMessage(data as unknown as MessageRow) };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    async react(messageId, emoji, on): Promise<OpResult> {
      try {
        if (on) {
          const { error } = await supabase.from('reactions').insert({ message_id: messageId, emoji });
          if (error && error.code !== '23505') return { ok: false, reason: failReason(error) };
        } else {
          const { error } = await supabase
            .from('reactions')
            .delete()
            .eq('message_id', messageId)
            .eq('emoji', emoji)
            .eq('user_id', myUserId);
          if (error) return { ok: false, reason: failReason(error) };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    async uploadImage(file): Promise<UploadResult> {
      if (!IMAGE_TYPES.includes(file.type)) return { ok: false, reason: 'type' };
      if (file.size > IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
      const path = `${myUserId}/${uid()}.${EXTENSIONS[file.type]}`;
      try {
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (error) return { ok: false, reason: 'error' };
        return { ok: true, path };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },

    imageUrl(path) {
      return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },
  };
}
