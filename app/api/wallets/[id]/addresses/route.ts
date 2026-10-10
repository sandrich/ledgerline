import { z } from 'zod';
import { addAddressToWallet } from '../../../../../lib/db/repos-api';
import type { AddAddressResponse } from '../../../../../lib/queries/api-types';
import { addressSummaries } from '../../../../../lib/queries/portfolio';
import { getAddressById } from '../../../../../lib/queries/scope';
import { getDb } from '../../../../../lib/queries/server-db';
import { addressSchema, chainSchema, error, handle, json, notFound, parseBody, parseId } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const addSchema = z.object({
  address: addressSchema,
  label: z.string().trim().max(80).nullish(),
  chains: z.array(chainSchema).min(1).max(2).optional(),
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const walletId = parseId((await ctx.params).id);
  if (walletId == null) return error(400, 'invalid wallet id');
  const p = await parseBody(req, addSchema);
  if (!p.ok) return p.res;
  const db = getDb();
  const label = p.data.label === undefined ? undefined : p.data.label || null;
  const chains = p.data.chains ? [...new Set(p.data.chains)] : undefined;
  const r = addAddressToWallet(db, walletId, { address: p.data.address, label, chains });
  if (!r) return notFound('wallet');
  const row = getAddressById(db, r.addressId);
  if (!row) return error(500, 'address not stored');
  const [summary] = addressSummaries(db, [row], Math.floor(Date.now() / 1000));
  const body: AddAddressResponse = { address: summary, jobIds: r.jobIds, created: r.created };
  return json(body, r.created || r.linked ? 201 : 200);
});
