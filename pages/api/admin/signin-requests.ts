import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';
import { withAuth, AuthedApiRequest } from '@lib/auth/withAuth';
import { autoShareLearnerMaterials } from '@lib/google-drive/drive-helpers';
import {
  ensureSigninRequestTable, findCourseRun, enrolLearner, logEnrolmentAttempt, sendWelcomeSigninEmail, loginUrlFrom,
} from '@lib/learner/selfEnrolment';

// Admin → Sign-in Requests.
// GET  ?status=open|auto_enrolled|resolved|dismissed|all → requests + per-status counts
// POST { action: 'enrol', id, courseRunId? } → enrol the learner (any non-deleted run; staff may
//      correct the Course Run ID), email them the welcome email, mark resolved
// POST { action: 'dismiss', id, note? }       → mark dismissed

const STATUSES = ['open', 'auto_enrolled', 'resolved', 'dismissed'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  await ensureSigninRequestTable();

  if (req.method === 'GET') {
    const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status) ? req.query.status : null;
    const [rows, counts] = await Promise.all([
      pool.query(
        `SELECT r.id, r.created_at, r.full_name, r.email, r.phone, r.course_run_id, r.status, r.reason,
                r.resolved_at, r.resolution_note, c.title AS course_title, cr.start_date,
                ru.full_name AS resolved_by_name
         FROM signin_help_request r
         LEFT JOIN course_run cr ON cr.id = r.course_run_uuid
         LEFT JOIN course c ON c.id = cr.course_id
         LEFT JOIN app_user ru ON ru.id = r.resolved_by
         WHERE ($1::text IS NULL OR r.status = $1)
         ORDER BY r.created_at DESC
         LIMIT 300`,
        [status]
      ),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM signin_help_request GROUP BY status`),
    ]);
    const countMap = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of counts.rows) countMap[r.status] = r.count;
    return res.status(200).json({ success: true, data: rows.rows, counts: countMap });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { action, id } = req.body || {};
  const staffId = (req as AuthedApiRequest).authUser?.id || null;
  const found = await pool.query(`SELECT * FROM signin_help_request WHERE id = $1`, [id]);
  if (found.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Request not found' });
  }
  const request = found.rows[0];

  if (action === 'dismiss') {
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
    await pool.query(
      `UPDATE signin_help_request SET status = 'dismissed', resolved_at = NOW(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
      [id, staffId, note || 'Dismissed']
    );
    return res.status(200).json({ success: true });
  }

  if (action !== 'enrol') {
    return res.status(400).json({ success: false, error: 'Unknown action' });
  }

  const courseRunId = (typeof req.body.courseRunId === 'string' && req.body.courseRunId.trim()) || request.course_run_id;
  const run = await findCourseRun(courseRunId, { enforceWindow: false });
  if (run.status === 'not_found') {
    return res.status(404).json({ success: false, error: `No class found with Course Run ID ${courseRunId} (or it is deleted / cancelled).` });
  }
  if (run.status === 'ambiguous') {
    return res.status(409).json({ success: false, error: `Course Run ID ${courseRunId} matches more than one class — enrol them from the class page instead.` });
  }

  const result = await enrolLearner({ fullName: request.full_name, email: request.email, run: run.run, source: 'signin-request' });
  if (result.outcome === 'account_inactive') {
    return res.status(409).json({ success: false, error: 'This learner account is inactive. Reactivate it under User Management first, then try again.' });
  }
  if (result.outcome === 'enrolment_withdrawn') {
    return res.status(409).json({ success: false, error: 'This learner was removed from the class. Re-add them from the class page (Assign Student) if that was a mistake.' });
  }

  const alreadyEnrolled = result.outcome === 'already_enrolled';
  await pool.query(
    `UPDATE signin_help_request
     SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, course_run_uuid = $3, course_run_id = $4, resolution_note = $5
     WHERE id = $1`,
    [id, staffId, run.run.id, run.run.course_run_id, alreadyEnrolled ? 'Already enrolled — welcome email re-sent' : 'Enrolled — welcome email sent']
  );
  await logEnrolmentAttempt({
    email: request.email, fullName: request.full_name, courseRunId: run.run.course_run_id,
    action: alreadyEnrolled ? 'skipped' : 'inserted', accountAction: result.accountAction, source: 'signin-request',
  });

  const proto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'].split(',')[0].trim() : undefined;
  const mail = await sendWelcomeSigninEmail({
    fullName: request.full_name, email: request.email, run: run.run,
    loginUrl: loginUrlFrom(req.headers.host, proto), tempPassword: result.tempPassword,
  }).catch((e) => ({ success: false, error: e instanceof Error ? e.message : 'unknown' }));
  if (!alreadyEnrolled) {
    autoShareLearnerMaterials(run.run.id).catch(() => {});
  }

  return res.status(200).json({
    success: true,
    alreadyEnrolled,
    emailSent: mail.success,
    message: `${alreadyEnrolled ? 'Already enrolled in' : 'Enrolled into'} ${run.run.title}. ${mail.success ? 'Welcome email sent.' : `Welcome email failed: ${mail.error}`}`,
  });
}

export default withAuth(handler, { roles: ['admin', 'trainingProvider', 'developer'] });
