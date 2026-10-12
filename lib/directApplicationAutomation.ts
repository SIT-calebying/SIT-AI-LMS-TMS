import { randomUUID } from 'crypto';
import pool from './db';
import { withDaLock } from './daAutomationLock';
import { ensureDaAutomationTable } from './directApplicationAutomationSchema';
import { applicationsToSync, directApplicationFingerprint, directApplicationSyncWindow } from './directApplicationSync';
import { reconcileDirectApplicationCancellation } from './directApplicationCancellation';
import type { DaPipelineResult } from './autoEnrolDirectApplications';

export const DA_AUTOMATION_TASK = 'auto_retrieve_enrol_direct_applications';
export const DA_AUTOMATION_CRON = '0 9,12,15,18 * * *';
export interface DaAutomationIssue { applicationId?: string; step: string; message: string }
export interface DaAutomationRun {
  id: string; started_at?: string; completed_at?: string; status: string;
  fetched: number; imported: number; attempted: number; enrolled: number;
  already_enrolled: number; deferred: number; error_count: number; errors: DaAutomationIssue[];
  unchanged: number; cancelled: number; recovery: boolean; last_update_date: string;
}
interface Dependencies {
  retrieve: (filters: { lastUpdateDate: string }) => Promise<{ rows: Record<string, unknown>[] }>;
  importRows: (rows: Record<string, unknown>[]) => Promise<{
    inserted: number; updated: number; errors: { row: number; error: string; application_id?: string }[];
  }>;
  process: (ids: string[]) => Promise<DaPipelineResult[]>;
  cancel?: typeof reconcileDirectApplicationCancellation;
  now?: () => Date;
}

