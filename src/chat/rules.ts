// 代號、訊息、對話編號的規則。階段二時資料庫也會用同樣的規則檢查一次。
import type { ConversationId } from './types';

export const NICKNAME_PATTERN = /^[A-Za-z0-9]{1,12}$/;
export const MAX_BODY = 2000;
export const PAGE_SIZE = 50;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function isValidNickname(nickname: string): boolean {
  return NICKNAME_PATTERN.test(nickname);
}

/** 以「字」計算（emoji 算一個），和資料庫的字元數一致 */
export function bodyLength(body: string): number {
  return Array.from(body).length;
}

export function isValidBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length > 0 && bodyLength(trimmed) <= MAX_BODY;
}

export const roomConv = (roomId: string): ConversationId => `room:${roomId}`;
export const dmConv = (userId: string): ConversationId => `dm:${userId}`;
export const isDm = (conv: ConversationId): boolean => conv.startsWith('dm:');
/** `room:lobby` → `lobby`；`dm:xxx` → `xxx` */
export const convTarget = (conv: ConversationId): string => conv.slice(conv.indexOf(':') + 1);

/** 訊息裡的 @代號 */
export const MENTION_PATTERN = /@([A-Za-z0-9]{1,12})/g;

export function mentionsNickname(body: string, nickname: string): boolean {
  if (!nickname) return false;
  const lower = nickname.toLowerCase();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    if (match[1].toLowerCase() === lower) return true;
  }
  return false;
}

/** 回覆時顯示的引用摘要 */
export function snippetOf(body: string): string {
  return Array.from(body.replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
}
