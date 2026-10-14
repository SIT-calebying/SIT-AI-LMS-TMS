import pool from './db';
import { withDaLock } from './daAutomationLock';
import { cleanupDaInvoicesForApplicationId } from './services/daInvoiceCleanup';
import { removeDaLearnerFromCalendar } from './google-calendar/da-calendar-sync';

interface CancellationDependencies {
  invoices: typeof cleanupDaInvoicesForApplicationId;
  calendar: typeof removeDaLearnerFromCalendar;
}

/** TPG is authoritative: reconcile locally without sending another cancel request. */
export async function reconcileDirectApplicationCancellation(
  id: string,
  dependencies: CancellationDependencies = {
    invoices: cleanupDaInvoicesForApplicationId, calendar: removeDaLearnerFromCalendar,
  },
): Promise<{ cancelled: boolean; warnings: string[] }> {
  const result = await withDaLock(pool, `application:${id}`, async () => {
    const loaded = await pool.query('SELECT * FROM da_application WHERE id = $1', [id]);
    const row = loaded.rows[0];
    if (!row) throw new Error('Cancelled application no longer exists');
    if (String(row.application_status || '').trim().toLowerCase() !== 'cancelled') {
      throw new Error('Application status changed before cancellation reconciliation; retry source sync');
    }

    let calendarNeeded = row.calendar_added === true;
    let enrollmentIds: string[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE da_application SET enrolment_status = 'Cancelled',
        auto_enrol_status = 'cancelled', auto_enrol_error = NULL, updated_at = NOW() WHERE id = $1`, [id]);
      // MANUAL is a shared marker, never an enrolment identifier. Fallback matching
      // is scoped to the exact run and learner, including native-only enrolments.
      const ref = /^ENR-/i.test(String(row.enrolment_id || '').trim()) ? String(row.enrolment_id).trim() : null;
      const enrollments = await client.query(`UPDATE enrollment e SET enrolment_status = 'Cancelled',
          updated_at = NOW()
        WHERE ($1::text IS NOT NULL AND e.enrolment_id = $1)
          OR (e.course_run_id IN (SELECT id FROM course_run WHERE id::text = $2 OR course_run_id = $2)
            AND (($3::text IS NOT NULL AND (LOWER(TRIM(e.nric)) = LOWER(TRIM($3)) OR e.user_id IN (
                SELECT user_id FROM learner_profile WHERE LOWER(TRIM(nric)) = LOWER(TRIM($3)))))
              OR ($3::text IS NULL AND $4::text IS NOT NULL AND
                (LOWER(TRIM(e.email)) = LOWER(TRIM($4)) OR e.user_id IN (
                  SELECT id FROM app_user WHERE LOWER(email) = LOWER($4) OR LOWER(secondary_email) = LOWER($4))))))
        RETURNING e.id, e.enrolment_id, e.calendar_added`,
      [ref, row.course_run_id, row.trainee_id || null, row.trainee_email || null]);
      enrollmentIds = enrollments.rows.map(e => e.id);
      calendarNeeded ||= enrollments.rows.some(e => e.calendar_added === true);
      const refs = [...new Set([ref, ...enrollments.rows.map(e => e.enrolment_id)].filter(r => /^ENR-/i.test(String(r || ''))))];
      if (refs.length) {
        await client.query(`UPDATE ssg_enrolments SET enrolment_status = 'Cancelled',
          raw_data = CASE WHEN jsonb_typeof(raw_data) = 'object' THEN jsonb_set(raw_data, '{status}', '"Cancelled"') ELSE raw_data END
          WHERE enrolment_id = ANY($1::text[])`, [refs]);
        await client.query(`UPDATE ssg_enrolment_record SET status = 'Cancelled', updated_at = NOW()
          WHERE enrolment_reference = ANY($1::text[])`, [refs]);
        await client.query(`UPDATE invoice_jobs SET status = 'cancelled',
          last_error = 'TPGateway application cancelled', updated_at = NOW()
          WHERE enrolment_id = ANY($1::text[])`, [refs]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }

    const warnings: string[] = [];
    try {
      const invoices = await dependencies.invoices(row.application_id);
      warnings.push(...invoices.warnings);
    } catch (error) { warnings.push(`Invoices: ${error instanceof Error ? error.message : String(error)}`); }

    try {
      // Remove even when an old invite was never stamped locally. If calendar
      // sync is disabled, defer only invitations we know were previously added.
      if (row.trainee_email && row.course_title && row.course_run_id) {
        await dependencies.calendar(row.trainee_email, row.course_run_id, row.course_title,
          row.course_start_date, { throwOnError: true, allowDisabled: !calendarNeeded });
      } else if (calendarNeeded) {
        throw new Error('Missing learner email or course details for calendar removal');
      }
      await pool.query('UPDATE da_application SET calendar_added = false WHERE id = $1', [id]);
      await pool.query('UPDATE enrollment SET calendar_added = false WHERE id = ANY($1::uuid[])', [enrollmentIds]);
    } catch (error) { warnings.push(`Calendar: ${error instanceof Error ? error.message : String(error)}`); }
    return { cancelled: warnings.length === 0, warnings };
  });
  return result ?? { cancelled: false, warnings: ['Application is currently processing; cancellation will retry'] };
}
