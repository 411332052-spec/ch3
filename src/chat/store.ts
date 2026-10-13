// 畫面狀態：多個對話的訊息、線上名單、連線狀態、未讀數，以及「離開提示」的緩衝規則。
// 只依賴 ChatClient 介面，不知道資料是模擬的還是 Supabase 的。
import { MAX_BODY, bodyLength, convTarget, dmConv, isDm, isValidBody, mentionsNickname, roomConv, snippetOf } from './rules';
import type {
  ChatClient,
  ConnectionStatus,
  ConversationId,
  FailReason,
  Features,
  JoinResult,
  Member,
  Message,
  Peer,
  Reaction,
  ReactionEvent,
  Room,
} from './types';

/** 有人離開後，等這麼久都沒回來才顯示「離開了聊天室」 */
export const LEAVE_GRACE_MS = 10_000;
const BACKFILL_RECHECK = 50;

export type Item =
  | { kind: 'msg'; key: string; msg: Message }
  | { kind: 'notice'; key: string; type: 'join' | 'leave'; nickname: string };

export interface State {
  phase: 'entry' | 'chat';
  nickname: string;
  userId: string;
  features: Features;
  rooms: Room[];
  peers: Peer[];
  /** 目前顯示的對話 */
  current: ConversationId;
  /** 最近待過的公開聊天室（在私訊畫面時，線上名單看的是它） */
  room: string;
  members: Member[];
  status: ConnectionStatus;
  /** 目前對話的訊息（和內部資料是同一個陣列） */
  items: Item[];
  hasMore: boolean;
  loadingOlder: boolean;
  loadingConv: boolean;
  unread: Record<ConversationId, number>;
}

/** 告訴畫面「這次變動是什麼」，畫面據此決定要不要捲動 */
export type ChangeHint =
  | 'init'
  | 'switch'
  | 'append-own'
  | 'append-other'
  | 'append-notice'
  | 'prepend'
  | 'update'
  | 'other';

export interface IncomingInfo {
  isCurrent: boolean;
  mention: boolean;
  dm: boolean;
}

interface Conv {
  items: Item[];
  byClient: Map<string, Message>;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  /** 還沒載入歷史時先收到的新訊息，載入完成後再併進去 */
  pending: Message[];
}

type Listener = (state: State, hint: ChangeHint) => void;

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const FAIL_TEXT: Record<FailReason, string> = {
  offline: '目前離線，等連線恢復後再試一次',
  invalid: '內容不符合規定，請修改後再試',
  rate_limited: '送得太快了，請稍等幾秒再試',
  error: '操作失敗，請稍後再試',
};

export class ChatStore {
  readonly state: State = {
    phase: 'entry',
    nickname: '',
    userId: '',
    features: { dm: false, upload: false, typing: false },
    rooms: [],
    peers: [],
    current: '',
    room: 'lobby',
    members: [],
    status: 'connected',
    items: [],
    hasMore: false,
    loadingOlder: false,
    loadingConv: false,
    unread: {},
  };

  private listeners = new Set<Listener>();
  private incomingListeners = new Set<(msg: Message, info: IncomingInfo) => void>();
  private toastListeners = new Set<(text: string) => void>();
  private convs = new Map<ConversationId, Conv>();
  private byId = new Map<number, Message>();
  private pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();
  private detachers: (() => void)[] = [];
  private noticeSeq = 0;

  constructor(private client: ChatClient) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 收到「別人」的新訊息時通知（用來更新分頁標題、播提示音、桌面通知） */
  onIncoming(listener: (msg: Message, info: IncomingInfo) => void): () => void {
    this.incomingListeners.add(listener);
    return () => {
      this.incomingListeners.delete(listener);
    };
  }

  onToast(listener: (text: string) => void): () => void {
    this.toastListeners.add(listener);
    return () => {
      this.toastListeners.delete(listener);
    };
  }

  private emit(hint: ChangeHint) {
    for (const listener of [...this.listeners]) listener(this.state, hint);
  }

  /** 在畫面上跳出一則短暫的提示 */
  toast(text: string) {
    for (const listener of [...this.toastListeners]) listener(text);
  }