/** Await and report import, cancellation reconciliation and enrolment outcomes. */
export async function runDirectApplicationAutomation(overrides?: Dependencies): Promise<DaAutomationRun | null> {
  await ensureDaAutomationTable();
  const dependencies: Dependencies = overrides ?? {
    retrieve: async filters => (await import('../pages/api/admin/retrieve-da-applications'))
      .retrieveDirectApplications(filters, { syncExisting: true }),
    importRows: async rows => (await import('../pages/api/admin/upload-da-applications'))
      .importDirectApplications(rows, { enqueue: false, sourceSync: true }),
    process: async ids => (await import('./autoEnrolDirectApplications'))
      .bulkProcessDirectApplications(ids, { onlyUnenrolled: true }),
  };
  return withDaLock(pool, 'scheduled-fetch-enrol', async () => {
    await pool.query(`UPDATE da_automation_run SET status = 'interrupted', completed_at = NOW(),
      error_count = error_count + 1, errors = errors || $1::jsonb WHERE status = 'running'`,
    [JSON.stringify([{ step: 'interrupted', message: 'Previous process stopped before reporting completion; unfinished applications will be retried.' }])]);
    const fetchStarted = dependencies.now?.() ?? new Date();
    const state = await pool.query('SELECT * FROM da_application_sync_state WHERE task_id = $1', [DA_AUTOMATION_TASK]);
    const window = directApplicationSyncWindow(state.rows[0] || {}, fetchStarted);
    const report: DaAutomationRun = { id: randomUUID(), status: 'running', fetched: 0, imported: 0,
      attempted: 0, enrolled: 0, already_enrolled: 0, deferred: 0, error_count: 0, errors: [],
      unchanged: 0, cancelled: 0, recovery: window.recovery, last_update_date: window.lastUpdateDate };
    await pool.query(`INSERT INTO da_automation_run (id, status, recovery, last_update_date)
      VALUES ($1, 'running', $2, $3)`, [report.id, report.recovery, report.last_update_date]);
    let step = 'fetch';
    try {
      // All statuses, all course dates. Eligibility is applied when enrolling,
      // rather than hiding updates/cancellations of existing applications.
      const { rows: fetchedRows } = await dependencies.retrieve({ lastUpdateDate: window.lastUpdateDate });
      const fetchedIds = [...new Set(fetchedRows.map(row => String(row['Application ID'] || '').trim()).filter(Boolean))];
      const previous = await pool.query(`SELECT da.id, da.application_id, s.source_fingerprint
        FROM da_application da LEFT JOIN da_application_source_sync s USING (application_id)
        WHERE da.application_id = ANY($1::text[])`, [fetchedIds]);
      const previousById = new Map(previous.rows.map(row => [row.application_id, row]));
      const rows = applicationsToSync(fetchedRows, new Set(previousById.keys()), window.today);
      report.fetched = rows.length;
      step = 'import';
      let importComplete = true;
      const failedImports = new Set<string>();
      for (const row of rows) {
        const applicationId = String(row['Application ID']).trim();
        const fingerprint = directApplicationFingerprint(row);
        const old = previousById.get(applicationId);
        if (old?.source_fingerprint === fingerprint) { report.unchanged++; continue; }
        // Coordinate source updates with manual/scheduled enrolment on that row.
        const imported = await withDaLock(pool, old ? `application:${old.id}` : `source:${applicationId}`, async () => {
          const result = await dependencies.importRows([row]);
          report.imported += result.inserted + result.updated;
          if (result.errors.length) {
            for (const error of result.errors) report.errors.push({ applicationId, step: 'import', message: error.error });
            return false;
          }
          const stored = await pool.query('SELECT id FROM da_application WHERE application_id = $1', [applicationId]);
          if (!stored.rows.length) {
            report.errors.push({ applicationId, step: 'import', message: 'Application was not imported; review possible duplicate learner/course run.' });
            return false;
          }
          // Queue cleanup durably before advancing the cursor. A crash after an
          // import is safe: the old cursor/version causes that source row to retry.
          const cancelled = String(row['Application Status'] || '').trim().toLowerCase() === 'cancelled';
          await pool.query(`INSERT INTO da_application_source_sync
            (application_id, source_fingerprint, source_modified_on, cancellation_pending)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (application_id) DO UPDATE SET
              source_fingerprint = EXCLUDED.source_fingerprint, source_modified_on = EXCLUDED.source_modified_on,
              cancellation_pending = EXCLUDED.cancellation_pending, cancellation_error = NULL, synced_at = NOW()`,
          [applicationId, fingerprint, row['TPG Modified On'] || null, cancelled]);
          return true;
        });
        if (imported !== true) {
          importComplete = false;
          failedImports.add(applicationId);
          if (imported === null) {
            report.deferred++;
            report.errors.push({ applicationId, step: 'import', message: 'Application is processing; source update deferred to the next pull.' });
          }
        }
      }
      if (importComplete) {
        // Save FETCH START, not completion: changes published during paging must
        // still be included next time. Cleanup/enrolment retries live separately.
        await pool.query(`INSERT INTO da_application_sync_state (task_id, last_successful_fetch_at, last_recovery_at)
          VALUES ($1, $2, CASE WHEN $3 THEN $2::timestamptz ELSE NULL END)
          ON CONFLICT (task_id) DO UPDATE SET last_successful_fetch_at = EXCLUDED.last_successful_fetch_at,
            last_recovery_at = COALESCE(EXCLUDED.last_recovery_at, da_application_sync_state.last_recovery_at)`,
        [DA_AUTOMATION_TASK, fetchStarted.toISOString(), window.recovery]);
      }

      step = 'cancellation';
      const pending = await pool.query(`SELECT da.id, da.application_id FROM da_application da
        JOIN da_application_source_sync s USING (application_id) WHERE s.cancellation_pending`);
      for (const row of pending.rows) {
        try {
          const result = await (dependencies.cancel ?? reconcileDirectApplicationCancellation)(row.id);
          await pool.query(`UPDATE da_application_source_sync SET cancellation_pending = $2, cancellation_error = $3
            WHERE application_id = $1`, [row.application_id, !result.cancelled, result.warnings.join('; ') || null]);
          if (result.cancelled) report.cancelled++;
          else for (const message of result.warnings) report.errors.push({ applicationId: row.application_id, step, message });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await pool.query('UPDATE da_application_source_sync SET cancellation_error = $2 WHERE application_id = $1', [row.application_id, message]);
          report.errors.push({ applicationId: row.application_id, step, message });
        }
      }

      step = 'enrol';
      // Only source-synced applications are retried. Unchanged rows can still
      // need enrolling after a previous failure, even outside today's API window.
      const existing = await pool.query(`SELECT da.id, da.application_id, da.enrolment_id FROM da_application da
        JOIN da_application_source_sync s USING (application_id)
        WHERE LOWER(TRIM(da.application_status)) LIKE 'confirmed%'
          AND da.course_start_date >= $1::date AND NOT s.cancellation_pending
          AND (NULLIF(TRIM(da.enrolment_id), '') IS NULL OR da.application_id = ANY($2::text[]))`,
      [window.today, rows.map(row => String(row['Application ID']).trim())]);
      const eligible = existing.rows.filter(row => !failedImports.has(row.application_id));
      const candidates = eligible.filter(row => !String(row.enrolment_id || '').trim());
      report.already_enrolled = eligible.length - candidates.length;
      report.attempted = candidates.length;
      const results = candidates.length ? await dependencies.process(candidates.map(row => row.id)) : [];
      const resultsById = new Map(results.map(result => [result.id, result]));
      for (const row of candidates) {
        const result = resultsById.get(row.id);
        if (result?.skipped) {
          if (result.failedStep === 'already_enrolled') report.already_enrolled++;
          else report.deferred++;
          continue;
        }
        if (result?.enrolmentId) report.enrolled++;
        if (!result?.success) report.errors.push({ applicationId: row.application_id, step: result?.failedStep || step, message: result?.error || 'Pipeline returned no outcome' });
      }
      report.status = report.errors.length ? 'completed_with_errors' : 'completed';
    } catch (error) {
      report.status = 'failed';
      report.errors.push({ step, message: error instanceof Error ? error.message : 'Unexpected automation failure' });
    }
    report.error_count = report.errors.length;
    await pool.query(`UPDATE da_automation_run SET completed_at = NOW(), status = $2,
      fetched = $3, imported = $4, attempted = $5, enrolled = $6, already_enrolled = $7,
      deferred = $8, error_count = $9, errors = $10::jsonb, unchanged = $11, cancelled = $12 WHERE id = $1`,
    [report.id, report.status, report.fetched, report.imported, report.attempted, report.enrolled,
      report.already_enrolled, report.deferred, report.error_count, JSON.stringify(report.errors), report.unchanged, report.cancelled]);
    return report;
  });
}
