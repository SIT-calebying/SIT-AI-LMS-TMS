import type { NextApiRequest, NextApiResponse } from 'next';
import { requireRole } from '@lib/auth/requireRole';
import { getSSGCredentialsService } from '@lib/ssg/services/credentials-service';
import {
  createSSGDirectCourseApplicationAPI,
  type DirectCourseApplication,
} from '@lib/ssg/api/direct-course-application-api';
import { getTrainingPartnerIdentifiers } from '@lib/trainingPartnerIdentifiers';
import pool from '@lib/db';
import { collectDirectApplicationPages } from '@lib/directApplicationPagination';
import { directApplicationSyncWindow } from '@lib/directApplicationSync';

export const config = { maxDuration: 300 };

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES_PER_REQUEST = 100;

function yyyymmddToIso(value: unknown): string {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return raw;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isoDateOnly(value: unknown): string {
  if (!value) return '';
  const raw = String(value).trim();
  const datePart = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePart) return datePart[1];
  return yyyymmddToIso(raw);
}

function parseDateFilter(value: unknown): number | undefined {
  if (!value) return undefined;
  const raw = String(value).trim();
  if (/^\d{8}$/.test(raw)) return Number(raw);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);
  return undefined;
}

function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeApplication(app: DirectCourseApplication): Record<string, unknown> {
  const currentRun = app.run?.current || {};
  const course = app.course || {};
  const profile = app.profile || {};
  const fee = app.feeDetail || {};

  return {
    'Application ID': cleanString(app.applicationId),
    'Application Date': isoDateOnly(app.confirmedOn || app.createdOn || app.modifiedOn),
    'TPG Created On': cleanString(app.createdOn),
    'TPG Modified On': cleanString(app.modifiedOn),
    'Application Status': cleanString(app.applicationStatus),
    // SSG returns "Confirmed" for both paid and unpaid learners; the portal's
    // "Confirmed (Pending payment)" comes from paymentDetail.status ("Pending" /
    // "Paid"). Display only — not a da_application column, so import ignores it.
    'TPG Payment Status': cleanString((app.paymentDetail as { status?: unknown } | null | undefined)?.status),
    'Application Cancelled By': cleanString(app.cancelledBy),
    'Trainee Name': cleanString(profile.fullName),
    'Trainee ID': cleanString(profile.nric),
    'Date of Birth': yyyymmddToIso(profile.dateOfBirth),
    'Trainee Email': cleanString(profile.emailAddress),
    'Trainee Phone Country Code': cleanString(profile.countryCode),
    'Trainee Phone': cleanString(profile.contactNumber),
    'Course Run ID': cleanString(currentRun.id),
    'Course Reference Number': cleanString(course.courseReferenceNumber),
    'Course Title': cleanString(course.courseTitle),
    'Course Start Date': yyyymmddToIso(currentRun.startDate),
    'Course End Date': yyyymmddToIso(currentRun.endDate),
    'Full course fee': fee.fullCourseFee ?? '',
    GST: fee.gstAmount ?? '',
    'SkillsFuture subsidy': fee.skillsFutureSubsidyAmount ?? '',
    'SkillsFuture Credit': fee.indicatedSFCUsageAmount ?? '',
    'SF Claim ID': cleanString(app.sfcClaimId),
    'Payable Fee': fee.payableFee ?? '',
    'Highest Qualification': cleanString(profile.highestQualification?.title),
    'Highest Relevant Certification': cleanString(profile.highestRelevantCertification),
  };
}

interface RetrievalDependencies {
  credentials: () => ReturnType<ReturnType<typeof getSSGCredentialsService>['getSSGCredentials']>;
  partner: typeof getTrainingPartnerIdentifiers;
  api: typeof createSSGDirectCourseApplicationAPI;
}

