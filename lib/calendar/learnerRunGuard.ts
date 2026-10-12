import pool from '../db';

/**
 * Has this learner MOVED AWAY from the given class?
 *
 * True when the learner (matched by email or NRIC) has a Confirmed enrolment in
 * ANOTHER current/upcoming run of the SAME course, and no Confirmed enrolment in
 * this run. That is exactly a learner who was rescheduled / moved to a different
 * course run.
 *
 * Moves only update `enrollment.course_run_id`. The learner's Direct Application
 * row and the SSG staging row keep pointing at the OLD run, and several calendar
 * paths re-add learners from those rows — which put moved learners back on the
 * old class's event even after admins removed them. Those paths call this first.
 *
 * Past runs (end_date before today) don't count, so a learner retaking a course
 * they finished before is never treated as moved. Unknown run → false.
 */
export async function learnerMovedAwayFromRun(
  runRef: string,
  email: string | null | undefined,
  nric?: string | null
): Promise<boolean> {
  const em = String(email || '').trim().toLowerCase();
  const id = String(nric || '').trim().toUpperCase();
  if (!runRef || (!em && !id)) return false;
  const r = await pool.query<{ moved: boolean }>(
    `WITH r AS (
       SELECT id, course_id FROM course_run WHERE id::text = $1 OR course_run_id = $1 LIMIT 1
     ), mine AS (
       SELECT e.course_run_id, e.enrolment_status, cr.end_date
         FROM enrollment e
         JOIN course_run cr ON cr.id = e.course_run_id
         LEFT JOIN app_user au ON au.id = e.user_id
         JOIN r ON cr.course_id = r.course_id
        WHERE ($2 <> '' AND (LOWER(BTRIM(COALESCE(e.email, ''))) = $2 OR LOWER(BTRIM(COALESCE(au.email, ''))) = $2))
           OR ($3 <> '' AND UPPER(BTRIM(COALESCE(e.nric, ''))) = $3)
     )
     SELECT EXISTS (SELECT 1 FROM mine, r WHERE mine.course_run_id <> r.id AND mine.enrolment_status = 'Confirmed'
                      AND mine.end_date >= (NOW() AT TIME ZONE 'Asia/Singapore')::date)
        AND NOT EXISTS (SELECT 1 FROM mine, r WHERE mine.course_run_id = r.id AND mine.enrolment_status = 'Confirmed')
        AND EXISTS (SELECT 1 FROM r) AS moved`,
    [runRef, em, id]
  );
  return r.rows[0]?.moved === true;
}
