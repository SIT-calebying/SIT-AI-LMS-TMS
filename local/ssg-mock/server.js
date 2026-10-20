'use strict';
/**
 * Local mock of SSG / TPGateway for AI-LMS-TMS (git-excluded, dev only).
 *
 * Wire format mirrors what lib/ssg/** expects:
 *   - request bodies are a bare base64 AES-256-CBC string (fixed IV "SSGAPIInitVector")
 *   - /tpg/enrolments*  -> response body is an encrypted base64 string of {data,status,error}
 *   - everything else   -> plain JSON
 * The shapes are modelled on the app's own parsers, NOT on SSG's real contract, and the
 * client certificate is not checked (plain HTTP). Unknown routes return 404 and are logged.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4010);
const KEY = Buffer.from(process.env.MOCK_ENC_KEY || '', 'base64');
const DATA_FILE = process.env.DATA_FILE || '/data/state.json';
const IV = Buffer.from('SSGAPIInitVector', 'utf8');
if (KEY.length !== 32) { console.error('MOCK_ENC_KEY must be base64 of 32 bytes'); process.exit(1); }

// ── crypto ───────────────────────────────────────────────────────────────────
const encrypt = (obj) => {
  const c = crypto.createCipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]).toString('base64');
};
const decrypt = (text) => {
  let s = String(text || '').trim();
  if (s.startsWith('"') && s.endsWith('"')) { try { s = JSON.parse(s); } catch { /* keep */ } }
  const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
  const out = Buffer.concat([d.update(Buffer.from(s.replace(/\s/g, ''), 'base64')), d.final()]).toString('utf8');
  return JSON.parse(out);
};
/** Body is normally encrypted; tolerate plain JSON so curl-driven tests work. */
const readPayload = (raw) => {
  if (!raw || !raw.trim()) return {};
  try { return decrypt(raw); } catch { /* fall through */ }
  try { return JSON.parse(raw); } catch { return null; }
};

// ── state ────────────────────────────────────────────────────────────────────
const fresh = () => ({ seq: { run: 1000000, enrol: 0, assess: 0 }, runs: {}, enrolments: {}, assessments: {}, attendance: [] });
let db = fresh();
try { db = { ...fresh(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* first boot */ }
const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.warn('[ssg-mock] state not persisted:', e.message); }
};

// ── helpers ──────────────────────────────────────────────────────────────────
const ymd = (n) => { const s = String(n || '').replace(/-/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : ''; };
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(String(v).replace(/-/g, '')));
const errBody = (status, code, message, details) => ({ error: { code: String(code), message, ...(details ? { details } : {}) }, status });

