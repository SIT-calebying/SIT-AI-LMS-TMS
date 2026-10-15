-- When the missing-grant sync (lib/services/missingGrantSync.ts) last asked TPG for an
-- enrolment's grants. NULL = never checked. Also ensured at runtime by
-- lib/services/grantImport/ensureSsgEnrolmentGrantRollups.ts.
ALTER TABLE public.ssg_enrolments ADD COLUMN IF NOT EXISTS grants_checked_at timestamptz;

-- Indexes for the "enrolments with no grants" lookup and the superseded-duplicate filter on
-- Consolidated Finance (both rescanned the whole table per enrolment without them).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssg_grants_enrollment_id
  ON public.ssg_grants(enrollment_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssg_enrolments_nric_run
  ON public.ssg_enrolments(trainee_nric, ((raw_data->'course'->'run'->>'id')));
