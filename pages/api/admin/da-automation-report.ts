import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@lib/auth/withAuth';
import pool from '@lib/db';
import { DA_AUTOMATION_TASK, DA_AUTOMATION_CRON } from '@lib/directApplicationAutomation';
import { ensureDaAutomationTable } from '@lib/directApplicationAutomationSchema';
import { directApplicationSyncWindow } from '@lib/directApplicationSync';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureDaAutomationTable();
    const [config, runs, attention, recovery] = await Promise.all([
      pool.query('SELECT enabled, cron_expression FROM scheduler_config WHERE id = $1', [DA_AUTOMATION_TASK]),
      // DATE is a calendar boundary, not an instant. Prevent pg/JSON timezone
      // conversion from displaying the previous day on Singapore servers.
      pool.query('SELECT *, last_update_date::text AS last_update_date FROM da_automation_run ORDER BY started_at DESC LIMIT 5'),
      pool.query(`SELECT da.application_id, da.auto_enrol_status,
          COALESCE(s.cancellation_error, da.auto_enrol_error) AS auto_enrol_error, COUNT(*) OVER()::int AS total
        FROM da_application da LEFT JOIN da_application_source_sync s USING (application_id)
        WHERE course_start_date >= $1::date AND (s.cancellation_pending OR (LOWER(TRIM(application_status)) LIKE 'confirmed%'
        AND (auto_enrol_status IN ('failed', 'pending_identity')
          OR NULLIF(TRIM(auto_enrol_error), '') IS NOT NULL
          OR (auto_enrol_status = 'pending' AND updated_at < NOW() - INTERVAL '30 minutes'))))
        ORDER BY da.updated_at DESC LIMIT 10`, [directApplicationSyncWindow({}).tomorrow]),
      pool.query('SELECT *, last_update_date::text AS last_update_date FROM da_automation_run WHERE recovery ORDER BY started_at DESC LIMIT 1'),
    ]);
    const runtimeEnabled = process.env.ENABLE_APP_SCHEDULER === 'true'
      || (process.env.NODE_ENV === 'production' && process.env.ENABLE_APP_SCHEDULER !== 'false');
    return res.status(200).json({ success: true, enabled: !!config.rows[0]?.enabled && runtimeEnabled,
      configuredEnabled: !!config.rows[0]?.enabled, runtimeEnabled,
      cron: config.rows[0]?.cron_expression || DA_AUTOMATION_CRON, timezone: 'Asia/Singapore',
      latest: runs.rows[0] || null, recent: runs.rows, attentionCount: attention.rows[0]?.total || 0,
      latestRecovery: recovery.rows[0] || null,
      attention: attention.rows.map(({ total, ...row }) => row) });
  } catch {
    return res.status(500).json({ success: false, error: 'Unable to read automation report. Check that the database migration has been applied.' });
  }
}
export default withAuth(handler, { roles: ['admin', 'developer', 'trainingProvider'] });
