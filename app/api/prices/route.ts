import { z } from 'zod';
import { getPriceSeries } from '../../../lib/queries/misc';
import { getDb } from '../../../lib/queries/server-db';
import { handle, json, parseQuery, rangeSchema } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  keys: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(',').map((k) => k.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(120).regex(/^[a-z0-9-]+:[A-Za-z0-9._-]+$/, 'expected price keys like coingecko:ethereum')).min(1).max(50)),
  range: rangeSchema.default('7d'),
});

export const GET = handle((req: Request) => {
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  return json(getPriceSeries(getDb(), q.data.keys, q.data.range));
});