  private conv(id: ConversationId): Conv {
    let c = this.convs.get(id);
    if (!c) {
      c = {
        items: [],
        byClient: new Map(),
        hasMore: false,
        loaded: false,
        loading: false,
        loadingOlder: false,
        pending: [],
      };
      this.convs.set(id, c);
    }
    return c;
  }

  /** 把目前對話的狀態複製到 state */
  private syncCurrent() {
    const c = this.conv(this.state.current);
    this.state.items = c.items;
    this.state.hasMore = c.hasMore;
    this.state.loadingOlder = c.loadingOlder;
    this.state.loadingConv = c.loading;
  }

  // ---- 標題 ----

  titleOf(conv: ConversationId): string {
    if (isDm(conv)) {
      const peer = this.state.peers.find((p) => p.userId === convTarget(conv));
      return peer ? `私訊 ${peer.nickname}` : '私訊';
    }
    const room = this.state.rooms.find((r) => r.id === convTarget(conv));
    return room ? `# ${room.name}` : '聊天室';
  }

  // ---- 進入聊天室 ----

  async enter(nickname: string): Promise<JoinResult> {
    this.state.nickname = nickname;
    this.attach();
    const joined = await this.client.join(nickname);
    if (!joined.ok) {
      this.detach();
      return joined;
    }
    try {
      const { client, state } = this;
      state.userId = client.userId;
      state.features = client.features;
      const [rooms, peers] = await Promise.all([
        client.loadRooms(),
        client.features.dm ? client.loadDmPeers() : Promise.resolve([] as Peer[]),
      ]);
      state.rooms = rooms;
      state.peers = peers;
      state.room = rooms[0]?.id ?? 'lobby';
      state.current = roomConv(state.room);
      if (state.room !== 'lobby') client.setPresence({ room: state.room });
      await this.load(state.current);
    } catch (error) {
      console.error(error);
      this.client.leave();
      this.detach();
      return { ok: false, reason: 'error' };
    }
    this.state.phase = 'chat';
    this.syncCurrent();
    this.emit('init');
    return { ok: true };
  }

  private attach() {
    this.detach();
    const c = this.client;
    this.detachers = [
      c.on('message:new', (msg) => this.onMessage(msg)),
      c.on('message:update', (msg) => this.onUpdate(msg)),
      c.on('reaction:add', (e) => this.applyReaction(e, true)),
      c.on('reaction:remove', (e) => this.applyReaction(e, false)),
      c.on('presence:sync', (members) => {
        this.state.members = members;
        this.emit('other');
      }),
      c.on('presence:join', (member) => this.onJoin(member)),
      c.on('presence:leave', (member) => this.onLeave(member)),
      c.on('connection:status', (status) => this.onStatus(status)),
    ];
  }

  private detach() {
    this.detachers.forEach((off) => off());
    this.detachers = [];
    this.pendingLeave.forEach(clearTimeout);
    this.pendingLeave.clear();
  }

  // ---- 對話與歷史 ----

  private async load(conv: ConversationId) {
    const c = this.conv(conv);
    c.loading = true;
    try {
      const page = await this.client.loadLatest(conv);
      c.items.length = 0;
      c.byClient.clear();
      for (const msg of page.messages) this.addMessage(c, msg);
      c.hasMore = page.hasMore;
      c.loaded = true;
      for (const msg of c.pending) this.addMessage(c, msg);
      c.pending = [];
    } finally {
      c.loading = false;
    }
  }

  async switchTo(conv: ConversationId): Promise<void> {
    const { state } = this;
    if (conv === state.current) return;
    state.current = conv;
    state.unread[conv] = 0;
    if (!isDm(conv)) {
      state.room = convTarget(conv);
      this.client.setPresence({ room: state.room, typing: false });
    } else {
      this.client.setPresence({ typing: false });
    }
    this.syncCurrent();
    this.emit('switch');
    const c = this.conv(conv);
    if (!c.loaded && !c.loading) {
      state.loadingConv = true;
      this.emit('other');
      try {
        await this.load(conv);
      } catch (error) {
        console.error(error);
        this.toast('載入訊息失敗，請稍後再試');
      }
      if (state.current === conv) {
        this.syncCurrent();
        this.emit('switch');
      }
    }
  }

  /** 開啟和某人的私訊 */
  async openDm(userId: string, nickname: string): Promise<void> {
    if (!this.state.features.dm || userId === this.state.userId) return;
    this.ensurePeer(userId, nickname);
    await this.switchTo(dmConv(userId));
  }

