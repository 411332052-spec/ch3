// 階段二使用的「Supabase 資料來源」。與 mock.ts 遵守同一份介面（types.ts）。
//   訊息歷史與新增 → 資料表 messages
//   即時收新訊息   → Realtime（Postgres Changes）
//   誰在線上       → Realtime Presence
// 只使用公開的專案網址與 anon（publishable）key；金鑰從 config.ts 傳進來。
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { PAGE_SIZE, isValidNickname } from './rules';
import type {
  ChatClient,
  ChatEventMap,
  JoinResult,
  Member,
  Message,
  Page,
  SendResult,
} from './types';

const CHANNEL_NAME = 'room:main';
/** 等第一次取得線上名單的最長時間 */
const FIRST_SYNC_TIMEOUT_MS = 3_000;
/** 登記自己之後，等其他人的名單同步過來，再判斷有沒有人同時搶同一個代號 */
const SETTLE_MS = 800;
const SUBSCRIBE_TIMEOUT_MS = 10_000;
/** 切到背景超過這麼久再回來，就視同一次重連並補訊息 */
const BACKGROUND_RESYNC_MS = 3_000;
const BACKFILL_LIMIT = 1_000;

interface PresenceMeta {
  nickname: string;
  clientId: string;
  joinedAt: string;
}

interface MessageRow {
  id: number;
  client_msg_id: string;
  nickname: string;
  body: string;
  created_at: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    clientMsgId: row.client_msg_id,
    nickname: row.nickname,
    body: row.body,
    createdAt: row.created_at,
    sendState: 'sent',
  };
}

function toMember(meta: PresenceMeta): Member {
  return { nickname: meta.nickname, clientId: meta.clientId, joinedAt: meta.joinedAt };
}

