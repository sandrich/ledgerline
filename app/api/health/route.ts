import type { HealthResponse } from '../../../lib/queries/api-types';
import { getHealth } from '../../../lib/queries/misc';
import { databasePath, getDb } from '../../../lib/queries/server-db';
import { handle, json } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(() => {
  try {
    return json(getHealth(getDb(), databasePath()));
  } catch (err) {
    const body: HealthResponse = { ok: false, lastSnapshotAt: null, workerHeartbeatAt: null, dbSizeBytes: 0 };
    console.error('[api/health]', err);
    return json(body, 503);
  }
});
