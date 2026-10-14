import { withAuth } from '@lib/auth/withAuth';
import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../../lib/db';

// POST { courseRunUuid | courseRunId, userId | learnerEmail, personalEmail, releaseEmptyDuplicate? }
//
// Sets app_user.secondary_email on a learner who is enrolled in the given course run, so they
// can log in with a personal email (login + forgot-password already match secondary_email) and
// land on the SAME account that holds their official enrolment — no duplicate learner, no
// second enrolment, NRIC/SSG link/attendance stay together. Typical case: company email
// (e.g. @stengg.com) cannot receive OTP / reach the LMS.
//
// - courseRunId is the SSG course run id (e.g. "1225009"); courseRunUuid is the local course_run.id.
// - learnerEmail matches the learner's primary OR current secondary email.
// - personalEmail "" / null clears the secondary email.
// - If personalEmail already belongs to ANOTHER account, refuse (409) — login picks the first match,
//   so two accounts sharing one email would be ambiguous. Exception: an unused learner-only account
//   (no enrolments, no other roles — e.g. one created by mistake when someone tried to add the
//   personal email as a new learner). Returns 409 code EMPTY_DUPLICATE_ACCOUNT; resend with
//   releaseEmptyDuplicate:true to disable that account and free its email (reversible, nothing deleted).
//
// Machine callers (OpenClaw / Kael) use x-api-key like every other route.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INACTIVE_ENROLMENT_STATUSES = ['admin removed', 'cancelled', 'withdrawn'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { courseRunUuid, courseRunId, userId, learnerEmail, personalEmail, releaseEmptyDuplicate } = req.body || {};

  if (!courseRunUuid && !courseRunId) {
    return res.status(400).json({ success: false, error: 'courseRunUuid or courseRunId is required' });
  }
  if (!userId && !learnerEmail) {
    return res.status(400).json({ success: false, error: 'userId or learnerEmail is required' });
  }
  if (personalEmail !== undefined && personalEmail !== null && typeof personalEmail !== 'string') {
    return res.status(400).json({ success: false, error: 'personalEmail must be a string' });
  }

  const newEmail: string | null = personalEmail ? personalEmail.trim().toLowerCase() : null;
  if (newEmail && !EMAIL_RE.test(newEmail)) {
    return res.status(400).json({ success: false, error: `"${newEmail}" is not a valid email address` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve the course run
    const runResult = courseRunUuid
      ? await client.query(`SELECT id, course_run_id FROM course_run WHERE id = $1`, [courseRunUuid])
      : await client.query(`SELECT id, course_run_id FROM course_run WHERE course_run_id = $1`, [String(courseRunId).trim()]);
    if (runResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Course run not found' });
    }
    if (runResult.rows.length > 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `Course run id ${courseRunId} matches more than one class — use courseRunUuid` });
    }
    const runUuid: string = runResult.rows[0].id;

    // Resolve the learner — must hold an active enrolment in this run
    const learnerResult = await client.query(
      `SELECT au.id, au.full_name, au.email, au.secondary_email
         FROM enrollment e
         JOIN app_user au ON au.id = e.user_id
        WHERE e.course_run_id = $1
          AND LOWER(COALESCE(e.enrolment_status, '')) <> ALL($3::text[])
          AND ${userId ? 'au.id = $2' : '(LOWER(au.email) = LOWER($2) OR LOWER(au.secondary_email) = LOWER($2))'}`,
      [runUuid, userId || String(learnerEmail).trim(), INACTIVE_ENROLMENT_STATUSES]
    );
    if (learnerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: `${learnerEmail || 'This learner'} is not enrolled in this class` });
    }
    if (learnerResult.rows.length > 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `${learnerEmail} matches more than one enrolled learner — use userId` });
    }
    const learner = learnerResult.rows[0];

    if (newEmail && newEmail === (learner.email || '').toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Personal email is the same as the learner\'s main email' });
    }

    let releasedAccount: { userId: string; originalEmail: string } | null = null;

    if (newEmail) {
      // Any other account already answering to this email?
      const conflicts = await client.query(
        `SELECT au.id, au.full_name, au.email, au.secondary_email,
                (SELECT COUNT(*)::int FROM enrollment e WHERE e.user_id = au.id) AS enrolment_count,
                (SELECT COUNT(*)::int FROM user_role_map r WHERE r.user_id = au.id AND r.role <> 'Learner') AS other_role_count
           FROM app_user au
          WHERE au.id <> $1
            AND (LOWER(au.email) = $2 OR LOWER(au.secondary_email) = $2)`,
        [learner.id, newEmail]
      );

      for (const c of conflicts.rows) {
        const isUnusedPrimary = c.enrolment_count === 0 && c.other_role_count === 0 && (c.email || '').toLowerCase() === newEmail;
        if (!isUnusedPrimary) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            code: 'EMAIL_IN_USE',
            error: `${newEmail} is already used by another account (${c.full_name || c.email}) that has enrolments or other roles. Not changed.`,
          });
        }
        if (releaseEmptyDuplicate !== true) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            code: 'EMPTY_DUPLICATE_ACCOUNT',
            error: `${newEmail} already has a separate, unused learner account (${c.full_name || 'no name'}, no enrolments). It must be disabled so the email logs into ${learner.full_name}'s account instead. Resend with releaseEmptyDuplicate: true to do that.`,
            duplicate: { userId: c.id, fullName: c.full_name, email: c.email },
          });
        }
        // Disable the unused account and move it off the email (kept, not deleted — reversible).
        await client.query(
          `UPDATE app_user
              SET email = $2, account_status = 'inactive', updated_at = NOW()
            WHERE id = $1`,
          [c.id, `released-${c.id}@released.invalid`]
        );
        // Same as revokeAllSessions(), inside this transaction
        await client.query(`DELETE FROM user_session WHERE user_id = $1`, [c.id]);
        releasedAccount = { userId: c.id, originalEmail: c.email };
        console.log(`[set-learner-login-email] released unused account ${c.id} (was ${c.email}) for learner ${learner.id}`);
      }
    }

    await client.query(
      `UPDATE app_user SET secondary_email = $2, updated_at = NOW() WHERE id = $1`,
      [learner.id, newEmail]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: newEmail
        ? `${learner.full_name} can now log in with ${newEmail} (same account as ${learner.email}).`
        : `Personal login email removed for ${learner.full_name}.`,
      learner: { userId: learner.id, fullName: learner.full_name, email: learner.email, secondaryEmail: newEmail },
      previousSecondaryEmail: learner.secondary_email || null,
      releasedAccount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[set-learner-login-email] error:', error);
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal server error' });
  } finally {
    client.release();
  }
}

export default withAuth(handler, { roles: ['admin', 'trainingProvider', 'developer'] });
