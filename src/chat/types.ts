// 畫面與「資料來源」之間的固定介面（對應 docs/architecture.md 第 5 節）。
// 階段一由 mock.ts 實作，階段二換成 Supabase 的實作，畫面程式不用改。

export type SendState = 'sending' | 'sent' | 'failed';

export interface Message {
  /** 資料庫流水號；傳送中尚未取得時為 null */
  id: number | null;
  /** 前端產生的唯一編號，重送時不會變成兩則 */
  clientMsgId: string;
  nickname: string;
  body: string;
  /** ISO 時間字串 */
  createdAt: string;
  /** 只存在前端 */
  sendState: SendState;
}

export interface Member {
  nickname: string;
  clientId: string;
  joinedAt: string;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export type JoinResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'taken' | 'error' };

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'invalid' | 'error' };

/** 資料來源會通知畫面的事件 */
export interface ChatEventMap {
  'message:new': Message;
  'presence:sync': Member[];
  'presence:join': Member;
  'presence:leave': Member;
  'connection:status': ConnectionStatus;
}

export interface Page {
  messages: Message[];
  hasMore: boolean;
}

/** 只有階段一的模擬資料來源才有：給「測試工具」面板用的按鈕 */
export interface DevControls {
  label: string;
  actions: { label: string; run: () => void }[];
}

export interface ChatClient {
  /** 這個瀏覽器分頁自己的隨機編號，不是身分 */
  readonly clientId: string;
  readonly dev?: DevControls;

  on<K extends keyof ChatEventMap>(
    event: K,
    handler: (payload: ChatEventMap[K]) => void,
  ): () => void;

  join(nickname: string): Promise<JoinResult>;
  leave(): void;
  /** 最新 50 則 */
  loadLatest(): Promise<Page>;
  /** 比 beforeId 更早的 50 則 */
  loadOlder(beforeId: number): Promise<Page>;
  /** 斷線重連後補上 afterId 之後漏掉的訊息 */
  loadAfter(afterId: number): Promise<Message[]>;
  send(body: string, clientMsgId: string): Promise<SendResult>;
}
