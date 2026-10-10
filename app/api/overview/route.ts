import { getOverview } from '../../../lib/queries/portfolio';
import { getDb } from '../../../lib/queries/server-db';
import { handle, json } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(() => json(getOverview(getDb())));