const send = (res, httpStatus, body, { encrypted = false } = {}) => {
  if (encrypted) {
    res.writeHead(httpStatus, { 'Content-Type': 'text/plain' });
    res.end(encrypt(body));
  } else {
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  return httpStatus;
};

/**
 * The app sends runs in two layouts: nested (registrationDates{}, courseDates{}, venue{}, courseVacancy{})
 * from edit payloads, and flat (openingRegistrationDate, courseStartDate, postalCode, courseVacancy:'A')
 * from pages/api/ssg/courses/courseRuns/publish.ts. Store one canonical nested form either way.
 */
const VACANCY = { A: 'Available', F: 'Full', L: 'Limited Vacancy' };
const normalizeRun = (run) => {
  const n = { ...run };
  if (run.registrationDates || run.openingRegistrationDate !== undefined) {
    n.registrationDates = run.registrationDates || { opening: num(run.openingRegistrationDate), closing: num(run.closingRegistrationDate) };
  }
  if (run.courseDates || run.courseStartDate !== undefined) {
    n.courseDates = run.courseDates || { start: num(run.courseStartDate), end: num(run.courseEndDate) };
  }
  if (!run.scheduleInfoType && run.scheduleInfoTypeCode) {
    n.scheduleInfoType = { code: run.scheduleInfoTypeCode, description: run.scheduleInfoTypeDescription };
  }
  if (!run.venue && run.postalCode !== undefined) {
    n.venue = {
      block: run.block || '', street: run.street || '', floor: run.floor, unit: run.unit, building: run.building || '',
      postalCode: run.postalCode, room: run.room, wheelChairAccess: run.wheelChairAccess === 'yes' || run.wheelChairAccess === true,
    };
  }
  if (typeof run.courseVacancy === 'string') n.courseVacancy = { code: run.courseVacancy, description: VACANCY[run.courseVacancy] || run.courseVacancy };
  return n;
};
const normalizeSession = (s) => {
  const n = { ...s };
  if (!s.venue && s.postalCode !== undefined) {
    n.venue = { floor: s.floor, unit: s.unit, postalCode: s.postalCode, room: s.room, wheelChairAccess: s.wheelChairAccess === 'yes' || s.wheelChairAccess === true };
  }
  return n;
};
const enrolledCount = (runId) => Object.values(db.enrolments).filter((e) => e.runId === runId && e.status !== 'Cancelled').length;

const runToView = (r) => ({
  id: r.id,
  sequenceNumber: r.sequenceNumber,
  courseStartDate: num(r.courseDates?.start),
  courseEndDate: num(r.courseDates?.end),
  registrationOpeningDate: num(r.registrationDates?.opening),
  registrationClosingDate: num(r.registrationDates?.closing),
  courseDates: r.courseDates,
  registrationDates: r.registrationDates,
  scheduleInfoType: r.scheduleInfoType,
  scheduleInfo: r.scheduleInfo,
  venue: r.venue,
  intakeSize: r.intakeSize,
  threshold: r.threshold,
  registeredUserCount: enrolledCount(r.id),
  modeOfTraining: r.modeOfTraining,
  courseAdminEmail: r.courseAdminEmail,
  courseVacancy: r.courseVacancy,
  linkCourseRunTrainer: r.linkCourseRunTrainer || [],
  sessions: sessionsOf(r),
  status: r.deleted ? 'Deleted' : 'Published',
});

const sessionsOf = (r) => (r.sessions || []).filter((s) => !s.deleted).map((s) => ({
  id: s.id,
  startDate: ymd(s.startDate) || s.startDate,
  endDate: ymd(s.endDate) || ymd(s.startDate) || s.endDate,
  startTime: s.startTime || '',
  endTime: s.endTime || '',
  modeOfTraining: s.modeOfTraining,
  venue: s.venue,
}));

const enrolmentRecord = (e) => ({
  referenceNumber: e.referenceNumber,
  status: e.status,
  course: { referenceNumber: e.courseReferenceNumber, run: { id: e.runId } },
  trainee: e.trainee,
  trainingPartner: e.trainingPartner,
  fees: e.fees,
  employer: e.employer,
  createdOn: e.createdOn,
  updatedOn: e.updatedOn,
});

const now = () => new Date().toISOString();

// ── routes ───────────────────────────────────────────────────────────────────
// Each handler returns [httpStatus, body, opts] or calls nothing else.
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// ---- Course runs (plain JSON) ----
route('POST', /^\/courses\/courseRuns\/publish$/, ({ payload }) => {
  const course = payload?.course;
  const ref = course?.courseReferenceNumber;
  if (!ref || !Array.isArray(course?.runs) || !course.runs.length) {
    return [400, errBody(400, 'MOCK-400', 'courseReferenceNumber and at least one run are required', [{ field: 'course.runs', message: 'required' }])];
  }
  const out = course.runs.map((run, i) => {
    const id = String(++db.seq.run);
    const sessions = (run.sessions || []).map((s, n) => ({ ...normalizeSession(s), id: s.id || `${ref}-${id}-S${n + 1}` }));
    db.runs[id] = { ...normalizeRun(run), sessions, id, courseReferenceNumber: ref, uen: course.trainingProvider?.uen, createdOn: now() };
    return { sequenceNumber: run.sequenceNumber ?? i + 1, runId: id, message: 'Course run published (mock)' };
  });
  save();
  // No top-level `status`: handleResponse() then keeps the whole body, which is the shape
  // pages/api/external/create-course-run.ts reads (ssgResult.data.data.course.runs[0].runId).
  return [200, { data: { course: { courseReferenceNumber: ref, runs: out } }, error: {}, meta: {} }];
});

route('GET', /^\/courses\/courseRuns\/id\/([^/]+)$/, ({ m }) => {
  const r = db.runs[m[1]];
  if (!r || r.deleted) return [404, errBody(404, 'MOCK-404', `Course run ${m[1]} not found`)];
  return [200, { data: { course: { courseReferenceNumber: r.courseReferenceNumber, trainingProvider: { uen: r.uen }, run: runToView(r) } }, error: {}, status: 200 }];
});

route('GET', /^\/courses\/courseRuns\/reference$/, ({ q }) => {
  const ref = q.get('courseReferenceNumber');
  const runs = Object.values(db.runs).filter((r) => r.courseReferenceNumber === ref && !r.deleted).map(runToView);
  return [200, { data: { course: { courseReferenceNumber: ref, runs } }, error: {}, status: 200 }];
});

route('POST', /^\/courses\/courseRuns\/edit\/([^/]+)$/, ({ m, payload }) => {
  const r = db.runs[m[1]];
  if (!r || r.deleted) return [404, errBody(404, 'MOCK-404', `Course run ${m[1]} not found`)];
  const run = normalizeRun(payload?.course?.run || {});
  if (run.action === 'delete') {
    r.deleted = true;
  } else {
    for (const k of ['registrationDates', 'courseDates', 'scheduleInfoType', 'scheduleInfo', 'venue', 'intakeSize',
      'threshold', 'modeOfTraining', 'courseAdminEmail', 'courseVacancy', 'linkCourseRunTrainer', 'sequenceNumber']) {
      if (run[k] !== undefined) r[k] = run[k];
    }
    if (Array.isArray(run.sessions)) {
      r.sessions = r.sessions || [];
      for (const s of run.sessions.map(normalizeSession)) {
        if (s.action === 'delete' && s.id) { const hit = r.sessions.find((x) => x.id === s.id); if (hit) hit.deleted = true; }
        else if (s.action === 'update' && s.id) { const hit = r.sessions.find((x) => x.id === s.id); if (hit) Object.assign(hit, s); }
        else r.sessions.push({ ...s, id: s.id || `${r.courseReferenceNumber}-${r.id}-S${r.sessions.length + 1}` });
      }
    }
  }
  r.updatedOn = now();
  save();
  return [200, { data: { course: { courseReferenceNumber: r.courseReferenceNumber, run: { id: r.id } } }, error: {}, status: 200 }];
});

route('GET', /^\/courses\/runs\/([^/]+)\/sessions$/, ({ m }) => {
  const r = db.runs[m[1]];
  if (!r || r.deleted) return [404, errBody(404, 'MOCK-404', `Course run ${m[1]} not found`)];
  return [200, { data: { sessions: sessionsOf(r) }, error: {}, status: 200 }];
});

// ---- Attendance (plain JSON) ----
route('POST', /^\/courses\/runs\/([^/]+)\/sessions\/attendance$/, ({ m, payload }) => {
  const a = payload?.course?.attendance;
  const sessionId = payload?.course?.sessionID;
  if (!db.runs[m[1]]) return [404, errBody(404, 'MOCK-404', `Course run ${m[1]} not found`)];
  if (!sessionId || !a?.trainee?.id || !a?.status?.code) {
    return [400, errBody(400, 'MOCK-400', 'sessionID, trainee.id and attendance.status.code are required')];
  }
  db.attendance = db.attendance.filter((x) => !(x.runId === m[1] && x.sessionId === sessionId && x.trainee.id === a.trainee.id));
  db.attendance.push({ runId: m[1], sessionId, status: a.status, trainee: a.trainee, meta: { createdOn: now(), updatedOn: now() } });
  save();
  return [200, { data: { status: 'Success' }, error: {}, status: 200 }];
});

route('GET', /^\/courses\/runs\/([^/]+)\/sessions\/attendance$/, ({ m, q }) => {
  const sid = q.get('sessionId');
  const rows = db.attendance.filter((x) => x.runId === m[1] && (!sid || x.sessionId === sid))
    .map((x) => ({ sessionId: x.sessionId, status: x.status, trainee: { id: x.trainee.id, name: x.trainee.name, email: x.trainee.email, numberOfHours: x.trainee.numberOfHours }, meta: x.meta }));
  return [200, { data: rows, error: {}, status: 200 }];
});

// ---- Direct applications / grants (empty stubs) ----
route('POST', /^\/courses\/applications\/trainingprovider\/filter$/, () => [200, { data: { applications: [], courseApplications: [], total: 0 }, error: {}, status: 200 }]);
route('POST', /^\/tpg\/grants\/search$/, () => [200, { data: { grants: [] }, error: {}, status: 200 }]);
route('GET', /^\/tpg\/grants\/details\/([^/]+)$/, ({ m }) => [404, errBody(404, 'MOCK-404', `Grant ${m[1]} not found`)]);

// ---- Enrolments (encrypted responses) ----
const E = { encrypted: true };

route('POST', /^\/tpg\/enrolments$/, ({ payload }) => {
  const en = payload?.enrolment;
  const runId = String(en?.course?.run?.id || '');
  const trainee = en?.trainee || {};
  const missing = [];
  if (!runId) missing.push('enrolment.course.run.id');
  if (!en?.course?.referenceNumber) missing.push('enrolment.course.referenceNumber');
  if (!trainee.id) missing.push('enrolment.trainee.id');
  if (!trainee.dateOfBirth) missing.push('enrolment.trainee.dateOfBirth');
  if (!trainee.contactNumber) missing.push('enrolment.trainee.contactNumber');
  if (missing.length) {
    return [400, errBody(400, 'TGS-441', 'Required fields cannot be blank', missing.map((f) => ({ field: f, message: 'Required fields cannot be blank' }))), E];
  }
  if (!db.runs[runId] || db.runs[runId].deleted) {
    return [404, errBody(404, 'TGS-404', `Course run ${runId} not found`, [{ field: 'enrolment.course.run.id', message: 'Course run not found' }]), E];
  }
  const d = new Date();
  const referenceNumber = `ENR-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${String(++db.seq.enrol).padStart(6, '0')}`;
  db.enrolments[referenceNumber] = {
    referenceNumber, status: 'Confirmed', runId, courseReferenceNumber: en.course.referenceNumber,
    trainee, trainingPartner: en.trainingPartner, fees: en.fees, employer: en.employer, createdOn: now(), updatedOn: now(),
  };
  save();
  return [200, { data: { enrolment: { referenceNumber, status: 'Confirmed', trainee: { id: trainee.id } } }, error: {}, status: 200 }, E];
});

route('POST', /^\/tpg\/enrolments\/search$/, ({ payload }) => {
  const en = payload?.enrolment || {};
  const runId = en.course?.run?.id ? String(en.course.run.id) : null;
  const traineeId = en.trainee?.id ? String(en.trainee.id).toUpperCase() : null;
  const hits = Object.values(db.enrolments).filter((e) =>
    (!runId || e.runId === runId) && (!traineeId || String(e.trainee?.id || '').toUpperCase() === traineeId));
  if (!hits.length) return [404, errBody(404, 'TGS-404', 'No enrolment found'), E];
  return [200, { data: hits.map((e) => ({ enrolment: enrolmentRecord(e) })), error: {}, status: 200 }, E];
});

route('GET', /^\/tpg\/enrolments\/details\/([^/]+)$/, ({ m }) => {
  const e = db.enrolments[m[1]];
  if (!e) return [404, errBody(404, 'TGS-404', `Enrolment ${m[1]} not found`), E];
  return [200, { data: { enrolment: enrolmentRecord(e) }, error: {}, status: 200 }, E];
});

const mutateEnrolment = (ref, payload) => {
  const e = db.enrolments[ref];
  if (!e) return [404, errBody(404, 'TGS-404', `Enrolment ${ref} not found`), E];
  const en = payload?.enrolment || {};
  const action = String(en.action || '').toLowerCase();
  if (action === 'cancel') e.status = 'Cancelled';
  if (en.course?.run?.id) e.runId = String(en.course.run.id);
  if (en.fees) e.fees = { ...(e.fees || {}), ...en.fees };
  if (en.trainee) e.trainee = { ...(e.trainee || {}), ...en.trainee };
  e.updatedOn = now();
  save();
  return [200, { data: { enrolment: { referenceNumber: ref, status: e.status } }, error: {}, status: 200 }, E];
};
route('POST', /^\/tpg\/enrolments\/details\/([^/]+)$/, ({ m, payload }) => mutateEnrolment(m[1], payload));
route('POST', /^\/tpg\/enrolments\/feeCollections\/([^/]+)$/, ({ m, payload }) => mutateEnrolment(m[1], payload));
route('POST', /^\/tpg\/enrolments\/([^/]+)\/cancel$/, ({ m, payload }) => mutateEnrolment(m[1], { enrolment: { ...(payload?.enrolment || {}), action: 'Cancel' } }));
route('POST', /^\/tpg\/enrolments\/([^/]+)$/, ({ m, payload }) => mutateEnrolment(m[1], payload));

// ---- Assessments (plain JSON) ----
const assessmentRecord = (a) => ({ referenceNumber: a.referenceNumber, ...a.body });
route('POST', /^\/tpg\/assessments$/, ({ payload }) => {
  const d = new Date();
  const referenceNumber = `ASM-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${String(++db.seq.assess).padStart(6, '0')}`;
  db.assessments[referenceNumber] = { referenceNumber, body: { ...(payload?.assessment || {}), status: 'Pending' }, createdOn: now() };
  save();
  return [200, { data: { referenceNumber, assessment: { referenceNumber } }, error: {}, status: 200 }];
});
route('POST', /^\/tpg\/assessments\/search$/, ({ payload }) => {
  const want = payload?.assessment?.referenceNumber;
  const hits = Object.values(db.assessments).filter((a) => !want || a.referenceNumber === want);
  if (!hits.length) return [404, errBody(404, 'MOCK-404', 'No assessment found')];
  return [200, { data: hits.map((a) => ({ assessment: assessmentRecord(a) })), error: {}, status: 200 }];
});
route('GET', /^\/tpg\/assessments\/(?:details\/)?([^/]+)$/, ({ m }) => {
  const a = db.assessments[m[1]];
  if (!a) return [404, errBody(404, 'MOCK-404', `Assessment ${m[1]} not found`)];
  return [200, { data: { assessment: assessmentRecord(a), ...assessmentRecord(a) }, error: {}, status: 200 }];
});
route('POST', /^\/tpg\/assessments\/([^/]+)$/, ({ m, payload }) => {
  const a = db.assessments[m[1]];
  if (!a) return [404, errBody(404, 'MOCK-404', `Assessment ${m[1]} not found`)];
  const body = payload?.assessment || {};
  if (String(body.action || '').toLowerCase() === 'void') a.body.status = 'Voided';
  else a.body = { ...a.body, ...body };
  save();
  return [200, { data: { assessment: { referenceNumber: m[1], status: a.body.status } }, error: {}, status: 200 }];
});

// ---- Mock admin (local only) ----
route('GET', /^\/__mock\/state$/, () => [200, {
  counts: { runs: Object.keys(db.runs).length, enrolments: Object.keys(db.enrolments).length, assessments: Object.keys(db.assessments).length, attendance: db.attendance.length },
  runs: db.runs, enrolments: db.enrolments, assessments: db.assessments,
}]);
route('POST', /^\/__mock\/reset$/, () => { db = fresh(); save(); return [200, { reset: true }]; });
route('GET', /^\/__mock\/health$/, () => [200, { ok: true }]);

// ── server ───────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const started = Date.now();
    const url = new URL(req.url, 'http://mock');
    const raw = Buffer.concat(chunks).toString('utf8');
    let status = 500;
    try {
      const hit = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) {
        console.warn(`[ssg-mock] UNHANDLED ${req.method} ${url.pathname}${url.search}`);
        status = send(res, 404, errBody(404, 'MOCK-404', `Mock has no handler for ${req.method} ${url.pathname}`));
      } else {
        const payload = req.method === 'GET' ? {} : readPayload(raw);
        if (payload === null) {
          status = send(res, 400, errBody(400, 'MOCK-400', 'Request body could not be decrypted or parsed (wrong encryption key?)'));
        } else {
          const [code, body, opts] = hit.fn({ m: url.pathname.match(hit.re), q: url.searchParams, payload });
          status = send(res, code, body, opts);
        }
      }
    } catch (e) {
      console.error('[ssg-mock] handler error:', e);
      status = send(res, 500, errBody(500, 'MOCK-500', String(e && e.message || e)));
    }
    console.log(`[ssg-mock] ${req.method} ${url.pathname} -> ${status} (${Date.now() - started}ms)`);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`[ssg-mock] listening on :${PORT}, ${Object.keys(db.runs).length} runs / ${Object.keys(db.enrolments).length} enrolments loaded`));
