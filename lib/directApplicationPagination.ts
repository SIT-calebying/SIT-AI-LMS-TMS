import { isDeepStrictEqual } from 'node:util';
import type { DirectCourseApplication, DirectCourseApplicationResponse } from './ssg/api/direct-course-application-api';

interface PaginationOptions { attempts?: number; allowIncomplete?: boolean }

/** Retry unstable pages, retaining each application's newest authoritative version. */
export async function collectDirectApplicationPages(
  fetchPage: (page: number) => Promise<DirectCourseApplicationResponse>, pageSize: number, maxPages = 100,
  options: PaginationOptions = {},
) {
  const applications = new Map<string, DirectCourseApplication>();
  const conflicting = new Set<string>();
  let total = 0;
  let pages = 0;
  let duplicates = 0;
  let attempts = 0;
  let complete = false;
  let problem = '';
  const limit = Math.max(1, Math.min(options.attempts ?? 1, 3));
  for (let attempt = 1; attempt <= limit; attempt++) {
    attempts = attempt;
    const passIds = new Set<string>();
    let reachedEnd = false;
    problem = '';
    for (let page = 1; page <= maxPages; page++) {
      let response: DirectCourseApplicationResponse;
      try { response = await fetchPage(page); }
      catch (error) { problem = error instanceof Error ? error.message : 'TPGateway request failed'; break; }
      pages++;
      const hasError = response.error?.message || response.error?.details?.length
        || (response.error?.code && String(response.error.code) !== '0');
      if (hasError && Number(response.status) !== 404) {
        throw new Error(response.error?.message || 'TPGateway returned an application retrieval error');
      }
      const current = response.data?.courseApplications;
      if (!Array.isArray(current)) throw new Error('Unexpected TPGateway response: application list is missing');
      // A final-page 404 advertises zero; it must not erase earlier totals.
      const reported = Number(response.meta?.total ?? 0);
      if (!Number.isFinite(reported) || reported < 0) throw new Error('Unexpected TPGateway total');
      total = Math.max(total, reported);
      if (!current.length) { reachedEnd = true; break; }
      let addedThisPass = 0;
      for (const application of current) {
        const id = String(application.applicationId || '').trim();
        if (!id) throw new Error('TPGateway returned an application without an ID');
        if (!passIds.has(id)) { passIds.add(id); addedThisPass++; }
        const old = applications.get(id);
        if (!old) { applications.set(id, application); continue; }
        duplicates++;
        if (isDeepStrictEqual(old, application)) continue;
        const oldDate = Date.parse(old.modifiedOn || '');
        const newDate = Date.parse(application.modifiedOn || '');
        if (Number.isFinite(oldDate) && Number.isFinite(newDate) && oldDate !== newDate) {
          if (newDate > oldDate) { applications.set(id, application); conflicting.delete(id); }
        } else {
          // Competing versions without ordered dates are unsafe to enrol/cancel.
          conflicting.add(id);
        }
      }
      if (total > 0 && applications.size - conflicting.size >= total) { reachedEnd = true; break; }
      if (!addedThisPass) { problem = 'TPGateway repeated a page; retrieval is incomplete'; break; }
      if (!total && current.length < pageSize) { reachedEnd = true; break; }
      // A short page with a known total is not proof of completion. Probe the next page.
      if (page === maxPages) problem = 'TPGateway pagination limit reached; retrieval is incomplete';
    }
    complete = reachedEnd && !problem && !conflicting.size && applications.size >= total;
    if (complete) break;
  }
  const verified = [...applications].filter(([id]) => !conflicting.has(id)).map(([, app]) => app);
  const warning = complete ? '' : `${problem ? `${problem}. ` : ''}Incomplete TPGateway retrieval: received ${verified.length} of ${total} applications after ${attempts} attempt(s), ${pages} page(s); ${duplicates} duplicate observations, ${conflicting.size} conflicting ID(s). Sync cursor retained for retry.`;
  if (!complete && !options.allowIncomplete) throw new Error(warning);
  return { applications: verified, total, pages, attempts, duplicates, complete, warnings: warning ? [warning] : [] };
}
