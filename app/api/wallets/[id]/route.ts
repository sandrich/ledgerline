import { z } from 'zod';
import { deleteWallet, updateWallet } from '../../../../lib/db/repos-api';
import { getWalletDetail, getWalletsWithAddresses } from '../../../../lib/queries/portfolio';
import { getDb } from '../../../../lib/queries/server-db';
import { colorSchema, error, handle, json, notFound, parseBody, parseId } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  if (id == null) return error(400, 'invalid wallet id');
  const detail = getWalletDetail(getDb(), id);
  return detail ? json(detail) : notFound('wallet');
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: colorSchema.nullable().optional(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
    excluded: z.boolean().optional(),
  })
  .strict();

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  if (id == null) return error(400, 'invalid wallet id');
  const p = await parseBody(req, patchSchema);
  if (!p.ok) return p.res;
  const db = getDb();
  if (!updateWallet(db, id, p.data)) return notFound('wallet');
  const wallet = getWalletsWithAddresses(db).find((w) => w.id === id);
  return wallet ? json(wallet) : notFound('wallet');
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  if (id == null) return error(400, 'invalid wallet id');
  const purged = deleteWallet(getDb(), id);
  if (purged == null) return notFound('wallet');
  return json({ ok: true, purgedAddressIds: purged });
});
