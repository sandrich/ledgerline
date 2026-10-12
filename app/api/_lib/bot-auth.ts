// Bearer token check for the bot API (/api/bot/*). The rest of the app has no authentication and
// relies on the loopback bind; bot routes are meant to be reached by other machines, so they also
// require BOT_API_TOKEN. Unset token = bot API disabled.
import { createHash, timingSafeEqual } from 'node:crypto';
import { error } from './http';

const MIN_TOKEN_LENGTH = 24;

function digest(s: string): Buffer {
  // equal length buffers for timingSafeEqual, whatever the input length
  return createHash('sha256').update(s).digest();
}

/** null when the request carries the configured token, otherwise the error response to return. */
export function requireBotToken(req: Request): Response | null {
  const expected = process.env.BOT_API_TOKEN?.trim() ?? '';
  if (!expected) return error(503, 'bot API disabled: set BOT_API_TOKEN in .env');
  if (expected.length < MIN_TOKEN_LENGTH) return error(503, `bot API disabled: BOT_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m || !timingSafeEqual(digest(m[1].trim()), digest(expected))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': 'Bearer' },
    });
  }
  return null;
}