  private ensurePeer(userId: string, nickname: string) {
    const existing = this.state.peers.find((p) => p.userId === userId);
    if (!existing) this.state.peers.push({ userId, nickname: nickname || '?' });
    else if (nickname && existing.nickname !== nickname) existing.nickname = nickname;
  }

  async loadOlder(): Promise<void> {
    const conv = this.state.current;
    const c = this.conv(conv);
    if (c.loadingOlder || c.loading || !c.hasMore) return;
    let oldest: number | null = null;
    for (const item of c.items) {
      if (item.kind === 'msg' && item.msg.id !== null && (oldest === null || item.msg.id < oldest)) {
        oldest = item.msg.id;
      }
    }
    if (oldest === null) return;
    c.loadingOlder = true;
    this.syncCurrent();
    this.emit('other');
    try {
      const page = await this.client.loadOlder(conv, oldest);
      const fresh: Item[] = [];
      for (const msg of page.messages) {
        if (c.byClient.has(msg.clientMsgId)) continue;
        const copy = this.copy(msg);
        c.byClient.set(copy.clientMsgId, copy);
        if (copy.id !== null) this.byId.set(copy.id, copy);
        fresh.push({ kind: 'msg', key: copy.clientMsgId, msg: copy });
      }
      c.items.unshift(...fresh);
      c.hasMore = page.hasMore;
      c.loadingOlder = false;
      if (this.state.current === conv) {
        this.syncCurrent();
        this.emit('prepend');
      }
    } catch (error) {
      console.error(error);
      c.loadingOlder = false;
      this.syncCurrent();
      this.emit('other');
    }
  }

  // ---- 訊息 ----

  private copy(msg: Message): Message {
    return {
      ...msg,
      reactions: msg.reactions.map((r) => ({ ...r })),
      replyTo: msg.replyTo ? { ...msg.replyTo } : null,
    };
  }

  /** 以伺服器的版本更新已存在的訊息（不動表情回應） */
  private applyServer(existing: Message, msg: Message) {
    existing.id = msg.id;
    existing.userId = msg.userId ?? existing.userId;
    existing.createdAt = msg.createdAt;
    existing.body = msg.body;
    existing.editedAt = msg.editedAt;
    existing.deletedAt = msg.deletedAt;
    existing.imagePath = msg.imagePath;
    existing.replyTo = msg.replyTo ?? existing.replyTo;
    existing.sendState = 'sent';
    if (existing.id !== null) this.byId.set(existing.id, existing);
  }

  /** 回傳 true 代表是新訊息，false 代表是已存在訊息的更新 */
  private addMessage(c: Conv, msg: Message): boolean {
    const existing = c.byClient.get(msg.clientMsgId);
    if (existing) {
      this.applyServer(existing, msg);
      return false;
    }
    const copy = this.copy(msg);
    c.byClient.set(copy.clientMsgId, copy);
    if (copy.id !== null) this.byId.set(copy.id, copy);
    c.items.push({ kind: 'msg', key: copy.clientMsgId, msg: copy });
    return true;
  }

  private onMessage(msg: Message) {
    const { state } = this;
    const mine = msg.userId === state.userId;
    const conv = msg.conversation;
    if (isDm(conv)) this.ensurePeer(convTarget(conv), mine ? (msg.toNickname ?? '') : msg.nickname);
    const c = this.conv(conv);
    const isCurrent = conv === state.current;
    const info: IncomingInfo = {
      isCurrent,
      mention: mentionsNickname(msg.body, state.nickname),
      dm: isDm(conv),
    };

    if (!c.loaded) {
      c.pending.push(msg);
      if (!mine) {
        state.unread[conv] = (state.unread[conv] ?? 0) + 1;
        this.emitIncoming(msg, info);
      }
      this.emit('other');
      return;
    }
    const isNew = this.addMessage(c, msg);
    if (!isNew) {
      this.emit('update');
      return;
    }
    if (isCurrent) this.syncCurrent();
    if (!mine) {
      if (!isCurrent) state.unread[conv] = (state.unread[conv] ?? 0) + 1;
      this.emitIncoming(msg, info);
    }
    if (isCurrent) this.emit(mine ? 'append-own' : 'append-other');
    else this.emit('other');
  }