/** Registration scope: every pull covers only classes starting tomorrow onward. */
export async function retrieveDirectApplications(
  filters: Record<string, unknown> = {}, options: { syncExisting?: boolean } = {},
  dependencies: RetrievalDependencies = {
    credentials: () => getSSGCredentialsService().getSSGCredentials(),
    partner: getTrainingPartnerIdentifiers, api: createSSGDirectCourseApplicationAPI,
  },
) {
    const req = { body: filters };
    const credentials = await dependencies.credentials();
    if (!credentials) {
      throw new Error('SSG credentials are not configured');
    }

    const tp = await dependencies.partner();
    const uen = cleanString(req.body?.uen) || credentials.uen || tp.uen;
    const tpCode = cleanString(req.body?.tpCode) || tp.code;
    if (!uen || !tpCode) {
      throw new Error('Missing UEN or Training Provider code');
    }

    const { tomorrow: tomorrowIso } = directApplicationSyncWindow({});
    const tomorrowYmd = Number(tomorrowIso.replace(/-/g, ''));

    // Always send lastUpdateDate explicitly; when the caller gives none, use
    // SSG's 180-day maximum. Old history cannot slip through because of the
    // run-start floor above, and rows the LMS already holds are deduped on import.
    const defaultSince = new Date(Date.now() - 180 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    const lastUpdateDate = parseDateFilter(req.body?.lastUpdateDate) ?? Number(defaultSince.replace(/-/g, ''));
    const requestedRunFrom = parseDateFilter(req.body?.runStartDateFrom);
    const runStartFrom = requestedRunFrom && requestedRunFrom > tomorrowYmd ? requestedRunFrom : tomorrowYmd;
    const runStartTo = parseDateFilter(req.body?.runStartDateTo);
    const minimumStart = yyyymmddToIso(runStartFrom);
    const maximumStart = runStartTo ? yyyymmddToIso(runStartTo) : undefined;

    const pageSizeRaw = Number(req.body?.pageSize || DEFAULT_PAGE_SIZE);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(Math.floor(pageSizeRaw), DEFAULT_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const api = dependencies.api(
      credentials.ssgApiBaseUrl || process.env.SSG_API_URL || process.env.SSG_API_BASE_URL || 'https://api.ssg-wsg.sg',
      credentials,
    );

    const requestedStatus = cleanString(req.body?.applicationStatus);
    const wantConfirmed = requestedStatus.toLowerCase() === 'confirmed';

    const baseFilter = {
      uen,
      tpCode,
      pageSize,
      sortBy: cleanString(req.body?.sortBy) || 'CourseRunStartDate',
      sortOrder: cleanString(req.body?.sortOrder).toLowerCase() === 'desc' ? 'desc' as const : 'asc' as const,
      keyword: cleanString(req.body?.keyword) || undefined,
      applicationId: cleanString(req.body?.applicationId) || undefined,
      // SSG matches this exactly, so "Confirmed" would miss "Confirmed (Pending
      // payment)" — the status Instant Confirm gives a paid course. For
      // Confirmed, ask SSG for every status and keep the enrollable ones below.
      applicationStatus: wantConfirmed ? undefined : requestedStatus || undefined,
      lastUpdateDate,
      runStartDate: {
        from: runStartFrom,
        to: runStartTo,
      },
    };

    const { applications, total, pages: pagesFetched, complete, warnings, attempts, duplicates } = await collectDirectApplicationPages(
      page => api.retrieveTrainingProviderCourseApplications({ ...baseFilter, page }), pageSize, MAX_PAGES_PER_REQUEST,
      { attempts: 3, allowIncomplete: options.syncExisting === true },
    );
    const allRows = applications.map(normalizeApplication);

    // Enforce the same registration scope if SSG ignores the date filter.
    const upcomingRows = allRows.filter((row) => {
      const start = String(row['Course Start Date'] || '');
      return /^\d{4}-\d{2}-\d{2}$/.test(start) && start >= minimumStart && (!maximumStart || start <= maximumStart);
    });
    // "Confirmed" plus its variants such as "Confirmed (Pending payment)" —
    // all enrollable per lib/da-status.ts.
    const rows = options.syncExisting ? upcomingRows : wantConfirmed
      ? upcomingRows.filter((row) => String(row['Application Status'] || '').trim().toLowerCase().startsWith('confirmed'))
      : upcomingRows;

    // Read-only: what the LMS already holds for each application, so a preview
    // can show which rows Fetch & Enrol would actually act on.
    const appIds = rows.map((row) => String(row['Application ID'] || '')).filter(Boolean);
    // "Enrolled" means the row holds an enrolment reference (ENR-… from SSG, or
    // MANUAL); auto_enrol_status is not reliable for this — most 'pending' rows
    // are already enrolled.
    const lmsStatus: Record<string, { applicationStatus: string | null; autoEnrolStatus: string | null; enrolmentId: string | null; enrolled: boolean }> = {};
    if (appIds.length > 0) {
      const existing = await pool.query(
        `SELECT application_id, application_status, auto_enrol_status, enrolment_id
           FROM da_application
          WHERE application_id = ANY($1)`,
        [appIds]
      );
      for (const r of existing.rows) {
        const enrolmentId = cleanString(r.enrolment_id) || null;
        lmsStatus[r.application_id] = {
          applicationStatus: r.application_status,
          autoEnrolStatus: r.auto_enrol_status,
          enrolmentId,
          enrolled: !!enrolmentId,
        };
      }
    }

    return {
      success: true,
      total,
      fetched: rows.length,
      skippedPastClasses: allRows.length - upcomingRows.length,
      lmsStatus,
      upcomingFrom: minimumStart,
      pages: pagesFetched,
      complete, warnings, attempts, duplicates,
      rows,
    };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  if (!await requireRole(req, res, ['admin', 'developer', 'trainingProvider'])) return;
  try {
    return res.status(200).json(await retrieveDirectApplications(req.body || {}));
  } catch (err) {
    console.error('retrieve-da-applications error:', err);
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to retrieve direct applications',
    });
  }
}
