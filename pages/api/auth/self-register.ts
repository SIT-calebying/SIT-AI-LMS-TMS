import type { NextApiRequest, NextApiResponse } from 'next';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import pool from '../../../lib/db';
import { normalizedEmail, limited } from '../../../lib/android/auth';
import { autoShareLearnerMaterials } from '@lib/google-drive/drive-helpers';

// POST { fullName, email, courseRunId }
// PUBLIC (login screen): a learner who can't log in / can't see their class enrols
// themselves into a course run using the Course Run ID from their course administrator.
// Mirrors the admin "Assign Student" flow (account + Learner role + enrolment + attendance
// rows) with these safeguards:
//  - rate limited per IP (generous: a whole class may share the venue Wi-Fi) and per email
//  - only live runs: not deleted/cancelled, from 14 days before start to 30 days after end
//  - new accounts get an unusable password, so the only way in is the email OTP
//    (proves the registrant owns the address)
//  - never reactivates a disabled account or restores an admin-removed enrolment
//  - no calendar / SSG push; every registration is logged to enrolment_sync_log

const SOURCE = 'self-registration';

function clientIp(req: NextApiRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
  return first || req.socket.remoteAddress || 'unknown';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim().replace(/\s+/g, ' ') : '';
  const email = normalizedEmail(req.body?.email);
  const courseRunId = typeof req.body?.courseRunId === 'string' ? req.body.courseRunId.trim() : '';

  if (fullName.length < 2 || fullName.length > 120) {
    return res.status(400).json({ success: false, error: 'Please enter your full name as shown on your NRIC / passport.' });
  }
  if (!email) {
    return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(courseRunId)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid Course Run ID.' });
  }

  if (await limited(`self-register:ip:${clientIp(req)}`, 60, 60) || await limited(`self-register:email:${email}`, 5, 60)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ success: false, error: 'Too many registration attempts. Please try again in an hour.' });
  }

  const runs = await pool.query(
    `SELECT cr.id, cr.course_id, cr.course_run_id, cr.start_date, cr.end_date, c.title
     FROM course_run cr
     JOIN course c ON c.id = cr.course_id
     WHERE LOWER(cr.course_run_id) = LOWER($1)
       AND COALESCE(cr.is_deleted, false) = false
       AND cr.class_status IS DISTINCT FROM 'Cancelled'
       AND (cr.start_date IS NULL OR (NOW() AT TIME ZONE 'Asia/Singapore')::date >= cr.start_date - 14)
       AND (cr.end_date IS NULL OR (NOW() AT TIME ZONE 'Asia/Singapore')::date <= cr.end_date + 30)
     LIMIT 2`,
    [courseRunId]
  );
  if (runs.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'We could not find an open class with that Course Run ID. Please check it with your course administrator or trainer.',
    });
  }
  if (runs.rows.length > 1) {
    return res.status(409).json({
      success: false,
      error: 'That Course Run ID matches more than one class. Please contact your course administrator or trainer.',
    });
  }
  const run = runs.rows[0];
  const classInfo = { courseTitle: run.title, startDate: run.start_date, endDate: run.end_date };

  const log = (action: string, accountAction: string, error?: string) =>
    pool.query(
      `INSERT INTO enrolment_sync_log (email, full_name, course_run_id, enrolment_status, action, account_action, source, error_message)
       VALUES ($1, $2, $3, 'Confirmed', $4, $5, $6, $7)`,
      [email, fullName, run.course_run_id, action, accountAction, SOURCE, error || null]
    ).catch(() => {});

  const client = await pool.connect();
  let userId: string;
  let accountAction: 'created' | 'existed' = 'existed';
  try {
    await client.query('BEGIN');

    const existingUser = await client.query(
      `SELECT id, COALESCE(LOWER(account_status), 'active') AS account_status
       FROM app_user
       WHERE LOWER(email) = $1 OR LOWER(secondary_email) = $1
       LIMIT 1`,
      [email]
    );

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      if (existingUser.rows[0].account_status !== 'active') {
        await client.query('ROLLBACK');
        await log('skipped', 'existed', 'account inactive');
        return res.status(403).json({
          success: false,
          error: 'Your account is inactive. Please contact your course administrator or trainer.',
        });
      }
      await client.query(
        `INSERT INTO user_role_map (user_id, role) VALUES ($1, 'Learner') ON CONFLICT DO NOTHING`,
        [userId]
      );
    } else {
      // Unusable password: the learner signs in with the email OTP (or sets one via Forgot Password).
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
      const created = await client.query(
        `INSERT INTO app_user (id, email, full_name, password_hash, account_status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active', NOW(), NOW())
         RETURNING id`,
        [email, fullName, passwordHash]
      );
      userId = created.rows[0].id;
      accountAction = 'created';
      await client.query(
        `INSERT INTO user_role_map (user_id, role) VALUES ($1, 'Learner') ON CONFLICT DO NOTHING`,
        [userId]
      );
      await client.query(
        `INSERT INTO learner_profile (user_id, tel) VALUES ($1, '') ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
    }

    const existingEnrol = await client.query(
      `SELECT id, enrolment_status FROM enrollment WHERE user_id = $1 AND course_run_id = $2`,
      [userId, run.id]
    );
    if (existingEnrol.rows.length > 0) {
      const status = existingEnrol.rows[0].enrolment_status;
      if (status) {
        await client.query('COMMIT');
        const removed = ['admin removed', 'cancelled', 'withdrawn'].includes(String(status).trim().toLowerCase());
        await log('skipped', accountAction, removed ? `existing enrolment is ${status}` : undefined);
        if (removed) {
          return res.status(409).json({
            success: false,
            error: 'Your enrolment in this class was withdrawn. Please contact your course administrator or trainer.',
          });
        }
        return res.status(200).json({
          success: true,
          alreadyEnrolled: true,
          ...classInfo,
          message: 'You are already enrolled in this class. Sign in with your email to see it.',
        });
      }
      // Ghost row (NULL status) — confirm it, same as the admin Assign Student flow.
      await client.query(
        `UPDATE enrollment SET enrolment_status = 'Confirmed', updated_at = NOW() WHERE id = $1`,
        [existingEnrol.rows[0].id]
      );
    } else {
      const learnerNric = await client.query(
        `SELECT NULLIF(nric, '') AS nric FROM learner_profile WHERE user_id = $1`,
        [userId]
      );
      await client.query(
        `INSERT INTO enrollment (id, user_id, course_id, course_run_id, progress_percent, payment_status, assessment_status,
                                 enrolment_status, enrolment_date, email, nric, raw_data, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 0, 'Unpaid', 'Pending', 'Confirmed', CURRENT_DATE, $4, $5, $6::jsonb, NOW(), NOW())`,
        [userId, run.course_id, run.id, email, learnerNric.rows[0]?.nric || null, JSON.stringify({ source: SOURCE, fullName })]
      );
    }

    // Attendance rows so trainers can mark them present (same identifier scheme as Assign Student).
    const nricRow = await client.query(`SELECT NULLIF(nric, '') AS nric FROM learner_profile WHERE user_id = $1`, [userId]);
    const identifier = nricRow.rows[0]?.nric || `_uid_${userId}`;
    await client.query(
      `INSERT INTO course_attendance (session_id, nric, user_id, is_present, reason_of_absence, updated_at)
       SELECT id, $2, $3, false, null, NOW() FROM course_session WHERE course_run_id = $1
       ON CONFLICT (session_id, nric) DO NOTHING`,
      [run.id, identifier, userId]
    );
    await client.query(`UPDATE app_user SET courses_updated_at = NOW() WHERE id = $1`, [userId]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[self-register] failed:', error instanceof Error ? error.message : error);
    await log('error', accountAction, error instanceof Error ? error.message : 'unknown');
    return res.status(500).json({ success: false, error: 'Registration failed. Please try again or contact your course administrator or trainer.' });
  } finally {
    client.release();
  }

  await log('inserted', accountAction);
  autoShareLearnerMaterials(run.id).catch((e) =>
    console.warn('[self-register] learner material share failed (non-blocking):', e instanceof Error ? e.message : e)
  );

  return res.status(200).json({
    success: true,
    ...classInfo,
    message: 'You are enrolled. Sign in with your email to receive a one-time code.',
  });
}

export default handler;
