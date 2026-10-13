// 階段二使用的「Supabase 資料來源」。與 mock.ts 遵守同一份介面（types.ts）。
//   身分           → Supabase 匿名登入（不用註冊，每個瀏覽器自動取得一個匿名身分）
//   訊息、回覆、私訊 → 資料表 messages（權限與頻率限制、字詞遮蔽都在資料庫端）
//   即時收新訊息、編輯、表情回應 → Realtime（Postgres Changes）
//   誰在線上、正在輸入、在哪個聊天室 → Realtime Presence
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

/** 訊息、編輯、表情回應的即時通道 */
const DB_CHANNEL = 'chat:db';
/** 線上名單（誰在線上、在哪個聊天室、正在輸入）的通道。和訊息通道分開，
 *  線上名單偶爾不穩時，不會連累訊息收發，也不會卡住進入聊天室。 */
const PRESENCE_CHANNEL = 'room:main';
/** 線上名單最多花這麼久；超過就先進入聊天室，線上名單在背景繼續重試 */
const PRESENCE_BUDGET_MS = 7_000;
const PRESENCE_SUBSCRIBE_MS = 3_000;
const TRACK_TIMEOUT_MS = 3_000;
const TRACK_ATTEMPTS = 2;
const BUCKET = 'chat-images';
/** 等第一次取得線上名單的最長時間 */
const FIRST_SYNC_TIMEOUT_MS = 3_000;
/** 登記自己之後，等其他人的名單同步過來，再判斷有沒有人同時搶同一個代號 */
const SETTLE_MS = 800;
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
  let presenceChannel: RealtimeChannel | null = null;
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

  function members(ch: RealtimeChannel): Member[] {
    return Object.values(ch.presenceState<Member>())
      .filter((metas) => metas.length > 0)
      .map((metas) => ({ ...metas[metas.length - 1] }));
  }

  async function teardown() {
    joined = false;
    self = null;
    const channels = [dbChannel, presenceChannel];
    dbChannel = null;
    presenceChannel = null;
    for (const ch of channels) {
      if (!ch) continue;
      try {
        await ch.untrack();
      } catch {
        // 已經斷線就算了
      }
      await supabase.removeChannel(ch);
    }
  }

  async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await delay(100);
    }
    return check();
  }

  /** 登記為在線者。這個通道偶爾會逾時，所以失敗就等它重連後再試，最多試幾次 */
  async function trackWithRetry(ch: RealtimeChannel, me: Member): Promise<boolean> {
    for (let attempt = 0; attempt < TRACK_ATTEMPTS; attempt++) {
      if (presenceChannel !== ch) return false; // 已經離開或換了通道
      if (!(await waitUntil(() => ch.state === 'joined', PRESENCE_SUBSCRIBE_MS))) continue;
      try {
        if ((await ch.track(me, { timeout: TRACK_TIMEOUT_MS })) === 'ok') return true;
      } catch {
        // 逾時就再試
      }
    }
    return false;
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
    const pc = presenceChannel;
    const me = self;
    emit('connection:status', 'reconnecting');
    if (pc) void trackWithRetry(pc, me);
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

      const lower = nickname.toLowerCase();
      const me: Member = {
        nickname,
        clientId,
        userId: myUserId,
        joinedAt: new Date().toISOString(),
        room: 'lobby',
        typing: false,
      };

      // ---- 1. 訊息通道：新訊息、編輯、表情回應 ----
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
        });

      let dbEverSubscribed = false;
      const dbSubscribed = new Promise<boolean>((resolve) => {
        db.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (!dbEverSubscribed) {
              dbEverSubscribed = true;
              resolve(true);
            } else if (joined) {
              // 斷線後自動重連成功：通知畫面補上漏掉的訊息
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

      // ---- 2. 線上名單通道 ----
      const pc = supabase.channel(PRESENCE_CHANNEL, { config: { presence: { key: clientId } } });
      presenceChannel = pc;
      let markSynced: () => void = () => {};
      const firstSync = new Promise<void>((resolve) => {
        markSynced = resolve;
      });
      pc.on('presence', { event: 'sync' }, () => {
        markSynced();
        if (joined) emit('presence:sync', members(pc));
      })
        // 同一個人更新資料（換聊天室、正在輸入）時，函式庫也會送 join／leave；
        // 只有「這個人原本沒有／之後完全沒有」才是真的加入或離開
        .on('presence', { event: 'join' }, (payload) => {
          if (!joined) return;
          const { currentPresences, newPresences } = payload as unknown as {
            currentPresences: Member[];
            newPresences: Member[];
          };
          if (currentPresences.length > 0) return;
          for (const meta of newPresences) emit('presence:join', { ...meta });
        })
        .on('presence', { event: 'leave' }, (payload) => {
          if (!joined) return;
          const { currentPresences, leftPresences } = payload as unknown as {
            currentPresences: Member[];
            leftPresences: Member[];
          };
          if (currentPresences.length > 0) return;
          for (const meta of leftPresences) emit('presence:leave', { ...meta });
        });
      pc.subscribe((status) => {
        // 連線重新建立後，重新登記自己在線
        if (status === 'SUBSCRIBED' && self) void pc.track(self).catch(() => {});
      });

      const presencePhase = async (): Promise<'ok' | 'taken' | 'degraded'> => {
        if (!(await waitUntil(() => pc.state === 'joined', PRESENCE_SUBSCRIBE_MS))) return 'degraded';
        await Promise.race([firstSync, delay(FIRST_SYNC_TIMEOUT_MS)]);
        // 檢查代號有沒有已經被在線的人使用（不分大小寫）
        if (members(pc).some((m) => m.clientId !== clientId && m.nickname.toLowerCase() === lower)) {
          return 'taken';
        }
        if (!(await trackWithRetry(pc, me))) return 'degraded';
        // 兩人幾乎同時搶同一個代號：等名單同步後，進入時間較晚者退出（時間相同則比 clientId）
        await delay(SETTLE_MS);
        const rivals = members(pc)
          .filter((m) => m.nickname.toLowerCase() === lower)
          .sort((a, b) =>
            a.joinedAt === b.joinedAt
              ? a.clientId.localeCompare(b.clientId)
              : a.joinedAt.localeCompare(b.joinedAt),
          );
        return rivals.length > 0 && rivals[0].clientId !== clientId ? 'taken' : 'ok';
      };
      const outcome = await Promise.race([
        presencePhase(),
        delay(PRESENCE_BUDGET_MS).then(() => 'degraded' as const),
      ]);
      if (outcome === 'taken') {
        await teardown();
        return { ok: false, reason: 'taken' };
      }

      self = me;
      joined = true;
      if (outcome === 'degraded') {
        // 線上名單暫時連不上：先讓使用者進入，聊天不受影響，名單在背景繼續重試
        console.warn('線上名單暫時連不上，先進入聊天室，背景繼續重試');
        void trackWithRetry(pc, me);
      }
      emit('connection:status', 'connected');
      emit('presence:sync', members(pc));
      return { ok: true };
    },

    leave() {
      void teardown();
    },

    setPresence(update) {
      if (!presenceChannel || !self) return;
      if (update.room !== undefined) self.room = update.room;
      if (update.typing !== undefined) self.typing = update.typing;
      void presenceChannel.track(self, { timeout: TRACK_TIMEOUT_MS }).catch(() => {});
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
