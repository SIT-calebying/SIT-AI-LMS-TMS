-- Login-page "can't sign in / can't see my class" submissions.
-- 'auto_enrolled' = the system created the account + enrolment itself;
-- 'open' = needs staff (shown on Admin → Sign-in Requests).
-- Runtime twin: ensureSigninRequestTable() in lib/learner/selfEnrolment.ts.
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

-- Editable "Learner Welcome Email" (Training Provider → Email Templates).
ALTER TABLE training_provider ADD COLUMN IF NOT EXISTS welcome_signin_email_subject TEXT;
ALTER TABLE training_provider ADD COLUMN IF NOT EXISTS welcome_signin_email_body TEXT;
-- Self-registered accounts get an emailed strong password they must change on first password login.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;
