import { z } from 'zod';
import { createWallet } from '../../../lib/db/repos-api';
import type { WalletsResponse } from '../../../lib/queries/api-types';
import { getWalletsWithAddresses } from '../../../lib/queries/portfolio';
import { getDb } from '../../../lib/queries/server-db';
import { colorSchema, error, handle, json, parseBody } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(() => {
  const body: WalletsResponse = { wallets: getWalletsWithAddresses(getDb()) };
  return json(body);
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: colorSchema.nullish(),
});

export const POST = handle(async (req: Request) => {
  const p = await parseBody(req, createSchema);
  if (!p.ok) return p.res;
  const db = getDb();
  const id = createWallet(db, { name: p.data.name, color: p.data.color ?? null });
  const wallet = getWalletsWithAddresses(db).find((w) => w.id === id);
  if (!wallet) return error(500, 'wallet not created');
  return json(wallet, 201);
});
