// 畫面與「資料來源」之間的固定介面（對應 docs/architecture.md 第 5 節）。
// 階段一由 mock.ts 實作，階段二由 supabase.ts 實作，畫面程式不用改。

export type SendState = 'sending' | 'sent' | 'failed';

/** 對話的編號：公開聊天室是 `room:<id>`，私訊是 `dm:<對方的 userId>` */
export type ConversationId = string;

export interface Room {
  id: string;
  name: string;
}

export interface Reaction {
  emoji: string;
  userId: string;
}

export interface ReplyRef {
  id: number;
  nickname: string | null;
  snippet: string | null;
}

export interface Message {
  /** 資料庫流水號；傳送中尚未取得時為 null */
  id: number | null;
  /** 前端產生的唯一編號，重送時不會變成兩則 */
  clientMsgId: string;
  conversation: ConversationId;
  /** 作者的匿名身分編號；舊訊息沒有作者時為 null */
  userId: string | null;
  nickname: string;
  /** 私訊的收件人代號（公開訊息為 null） */
  toNickname: string | null;
  body: string;
  /** ISO 時間字串 */
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyTo: ReplyRef | null;
  /** 上傳的圖片在 Storage 裡的路徑 */
  imagePath: string | null;
  reactions: Reaction[];
  /** 只存在前端 */
  sendState: SendState;
}

export interface Member {
  nickname: string;
  /** 每個瀏覽器分頁的隨機編號，不是身分 */
  clientId: string;
  /** 匿名身分編號，私訊用它指定對象 */
  userId: string;
  joinedAt: string;
  /** 目前待在哪個公開聊天室 */
  room: string;
  typing: boolean;
}

export interface Peer {
  userId: string;
  nickname: string;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export type JoinResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'taken' | 'auth' | 'error' };

export type FailReason = 'offline' | 'invalid' | 'rate_limited' | 'error';

export type OpResult = { ok: true } | { ok: false; reason: FailReason };
export type MessageResult = { ok: true; message: Message } | { ok: false; reason: FailReason };
export type UploadResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'type' | 'size' | 'rate_limited' | 'error' };

export interface ReactionEvent {
  messageId: number;
  emoji: string;
  userId: string;
}

/** 資料來源會通知畫面的事件 */
export interface ChatEventMap {
  'message:new': Message;
  /** 訊息被編輯或刪除 */
  'message:update': Message;
  'reaction:add': ReactionEvent;
  'reaction:remove': ReactionEvent;
  'presence:sync': Member[];
  'presence:join': Member;
  'presence:leave': Member;
  'connection:status': ConnectionStatus;
}

export interface Page {
  messages: Message[];
  hasMore: boolean;
}

export interface Draft {
  clientMsgId: string;
  conversation: ConversationId;
  body: string;
  /** 私訊時才有 */
  toNickname: string | null;
  replyToId: number | null;
  imagePath: string | null;
}

/** 這個資料來源支援哪些功能；畫面據此決定要不要顯示對應的按鈕 */
export interface Features {
  dm: boolean;
  upload: boolean;
  typing: boolean;
}

/** 只有模擬資料來源才有：給「測試工具」面板用的按鈕 */
export interface DevControls {
  label: string;
  actions: { label: string; run: () => void }[];
}

export interface ChatClient {
  /** 這個瀏覽器分頁自己的隨機編號 */
  readonly clientId: string;
  /** 自己的匿名身分編號（進入聊天室之後才有意義） */
  readonly userId: string;
  readonly features: Features;
  readonly dev?: DevControls;

  on<K extends keyof ChatEventMap>(
    event: K,
    handler: (payload: ChatEventMap[K]) => void,
  ): () => void;

  join(nickname: string): Promise<JoinResult>;
  leave(): void;
  /** 更新自己的在線資訊：目前在哪個聊天室、是否正在打字 */
  setPresence(update: { room?: string; typing?: boolean }): void;

  loadRooms(): Promise<Room[]>;
  loadDmPeers(): Promise<Peer[]>;
  /** 某個對話最新的 50 則 */
  loadLatest(conversation: ConversationId): Promise<Page>;
  /** 比 beforeId 更早的 50 則 */
  loadOlder(conversation: ConversationId, beforeId: number): Promise<Page>;
  /** 斷線重連後，補上 afterId 之後新增或被修改的訊息 */
  loadAfter(conversation: ConversationId, afterId: number): Promise<Message[]>;
  /** 查這些訊息目前有哪些表情回應 */
  loadReactions(messageIds: number[]): Promise<Map<number, Reaction[]>>;

  send(draft: Draft): Promise<OpResult>;
  edit(messageId: number, body: string): Promise<MessageResult>;
  remove(messageId: number): Promise<MessageResult>;
  react(messageId: number, emoji: string, on: boolean): Promise<OpResult>;

  uploadImage(file: File): Promise<UploadResult>;
  imageUrl(path: string): string;
}
