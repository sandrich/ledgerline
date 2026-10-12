// GET /api/bot/report?scope=all|wallet:<id>|address:<0x...>&window=24h|7d|30d&currency=USD|EUR|CHF
// Authorization: Bearer <BOT_API_TOKEN>
// -> BotReportResponse (lib/queries/api-types.ts): what changed over the window, for bots / LLMs.
import { z } from 'zod';
import { getReport } from '../../../../lib/queries/report';
import { parseScope, resolveScope } from '../../../../lib/queries/scope';
import { getDb } from '../../../../lib/queries/server-db';
import { requireBotToken } from '../../_lib/bot-auth';
import { error, handle, json, notFound, parseQuery } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  scope: z.string().optional(),
  window: z.enum(['24h', '7d', '30d']).default('24h'),
  currency: z.enum(['USD', 'EUR', 'CHF']).default('USD'),
});

export const GET = handle((req: Request) => {
  const denied = requireBotToken(req);
  if (denied) return denied;
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  const scope = parseScope(q.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const db = getDb();
  const ids = resolveScope(db, scope);
  if (!ids) return notFound(scope.kind);
  return json(getReport(db, { addressIds: ids, scope: q.data.scope ?? 'all', window: q.data.window, currency: q.data.currency }));
});
