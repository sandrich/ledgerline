// Spam / hidden token heuristics: no price => hidden, plus suspicious names.
const URL_RE = /(https?:\/\/|www\.|t\.me\/|\.(com|io|xyz|org|net|app|finance|site|top|me|us|cc|gg|pro|info|live|fun|vip)\b)/i;
const WORD_RE = /(claim|airdrop|visit|reward|voucher|bonus|giveaway|free\s|redeem|\$\s?\d)/i;

export function nameLooksSpam(symbol: string | null | undefined, name: string | null | undefined): boolean {
  const s = `${symbol ?? ''} ${name ?? ''}`;
  if (!s.trim()) return false;
  // Non-printable / zero-width characters are a common phishing trick.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f​-‏‪-‮]/.test(s)) return true;
  return URL_RE.test(s) || WORD_RE.test(s);
}

export interface SpamSignals {
  symbol: string | null;
  name: string | null;
  /** true / false when a price lookup succeeded, undefined when it was not possible (do not judge). */
  priced?: boolean;
  /** Source said it is a scam (Blockscout is_scam) or excluded it (Safe exclude_spam). */
  flaggedBySource?: boolean;
  /** Trusted tokens (Aave reserves, known canonical assets) are never spam. */
  trusted?: boolean;
}

export function isSpam(s: SpamSignals): boolean {
  if (s.trusted) return false;
  if (s.flaggedBySource) return true;
  if (nameLooksSpam(s.symbol, s.name)) return true;
  if (s.priced === false) return true;
  return false;
}
