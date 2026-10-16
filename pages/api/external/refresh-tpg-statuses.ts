import type { NextApiRequest, NextApiResponse } from 'next';
import { withServiceAuth } from '@lib/auth/withAuth';
import { refreshTpgStatuses, TPG_REFRESH_CLAIM_BATCH, TPG_REFRESH_GRANT_BATCH } from '@lib/services/tpgStatusRefresh';

/**
 * External API — Refresh Grant & SFC Claim Status from TPG
 *
 * Re-reads not-yet-final grants and SFC claims from TPG so the Financial Dashboard shows their
 * live status (Paid / Pending / Cancelled). See lib/services/tpgStatusRefresh.ts.
 *
 * POST /api/external/refresh-tpg-statuses
 * Headers: x-api-key: <EXTERNAL_API_KEY_FOR_CLAWDBOT>
 * Body (optional): { grantLimit?: number, claimLimit?: number }  (max 200 each)
 */
export const config = { maxDuration: 300 };

export async function runAutomation() {
  return refreshTpgStatuses();
}

const limitOf = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : fallback;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const result = await refreshTpgStatuses(limitOf(body.grantLimit, TPG_REFRESH_GRANT_BATCH), limitOf(body.claimLimit, TPG_REFRESH_CLAIM_BATCH));
    return res.status(200).json(result);
  } catch (err) {
    console.error('❌ refresh-tpg-statuses error:', err);
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' });
  }
}

export default withServiceAuth(handler);
