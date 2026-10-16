import { withAuth } from '@lib/auth/withAuth';
import type { NextApiRequest, NextApiResponse } from 'next';
import { refreshClaimStatuses, refreshGrantStatuses } from '@/lib/services/tpgStatusRefresh';

/**
 * POST /api/finance/tpg-status-refresh
 * Body: { enrolmentIds?: string[], claimIds?: string[] }  (max 25 each — the rows on screen)
 *
 * "Refresh from TPG" on the Financial Dashboard: re-reads the shown grants (by enrolment) and
 * SFC claims from TPG right now. Only updates the local copies (ssg_grants / ssg_claims);
 * nothing is written to TPG or QuickBooks.
 */
const MAX_IDS = 25;

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, MAX_IDS) : [];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  try {
    const enrolmentIds = idList(req.body?.enrolmentIds);
    const claimIds = idList(req.body?.claimIds);
    if (enrolmentIds.length === 0 && claimIds.length === 0) {
      return res.status(400).json({ success: false, error: 'enrolmentIds or claimIds is required' });
    }
    const grants = await refreshGrantStatuses(enrolmentIds);
    const claims = await refreshClaimStatuses(claimIds);
    return res.status(200).json({
      success: true,
      data: {
        grants: { checked: grants.checked, failed: grants.failures.length },
        claims: { checked: claims.checked, changed: claims.changed, failed: claims.failures.length },
        failures: [...grants.failures, ...claims.failures],
      },
    });
  } catch (e) {
    console.error('[tpg-status-refresh]', e);
    return res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Internal server error' });
  }
}

export default withAuth(handler, { roles: ['admin', 'trainingProvider', 'finance'] });
