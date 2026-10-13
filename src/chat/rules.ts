// 代號與訊息的規則。階段二時資料庫也會用同樣的規則檢查一次。

export const NICKNAME_PATTERN = /^[A-Za-z0-9]{1,12}$/;
export const MAX_BODY = 2000;
export const PAGE_SIZE = 50;

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
