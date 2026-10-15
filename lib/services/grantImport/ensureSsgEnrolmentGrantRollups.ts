import pool from '@/lib/db';

const gEnsure = globalThis as unknown as { __ssgEnrolmentGrantColumnsEnsured?: Promise<void> };

/**
 * Backward-compatible schema guard for Consolidated Finance.
 * Ensures the grant-payment rollup columns exist on `ssg_enrolments`.
 *
 * This intentionally does NOT require the full grant-import tables to exist, so the
 * finance page doesn't 500 if only partial migrations were applied.
 *
 * Runs once per process: `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes an ACCESS EXCLUSIVE
 * lock even when the column already exists, so running it on every page load queued every
 * read of ssg_enrolments behind any long-running query ("Loading enrolments…" for ages).
 */
export function ensureSsgEnrolmentGrantRollupColumns(): Promise<void> {
  if (!gEnsure.__ssgEnrolmentGrantColumnsEnsured) {
    gEnsure.__ssgEnrolmentGrantColumnsEnsured = ensureNow().catch((e) => {
      gEnsure.__ssgEnrolmentGrantColumnsEnsured = undefined;
      throw e;
    });
  }
  return gEnsure.__ssgEnrolmentGrantColumnsEnsured;
}

async function ensureNow(): Promise<void> {
  // Columns
  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS total_grant_expected numeric(10,2)`
  );
  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS total_grant_received numeric(10,2) NOT NULL DEFAULT 0`
  );
  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS total_grant_pending numeric(10,2)`
  );

  // Enum type + column (create if missing)
  await pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grant_payment_status') THEN
         CREATE TYPE public.grant_payment_status AS ENUM ('NOT_RECEIVED','PARTIAL','FULLY_PAID');
       END IF;
     END $$;`
  );
  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS grant_payment_status public.grant_payment_status`
  );

  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS last_grant_import_at timestamptz`
  );

  // When the missing-grant sync (lib/services/missingGrantSync.ts) last asked TPG for this
  // enrolment's grants. NULL = never checked.
  await pool.query(
    `ALTER TABLE public.ssg_enrolments
     ADD COLUMN IF NOT EXISTS grants_checked_at timestamptz`
  );

  // Indexes
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ssg_enrolments_grant_payment_status
     ON public.ssg_enrolments(grant_payment_status)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ssg_enrolments_last_grant_import_at
     ON public.ssg_enrolments(last_grant_import_at DESC)`
  );

  // Without these, "enrolments with no grants" (missingGrantSync) and the superseded-duplicate
  // filter in /api/finance/all-course-runs rescan the whole table per enrolment — measured at
  // 34s and 130s+ on prod (2026-10-15). CONCURRENTLY so the first build never blocks writes.
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssg_grants_enrollment_id
     ON public.ssg_grants(enrollment_id)`
  );
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssg_enrolments_nric_run
     ON public.ssg_enrolments(trainee_nric, ((raw_data->'course'->'run'->>'id')))`
  );
}
