import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import pool from '../db';
import { emailService } from '../services/emailService';
import {
  DEFAULT_WELCOME_SIGNIN_SUBJECT, DEFAULT_WELCOME_SIGNIN_BODY, fillWelcomeSigninTemplate, passwordSectionHtml,
} from './welcomeSigninEmailTemplate';

// Shared learner self-service enrolment: used by the public login-page form
// (pages/api/auth/self-register.ts) and the admin "Enrol & notify" action on
// sign-in requests (pages/api/admin/signin-requests.ts). Mirrors the admin
// Assign Student flow: account + Learner role + Confirmed enrolment + attendance rows.

export interface EnrolRun {
  id: string;
  course_id: string;
  course_run_id: string;
  start_date: string | null;
  end_date: string | null;
  title: string;
}

export type FindRunResult =
  | { status: 'found'; run: EnrolRun }
  | { status: 'not_found' }
  | { status: 'ambiguous' };

// enforceWindow: the public form only accepts live runs (14 days before start to
// 30 days after end); staff resolving a request can enrol into any non-deleted run.
export async function findCourseRun(courseRunId: string, { enforceWindow }: { enforceWindow: boolean }): Promise<FindRunResult> {
  const runs = await pool.query(
    `SELECT cr.id, cr.course_id, cr.course_run_id, cr.start_date, cr.end_date, c.title
     FROM course_run cr
     JOIN course c ON c.id = cr.course_id
     WHERE LOWER(cr.course_run_id) = LOWER($1)
       AND COALESCE(cr.is_deleted, false) = false
       AND cr.class_status IS DISTINCT FROM 'Cancelled'
       AND ($2::boolean = false OR (
             (cr.start_date IS NULL OR (NOW() AT TIME ZONE 'Asia/Singapore')::date >= cr.start_date - 14)
         AND (cr.end_date IS NULL OR (NOW() AT TIME ZONE 'Asia/Singapore')::date <= cr.end_date + 30)))
     LIMIT 2`,
    [courseRunId, enforceWindow]
  );
  if (runs.rows.length === 0) return { status: 'not_found' };
  if (runs.rows.length > 1) return { status: 'ambiguous' };
  return { status: 'found', run: runs.rows[0] };
}

export type EnrolOutcome = 'enrolled' | 'already_enrolled' | 'account_inactive' | 'enrolment_withdrawn';

