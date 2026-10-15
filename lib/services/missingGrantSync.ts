import pool from '@/lib/db';
import { refreshGrantsForEnrolments } from './billingSync';
import { ensureSsgEnrolmentGrantRollupColumns } from './grantImport/ensureSsgEnrolmentGrantRollups';

/**
 * Missing-grant sync for Consolidated Finance.
 *
 * Grants were only ever pulled from TPG at a few moments (invoice generation, a run import,
 * DA/company flows). An enrolment that never went through one of those — or whose one pull
 * hit a transient TPG failure — showed no grants even though TPG had them (2026-10-15:
 * ENR-2610-071513 and a random sample of 25 other invoiced enrolments all had grants in TPG
 * but none locally).
 *
 * This asks TPG for the grants of every Confirmed enrolment that has no ssg_grants rows:
 *   - never checked (grants_checked_at IS NULL) → checked, newest enrolments first;
 *   - checked but still no grants and enrolled within RECHECK_WINDOW_DAYS → rechecked every
 *     RECHECK_AFTER_HOURS, since TPG can create the grant after the enrolment;
 *   - older enrolments that TPG says have no grants are left alone (genuinely not funded).
 * Only a successful TPG answer marks an enrolment checked; failures are retried next run.
 */

const RECHECK_AFTER_HOURS = 12;
const RECHECK_WINDOW_DAYS = 45;
export const MISSING_GRANT_SYNC_BATCH = 60;

export interface MissingGrantSyncResult {
  success: boolean;
  skipped?: boolean;
  checked: number;
  withGrants: number;
  grantsSaved: number;
  failed: number;
  failures: Array<{ enrolmentId: string; error?: string }>;
}

const g = globalThis as unknown as {
  __missingGrantSyncRunning?: Promise<MissingGrantSyncResult>;
  __missingGrantSyncAt?: number;
};

async function syncMissingGrantsNow(limit: number, newOnly = false): Promise<MissingGrantSyncResult> {
  await ensureSsgEnrolmentGrantRollupColumns();

  const candidates = await pool.query(
    `SELECT se.enrolment_id
       FROM ssg_enrolments se
      WHERE se.enrolment_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(se.enrolment_status, ''))) = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM ssg_grants g WHERE g.enrollment_id = se.enrolment_id)
        AND (
          se.grants_checked_at IS NULL
          OR (NOT $4::boolean
              AND se.grants_checked_at < now() - make_interval(hours => $2)
              AND COALESCE(se.enrolment_date, se.created_date) > now() - make_interval(days => $3))
        )
      ORDER BY se.grants_checked_at NULLS FIRST, se.enrolment_id DESC
      LIMIT $1`,
    [limit, RECHECK_AFTER_HOURS, RECHECK_WINDOW_DAYS, newOnly]
  );
  const ids: string[] = candidates.rows.map((r: { enrolment_id: string }) => r.enrolment_id);
  if (ids.length === 0) {
    return { success: true, checked: 0, withGrants: 0, grantsSaved: 0, failed: 0, failures: [] };
  }

  const results = await refreshGrantsForEnrolments(ids);
  const ok = results.filter((r) => r.success).map((r) => r.enrolmentId);
  const failures = results
    .filter((r) => !r.success)
    .map((r) => ({ enrolmentId: r.enrolmentId, error: r.error }));

  if (ok.length > 0) {
    await pool.query(
      `UPDATE ssg_enrolments SET grants_checked_at = now() WHERE enrolment_id = ANY($1::text[])`,
      [ok]
    );
  }

  const withGrants = results.filter((r) => r.success && r.grantsUpserted > 0);
  const grantsSaved = withGrants.reduce((n, r) => n + r.grantsUpserted, 0);
  if (grantsSaved > 0 || failures.length > 0) {
    console.log(
      `[missingGrantSync] checked ${ids.length}: ${withGrants.length} enrolment(s) got ${grantsSaved} grant(s) from TPG, ${failures.length} failed`
    );
  }

  return {
    success: failures.length === 0,
    checked: ids.length,
    withGrants: withGrants.length,
    grantsSaved,
    failed: failures.length,
    failures,
  };
}

/** One run at a time per process; a call while one is running waits for that run. */
export function syncMissingGrants(limit = MISSING_GRANT_SYNC_BATCH): Promise<MissingGrantSyncResult> {
  if (g.__missingGrantSyncRunning) return g.__missingGrantSyncRunning;
  g.__missingGrantSyncAt = Date.now();
  g.__missingGrantSyncRunning = syncMissingGrantsNow(limit).finally(() => {
    g.__missingGrantSyncRunning = undefined;
  });
  return g.__missingGrantSyncRunning;
}

const PAGE_WAIT_MS = 4000;

/**
 * Consolidated Finance page load: fetch TPG grants for just the rows being shown (the current
 * page, or the rows a search for an enrolment / course run ID returned) that have none stored
 * and are due a check — never the whole backlog, so the table isn't held up. Waits at most
 * PAGE_WAIT_MS; anything slower finishes in the background and shows on the next refresh.
 * Returns true when grants were saved in time, so the caller can re-read its rows. Never throws.
 */
export async function syncGrantsForShownRows(enrolmentIds: string[]): Promise<boolean> {
  try {
    const ids = Array.from(new Set(enrolmentIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (ids.length === 0) return false;
    await ensureSsgEnrolmentGrantRollupColumns();
    const due = await pool.query(
      `SELECT se.enrolment_id
         FROM ssg_enrolments se
        WHERE se.enrolment_id = ANY($1::text[])
          AND LOWER(TRIM(COALESCE(se.enrolment_status, ''))) = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM ssg_grants g WHERE g.enrollment_id = se.enrolment_id)
          AND (
            se.grants_checked_at IS NULL
            OR (se.grants_checked_at < now() - make_interval(hours => $2)
                AND COALESCE(se.enrolment_date, se.created_date) > now() - make_interval(days => $3))
          )`,
      [ids, RECHECK_AFTER_HOURS, RECHECK_WINDOW_DAYS]
    );
    const dueIds: string[] = due.rows.map((r: { enrolment_id: string }) => r.enrolment_id);
    if (dueIds.length === 0) return false;

    const run = (async () => {
      const results = await refreshGrantsForEnrolments(dueIds);
      const ok = results.filter((r) => r.success).map((r) => r.enrolmentId);
      if (ok.length > 0) {
        await pool.query(
          `UPDATE ssg_enrolments SET grants_checked_at = now() WHERE enrolment_id = ANY($1::text[])`,
          [ok]
        );
      }
      return results.some((r) => r.success && r.grantsUpserted > 0);
    })().catch((e) => {
      console.warn('[missingGrantSync] shown-rows sync failed:', e);
      return false;
    });
    return await Promise.race([run, new Promise<boolean>((r) => setTimeout(() => r(false), PAGE_WAIT_MS))]);
  } catch (e) {
    console.warn('[missingGrantSync] shown-rows sync failed:', e);
    return false;
  }
}
