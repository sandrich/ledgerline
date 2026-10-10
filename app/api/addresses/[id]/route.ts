import { z } from 'zod';
import { updateAddress } from '../../../../lib/db/repos-api';
import { addressSummaries } from '../../../../lib/queries/portfolio';
import { getAddressById } from '../../../../lib/queries/scope';
import { getDb } from '../../../../lib/queries/server-db';
import { chainSchema, error, handle, json, notFound, parseBody, parseId } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    label: z.string().trim().max(80).nullable().optional(),
    chains: z.array(chainSchema).min(1).max(2).optional(),
    excluded: z.boolean().optional(),
  })
  .strict();

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  if (id == null) return error(400, 'invalid address id');
  const p = await parseBody(req, patchSchema);
  if (!p.ok) return p.res;
  const db = getDb();
  const r = updateAddress(db, id, {
    label: p.data.label === undefined ? undefined : p.data.label || null,
    chains: p.data.chains ? [...new Set(p.data.chains)] : undefined,
    excluded: p.data.excluded,
  });
  if (!r) return notFound('address');
  const row = getAddressById(db, id);
  if (!row) return notFound('address');
  const [summary] = addressSummaries(db, [row], Math.floor(Date.now() / 1000));
  return json({ address: summary, jobIds: r.jobIds });
});
