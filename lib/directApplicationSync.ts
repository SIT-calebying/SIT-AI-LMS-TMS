import { createHash } from 'crypto';

export type ApplicationRow = Record<string, unknown>;
const DAY_MS = 86_400_000;
export const DA_RECOVERY_DAYS = 180;
export const DA_RECOVERY_INTERVAL_DAYS = 7;
export type DirectApplicationSyncMode = 'incremental' | 'recovery';

export function singaporeDate(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Date-only API cursor, with overlap for same-day changes and delayed publication. */
export function directApplicationSyncWindow(
  state: { last_successful_fetch_at?: string | Date | null; last_recovery_at?: string | Date | null },
  now = new Date(),
  mode: DirectApplicationSyncMode = 'incremental',
) {
  const today = singaporeDate(now);
  const tomorrow = daysBefore(today, -1);
  const oldest = daysBefore(today, DA_RECOVERY_DAYS);
  const lastFetch = state.last_successful_fetch_at ? new Date(state.last_successful_fetch_at) : null;
  const recovery = mode === 'recovery';
  const since = recovery ? oldest : daysBefore(lastFetch ? singaporeDate(lastFetch) : today, 1);
  return { lastUpdateDate: since < oldest ? oldest : since, recovery, today, tomorrow };
}

export function directApplicationRecoveryDue(
  state: { last_recovery_at?: string | Date | null }, now = new Date(),
): boolean {
  return !state.last_recovery_at
    || now.getTime() - new Date(state.last_recovery_at).getTime() >= DA_RECOVERY_INTERVAL_DAYS * DAY_MS;
}

export function confirmedUpcomingApplication(row: ApplicationRow, today: string): boolean {
  const start = String(row['Course Start Date'] || '');
  return String(row['Application Status'] || '').trim().toLowerCase().startsWith('confirmed')
    && /^\d{4}-\d{2}-\d{2}$/.test(start) && start >= today;
}

/** Hash only source data; LMS invoice/calendar/enrolment timestamps are unrelated. */
export function directApplicationFingerprint(row: ApplicationRow): string {
  const ordered = Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function applicationsToSync(rows: ApplicationRow[], existingIds: Set<string>, startsFrom: string): ApplicationRow[] {
  return [...new Map(rows.filter(row => {
    const id = String(row['Application ID'] || '').trim();
    const start = String(row['Course Start Date'] || '');
    return id && /^\d{4}-\d{2}-\d{2}$/.test(start) && start >= startsFrom
      && (existingIds.has(id) || confirmedUpcomingApplication(row, startsFrom));
  }).map(row => [String(row['Application ID']).trim(), row])).values()];
}
