// 畫面狀態：訊息列表、線上名單、連線狀態，以及「離開提示」的緩衝規則。
// 只依賴 ChatClient 介面，不知道資料是模擬的還是 Supabase 的。
import type {
  ChatClient,
  ConnectionStatus,
  JoinResult,
  Member,
  Message,
} from './types';
import { isValidBody } from './rules';

/** 有人離開後，等這麼久都沒回來才顯示「離開了聊天室」 */
export const LEAVE_GRACE_MS = 10_000;

export type Item =
  | { kind: 'msg'; key: string; msg: Message }
  | { kind: 'notice'; key: string; type: 'join' | 'leave'; nickname: string };

export interface State {
  phase: 'entry' | 'chat';
  nickname: string;
  items: Item[];
  members: Member[];
  status: ConnectionStatus;
  hasMore: boolean;
  loadingOlder: boolean;
}

/** 告訴畫面「這次變動是什麼」，畫面據此決定要不要捲動 */
export type ChangeHint =
  | 'init'
  | 'append-own'
  | 'append-other'
  | 'append-notice'
  | 'prepend'
  | 'update'
  | 'other';

type Listener = (state: State, hint: ChangeHint) => void;

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class ChatStore {
  readonly state: State = {
    phase: 'entry',
    nickname: '',
    items: [],
    members: [],
    status: 'connected',
    hasMore: false,
    loadingOlder: false,
  };

  private listeners = new Set<Listener>();
  private messages = new Map<string, Message>();
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

  private emit(hint: ChangeHint) {
    for (const listener of [...this.listeners]) listener(this.state, hint);
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
      const { messages, hasMore } = await this.client.loadLatest();
      const buffered = this.state.items;
      this.state.items = [];
      this.messages.clear();
      for (const msg of messages) this.addMessage(msg);
      for (const item of buffered) {
        if (item.kind === 'msg') this.addMessage(item.msg);
      }
      this.state.hasMore = hasMore;
    } catch {
      this.client.leave();
      this.detach();
      return { ok: false, reason: 'error' };
    }
    this.state.phase = 'chat';
    this.emit('init');
    return { ok: true };
  }

  private attach() {
    this.detach();
    const c = this.client;
    this.detachers = [
      c.on('message:new', (msg) => this.onMessage(msg)),
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

  // ---- 訊息 ----

  /** 回傳 true 代表是新訊息，false 代表是已存在訊息的更新 */
  private addMessage(msg: Message): boolean {
    const existing = this.messages.get(msg.clientMsgId);
    if (existing) {
      existing.id = msg.id;
      existing.createdAt = msg.createdAt;
      existing.sendState = 'sent';
      return false;
    }
    const copy = { ...msg };
    this.messages.set(copy.clientMsgId, copy);
    this.state.items.push({ kind: 'msg', key: copy.clientMsgId, msg: copy });
    return true;
  }

  private onMessage(msg: Message) {
    const isNew = this.addMessage(msg);
    if (this.state.phase !== 'chat') return;
    if (!isNew) this.emit('update');
    else this.emit(msg.nickname === this.state.nickname ? 'append-own' : 'append-other');
  }

  async send(rawBody: string): Promise<void> {
    const body = rawBody.trim();
    if (!isValidBody(body)) return;
    const msg: Message = {
      id: null,
      clientMsgId: uid(),
      nickname: this.state.nickname,
      body,
      createdAt: new Date().toISOString(),
      sendState: 'sending',
    };
    this.messages.set(msg.clientMsgId, msg);
    this.state.items.push({ kind: 'msg', key: msg.clientMsgId, msg });
    this.emit('append-own');
    await this.deliver(msg);
  }

  async retry(clientMsgId: string): Promise<void> {
    const msg = this.messages.get(clientMsgId);
    if (!msg || msg.sendState !== 'failed') return;
    msg.sendState = 'sending';
    this.emit('update');
    await this.deliver(msg);
  }

  private async deliver(msg: Message) {
    let ok = false;
    try {
      ok = (await this.client.send(msg.body, msg.clientMsgId)).ok;
    } catch {
      ok = false;
    }
    if (ok) {
      if (msg.sendState === 'sending') msg.sendState = 'sent';
    } else {
      msg.sendState = 'failed';
    }
    this.emit('update');
  }

  async loadOlder(): Promise<void> {
    const { state } = this;
    if (state.loadingOlder || !state.hasMore) return;
    const oldest = this.oldestId();
    if (oldest === null) return;
    state.loadingOlder = true;
    this.emit('other');
    try {
      const page = await this.client.loadOlder(oldest);
      const fresh: Item[] = [];
      for (const msg of page.messages) {
        if (this.messages.has(msg.clientMsgId)) continue;
        const copy = { ...msg };
        this.messages.set(copy.clientMsgId, copy);
        fresh.push({ kind: 'msg', key: copy.clientMsgId, msg: copy });
      }
      state.items = [...fresh, ...state.items];
      state.hasMore = page.hasMore;
      state.loadingOlder = false;
      this.emit('prepend');
    } catch {
      state.loadingOlder = false;
      this.emit('other');
    }
  }

  private oldestId(): number | null {
    let oldest: number | null = null;
    for (const msg of this.messages.values()) {
      if (msg.id !== null && (oldest === null || msg.id < oldest)) oldest = msg.id;
    }
    return oldest;
  }

  private newestId(): number {
    let newest = 0;
    for (const msg of this.messages.values()) {
      if (msg.id !== null && msg.id > newest) newest = msg.id;
    }
    return newest;
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

  private async backfill() {
    try {
      const missed = await this.client.loadAfter(this.newestId());
      let added = false;
      for (const msg of missed) {
        if (this.addMessage(msg)) added = true;
      }
      if (added) this.emit('append-other');
    } catch {
      // 補不到就等下一次重連
    }
  }

  // ---- 線上名單與加入／離開提示 ----

  private onJoin(member: Member) {
    if (!this.state.members.some((m) => m.clientId === member.clientId)) {
      this.state.members = [...this.state.members, member];
    }
    if (this.state.phase !== 'chat' || member.clientId === this.client.clientId) {
      this.emit('other');
      return;
    }
    const timer = this.pendingLeave.get(member.clientId);
    if (timer !== undefined) {
      // 短暫離開又回來：不顯示任何提示
      clearTimeout(timer);
      this.pendingLeave.delete(member.clientId);
      this.emit('other');
      return;
    }
    this.pushNotice('join', member.nickname);
  }

  private onLeave(member: Member) {
    // 線上名單立即更新；聊天區的提示要等一小段時間
    this.state.members = this.state.members.filter((m) => m.clientId !== member.clientId);
    if (this.state.phase !== 'chat' || member.clientId === this.client.clientId) {
      this.emit('other');
      return;
    }
    const old = this.pendingLeave.get(member.clientId);
    if (old !== undefined) clearTimeout(old);
    this.pendingLeave.set(
      member.clientId,
      setTimeout(() => {
        this.pendingLeave.delete(member.clientId);
        this.pushNotice('leave', member.nickname);
      }, LEAVE_GRACE_MS),
    );
    this.emit('other');
  }

  private pushNotice(type: 'join' | 'leave', nickname: string) {
    this.state.items.push({ kind: 'notice', key: `notice-${++this.noticeSeq}`, type, nickname });
    this.emit('append-notice');
  }
}
