import { removeAddressFromWallet } from '../../../../../../lib/db/repos-api';
import { getDb } from '../../../../../../lib/queries/server-db';
import { error, handle, json, notFound, parseId } from '../../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; addressId: string }> };

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const params = await ctx.params;
  const walletId = parseId(params.id);
  const addressId = parseId(params.addressId);
  if (walletId == null || addressId == null) return error(400, 'invalid id');
  const r = removeAddressFromWallet(getDb(), walletId, addressId);
  if (!r) return notFound('wallet address link');
  return json({ ok: true, purged: r.purged });
});
