import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const connection = process.env.DA_AUTOMATION_TEST_DATABASE_URL;

test('direct application automation (disposable Postgres; no live services)', { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '15543', 'Refuse to run mutation tests against anything except the disposable test port');
  process.env.DATABASE_URL = connection;
  process.env.EXTERNAL_API_KEY_FOR_CLAWDBOT = 'test-only-service-key';
  process.env.ENABLE_APP_SCHEDULER = 'false';
  const { default: db } = await import('../lib/db');
  const { runDirectApplicationAutomation, DA_AUTOMATION_CRON } = await import('../lib/directApplicationAutomation');
  const { withDaLock } = await import('../lib/daAutomationLock');
  const { importDirectApplications } = await import('../pages/api/admin/upload-da-applications');
  const { processDirectApplication } = await import('../lib/autoEnrolDirectApplications');
  const { ensureDaAutomationTable } = await import('../lib/directApplicationAutomationSchema');
  const { reconcileDirectApplicationCancellation } = await import('../lib/directApplicationCancellation');
  const { cleanupDaInvoicesForApplicationId } = await import('../lib/services/daInvoiceCleanup');
  await ensureDaAutomationTable();
  const ownedApps: string[] = [];
  const ownedReports: string[] = [];
  const ownedUsers: string[] = [];
  const ownedCourses: string[] = [];
  const ownedRefs: string[] = [];
  const makeRow = (status = 'Confirmed', date = '2099-01-01') => {
    const id = `TEST-DA-AUTO-${randomUUID()}`;
    ownedApps.push(id);
    return { 'Application ID': id, 'Application Status': status, 'Course Start Date': date, 'Course Run ID': `test-${randomUUID()}` };
  };
  const insert = async (row: Record<string, string>, enrolment: string | null = null, status: string | null = null) => {
    const id = randomUUID();
    await db.query(`INSERT INTO da_application (id, application_id, application_status, course_start_date, enrolment_id, auto_enrol_status)
      VALUES ($1,$2,$3,$4,$5,$6)`, [id, row['Application ID'], row['Application Status'], row['Course Start Date'], enrolment, status]);
    return id;
  };
  const run = async (deps: Parameters<typeof runDirectApplicationAutomation>[0], options?: Parameters<typeof runDirectApplicationAutomation>[1]) => {
    const report = await runDirectApplicationAutomation(deps, options);
    if (report) ownedReports.push(report.id);
    return report!;
  };
  const noImport = async () => ({ inserted: 0, updated: 0, errors: [] });
  t.beforeEach(async () => {
    await db.query('DELETE FROM da_application_source_sync WHERE application_id = ANY($1::text[])', [ownedApps]);
    await db.query('DELETE FROM da_application_sync_state');
  });
  try {
    await t.test('schedule has four daily Singapore slots', () => {
      assert.equal(DA_AUTOMATION_CRON, '0 9,12,15,18 * * *');
    });
    await t.test('manual import can defer its background enrolment', async () => {
      const row = makeRow();
      const imported = await importDirectApplications([row], { enqueue: false });
      assert.equal(imported.inserted, 1);
      assert.deepEqual(imported.errors, []);
      const stored = await db.query('SELECT auto_enrol_status FROM da_application WHERE application_id=$1', [row['Application ID']]);
      assert.equal(stored.rows[0].auto_enrol_status, null);
    });
    await t.test('Confirmed (Pending payment) imports follow the same transition as Confirmed', async () => {
      const row = makeRow('Confirm application'); await insert(row);
      const imported = await importDirectApplications([{ ...row, 'Application Status': 'Confirmed (Pending payment)' }], { enqueue: false });
      assert.equal(imported.updated, 1);
      const stored = await db.query('SELECT application_status FROM da_application WHERE application_id=$1', [row['Application ID']]);
      assert.equal(stored.rows[0].application_status, 'Confirmed (Pending payment)');
    });
    await t.test('explicit empty manual selection does not enrol every eligible application', async () => {
      const { default: handler } = await import('../pages/api/admin/auto-enrol-direct-applications');
      let httpStatus = 0; let body: any;
      const response = { setHeader() {}, status(code: number) { httpStatus = code; return this; }, json(value: unknown) { body = value; return this; } };
      await handler({ method: 'POST', headers: { 'x-api-key': 'test-only-service-key' }, body: { applicationIds: [] } } as any, response as any);
      assert.equal(httpStatus, 200); assert.equal(body.queued, 0);
    });
    await t.test('retry earlier pending/failed manual attempts, skip enrolled and deduplicate fetched IDs', async () => {
      const pending = makeRow(); const failed = makeRow('Confirmed (Pending payment)'); const done = makeRow(); const manual = makeRow();
      const pendingId = await insert(pending, null, 'pending');
      const failedId = await insert(failed, null, 'failed');
      await insert(done, 'ENR-EXISTING'); await insert(manual, 'MANUAL');
      const report = await run({ retrieve: async () => ({ rows: [pending, failed, done, manual, pending] }), importRows: noImport,
        process: async ids => {
          assert.deepEqual(new Set(ids), new Set([pendingId, failedId]));
          return ids.map(id => ({ id, applicationId: '', success: true, finalStatus: 'enroled', enrolmentId: `ENR-${id}` }));
        } });
      assert.equal(report.fetched, 4); assert.equal(report.enrolled, 2); assert.equal(report.already_enrolled, 2);
      assert.equal(report.status, 'completed');
      const stored = await db.query('SELECT * FROM da_automation_run WHERE id=$1', [report.id]);
      assert.ok(stored.rows[0].completed_at); assert.equal(stored.rows[0].enrolled, 2);
    });
    await t.test('past, cancelled, unconfirmed and undated applications cannot auto-enrol', async () => {
      const report = await run({ retrieve: async () => ({ rows: [makeRow('Cancelled'), makeRow('Confirm application'), makeRow('Confirmed', '2020-01-01'), makeRow('Confirmed', '')] }),
        importRows: async rows => { assert.equal(rows.length, 0); return noImport(); },
        process: async ids => { assert.equal(ids.length, 0); return []; } });
      assert.equal(report.fetched, 4); assert.equal(report.status, 'completed');
    });
    await t.test('fetch failures are audited and never start import/enrolment', async () => {
      const report = await run({ retrieve: async () => { throw new Error('TPG unavailable'); },
        importRows: async () => { assert.fail('must not import after fetch failure'); },
        process: async () => { assert.fail('must not enrol after fetch failure'); } });
      assert.equal(report.status, 'failed'); assert.equal(report.error_count, 1); assert.equal(report.errors[0].step, 'fetch');
    });
    await t.test('enrolment success and downstream failure are reported separately', async () => {
      const row = makeRow(); const id = await insert(row);
      const report = await run({ retrieve: async () => ({ rows: [row] }), importRows: noImport,
        process: async () => [{ id, applicationId: row['Application ID'], success: false, finalStatus: 'failed', enrolmentId: 'ENR-NEW', failedStep: 'invoice', error: 'Invoice unavailable' }] });
      assert.equal(report.enrolled, 1); assert.equal(report.error_count, 1); assert.equal(report.status, 'completed_with_errors');
    });
    await t.test('failed imports are never enrolled even when an old row exists', async () => {
      const row = makeRow(); await insert(row);
      const report = await run({ retrieve: async () => ({ rows: [row] }), importRows: async () => ({ inserted: 0, updated: 0, errors: [{ row: 0, application_id: row['Application ID'], error: 'Write failed' }] }),
        process: async ids => { assert.equal(ids.length, 0); return []; } });
      assert.equal(report.error_count, 1); assert.equal(report.attempted, 0);
    });
    await t.test('concurrent automatic runs do not fetch or enrol twice', async () => {
      let finish!: () => void; let started!: () => void;
      const waiting = new Promise<void>(resolve => { finish = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      const first = run({ retrieve: async () => { started(); await waiting; return { rows: [] }; }, importRows: noImport, process: async () => [] });
      await entered;
      const second = await runDirectApplicationAutomation({ retrieve: async () => { assert.fail('duplicate fetch'); }, importRows: noImport, process: async () => [] });
      assert.equal(second, null); finish(); await first;
    });
    await t.test('manual and scheduled processing share the same row lock', async () => {
      const row = makeRow(); const id = await insert(row);
      await withDaLock(db, `application:${id}`, async () => {
        const result = await processDirectApplication(id);
        assert.equal(result.skipped, true); assert.equal(result.failedStep, 'busy');
      });
      const result = await processDirectApplication(id);
      assert.equal(result.finalStatus, 'pending_identity');
      const stored = await db.query('SELECT auto_enrol_status,auto_enrol_error FROM da_application WHERE id=$1', [id]);
      assert.equal(stored.rows[0].auto_enrol_status, 'pending_identity'); assert.ok(stored.rows[0].auto_enrol_error);
    });
    await t.test('unexpected pipeline failures persist failed status rather than Processing', async () => {
      const row = makeRow(); const id = await insert(row, null, 'pending');
      const query = db.query.bind(db);
      db.query = ((sql: any, ...args: any[]) => {
        if (typeof sql === 'string' && sql.includes('da.*')) throw new Error('Injected pipeline failure');
        return (query as any)(sql, ...args);
      }) as typeof db.query;
      try { const result = await processDirectApplication(id); assert.equal(result.finalStatus, 'failed'); }
      finally { db.query = query as typeof db.query; }
      const stored = await db.query('SELECT auto_enrol_status,auto_enrol_error FROM da_application WHERE id=$1', [id]);
      assert.equal(stored.rows[0].auto_enrol_status, 'failed'); assert.match(stored.rows[0].auto_enrol_error, /Injected pipeline failure/);
    });
    await t.test('scheduled pipeline rechecks enrolment under its row lock after a manual run finishes', async () => {
      const row = makeRow(); const id = await insert(row, 'ENR-JUST-FINISHED');
      const result = await processDirectApplication(id, undefined, { onlyUnenrolled: true });
      assert.equal(result.skipped, true); assert.equal(result.failedStep, 'already_enrolled'); assert.equal(result.success, true);
    });
    await t.test('interrupted process history remains visible after retry', async () => {
      const staleId = randomUUID(); ownedReports.push(staleId);
      await db.query("INSERT INTO da_automation_run (id,status) VALUES ($1,'running')", [staleId]);
      await run({ retrieve: async () => ({ rows: [] }), importRows: noImport, process: async () => [] });
      const stored = await db.query('SELECT status,error_count FROM da_automation_run WHERE id=$1', [staleId]);
      assert.equal(stored.rows[0].status, 'interrupted'); assert.equal(stored.rows[0].error_count, 1);
    });
    await t.test('source sync and manual preview enforce tomorrow onward, including existing cancellations', async () => {
      const { retrieveDirectApplications } = await import('../pages/api/admin/retrieve-da-applications');
      const row = makeRow('Confirmed', '2020-01-01'); await insert(row, 'ENR-PAST');
      const calls: any[] = [];
      const dependencies = {
        credentials: async () => ({ uen: 'TEST-UEN', ssgApiBaseUrl: 'https://unused.example.test' } as any),
        partner: async () => ({ uen: 'TEST-UEN', code: 'TEST-UEN-01' } as any),
        api: (() => ({ retrieveTrainingProviderCourseApplications: async (filter: any) => {
          calls.push(filter);
          const { directApplicationSyncWindow } = await import('../lib/directApplicationSync');
          const window = directApplicationSyncWindow({});
          return { meta: { total: 3 }, data: { courseApplications: [
            { applicationId: row['Application ID'], applicationStatus: 'Cancelled', modifiedOn: '2026-10-12T08:00:00+08:00', run: { current: { startDate: '20200101' } } },
            { applicationId: 'TODAY-TEST', applicationStatus: 'Confirmed', run: { current: { startDate: window.today.replace(/-/g, '') } } },
            { applicationId: 'TOMORROW-TEST', applicationStatus: 'Cancelled', modifiedOn: '2026-10-12T08:00:00+08:00', run: { current: { startDate: window.tomorrow.replace(/-/g, '') } } },
          ] } };
        } })) as any,
      };
      const synced = await retrieveDirectApplications({ lastUpdateDate: '2026-10-11' }, { syncExisting: true }, dependencies);
      const { directApplicationSyncWindow } = await import('../lib/directApplicationSync');
      const tomorrow = directApplicationSyncWindow({}).tomorrow;
      assert.equal(calls[0].lastUpdateDate, 20261011);
      assert.equal(calls[0].runStartDate.from, Number(tomorrow.replace(/-/g, '')));
      assert.equal(calls[0].applicationStatus, undefined); assert.equal(synced.rows.length, 1);
      assert.equal(synced.rows[0]['Application Status'], 'Cancelled');
      assert.equal(synced.rows[0]['TPG Modified On'], '2026-10-12T08:00:00+08:00');
      const preview = await retrieveDirectApplications({}, {}, dependencies);
      assert.equal(preview.rows.length, 1); assert.equal(preview.rows[0]['Application ID'], 'TOMORROW-TEST');
      assert.equal(calls[1].runStartDate.from, calls[0].runStartDate.from);
    });
    await t.test('unchanged overlaps skip imports; an existing payment/status/profile change updates without enrolling again', async () => {
      const row = makeRow('Confirmed (Pending payment)'); await insert(row, 'ENR-DONE');
      const dependencies = { retrieve: async () => ({ rows: [row] }), importRows: noImport,
        process: async () => { assert.fail('existing enrolment must not be created again'); } };
      await run(dependencies);
      await db.query('UPDATE da_application SET updated_at=NOW() WHERE application_id=$1', [row['Application ID']]);
      const unchanged = await run({ ...dependencies, importRows: async () => { assert.fail('must skip unchanged source'); } });
      assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.imported, 0);
      const changed = { ...row, 'Application Status': 'Confirmed', 'Trainee Email': 'changed@example.test' };
      const updated = await run({ ...dependencies, retrieve: async () => ({ rows: [changed] }),
        importRows: rows => importDirectApplications(rows, { enqueue: false, sourceSync: true }) });
      assert.equal(updated.imported, 1);
      const stored = await db.query('SELECT application_status,trainee_email,enrolment_id FROM da_application WHERE application_id=$1', [row['Application ID']]);
      assert.deepEqual(stored.rows[0], { application_status: 'Confirmed', trainee_email: 'changed@example.test', enrolment_id: 'ENR-DONE' });
    });
    await t.test('failed fetch/import holds the cursor and failed sources can retry from the same window', async () => {
      const row = makeRow(); await insert(row, 'ENR-DONE');
      const now = () => new Date('2026-10-12T01:00:00Z');
      await run({ retrieve: async filters => { assert.equal(filters.lastUpdateDate, '2026-10-11'); return { rows: [row] }; },
        importRows: noImport, process: async () => [], now });
      const original = (await db.query('SELECT * FROM da_application_sync_state')).rows[0];
      const fetchFailed = await run({ retrieve: async filters => { assert.equal(filters.lastUpdateDate, '2026-10-11'); throw new Error('Second page unavailable'); },
        importRows: noImport, process: async () => [], now: () => new Date('2026-10-12T04:00:00Z') });
      assert.equal(fetchFailed.status, 'failed');
      assert.deepEqual((await db.query('SELECT * FROM da_application_sync_state')).rows[0], original);
      const changed = { ...row, 'Trainee Name': 'Changed' };
      const importFailed = await run({ retrieve: async () => ({ rows: [changed] }),
        importRows: async () => ({ inserted: 0, updated: 0, errors: [{ row: 1, error: 'Write failed' }] }),
        process: async () => [], now: () => new Date('2026-10-12T04:00:00Z') });
      assert.equal(importFailed.error_count, 1);
      assert.deepEqual((await db.query('SELECT * FROM da_application_sync_state')).rows[0], original);
      await run({ retrieve: async () => ({ rows: [changed] }), importRows: noImport,
        process: async () => [], now: () => new Date('2026-10-12T07:00:00Z') });
      assert.equal((await db.query('SELECT last_successful_fetch_at FROM da_application_sync_state')).rows[0].last_successful_fetch_at.toISOString(), '2026-10-12T07:00:00.000Z');
    });
    await t.test('incomplete recovery processes safe rows, holds its completion marker, and never moves the incremental cursor', async () => {
      const recentTime = new Date('2026-10-12T01:00:00Z');
      const row = makeRow(); await insert(row, 'ENR-DONE');
      await run({ retrieve: async () => ({ rows: [] }), importRows: noImport, process: async () => [], now: () => recentTime });
      const partial = await run({ retrieve: async filters => {
        assert.equal(filters.lastUpdateDate, '2026-04-15');
        return { rows: [row], complete: false, warnings: ['received 1 of 2; recovery incomplete'] };
      }, importRows: noImport, process: async () => { assert.fail('already enrolled'); }, now: () => new Date('2026-10-12T04:00:00Z') }, { mode: 'recovery' });
      assert.equal(partial.status, 'completed_with_errors'); assert.equal(partial.fetched, 1);
      const state = (await db.query('SELECT * FROM da_application_sync_state')).rows[0];
      assert.equal(state.last_successful_fetch_at.toISOString(), recentTime.toISOString());
      assert.equal(state.last_recovery_at, null);
      await run({ retrieve: async filters => { assert.equal(filters.lastUpdateDate, '2026-10-11'); return { rows: [] }; },
        importRows: noImport, process: async () => [], now: () => new Date('2026-10-12T07:00:00Z') });
      await run({ retrieve: async () => ({ rows: [row] }), importRows: noImport, process: async () => [],
        now: () => new Date('2026-10-12T10:00:00Z') }, { mode: 'recovery' });
      const completed = (await db.query('SELECT * FROM da_application_sync_state')).rows[0];
      assert.equal(completed.last_successful_fetch_at.toISOString(), '2026-10-12T07:00:00.000Z');
      assert.equal(completed.last_recovery_at.toISOString(), '2026-10-12T10:00:00.000Z');
    });
    await t.test('partial retrieval never enrols locally confirmed applications absent from the verified source set', async () => {
      const observed = makeRow(); await insert(observed, 'ENR-DONE');
      const unseen = makeRow(); await insert(unseen);
      await run({ retrieve: async () => ({ rows: [unseen] }), importRows: noImport,
        process: async () => [] });
      const partial = await run({ retrieve: async () => ({ rows: [observed], complete: false }), importRows: noImport,
        process: async () => { assert.fail('unseen row may have been cancelled at source'); } });
      assert.equal(partial.attempted, 0); assert.equal(partial.error_count, 1);
    });
    await t.test('manual sync route requires authentication and validates mode before requesting a job', async () => {
      const { default: handler } = await import('../pages/api/admin/run-da-automation');
      let httpStatus = 0;
      const response = { setHeader() {}, status(code: number) { httpStatus = code; return this; }, json() {} };
      await handler({ method: 'POST', headers: {}, body: { mode: 'recovery' } } as any, response as any);
      assert.equal(httpStatus, 401);
      await handler({ method: 'POST', headers: { 'x-api-key': 'test-only-service-key' }, body: { mode: 'all' } } as any, response as any);
      assert.equal(httpStatus, 400);
    });
    await t.test('failed enrolments retry from local source state even when the next API pull returns no applications', async () => {
      const row = makeRow(); const id = await insert(row);
      const failed = await run({ retrieve: async () => ({ rows: [row] }), importRows: noImport,
        process: async () => [{ id, applicationId: row['Application ID'], success: false, finalStatus: 'failed', error: 'SSG unavailable' }] });
      assert.equal(failed.error_count, 1);
      const retried = await run({ retrieve: async () => ({ rows: [] }), importRows: noImport,
        process: async ids => {
          assert.deepEqual(ids, [id]);
          await db.query("UPDATE da_application SET enrolment_id='ENR-RETRIED' WHERE id=$1", [id]);
          return [{ id, applicationId: row['Application ID'], success: true, finalStatus: 'enroled', enrolmentId: 'ENR-RETRIED' }];
        } });
      assert.equal(retried.fetched, 0); assert.equal(retried.enrolled, 1);
      await run({ retrieve: async () => ({ rows: [] }), importRows: noImport,
        process: async () => { assert.fail('already enrolled retry must not run again'); } });
    });
    await t.test('new confirmed applications enrol while existing future registrations receive updates', async () => {
      const fresh = makeRow();
      const existing = makeRow('Confirmed'); await insert(existing, 'ENR-EXISTING');
      const changed = { ...existing, 'Trainee Name': 'Updated learner' };
      const report = await run({ retrieve: async () => ({ rows: [fresh, changed, makeRow('Confirm application')] }),
        importRows: rows => importDirectApplications(rows, { enqueue: false, sourceSync: true }),
        process: async ids => {
          const stored = (await db.query('SELECT * FROM da_application WHERE id=ANY($1::uuid[])', [ids])).rows;
          assert.equal(stored.length, 1); assert.equal(stored[0].application_id, fresh['Application ID']);
          await db.query("UPDATE da_application SET enrolment_id='ENR-NEW' WHERE id=$1", [stored[0].id]);
          return [{ id: stored[0].id, applicationId: fresh['Application ID'], success: true, finalStatus: 'enroled', enrolmentId: 'ENR-NEW' }];
        } });
      assert.equal(report.imported, 2); assert.equal(report.enrolled, 1); assert.equal(report.error_count, 0);
      assert.equal((await db.query('SELECT trainee_name FROM da_application WHERE application_id=$1', [existing['Application ID']])).rows[0].trainee_name, 'Updated learner');
    });
    await t.test('source cancellation waits for an in-flight row operation and holds the fetch cursor', async () => {
      const row = makeRow(); const id = await insert(row);
      const report = await withDaLock(db, `application:${id}`, async () => run({
        retrieve: async () => ({ rows: [{ ...row, 'Application Status': 'Cancelled' }] }),
        importRows: async () => { assert.fail('must not overwrite an in-flight enrolment'); },
        process: async () => { assert.fail('must not enrol after deferred source update'); },
      }));
      assert.equal(report?.deferred, 1); assert.equal(report?.error_count, 1);
      assert.equal((await db.query('SELECT * FROM da_application_sync_state')).rows.length, 0);
      assert.equal((await db.query('SELECT application_status FROM da_application WHERE id=$1', [id])).rows[0].application_status, 'Confirmed');
    });
    await t.test('today and past local retries are excluded from enrolment and cancellation reconciliation', async () => {
      const today = makeRow('Confirmed', '2026-10-12'); await insert(today);
      const cancelled = makeRow('Cancelled', '2026-10-11'); await insert(cancelled, 'ENR-PAST');
      for (const row of [today, cancelled]) {
        await db.query(`INSERT INTO da_application_source_sync (application_id,source_fingerprint,cancellation_pending)
          VALUES ($1,'test',$2)`, [row['Application ID'], row === cancelled]);
      }
      const report = await run({ retrieve: async () => ({ rows: [today, cancelled] }),
        importRows: async () => { assert.fail('outside registration scope'); },
        process: async () => { assert.fail('today must not auto-enrol'); },
        cancel: async () => { assert.fail('past class must not reconcile'); },
        now: () => new Date('2026-10-12T01:00:00Z') });
      assert.equal(report.attempted, 0); assert.equal(report.cancelled, 0);
      assert.equal((await db.query('SELECT cancellation_pending FROM da_application_source_sync WHERE application_id=$1', [cancelled['Application ID']])).rows[0].cancellation_pending, true);
    });
    await t.test('TPG cancellation of a future registration reconciles records and retries failed invoice/calendar cleanup', async () => {
      const row = { ...makeRow('Confirmed'), 'Trainee Email': `cancel-${randomUUID()}@example.test`,
        'Trainee ID': `TEST-${randomUUID()}`, 'Course Title': 'Test cancellation' };
      const ref = `ENR-${randomUUID()}`; ownedRefs.push(ref);
      const id = await insert(row, ref);
      const userId = randomUUID(); ownedUsers.push(userId);
      const courseId = randomUUID(); ownedCourses.push(courseId);
      const runId = randomUUID();
      await db.query('INSERT INTO app_user (id,email,full_name) VALUES ($1,$2,$3)', [userId, row['Trainee Email'], 'Test learner']);
      await db.query('INSERT INTO course (id,title) VALUES ($1,$2)', [courseId, 'Test cancellation']);
      await db.query('INSERT INTO course_run (id,course_id,course_run_id,start_date,end_date) VALUES ($1,$2,$3,$4,$4)', [runId, courseId, row['Course Run ID'], row['Course Start Date']]);
      await db.query(`INSERT INTO enrollment (user_id,course_id,course_run_id,enrolment_id,enrolment_status,nric,email,calendar_added)
        VALUES ($1,$2,$3,$4,'Confirmed',$5,$6,true)`, [userId, courseId, runId, ref, row['Trainee ID'], row['Trainee Email']]);
      await db.query(`INSERT INTO ssg_enrolments (enrolment_id,enrolment_status,raw_data) VALUES ($1,'Confirmed','{"status":"Confirmed"}')`, [ref]);
      await db.query(`INSERT INTO ssg_enrolment_record (enrolment_reference,status) VALUES ($1,'Confirmed')`, [ref]);
      await db.query(`INSERT INTO invoice_jobs (enrolment_id,user_id,learner_email,course_code,qbo_invoice_id,status)
        VALUES ($1,$2,$3,'TEST','MAIN-TEST','done')`, [ref, userId, row['Trainee Email']]);
      await db.query(`UPDATE da_application SET course_run_id=$2,trainee_email=$3,trainee_id=$4,course_title=$5,
        calendar_added=true,invoice_id='MAIN-TEST',grant_invoice_id='GRANT-TEST',sfc_invoice_id='SFC-TEST' WHERE id=$1`,
      [id, row['Course Run ID'], row['Trainee Email'], row['Trainee ID'], row['Course Title']]);
      let failCleanup = true;
      const removed: string[] = [];
      const cancel: typeof reconcileDirectApplicationCancellation = applicationId => reconcileDirectApplicationCancellation(applicationId, {
        invoices: app => cleanupDaInvoicesForApplicationId(app, async (invoice, label) => {
          if (!invoice) return null;
          if (failCleanup && label === 'main') return 'main: QuickBooks unavailable';
          removed.push(invoice); return null;
        }),
        calendar: async (_email, _run, _title, _date, options) => {
          assert.equal(options?.throwOnError, true);
          if (failCleanup) throw new Error('Calendar unavailable');
          return { totalSessions: 1, removedFrom: 1 };
        },
      });
      const cancelledRow = { ...row, 'Application Status': 'Cancelled', 'TPG Modified On': '2026-10-12' };
      const dependencies = { retrieve: async () => ({ rows: [cancelledRow] }),
        importRows: (rows: Record<string, unknown>[]) => importDirectApplications(rows, { enqueue: false, sourceSync: true }),
        process: async () => { assert.fail('cancelled learner must not auto-enrol'); }, cancel };
      const first = await run(dependencies);
      assert.equal(first.attempted, 0); assert.equal(first.cancelled, 0); assert.equal(first.error_count, 2);
      const da = (await db.query('SELECT * FROM da_application WHERE id=$1', [id])).rows[0];
      assert.equal(da.application_status, 'Cancelled'); assert.equal(da.enrolment_status, 'Cancelled');
      assert.equal(da.invoice_id, 'MAIN-TEST'); assert.equal(da.grant_invoice_id, null); assert.equal(da.sfc_invoice_id, null);
      assert.equal(da.calendar_added, true);
      assert.equal((await db.query('SELECT enrolment_status FROM enrollment WHERE enrolment_id=$1', [ref])).rows[0].enrolment_status, 'Cancelled');
      assert.equal((await db.query('SELECT enrolment_status,raw_data FROM ssg_enrolments WHERE enrolment_id=$1', [ref])).rows[0].raw_data.status, 'Cancelled');
      assert.equal((await db.query('SELECT status FROM ssg_enrolment_record WHERE enrolment_reference=$1', [ref])).rows[0].status, 'Cancelled');
      assert.equal((await db.query('SELECT status FROM invoice_jobs WHERE enrolment_id=$1', [ref])).rows[0].status, 'cancelled');
      assert.equal((await db.query('SELECT cancellation_pending FROM da_application_source_sync WHERE application_id=$1', [row['Application ID']])).rows[0].cancellation_pending, true);
      const { default: reportHandler } = await import('../pages/api/admin/da-automation-report');
      let httpStatus = 0; let body: any;
      const response = { setHeader() {}, status(code: number) { httpStatus = code; return this; }, json(value: unknown) { body = value; return this; } };
      await reportHandler({ method: 'GET', headers: { 'x-api-key': 'test-only-service-key' } } as any, response as any);
      assert.equal(httpStatus, 200);
      assert.ok(body.attention.some((item: any) => item.application_id === row['Application ID'] && /QuickBooks unavailable/.test(item.auto_enrol_error)));
      failCleanup = false;
      const retried = await run({ ...dependencies, retrieve: async () => ({ rows: [] }) });
      assert.equal(retried.cancelled, 1); assert.equal(retried.error_count, 0);
      assert.deepEqual(removed.sort(), ['GRANT-TEST', 'MAIN-TEST', 'SFC-TEST'].sort());
      const cleaned = (await db.query('SELECT invoice_id,calendar_added FROM da_application WHERE id=$1', [id])).rows[0];
      assert.equal(cleaned.invoice_id, null); assert.equal(cleaned.calendar_added, false);
      assert.equal((await db.query('SELECT qbo_invoice_id FROM invoice_jobs WHERE enrolment_id=$1', [ref])).rows[0].qbo_invoice_id, null);
      await run({ ...dependencies, retrieve: async () => ({ rows: [cancelledRow] }),
        cancel: async () => { assert.fail('successful cancellation must not clean up again'); } });
    });
    await t.test('native-only cancellation matches the exact learner/run and never every MANUAL enrolment', async () => {
      const row = { ...makeRow('Cancelled', '2020-01-01'), 'Trainee ID': `TEST-${randomUUID()}` };
      const id = await insert(row, 'MANUAL');
      const courseId = randomUUID(); ownedCourses.push(courseId);
      const runId = randomUUID();
      const unrelatedRunId = randomUUID();
      await db.query('INSERT INTO course (id,title) VALUES ($1,$2)', [courseId, 'Manual test']);
      await db.query('INSERT INTO course_run (id,course_id,course_run_id) VALUES ($1,$2,$3)', [runId, courseId, row['Course Run ID']]);
      await db.query('INSERT INTO course_run (id,course_id,course_run_id) VALUES ($1,$2,$3)', [unrelatedRunId, courseId, `other-${randomUUID()}`]);
      const userIds = [randomUUID(), randomUUID()]; ownedUsers.push(...userIds);
      for (let i = 0; i < userIds.length; i++) {
        await db.query('INSERT INTO app_user (id,email,full_name) VALUES ($1,$2,$3)', [userIds[i], `${userIds[i]}@example.test`, 'Manual learner']);
        await db.query(`INSERT INTO enrollment (user_id,course_id,course_run_id,enrolment_id,nric,enrolment_status)
          VALUES ($1,$2,$3,'MANUAL',$4,'Confirmed')`, [userIds[i], courseId, i === 0 ? runId : unrelatedRunId, i === 0 ? row['Trainee ID'] : 'UNRELATED']);
      }
      await db.query('UPDATE da_application SET trainee_id=$2,course_run_id=$3 WHERE id=$1', [id, row['Trainee ID'], row['Course Run ID']]);
      const result = await reconcileDirectApplicationCancellation(id, {
        invoices: async () => ({ found: true, warnings: [] }), calendar: async () => { assert.fail('no calendar details'); },
      });
      assert.equal(result.cancelled, true);
      const stored = await db.query('SELECT user_id,enrolment_status FROM enrollment WHERE user_id=ANY($1::uuid[])', [userIds]);
      assert.equal(stored.rows.find(r => r.user_id === userIds[0]).enrolment_status, 'Cancelled');
      assert.equal(stored.rows.find(r => r.user_id === userIds[1]).enrolment_status, 'Confirmed');
    });
  } finally {
    await db.query('DELETE FROM da_application_source_sync WHERE application_id = ANY($1::text[])', [ownedApps]);
    await db.query('DELETE FROM da_application_sync_state');
    await db.query('DELETE FROM invoice_jobs WHERE user_id = ANY($1::uuid[])', [ownedUsers]);
    await db.query('DELETE FROM ssg_enrolments WHERE enrolment_id = ANY($1::text[])', [ownedRefs]);
    await db.query('DELETE FROM ssg_enrolment_record WHERE enrolment_reference = ANY($1::text[])', [ownedRefs]);
    await db.query('DELETE FROM enrollment WHERE user_id = ANY($1::uuid[])', [ownedUsers]);
    await db.query('DELETE FROM course_run WHERE course_id = ANY($1::uuid[])', [ownedCourses]);
    await db.query('DELETE FROM course WHERE id = ANY($1::uuid[])', [ownedCourses]);
    await db.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [ownedUsers]);
    await db.query('DELETE FROM da_application WHERE application_id = ANY($1::text[])', [ownedApps]);
    await db.query('DELETE FROM da_automation_run WHERE id = ANY($1::uuid[])', [ownedReports]);
    await db.end();
  }
});
