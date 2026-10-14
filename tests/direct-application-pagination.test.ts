import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDirectApplicationPages } from '../lib/directApplicationPagination';

test('TPG pagination starts at page 1, deduplicates overlaps and fetches the final page', async () => {
  const requested: number[] = [];
  const result = await collectDirectApplicationPages(async page => {
    requested.push(page);
    return { data: { courseApplications: (page === 1 ? ['a', 'b'] : page === 2 ? ['b', 'c'] : ['d']).map(applicationId => ({ applicationId })) }, meta: { total: 4 } };
  }, 2);
  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(result.applications.length, 4);
});
test('repeated TPG pages fail closed', async () => {
  await assert.rejects(collectDirectApplicationPages(async () => ({ data: { courseApplications: [{ applicationId: 'a' }] }, meta: { total: 2 } }), 1), /repeated/);
});
test('truncated TPG results cannot claim success', async () => {
  await assert.rejects(collectDirectApplicationPages(async page => ({ data: { courseApplications: page === 1 ? [{ applicationId: 'a' }] : [] }, meta: { total: 3 } }), 2), /Incomplete/);
});

test('short pages with a larger total continue; final 404 cannot erase missing count', async () => {
  const result = await collectDirectApplicationPages(async page => ({
    data: { courseApplications: page <= 3 ? [{ applicationId: `A${page}` }] : [] }, meta: { total: page <= 3 ? 3 : 0 },
  }), 100);
  assert.equal(result.applications.length, 3); assert.equal(result.complete, true);
  await assert.rejects(collectDirectApplicationPages(async page => ({
    data: { courseApplications: page === 1 ? [{ applicationId: 'A' }] : [] }, meta: { total: page === 1 ? 3 : 0 }, status: page === 1 ? 200 : 404,
  }), 100), /received 1 of 3/);
});

test('a second traversal recovers IDs missed by overlapping pages', async () => {
  let pass = 0;
  const result = await collectDirectApplicationPages(async page => {
    if (page === 1) pass++;
    const ids = page === 1 ? ['a', 'b'] : page === 2 ? (pass === 1 ? ['b', 'c'] : ['c', 'd']) : [];
    return { data: { courseApplications: ids.map(applicationId => ({ applicationId })) }, meta: { total: 4 } };
  }, 2, 100, { attempts: 3, allowIncomplete: true });
  assert.equal(result.complete, true); assert.equal(result.attempts, 2);
  assert.deepEqual(result.applications.map(a => a.applicationId), ['a', 'b', 'c', 'd']);
});

test('persistent mismatch returns verified records with an explicit warning after three attempts', async () => {
  const result = await collectDirectApplicationPages(async page => ({
    data: { courseApplications: page === 1 ? [{ applicationId: 'a' }, { applicationId: 'b' }] : [] }, meta: { total: 3 },
  }), 2, 100, { attempts: 3, allowIncomplete: true });
  assert.equal(result.complete, false); assert.equal(result.attempts, 3);
  assert.equal(result.applications.length, 2); assert.match(result.warnings[0], /received 2 of 3/);
});

test('newer cancellation wins over older confirmed duplicate; unordered conflicting ID is held', async () => {
  const result = await collectDirectApplicationPages(async page => ({ data: { courseApplications: page === 1 ? [
    { applicationId: 'a', applicationStatus: 'Confirmed', modifiedOn: '2026-10-12T00:00:00Z' },
    { applicationId: 'b', applicationStatus: 'Confirmed' },
  ] : page === 2 ? [
    { applicationId: 'a', applicationStatus: 'Cancelled', modifiedOn: '2026-10-13T00:00:00Z' },
    { applicationId: 'b', applicationStatus: 'Cancelled' },
  ] : [] }, meta: { total: 3 } }), 2, 100, { attempts: 3, allowIncomplete: true });
  assert.equal(result.complete, false);
  assert.deepEqual(result.applications.map(a => [a.applicationId, a.applicationStatus]), [['a', 'Cancelled']]);
  assert.match(result.warnings[0], /1 conflicting ID/);
});
test('missing list, API errors and anonymous applications fail closed', async () => {
  await assert.rejects(collectDirectApplicationPages(async () => ({}), 100), /list is missing/);
  await assert.rejects(collectDirectApplicationPages(async () => ({ error: { message: 'Rejected' }, status: 200 }), 100), /Rejected/);
  await assert.rejects(collectDirectApplicationPages(async () => ({ data: { courseApplications: [{}] } }), 100), /without an ID/);
});
test('page limit fails closed, valid empty response succeeds', async () => {
  await assert.rejects(collectDirectApplicationPages(async page => ({ data: { courseApplications: [{ applicationId: `${page}` }] } }), 1, 2), /limit reached/);
  const result = await collectDirectApplicationPages(async () => ({ data: { courseApplications: [] }, meta: { total: 0 }, status: 404 }), 100);
  assert.equal(result.applications.length, 0);
  const emptyError = await collectDirectApplicationPages(async () => ({ data: { courseApplications: [] }, error: {}, status: 200 }), 100);
  assert.equal(emptyError.applications.length, 0);
});
