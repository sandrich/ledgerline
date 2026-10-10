// GET /api/suggestions -> SuggestionsResponse: pending smart wallets (Safes, DSProxies) owned by a
//   tracked EOA and not tracked yet on that chain (lib/queries/suggestions.ts).
// POST /api/suggestions { id, action: 'accept' | 'dismiss', label? } -> SuggestionActionResponse.
//   accept adds the address to every wallet of its owner with the suggested chain(s).
import { z } from 'zod';
import type { SuggestionsResponse } from '../../../lib/queries/api-types';
import { getDb } from '../../../lib/queries/server-db';
import { actOnSuggestion, getSuggestions } from '../../../lib/queries/suggestions';
import { handle, json, notFound, parseBody } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(() => {
  const body: SuggestionsResponse = { suggestions: getSuggestions(getDb()) };
  return json(body);
});

const actionSchema = z.object({
  id: z.coerce.number().int().positive(),
  action: z.enum(['accept', 'dismiss']),
  label: z.string().trim().max(80).nullish(),
});

export const POST = handle(async (req: Request) => {
  const p = await parseBody(req, actionSchema);
  if (!p.ok) return p.res;
  const r = actOnSuggestion(getDb(), p.data.id, p.data.action, { label: p.data.label || null });
  if (!r) return notFound('suggestion');
  return json(r);
});