  private emitIncoming(msg: Message, info: IncomingInfo) {
    for (const listener of [...this.incomingListeners]) listener(msg, info);
  }

  /** 別人（或自己在別的分頁）編輯或刪除了訊息 */
  private onUpdate(msg: Message) {
    if (msg.id === null) return;
    const existing = this.byId.get(msg.id);
    if (!existing) return;
    this.applyServer(existing, msg);
    this.emit('update');
  }

  private applyReaction(event: ReactionEvent, add: boolean) {
    const msg = this.byId.get(event.messageId);
    if (!msg) return;
    const index = msg.reactions.findIndex((r) => r.emoji === event.emoji && r.userId === event.userId);
    if (add && index === -1) msg.reactions.push({ emoji: event.emoji, userId: event.userId });
    else if (!add && index !== -1) msg.reactions.splice(index, 1);
    else return;
    this.emit('update');
  }

  // ---- 送出、重送、編輯、刪除、表情 ----

  async send(options: {
    body: string;
    replyTo?: Message | null;
    imagePath?: string | null;
  }): Promise<void> {
    const { state } = this;
    const body = options.body.trim();
    const imagePath = options.imagePath ?? null;
    if (imagePath === null ? !isValidBody(body) : bodyLength(body) > MAX_BODY) return;
    const conv = state.current;
    const reply = options.replyTo ?? null;
    const peer = isDm(conv) ? state.peers.find((p) => p.userId === convTarget(conv)) : undefined;
    const msg: Message = {
      id: null,
      clientMsgId: uid(),
      conversation: conv,
      userId: state.userId,
      nickname: state.nickname,
      toNickname: peer?.nickname ?? null,
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      replyTo:
        reply && reply.id !== null
          ? { id: reply.id, nickname: reply.nickname, snippet: reply.deletedAt ? null : snippetOf(reply.body) }
          : null,
      imagePath,
      reactions: [],
      sendState: 'sending',
    };
    const c = this.conv(conv);
    c.byClient.set(msg.clientMsgId, msg);
    c.items.push({ kind: 'msg', key: msg.clientMsgId, msg });
    this.syncCurrent();
    this.emit('append-own');
    await this.deliver(msg);
  }

  async retry(clientMsgId: string): Promise<void> {
    const msg = this.conv(this.state.current).byClient.get(clientMsgId);
    if (!msg || msg.sendState !== 'failed') return;
    msg.sendState = 'sending';
    this.emit('update');
    await this.deliver(msg);
  }

  private async deliver(msg: Message) {
    let result: { ok: true } | { ok: false; reason: FailReason };
    try {
      result = await this.client.send({
        clientMsgId: msg.clientMsgId,
        conversation: msg.conversation,
        body: msg.body,
        toNickname: msg.toNickname,
        replyToId: msg.replyTo?.id ?? null,
        imagePath: msg.imagePath,
      });
    } catch {
      result = { ok: false, reason: 'error' };
    }
    if (result.ok) {
      if (msg.sendState === 'sending') msg.sendState = 'sent';
    } else {
      msg.sendState = 'failed';
      this.toast(FAIL_TEXT[result.reason]);
    }
    this.emit('update');
  }

  async edit(msg: Message, rawBody: string): Promise<boolean> {
    const body = rawBody.trim();
    if (msg.id === null) return false;
    if (msg.imagePath === null ? !isValidBody(body) : bodyLength(body) > MAX_BODY) return false;
    if (body === msg.body) return true;
    const result = await this.client.edit(msg.id, body);
    if (!result.ok) {
      this.toast(FAIL_TEXT[result.reason]);
      return false;
    }
    this.applyServer(msg, result.message);
    this.emit('update');
    return true;
  }

  async remove(msg: Message): Promise<void> {
    if (msg.id === null) return;
    const result = await this.client.remove(msg.id);
    if (!result.ok) {
      this.toast(FAIL_TEXT[result.reason]);
      return;
    }
    this.applyServer(msg, result.message);
    this.emit('update');
  }

