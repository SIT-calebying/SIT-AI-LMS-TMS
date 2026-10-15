import type { NextApiRequest, NextApiResponse } from 'next';
import { withServiceAuth } from '@lib/auth/withAuth';
import { MISSING_GRANT_SYNC_BATCH, syncMissingGrants } from '@lib/services/missingGrantSync';

/**
 * External API — Sync Missing Grants from TPG
 *
 * Pulls TPG grants for Confirmed enrolments that have none stored locally, so every row on
 * Consolidated Finance Data shows the grants TPG has for it. See lib/services/missingGrantSync.ts.
 *
 * POST /api/external/sync-missing-grants
 * Headers: x-api-key: <EXTERNAL_API_KEY_FOR_CLAWDBOT>
 * Body (optional): { limit?: number }  (max 200)
 */
export const config = { maxDuration: 300 };

export async function runAutomation() {
  return syncMissingGrants();
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  try {
    const raw = Number((req.body || {}).limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : MISSING_GRANT_SYNC_BATCH;
    const result = await syncMissingGrants(limit);
    return res.status(200).json(result);
  } catch (err) {
    console.error('❌ sync-missing-grants error:', err);
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
}

export default withServiceAuth(handler);
