import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@lib/auth/withAuth';
import { requestDirectApplicationAutomation } from '@lib/directApplicationAutomation';

export const config = { maxDuration: 300 };

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const mode = req.body?.mode;
  if (mode !== 'incremental' && mode !== 'recovery') return res.status(400).json({ success: false, error: 'Mode must be incremental or recovery' });
  // Docker keeps this process alive beyond the request timeout. Every phase is
  // audited and uses the same cross-replica lock as the scheduled task.
  try {
    const report = await requestDirectApplicationAutomation(mode);
    if (!report) return res.status(409).json({ success: false, error: 'Another sync is already running. Wait for its report to finish, then retry.' });
    return res.status(202).json({ success: true, runId: report.id, message: mode === 'recovery'
      ? 'Recent updates started; the 180-day recovery scan follows immediately. Progress appears in the run report.'
      : 'Recent updates started. Progress appears in the run report.' });
  } catch {
    return res.status(500).json({ success: false, error: 'Unable to start sync; check the run report or server logs.' });
  }
}

export default withAuth(handler, { roles: ['admin', 'developer', 'trainingProvider'] });