export function createSupabaseClient(url: string, anonKey: string): ChatClient {
  const clientId = uid();
  const supabase = createClient(url, anonKey, {
    // 不登入，所以不需要保存任何登入狀態
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

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

  let channel: RealtimeChannel | null = null;
  let self: Member | null = null;
  let joined = false;
  let hiddenAt: number | null = null;

  function members(ch: RealtimeChannel): Member[] {
    return Object.values(ch.presenceState<PresenceMeta>()).map((metas) =>
      toMember(metas[metas.length - 1]),
    );
  }

  async function teardown() {
    joined = false;
    self = null;
    const ch = channel;
    channel = null;
    if (ch) {
      try {
        await ch.untrack();
      } catch {
        // 已經斷線就算了
      }
      await supabase.removeChannel(ch);
    }
  }

  // ---- 網路與前景／背景（架構文件 6.4）----
  window.addEventListener('offline', () => {
    if (joined) emit('connection:status', 'offline');
  });
  window.addEventListener('online', () => {
    if (joined && channel?.state === 'joined') emit('connection:status', 'connected');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (!joined || !channel || !self || away < BACKGROUND_RESYNC_MS) return;
    if (channel.state !== 'joined') return; // 連線已經斷了，等函式庫自己重連
    // 手機從背景回來可能漏了訊息：走一次「重連」流程，讓畫面補上漏掉的訊息
    const ch = channel;
    const me = self;
    emit('connection:status', 'reconnecting');
    void ch.track(me).then(() => {
      if (joined) emit('connection:status', 'connected');
    });
  });

  return {
    clientId,

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

      const lower = nickname.toLowerCase();
      const ch = supabase.channel(CHANNEL_NAME, { config: { presence: { key: clientId } } });
      channel = ch;

      let markSynced: () => void = () => {};
      const firstSync = new Promise<void>((resolve) => {
        markSynced = resolve;
      });

      ch.on('presence', { event: 'sync' }, () => {
        markSynced();
        if (joined) emit('presence:sync', members(ch));
      })
        .on('presence', { event: 'join' }, ({ newPresences }) => {
          if (!joined) return;
          for (const meta of newPresences as unknown as PresenceMeta[]) {
            emit('presence:join', toMember(meta));
          }
        })
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {
          if (!joined) return;
          for (const meta of leftPresences as unknown as PresenceMeta[]) {
            emit('presence:leave', toMember(meta));
          }
        })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            if (joined) emit('message:new', toMessage(payload.new as MessageRow));
          },
        );

      let everSubscribed = false;
      const subscribed = new Promise<boolean>((resolve) => {
        ch.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (!everSubscribed) {
              everSubscribed = true;
              resolve(true);
            } else if (joined && self) {
              // 斷線後自動重連成功：重新登記在線，並通知畫面補上漏掉的訊息
              void ch.track(self);
              emit('connection:status', 'connected');
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (!everSubscribed) resolve(false);
            else if (joined) emit('connection:status', 'reconnecting');
          }
        });
      });

      const connected = await Promise.race([
        subscribed,
        delay(SUBSCRIBE_TIMEOUT_MS).then(() => false),
      ]);
      if (!connected) {
        await teardown();
        return { ok: false, reason: 'error' };
      }

      // 檢查代號有沒有已經被在線的人使用
      await Promise.race([firstSync, delay(FIRST_SYNC_TIMEOUT_MS)]);
      const taken = members(ch).some(
        (m) => m.clientId !== clientId && m.nickname.toLowerCase() === lower,
      );
      if (taken) {
        await teardown();
        return { ok: false, reason: 'taken' };
      }

      // 登記為在線者
      const me: Member = { nickname, clientId, joinedAt: new Date().toISOString() };
      const tracked = await ch.track(me);
      if (tracked !== 'ok') {
        await teardown();
        return { ok: false, reason: 'error' };
      }

      // 兩人幾乎同時搶同一個代號：等名單同步後，進入時間較晚者退出（時間相同則比 clientId）
      await delay(SETTLE_MS);
      const rivals = members(ch)
        .filter((m) => m.nickname.toLowerCase() === lower)
        .sort((a, b) =>
          a.joinedAt === b.joinedAt
            ? a.clientId.localeCompare(b.clientId)
            : a.joinedAt.localeCompare(b.joinedAt),
        );
      if (rivals.length > 0 && rivals[0].clientId !== clientId) {
        await teardown();
        return { ok: false, reason: 'taken' };
      }

      self = me;
      joined = true;
      emit('connection:status', 'connected');
      emit('presence:sync', members(ch));
      return { ok: true };
    },

    leave() {
      void teardown();
    },

    async loadLatest(): Promise<Page> {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1);
      if (error) throw error;
      const rows = data as MessageRow[];
      return {
        messages: rows.slice(0, PAGE_SIZE).reverse().map(toMessage),
        hasMore: rows.length > PAGE_SIZE,
      };
    },

    async loadOlder(beforeId): Promise<Page> {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .lt('id', beforeId)
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1);
      if (error) throw error;
      const rows = data as MessageRow[];
      return {
        messages: rows.slice(0, PAGE_SIZE).reverse().map(toMessage),
        hasMore: rows.length > PAGE_SIZE,
      };
    },

    async loadAfter(afterId): Promise<Message[]> {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(BACKFILL_LIMIT);
      if (error) throw error;
      return (data as MessageRow[]).map(toMessage);
    },

    async send(body, clientMsgId): Promise<SendResult> {
      if (!joined || !self) return { ok: false, reason: 'offline' };
      if (navigator.onLine === false) return { ok: false, reason: 'offline' };
      try {
        const { error } = await supabase
          .from('messages')
          .insert({ client_msg_id: clientMsgId, nickname: self.nickname, body });
        // 23505 = 同一個 clientMsgId 已經存在：代表上一次其實已經送成功，重送不會變兩則
        if (!error || error.code === '23505') return { ok: true };
        return { ok: false, reason: 'error' };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },
  };
}
