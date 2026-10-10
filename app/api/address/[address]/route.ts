import { getAddressDetail } from '../../../../lib/queries/portfolio';
import { getDb } from '../../../../lib/queries/server-db';
import { addressSchema, error, handle, json, notFound } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const a = addressSchema.safeParse((await ctx.params).address);
  if (!a.success) return error(400, 'invalid address');
  const detail = getAddressDetail(getDb(), a.data);
  return detail ? json(detail) : notFound('address');
});