// Strong random password for new accounts: 14 chars, guaranteed upper/lower/digit/symbol,
// no look-alike characters (0/O, 1/l/I) so it can be typed from the email.
export function generateStrongPassword(length = 14): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%*?-'];
  const all = sets.join('');
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Never reactivates a disabled account or restores an admin-removed enrolment —
// those were staff decisions. OTP is the preferred way in; new accounts also get a
// strong random password (returned so the welcome email can carry it) flagged
// must_change_password, so a password login forces the learner to set their own.
// Existing accounts keep their password — a public form must never reset one.
export async function enrolLearner(
  { fullName, email, run, source }: { fullName: string; email: string; run: EnrolRun; source: string }
): Promise<{ outcome: EnrolOutcome; accountAction: 'created' | 'existed'; userId: string | null; tempPassword?: string }> {
  await ensureSigninRequestTable();
  const client = await pool.connect();
  let accountAction: 'created' | 'existed' = 'existed';
  let tempPassword: string | undefined;
  try {
    await client.query('BEGIN');

    const existingUser = await client.query(
      `SELECT id, COALESCE(LOWER(account_status), 'active') AS account_status
       FROM app_user
       WHERE LOWER(email) = $1 OR LOWER(secondary_email) = $1
       LIMIT 1`,
      [email]
    );

    let userId: string;
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      if (existingUser.rows[0].account_status !== 'active') {
        await client.query('ROLLBACK');
        return { outcome: 'account_inactive', accountAction, userId };
      }
    } else {
      tempPassword = generateStrongPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const created = await client.query(
        `INSERT INTO app_user (id, email, full_name, password_hash, must_change_password, account_status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, TRUE, 'active', NOW(), NOW())
         RETURNING id`,
        [email, fullName, passwordHash]
      );
      userId = created.rows[0].id;
      accountAction = 'created';
      await client.query(
        `INSERT INTO learner_profile (user_id, tel) VALUES ($1, '') ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
    }
    await client.query(
      `INSERT INTO user_role_map (user_id, role) VALUES ($1, 'Learner') ON CONFLICT DO NOTHING`,
      [userId]
    );

    const existingEnrol = await client.query(
      `SELECT id, enrolment_status FROM enrollment WHERE user_id = $1 AND course_run_id = $2`,
      [userId, run.id]
    );
    if (existingEnrol.rows.length > 0) {
      const status = existingEnrol.rows[0].enrolment_status;
      if (status) {
        await client.query('COMMIT');
        const withdrawn = ['admin removed', 'cancelled', 'withdrawn'].includes(String(status).trim().toLowerCase());
        return { outcome: withdrawn ? 'enrolment_withdrawn' : 'already_enrolled', accountAction, userId, tempPassword };
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
        [userId, run.course_id, run.id, email, learnerNric.rows[0]?.nric || null, JSON.stringify({ source, fullName })]
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
    return { outcome: 'enrolled', accountAction, userId, tempPassword };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function logEnrolmentAttempt(
  { email, fullName, courseRunId, action, accountAction, source, error }:
  { email: string; fullName: string; courseRunId: string; action: string; accountAction: string; source: string; error?: string }
) {
  await pool.query(
    `INSERT INTO enrolment_sync_log (email, full_name, course_run_id, enrolment_status, action, account_action, source, error_message)
     VALUES ($1, $2, $3, 'Confirmed', $4, $5, $6, $7)`,
    [email, fullName, courseRunId, action, accountAction, source, error || null]
  ).catch(() => {});
}

// ── Sign-in requests ────────────────────────────────────────────────────────
// Every login-page submission is recorded. Ones the system fixed on its own are
// 'auto_enrolled'; the rest are 'open' and appear on Admin → Sign-in Requests.
// Twin of database/migrations/add-signin-help-request.sql.

let ensured: Promise<void> | null = null;
export function ensureSigninRequestTable(): Promise<void> {
  if (!ensured) {
    ensured = pool.query(`
      CREATE TABLE IF NOT EXISTS signin_help_request (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        course_run_id TEXT NOT NULL,
        course_run_uuid UUID,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('auto_enrolled', 'open', 'resolved', 'dismissed')),
        reason TEXT,
        resolved_at TIMESTAMPTZ,
        resolved_by UUID,
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS signin_help_request_status_created_idx ON signin_help_request (status, created_at DESC);
      ALTER TABLE training_provider ADD COLUMN IF NOT EXISTS welcome_signin_email_subject TEXT;
      ALTER TABLE training_provider ADD COLUMN IF NOT EXISTS welcome_signin_email_body TEXT;
      ALTER TABLE app_user ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;
    `).then(() => undefined).catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

export const SIGNIN_REQUEST_REASONS: Record<string, string> = {
  not_found: 'No open class matches this Course Run ID (wrong ID, or the class is outside the registration window).',
  ambiguous: 'This Course Run ID matches more than one class.',
  account_inactive: 'The learner account is inactive.',
  enrolment_withdrawn: 'The learner was withdrawn / removed from this class.',
  error: 'The automatic enrolment failed with an error.',
};

// ── Welcome email ───────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const formatDate = (d: string | Date | null) =>
  d ? new Date(d).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }) : 'soon';

// The TMS sign-in link: the host the learner actually used (correct per tenant),
// falling back to the configured base URL.
export function loginUrlFrom(host: string | undefined, proto?: string): string {
  if (host) {
    const scheme = proto || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https');
    return `${scheme}://${host}`;
  }
  return (process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
}

export async function sendWelcomeSigninEmail(
  { fullName, email, run, loginUrl, tempPassword }: { fullName: string; email: string; run: EnrolRun; loginUrl: string; tempPassword?: string }
): Promise<{ success: boolean; error?: string }> {
  await ensureSigninRequestTable();
  const tp = await pool.query(
    `SELECT company_name, company_shortname, welcome_signin_email_subject, welcome_signin_email_body FROM training_provider LIMIT 1`
  );
  const row = tp.rows[0] || {};
  const companyName = row.company_name || 'Training Provider';
  const vars = (escape: boolean) => {
    const e = (v: string) => (escape ? escapeHtml(v) : v);
    return {
      '{LEARNER_NAME}': e(fullName),
      '{LEARNER_EMAIL}': e(email),
      '{COURSE_NAME}': e(run.title),
      '{COURSE_RUN_ID}': e(run.course_run_id),
      '{COURSE_START_DATE}': formatDate(run.start_date),
      '{LOGIN_URL}': loginUrl,
      '{PASSWORD_SECTION}': escape ? passwordSectionHtml(tempPassword && escapeHtml(tempPassword)) : '',
      '{TEMP_PASSWORD}': e(tempPassword || ''),
      '{COMPANY_NAME}': e(companyName),
      '{COMPANY_SHORT_NAME}': e(row.company_shortname || companyName),
    };
  };
  const subject = fillWelcomeSigninTemplate(row.welcome_signin_email_subject || DEFAULT_WELCOME_SIGNIN_SUBJECT, vars(false));
  const html = fillWelcomeSigninTemplate(row.welcome_signin_email_body || DEFAULT_WELCOME_SIGNIN_BODY, vars(true));
  return emailService.sendEmail({ to: email, subject, html });
}