  async react(msg: Message, emoji: string): Promise<void> {
    if (msg.id === null || msg.deletedAt) return;
    const me = this.state.userId;
    const index = msg.reactions.findIndex((r) => r.emoji === emoji && r.userId === me);
    const adding = index === -1;
    // 先在畫面上反應，失敗再還原
    if (adding) msg.reactions.push({ emoji, userId: me });
    else msg.reactions.splice(index, 1);
    this.emit('update');
    const result = await this.client.react(msg.id, emoji, adding);
    if (!result.ok) {
      const at = msg.reactions.findIndex((r) => r.emoji === emoji && r.userId === me);
      if (adding && at !== -1) msg.reactions.splice(at, 1);
      else if (!adding && at === -1) msg.reactions.push({ emoji, userId: me });
      this.toast(FAIL_TEXT[result.reason]);
      this.emit('update');
    }
  }

  setTyping(on: boolean) {
    if (!this.state.features.typing || isDm(this.state.current)) return;
    this.client.setPresence({ typing: on });
  }

  findById(id: number): Message | undefined {
    return this.byId.get(id);
  }

  uploadImage(file: File) {
    return this.client.uploadImage(file);
  }

  imageUrl(path: string): string {
    return this.client.imageUrl(path);
  }

  // ---- 連線狀態與補訊息 ----

  private onStatus(status: ConnectionStatus) {
    const previous = this.state.status;
    this.state.status = status;
    this.emit('other');
    if (status === 'connected' && previous !== 'connected' && this.state.phase === 'chat') {
      void this.backfill();
    }
  }

  /** 重連後：補上漏掉的新訊息，並更新最近幾則可能被編輯、刪除或加了表情的訊息 */
  private async backfill() {
    let appended = false;
    let changed = false;
    for (const [conv, c] of this.convs) {
      if (!c.loaded) continue;
      try {
        const ids = c.items
          .flatMap((item) => (item.kind === 'msg' && item.msg.id !== null ? [item.msg.id] : []))
          .sort((a, b) => a - b);
        const afterId = ids.length > BACKFILL_RECHECK ? ids[ids.length - BACKFILL_RECHECK - 1] : 0;
        const missed = await this.client.loadAfter(conv, afterId);
        for (const msg of missed) {
          const mine = msg.userId === this.state.userId;
          const isNew = this.addMessage(c, msg);
          if (isNew) {
            appended = appended || conv === this.state.current;
            if (!mine && conv !== this.state.current) {
              this.state.unread[conv] = (this.state.unread[conv] ?? 0) + 1;
            }
          }
          changed = true;
        }
        const recheck = c.items.flatMap((item) =>
          item.kind === 'msg' && item.msg.id !== null && item.msg.id > afterId ? [item.msg] : [],
        );
        const reactions = await this.client.loadReactions(recheck.map((m) => m.id as number));
        for (const msg of recheck) {
          const latest: Reaction[] | undefined = reactions.get(msg.id as number);
          if (latest) msg.reactions = latest;
        }
      } catch (error) {
        console.error(error); // 補不到就等下一次重連
      }
    }
    this.syncCurrent();
    if (appended) this.emit('append-other');
    else if (changed) this.emit('update');
  }

  // ---- 線上名單與加入／離開提示 ----

  private onJoin(member: Member) {
    if (this.state.phase !== 'chat' || member.clientId === this.client.clientId) return;
    const timer = this.pendingLeave.get(member.clientId);
    if (timer !== undefined) {
      // 短暫離開又回來：不顯示任何提示
      clearTimeout(timer);
      this.pendingLeave.delete(member.clientId);
      return;
    }
    this.pushNotice(member.room, 'join', member.nickname);
  }

  private onLeave(member: Member) {
    if (this.state.phase !== 'chat' || member.clientId === this.client.clientId) return;
    const old = this.pendingLeave.get(member.clientId);
    if (old !== undefined) clearTimeout(old);
    this.pendingLeave.set(
      member.clientId,
      setTimeout(() => {
        this.pendingLeave.delete(member.clientId);
        this.pushNotice(member.room, 'leave', member.nickname);
      }, LEAVE_GRACE_MS),
    );
  }

  private pushNotice(roomId: string, type: 'join' | 'leave', nickname: string) {
    const conv = roomConv(roomId);
    const c = this.convs.get(conv);
    if (!c || !c.loaded) return;
    c.items.push({ kind: 'notice', key: `notice-${++this.noticeSeq}`, type, nickname });
    if (conv === this.state.current) {
      this.syncCurrent();
      this.emit('append-notice');
    }
  }
}
