# SIT-AI-LMS-TMS — Architecture & Interfaces Reference

Reverse-engineered architecture of the SIT-AI-LMS-TMS fork. This is the companion deep-reference to
[`../PROJECT.md`](../PROJECT.md) (overview) and [`../SIT_PATCHES.md`](../SIT_PATCHES.md) (fork diff). It documents the
**architecture**, **design**, **modules**, **internal interfaces** and **external interfaces** with source-grounded
paths, function names and env vars.

> Reading guide: line counts are from the checked-out tree (pages 91.7K, components 134K, lib 72K lines). "Verified"
> means confirmed directly from source; otherwise marked as inferred.

---

## 1. Architecture

### 1.1 Shape

A single Next.js 16 **Pages Router** application that is simultaneously a client-side SPA (React 18) and a large
REST API (619 `pages/api/*` routes). There is no separate backend service — the Next.js server executes the API
handlers, the in-process scheduler, and the SSG/SaaS client libraries in the same Node process. Data lives in
**PostgreSQL 17** (local or Supabase; SSL when prod/Supabase) behind a `pg` connection pool.

```
┌──────────── Browser SPA (React, Tailwind) ────────────┐
│  LmsContext (auth/user/mode) → components/ portals     │
│  lib/clientAuthFetch.ts attaches `Authorization: Bearer lms_…`  │
└───────────────────────┬────────────────────────────────┘
                        │ HTTPS
┌───────────────────────▼────────────────────────────────┐
│                Next.js server (one process)             │
│  pages/api/*  ── withAuth / withServiceAuth guards ──►  │
│        lib/auth (sessions, roles, service keys)         │
│  lib/scheduler  (node-cron, DB-driven, single-flight)   │  ──► /api/external/* (direct or HTTPS)
│  instrumentation.ts (boot: android reminders, Gmail warm-up, table ensures) │
│  lib/ssg, lib/tpg, lib/google-*, lib/quickbooks, …      │
└───────────────────────┬────────────────────────────────┘
                        │ pg
              ┌─────────▼──────────┐
              │   PostgreSQL 17    │
              └────────────────────┘
```

### 1.2 Request lifecycle (authenticated route)

1. Browser `fetch` is globally wrapped by `lib/clientAuthFetch.installAuthFetch()` (installed once in `_app.tsx`):
   a Bearer token from `localStorage['auth_token']` is added to every same-origin `/api/*` call; a `401` clears
   `auth_token`/`user_data` and redirects to `/` (auth endpoints are exempt to avoid a redirect loop).
2. Handlers are wrapped by `withAuth(handler, {roles})` (or `withServiceAuth` for machine-only routes):
   `cors()` preflight → `getAuthedUser(req)` → `401` if no session/key → `403` if the role set doesn't include a
   granted role → `req.authUser` attached → handler runs.
3. `getAuthedUser` checks the machine `x-api-key` first (a service caller gets every role, `isService:true`); otherwise
   it looks up the Bearer token's **SHA-256 hash** in `user_session` (expiry + `account_status='active'`), refreshes
   `last_used_at` at most every 15 min, then loads the user's roles from `user_role_map`.
4. Several narrow routes add a second guard layer: `requireCourseRunTrainer` (trainer may only touch an **assigned**
   class), `requireSelfTrainer` (trainer may only read their own rows).

### 1.3 Build-time auth guardrail

`scripts/check-api-auth.js` runs inside `npm run lint` and `npm run build`. It walks every `pages/api/*.ts`, skips the
explicit `PUBLIC` allowlist (~24 routes, each with a commented justification) and `public/` prefixes, and greps for an
`AUTH_MARKER` (`withAuth|withServiceAuth|requireRole|getAuthedUser|isServiceRequest|x-api-key`). Any route without one
fails the build. Net effect: **new unauth'd routes are structurally impossible to ship accidentally.**

---

## 2. Design principles

| Invariant | Evidence |
|---|---|
| **Route is the only trusted boundary** | `check-api-auth.js`; every handler wrapped in a guard |
| **Persistence is the source of truth; scheduler is a thin driver** | `lib/scheduler/scheduler.ts` — `scheduler_config` rows → cron → authenticated exec |
| **SSG is the system of record for the compliance domain** | Mirror + reconcile (`ssg_*` tables; many `sync-*`, `reconcile-*`, `backfill-*` jobs) |
| **External agents stay outside the app** | OpenClaw/Hermes chatbot over WhatsApp/Telegram, driving `/api/external/*`; `lib/trainerWhatsapp.ts`, `lib/trainerInvitationSender.ts` |
| **Multi-tenancy by config, not fork** | `training_provider` row gates flags/credentials/rates/branding |
| **Idempotent, single-flight automation** | globalThis in-process lock + `pg_try_advisory_lock` (cross-replica) |
| **Cryptography is a fixed SSG scheme** | AES-256-CBC/PKCS7, fixed IV `'SSGAPIInitVector'`, base64 32-byte key |

---

## 3. Modules

### 3.1 `lib/` module map (289 files) — reverse-engineered inventory

| Module | Responsibility | Key exports / files |
|---|---|---|
| `lib/auth/` | Authentication & authorization | `withAuth`, `withServiceAuth`, `requireRole`, `getAuthedUser`, `normalizeRole` (`requireRole.ts`); `createSession`, `revokeSession`, `revokeAllSessions`, `hashSessionToken`, `pruneExpiredSessions` (`session.ts`); `isServiceRequest` (`serviceKey.ts`); `requireCourseRunTrainer`, `isAssignedTrainer`, `isStaff`, `requireSelfTrainer` (`courseRunAccess.ts`); `authHeader()` |
| `lib/scheduler/` | In-process node-cron scheduler | `initScheduler`, `scheduleTask`, `executeTask`, `getSchedulerTasks`, `updateTaskSchedule`, `runTaskNow` (`scheduler.ts`) |
| `lib/ssg/` | SkillsFuture/TPGateway client (real, not stubbed) | Barrel `index.ts`; `api/{course,enrolment,assessment,attendance,direct-course-application}-api.ts`; `models/*`; `services/{credentials,encryption,enrolment,stub-credentials}-service.ts`; `utils/{cryptography,encryption-service,http-utils,validators,attendance-decrypt,sync-enrolment-to-db}.ts`; top-level `push*`, `reconcileEnrolmentIds.ts`, `syncRunSessions.ts` |
| `lib/tpg/` | TPGateway job orchestration | `grantFetchJobStore.ts`, `fetchGrantDisbursements.ts`, `confirmApplications.ts`, `jobStore.ts` |
| `lib/ai/` | AI provider layer (LLM credentials + selection) | `schema.ts`, `login.ts` (provider OAuth login), `settings.ts`, `claude.ts`, `codex.ts`, `credentials.ts`, `query.ts`, `models.ts`, `document.ts`, `claude-login.ts` |
| `lib/cw-slides-v2/` `lib/cw-slides-v3/` | Two generations of AI courseware slide-gen pipelines | `index.ts`, `orchestrator.ts`, `phase1_research.ts`, `phase2_content.ts`, `phase3_editor.ts`, `phase4_infographic.ts`, `phase5_assembly.ts`, `prompts.ts`, `pptx_builder.ts`, `wikipedia_research.ts`, `types.ts`, `duration.ts` |
| `lib/courseImage/` | AI course-banner generation (Cloudflare R2) | `template.ts`, `renderer.ts` (via `lib/r2.ts`) |
| `lib/google-auth/` `lib/google-calendar/` `lib/google-drive/` | Google OAuth, Calendar, Drive | `googleAuth.ts`; `ca-calendar-sync.ts`, `da-calendar-sync.ts`; `drive-helpers.ts`, `profile-image-helpers.ts`, `assessmentRecordFolder.ts`, `submissionFolder.ts`; `googleOauthRenew.ts` |
| `lib/zoom/` | Zoom OAuth client + meetings | `client.ts` |
| `lib/virtual-meetings/` | Provider abstraction (Google Meet / Zoom / Teams) | `zoom-meeting-service.ts` |
| `lib/quickbooks/` | QuickBooks Online invoice generation + QBO proxy | `qbProxyClient.ts`, `createDirectApplicationInvoice.ts`, `createCompanyApplicationInvoice.ts`, `createTrainerBill.ts`, `qboRedirect.ts`, `resolveCustomerRef.ts`, `invoiceOwnership.ts`, `grantInvoiceCreationLock.ts` |
| `lib/payroll/` | Trainer payout tiers, bills, payouts | `featureFlag.ts`, `calculate.ts`, `trainerBill.ts`, `billNo.ts`, `resolveTrainer.ts`, `requireEnabled.ts`, `ensure*Table.ts` |
| `lib/billing/` | Billing canonical refs | `canonicalEnrolmentRef.ts` |
| `lib/mobile/` / `lib/android/` | Native iOS/Android companions | `mobile/{schema,data,apns,reminders}.ts`; `android/{schema,data,dates,reminders,auth}.ts` |
| `lib/microsoft-redeem/` | Microsoft Reward redeem codes | `constants.ts`, `login.ts`, `courses.ts`, `generate.ts`, `db.ts` |
| `lib/calendar/` | Class↔Google Calendar reconciliation | `calendarClient.ts`, `ensureClassCalendarEvent.ts`, `addTrainerToCalendar.ts`, `confirmTrainerOnCalendar.ts`, `reconcileRunCalendar.ts`, `runAttendees.ts`, `attendeeDiffs.ts`, `eventMatch.ts`, `trainerAcknowledgement.ts`, `triggerClassCalendarSync.ts` |
| `lib/assessment/` | Assessor sign-off, ASR e-signing, Pages→PDF | `assessorStamp.ts`, `summaryRecordStamp.ts`, `summaryRecord.ts`, `signSubmissions.ts`, `pagesToPdf.ts`, `pagesIwa.ts`, `odtStamp.ts`, `pdfjsNodePolyfill.ts` |
| `lib/trainers/` | Trainer collection/rows | `collectRunTrainers.ts`, `taggedTrainers.ts`, `adminTrainerRow.ts` |
| `lib/learner/` | Learner portal logic | `selfEnrolment.ts`, `welcomeSigninEmailTemplate.ts` |
| `lib/services/` | Business-logic services | `authService.ts` (client), `courseService.ts`, `courseApiService.ts`, `certificateService.ts`, `certificateIssuance.ts`, `proformaInvoiceService.ts`, `emailService.ts`, `billingSync.ts`, `qboInvoiceService.ts`, `invoiceJobs.ts`/`invoiceJobProcessor.ts`/`invoiceJobsRunner.ts`, `n8nWebhookService.ts`, `trainingProviderService.ts`, `claimUploadService.ts`, `tpgStatusRefresh.ts`, `acraEntityLookup.ts`, `apiClient.ts`, `geminiService.ts`, `sfciteImport/*`, `grantImport/*`, `reconcileEnrolmentCancellations.ts`, `missingGrantSync.ts`, `frontend`… |
| `lib/` top-level (domains) | Direct-application + ops helpers | `directApplicationAutomation.ts`, `directApplicationEmailIngest.ts`, `directApplicationSync.ts`, `autoEnrolDirectApplications.ts`, `companyApplicationsTable.ts`, `trainerInvitationSender.ts`, `trainerInvitations.ts`, `trainerWhatsapp.ts`, `courseCode.ts`, `courseChangeLog.ts`, `courseRenewalStatus.ts`, `wsqScheduleSync.ts`, `grantEligibility.ts`, `sanitiseHelpers.ts`, `gmailOauthSend.ts`, `smtp.ts`, `r2.ts`, `supabaseClient.ts`, `chromium-launch.ts`, `cors.ts`, `config.ts`, `db.ts` |
| `lib/utils/` | Small shared helpers | `id-type.ts`, `dateOnly.ts`, `tmsInvoiceNo.ts`, `courseCodes.ts`, `sanitizeGoogleLink.ts` |

### 3.2 `pages/api/` domain map (619 routes)

| Prefix | Coarse surface | Notes |
|---|---|---|
| `auth/` | login, verify, logout, send-otp, forgot/update-password, self-register, oauth-sync, admin-reset, check-refresh | Public login/OTP/forgot paths are allowlisted |
| `admin/` | ~140 ops: course-run CRUD, trainer/learner mgmt, TPG confirm, WSQ schedule sync, certificates, automation triggers + logs, DA/CA management, scheduler, sanctions | Staff-only; many are "run/trigger" entry points for in-process jobs |
| `external/` | ~79 machine-authenticated endpoints (`auto-*`, `sync-*`, `reconcile-*`, `backfill-*`, `run-*`) | Guard: `withServiceAuth` (`x-api-key`); used by scheduler, n8n, OpenClaw/Hermes |
| `training-provider/` | TP portal: users/roles, webhooks, email templates, claims, finance, company settings, SSG default app | TP-scoped |
| `finance/` | grant-fetch, invoice jobs, automation, proforma, TPG status refresh | Finance ops |
| `trainer/` | attendance, grading, TRAQOM, announcements, assessor signature, class roster | Trainer-scoped (`requireCourseRunTrainer`) |
| `ssg/` | SSG proxies: encrypt/decrypt, courses, courseRuns, sessions, attendance, cert-check, training-providers | Wraps `lib/ssg` |
| `courses/`, `course-runs/`, `course/` | Course CRUD, learning units, quizzes, assessments, developer portal | — |
| `enrolment/`, `enrolments/`, `enrollments/` | Create/update/cancel/bulk, SSG post-enrol | — |
| `assessments/`, `grading/`, `submissions/` | Publish, submit, grade, SSG assessment CRUD | — |
| `quickbooks/` | QBO OAuth connect/callback + proxy | — |
| `integrations/` | Google OAuth, Zoom OAuth/status/test, Gmail/SMTP test | — |
| `mobile/`, `android/` | Native companion backends (auth, dashboard, device, reminders) | — |
| `payroll/`, `billing/`, `sf-credits/`, `grant-import/`, `sfc-import/` | Payouts, billing history/proforma, claims, bulk imports | — |
| `certificates/`, `feedback-form/`, `bookmarks/`, `completions/`, `progress/` | Cert issuance, public feedback, learner progress | — |
| `ai/`, `config/`, `developer/` | AI chat/generate/provider config; developer courseware (cw-*, cp-*) | — |
| `webhooks/[token].ts`, `uploads/[...path].ts`, `files/download.ts`, `download/[...path].ts` | Tokenised webhook entry; file serving | Public with justification |

### 3.3 `components/` (241 files) — role portals + shared UI

| Directory | Contents |
|---|---|
| `components/admin/` | Admin portal (61 files): `AdminSidebar`, `AdminCalendarView`/`InAppCalendar`/`GoogleCalendarEmbed`, `ClassDetailView`, `ClassManagementViews`, `CreateNewClassView`, `EditCourseRunView`, `EnrollLearners`, `ViewTrainers`/`ViewLearners`, `OngoingClasses`/`CompletedClasses`/`AttendanceChecker`, `SchedulerView`/`SchedulerSummaryView`, `GrantManagementViews`, `CompanyApplicationViews`/`DirectApplicationViews`, `BulkEnrolmentViews`/`BulkAssessmentEditor`, `CertificateManagement`/`SendCertificateSG`/`SendCertificateGH`/`MicrosoftCertificate`, `FundingValidityView`, `FeedbackFormBuilder`/`ResponsesView`, `SupportTicketsView`/`SigninRequestsView`, `RescheduleCancelView`/`SessionRescheduleModal`/`MoveClassModal`, `WsqScheduleSyncView`, `DuplicateCourseRunsView`, `MasterListView`, `CourseImageGeneratorView`, `SearchTrainers`/`SearchPastLearners`/`AddTrainerForm`/`BulkUploadTrainersView`, `BulkUploadCoursesView`, `UpsertFromSsgModal`, `SoftwareCredentialsView`, `SyncedEnrolmentsView`, `CheckSupportingDocumentView`, `ViewClassByDateView` |
| `components/trainer/` | Trainer portal (37 files): `TrainerSidebar`, `TrainerMyClasses`, `TrainerAttendanceDashboard`, `TrainerPayoutTable`, `AssessmentGrading`, `AssessmentSummarySection`, `AssessorSignatureForm`/`SignaturePad`, `PastAttendance`/`PastAssessment`, `VirtualMeetingLinkEditor`, `TrainingHoursPage`, guides pages, `PaymentHistoryPage`, + **19 Tools card pages** |
| `components/training-provider/` | TP portal (26 files): sidebars, `DocumentsView`, `FinanceManagementView`, `AdminManagementView`/`UserManagementView`, `WebhooksView`, `ApiEndpointsView`, `SsgApiSummaryView`, `ClaimCheckView` + ~13 email-template views (OTP, Certificate, Feedback, Welcome, TrainerInvitation, CourseConfirmation, …) |
| `components/developer/` | Developer portal (19 files): `DeveloperSidebar`, Course-Profile (`cp-generator/`) + Courseware (`courseware-generator/`) generators, `CwGeneratorView`, `CpGeneratorView`, `CoursewareToolsView`, `SeoGeneratorView`, `CourseChangeControlView`, `ExpiredCourseListView` |
| `components/finance/` | Finance portal (28 files): `FinanceSearchPalette`, `SsgAppSelector`, QuickBooks views (`QBInvoiceView`, `QBPaymentView`, `QBCustomerView`, `QBEstimateView`), Bizfile views (7), claims/grants views (`ViewClaimView`, `GrantImportView`, `GrantCalculatorView`, `AllCourseRunsView`, …), `automation/` subfolder |
| `components/payroll/` | Payroll portal (8 files): `PayoutListView`, `BillListView`, `PayrollSettingsView`, `TrainerPayoutHistory`, `PayoutEditDialog`, `ManualClassDialog`, `TrainerPicker`, `shared` |
| **no `components/learner/` dir** | Learner views are composed in `layouts/LearnerLayout.tsx` from **top-level** components (`CourseList`, `MyCalendarView`, `ProfilePage`, `HelpAndSupportView`, `LearnerGrantCalculatorView`, `BillingHistoryView`, `CertificateHistoryView`) and re-use the **trainer** tools pages |
| `components/ssg/` | SSG API views |
| `components/ui/` | Shared primitives. ⚠️ Two icon sources: `Icon.tsx` has a real `IconName` enum with **70+ SVGs**; `index.tsx` re-exports a *simplified* `Button`/`Card`/`Icon`(5)/`Spinner`/`Switch`/`Input`/`Checkbox`/`SearchableSelect`/`Select`. Also `Badge`, `Alert`, `Tabs`, `Toast`, `EmptyState`, `HelpTip`, `ManualDateInput`, `DateRangeCell`, `CourseImage`, `ProcessingOverlay` |
| `components/common/` | `LearnerProfileCard`, `AdminProfileCard` |
| Top-level shared | `Header.tsx` (with **RoleSwitcher** → `switchRole`), `Footer.tsx`, `LoginScreen.tsx`, `NavBox`/`ToolsMenu.tsx`, `AiChatbot.tsx` + `chatTemplates.ts`, `toolsData.ts`, `CourseList`/`CourseDetail`/`CourseEditor`, `CalendarView`/`MyCalendarView`, `QuizGenerator`, `GradingView`, `HelpAndSupportView`, `BillingHistoryView`, `CertificateHistoryView`, profile cards, dashboards |

**SPA navigation (verified).** `pages/index.tsx` is the single shell: `isLoading`→Spinner, `!isAuthenticated`→`LoginScreen`, else a `if (role === UserRole.X) return <XxxLayout />` chain over the 7 layouts (`layouts/{Learner,Trainer,Developer,Admin,Finance,Payroll,TrainingProvider}Layout.tsx`). **No file-based routing** — view switching is LmsContext state synced to URL query params (`?view=`, `?adminPage=`, `?trainerPage=`, `?courseId=`, `?courseRunId=`); the provider listens to `router.events('routeChangeComplete')` to re-hydrate from the URL (back/forward works), and uses shallow pushes (with a Next 16 same-URL guard). Role display names/emoji live in `Header.tsx.getRoleDisplayName` and `LoginScreen.tsx`.

Client state lives in `contexts/LmsContext.tsx` (`LmsProvider` wraps `_app.tsx`; `useLms()` throws outside provider). Exposes: auth (`isAuthenticated`, `isLoading`, `currentUser`, `login`, `logout`), roles (`role`, `userRoles`, `switchRole`), navigation (`currentView`/`adminPage`/`trainerPage`/`developerPage` + setters, `handleNavigation`), drill-down (`selectedCourse`, `editingCourse`, `courseEditMode`, `editingCourseRun`, `selectedCourseRunId`, class-flow return state), company (`trainingProviderProfile`, `ssgApp`, `financePage` persisted to `localStorage['lms.financePage']`), course learning data (`courses`, `learningUnits`, `courseAssessments`, bookmarks/completions, `submissions`, `certificate`), chat (`isChatOpen`, `resetInAppChat`). On mount it initialises the colour scheme, reads the SSG default app, does an auth check (with 10s safety timeout), restores state from the URL, polls every 60s (for newly-published assessments), and handles focus/`visibilitychange`.

Custom hooks (barrel `hooks/index.ts` **re-exports only `useDeveloperCourses`**; the rest are standalone `@hooks/` files): `useCourses`, `useProfile`, `useTrainerCourses`, `useAppVersion`, `useCourseValidityFeature`, `useScheduleChangeConfirm.tsx` (step-confirm modal w/ per-step sync/notify toggles), `useSessionReschedule.ts` (SSG + Google-Calendar reschedule orchestration), `useTrainerProfile`.

`components/toolsData.ts` is the shared trainer/learner tool catalogue (data-only): ~19 ordered `TOOL_GROUPS` (edTools, projectMgt, sixSigma, cyberSecurity, networking, finance, hr, dataAnalytics, ml, stat, doe, spc, sustainability, k8s, blockchain, quantum, design, genAi, agenticAi, virtual), with `GENAI_LINK_GROUPS`/`AGENTIC_AI_GROUPS` nested. Consumed by `ToolsMenu.tsx` and the learner/trainer layouts (learner mirrors the full trainer catalogue when `currentView === View.Tools`).

---

## 4. Internal interfaces

### 4.1 Session & auth (verified, `lib/auth/`)

```ts
// lib/auth/session.ts
export const SESSION_TOKEN_PREFIX = 'lms_';            // raw = 'lms_' + 32 bytes hex
export function hashSessionToken(rawToken: string): string; // sha256 hex; ONLY the hash is stored in user_session
export async function createSession(userId: string): Promise<string>; // inserts, TTL 30 days
export async function revokeSession(rawToken: string): Promise<void>;
export async function revokeAllSessions(userId: string): Promise<void>;
export function pruneExpiredSessions(): void;          // delete expired >7d, fire-and-forget

// lib/auth/withAuth.ts
export function withAuth(handler, opts?{roles?: string[]}): NextApiHandler;   // CORS→auth→role→req.authUser
export function withServiceAuth(handler): NextApiHandler;                      // machine key only
// lib/auth/requireRole.ts
export interface AuthedUser { id: string; roles: Set<string>; isService?: boolean }
export function normalizeRole(dbRole: string): string;  // 'Training Provider'->'trainingProvider', else lowercase
export async function getAuthedUser(req): Promise<AuthedUser | null>;
export async function requireRole(req,res,allowed): Promise<AuthedUser | null>; // writes 401/403, returns null on fail
// lib/auth/serviceKey.ts
export function isServiceRequest(req): boolean;         // x-api-key | ?authKey|?key | body.authKey, timing-safe
// lib/auth/courseRunAccess.ts
export function isStaff(user): boolean;                 // service or any role outside {trainer,learner}
export async function isAssignedTrainer(userId, courseRunId): Promise<boolean>; // junction + legacy cols, by id OR email
export async function requireCourseRunTrainer(user,res,courseRunId): Promise<boolean>; // 403 if not assigned
export async function requireSelfTrainer(user,res,requested): Promise<boolean>;
```

Roles (DB `user_role_map`), normalized: `learner`, `trainer`, `developer`, `admin`, `finance`, `payroll`,
`trainingprovider`→`trainingProvider`. A user with no role defaults to `learner`. `Payroll` is filtered out unless
`lib/payroll/featureFlag.isPayrollEnabled()` is true.

### 4.2 Scheduler (verified, `lib/scheduler/scheduler.ts`)

- Boot: `instrumentation.ts` `register()` (Node runtime) → if `ENABLE_APP_SCHEDULER==='true'` or
  (`NODE_ENV==='production'` and not explicitly `'false'`) → `startAndroidReminderScheduler()` + `initScheduler()`.
- Config lives in **`scheduler_config`** (id, name, cron_expression, enabled, api_endpoint, email_template,
  days_in_advance, last_run_at, last_status). ~30 default tasks `seedDefaults()` upserts per boot; unknown ids pruned.
- Dispatch: `executeTask(task)` first tries a **direct in-process handler** (`directHandlers` map, lazy-imported, no
  HTTP/metrics/auth needed); fallback POSTs the `api_endpoint` over HTTP with `x-api-key: EXTERNAL_API_KEY_FOR_CLAWDBOT`.
- **Single-flight:** globalThis `inFlight` Set (same-process) **and** `pg_try_advisory_lock(hash(task.id))`
  (cross-replica). Times are `Asia/Singapore` (SGT).
- Admin surface: `pages/api/admin/scheduler.ts` + `getSchedulerTasks/updateTaskSchedule/runTaskNow/reloadTask`.

Representative default jobs (cron, SGT): DA automation (multiple daily, off by default), `*/5` mobile reminders,
`0 14` auto-create-assessment-records, `0 18` auto-create-learners, `0 1/18` date+attendance syncs, `30 18`
auto-create-certificates, `0 9/10 + days_in_advance` confirm emails, `0 2` upcoming TGS enrolments/trainers + WSQ
schedule push (off), `0 3` trainer→TPG, `0 2` calendar + trainers, `0 7` courseware/attendance email, `0 10 Mon/Thu`
trainer invitations, `30 12` WhatsApp class reminders, `*/3h` SSG enrolments, `*/30*` missing grants + TPG status,
`0 5` cancellation reconcile, `0 2 Sun` PII sanitise, `0 4` proforma invoices, `0 3` MailerLite, `0 8` funding renewal.

### 4.3 Data layer (verified, `lib/db.ts`)

- Single `pg` Pool from `DATABASE_URL`; `ssl: {rejectUnauthorized:false}` when prod or Supabase.
- Idempotent **auto-migrations run on every startup** (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT
  EXISTS` in `lib/db.ts`): `da_application` invoice cols, `training_provider` cert/label cols,
  `course_run_calendar_event`, `user_session`, `trainer_assessor_signature`, `learner_signature`,
  `assessment_summary_record`; plus `instrumentation.ts` ensures `cp_prompt_template` and `course_announcement`.
- Explicit migrations live in `database/migrations/` (run via `npm run db:migrate`, `scripts/migrate.js`).
- Anti-churn tuning: `idleTimeoutMillis: 60_000`, `keepAlive: true`, `keepAliveInitialDelayMillis: 10_000` — comments
  document a real incident where 10s idle + no keepalive churned physical connections and dropped connections across
  the Docker NAT.

### 4.4 Shared component & hooks interfaces

`components/ui/index.tsx` exports typed primitives (Button, Card, Icon, Spinner, Switch, Input, Checkbox,
SearchableSelect, Select). `hooks/index.ts` re-exports custom hooks. Components import via `@components/*`, `@hooks/*`,
`@lib/*`, `@contexts/*`, `@app-types`, `@styles/*`, `@utils/*` aliases (defined in both `tsconfig.json` paths and
Turbopack/webpack `resolveAlias`).

---

## 5. External interfaces

### 5.1 SkillsFuture SSG / TPGateway (verified)

- **Base URL:** `training_provider.ssg_api_base_url` → `SSG_API_BASE_URL` → `SSG_API_URL` → default
  `https://api.ssg-wsg.sg`. App4 (OAuth) uses `https://public-api.ssg-wsg.sg`.
- **Credentials** (`lib/ssg/services/credentials-service.ts`): per-tenant from the `training_provider` row across
  four "apps" — **App1** (`ssg_app1_cert_file`/`_private_key`/`_encryption_key`), **App2** (default, self-signed
  `ssg_self_sign_cert_file`/`_private_key`/`ssg_encryption_key`), **App3**, and **App4** (OAuth2 `ssg_app4_client_id`/
  `_secret`). PEM resolution: DB file path → HTTP (served by Next) → local disk → env (`CERT_VALUE`, `CERT_1_CERT`,
  `SSG_CERT_PATH`, `PRIVATE_KEY_VALUE`, `SSG_PRIVATE_KEY_PATH`), with `resolvePem` normalising base64/literal-`\n`/
  CRLF. Encryption key must base64-decode to **32 bytes** (AES-256).
- **Wire protocol:** AES-256-CBC/PKCS7, **fixed IV `'SSGAPIInitVector'`**, payload `JSON → encryptJSON(key) → base64`,
  mTLS (cert/key supplied per request via `HTTPRequestBuilder.withEndpoint(...).withCert(...).withKey(...)`),
  `accept`/`Content-Type: application/json`, 30s timeout. Helper signing via `CryptoUtils.sha256/hmacSha256`.
- **Client surface (typed):** `SSGCourseAPI`, `SSGEnrolmentAPI`, `SSGAssessmentAPI`, `SSGAttendanceAPI`,
  `DirectCourseApplicationAPI`, 30+ enums (`SponsorshipType`, `Grade`, `AttendanceStatus`, `ModeOfTraining`,
  `EnrolmentStatus`, `AssessmentResult`, `SSG_ENDPOINTS`, …). `lib/ssg/api/*.ts` + `lib/ssg/models/*`.
- **Behavioural posture:** the LMS mirrors SSG into `ssg_course_runs`, `ssg_enrolments`, `ssg_enrolment_record`,
  `ssg_grants`, `ssg_claims` and reconciles bi-directionally (trainer→TPG push, enrolment-ID backfill, cancellation
  reconcile, WSQ schedule push). Missing key ⇒ `encryption-service` throws / `credentials-service` returns `null`.
- **Proxy routes:** `pages/api/ssg/*` (encrypt/decrypt, courses, courseRuns, sessions, attendance, cert-check,
  training-providers) + many `ssg-*` under `assessments/`, `admin/`, `enrolments/`.

### 5.2 Google (OAuth, Calendar, Drive, Gmail)

- **Auth:** `lib/google-auth/googleAuth.ts`, `pages/api/integrations/google/oauth-{start,callback}.ts` (single-use state
  nonce). Client id/secret/refresh token stored on `training_provider`. Cached via `lib/googleOauthRenew.ts`; Gmail OAuth
  warmed up at boot in `instrumentation.ts` so the first OTP after deploy is fast.
- **Calendar:** `lib/calendar/*` — `ensureClassCalendarEvent`, `addTrainerToCalendar`, `confirmTrainerOnCalendar`,
  `reconcileRunCalendar`, `runAttendees`, `attendeeDiffs`. `[VIRTUAL]`-titled events map to course runs (set
  `class_type=Virtual`, store Meet link). `course_run_calendar_event` table maps run×session→Google event id.
  `sync-google-calendar`, `auto-add-today-enrolments-to-calendar`, `sync-trainers-to-calendar` jobs.
- **Drive:** `lib/google-drive/*` — `drive-helpers` (incl. `autoShareLearnerMaterials`), `profile-image-helpers`,
  `assessmentRecordFolder`, `submissionFolder`; invoice snapshot upload (`lib/services/invoiceDriveUpload.ts`).
  Routes `upload/*`, `google-drive/image`, `files/download.ts`, `download/*`.

### 5.3 Zoom + virtual meetings

- **Zoom:** OAuth (`pages/api/integrations/zoom/oauth/{connect,callback}.ts`, status/test workshops), credentials on
  `training_provider` (`zoom_oauth_*`, `zoom_account_id/user_id/email`, `zoom_enabled`). `lib/zoom/client.ts`.
- **Abstraction:** `training_provider.virtual_meeting_provider` ∈ {google_meet, zoom, teams}; course-run meeting links
  override the company default; `lib/virtual-meetings/zoom-meeting-service.ts`, `pages/api/virtual-meetings/create.ts`.

### 5.4 QuickBooks Online

- OAuth2: `pages/api/quickbooks/oauth/{connect,callback}.ts`, `lib/quickbooks/qboRedirect.ts`;
  `pages/api/internal/sync-qb-token.ts`.
- `lib/quickbooks/qbProxyClient.ts` + `pages/api/quickbooks/proxy.ts`: proxy query/create/send/delete/void/pdf/read
  over estimates, invoices, payments. Invoice generation services: `createDirectApplicationInvoice`,
  `createCompanyApplicationInvoice`, `createTrainerBill`, `invoiceOwnership`, `resolveCustomerRef`,
  `grantInvoiceCreationLock.ts` (single-flight against dupe invoices). Email policy via
  `lib/services/qboInvoiceEmailPolicy.ts`.

### 5.5 Bizfile / ACRA

`pages/api/bizfile/query.ts`, `lib/services/acraEntityLookup.ts` — company profile, key dates, address, SSIC,
shareholders.

### 5.6 Email & notifications

- `lib/services/emailService.ts`: dual-transport failover — SMTP toggle (`lib/smtp.ts`, credentials from the company
  setting row, **no Coolify `SMTP_*` env** consulted) primary vs Gmail OAuth (`lib/gmailOauthSend.ts`) primary depending
  on the toggle; falls back to the other. Types: `{success, error?, messageId?, via: 'smtp'|'gmail'}`.
- Senders: OTP, welcome/self-registration, course confirmation, trainer invitations (accept/decline), certificates,
  feedback compilations, proforma/invoices, payment reminders — template-driven (email_template/id columns on
  `training_provider`).
- WhatsApp: external OpenClaw WhatsApp agent pulls a **rate-gated queue** (`lib/trainerWhatsapp.ts`) — invitation/reminder
  nudges (≤5/day, 10–13 SGT) and class reminders (≤7/day, 13–17 SGT), ≥15 min apart, acceptance rechecked before release.
- MailerLite: `sync-learners-to-mailerlite` daily (gov.sg always excluded); `sync_learners_to_mailerlite_log`.

### 5.7 Webhooks & external automation

- Tokenised in route `pages/api/webhooks/[token].ts` (unguessable `endpoint_token`); webhook config/
  logs in `lib/trainingProviderService.ts`, `pages/api/training-provider/webhooks.ts` / `webhook-logs.ts`;
  `webhooks` + `webhook_logs` tables. Log every delivery for debugging.
- **External-agent surface (OpenClaw/Hermes + n8n):** `pages/api/external/*` (~79) guarded by `withServiceAuth`
  (`x-api-key: EXTERNAL_API_KEY_FOR_CLAWDBOT` / `SCHEDULER_SECRET`). These are the machine contract: e.g.
  `assign-trainer`, `unassign-trainer`, `get-course-run`, `list-course-runs`, `auto-create-learners`,
  `sync-course-run-dates`, `wsq-submit-runs`, `wsq-schedule-gap`, plus the `auto-*` (cron) endpoints. n8n webhook
  service: `lib/services/n8nWebhookService.ts`.
- **Chat launcher** (`components/AiChatbot.tsx` + `chatTemplates.ts`): floating WhatsApp/Telegram widget, two
  role-scoped variants (ops vs trainer), ~44 fill-in-the-blank templates whose field names mirror the agent's tools and
  `/api/external/*` params. Chat is an EXTERNAL agent (OpenClaw/Hermes), not in-process.

### 5.8 AI / LLM providers

- Per-tenant selection via `pages/api/config/ai-provider.ts`, `pages/api/config/gemini-key.ts`; `lib/ai/{settings,
  credentials,models,query,claude,codex,login,claude-login}.ts`. Providers: Claude (Agent SDK, `claude-opus-5`),
  OpenAI (Codex SDK `gpt-5.6-sol`), Anthropic, Google Gemini, plus MiniMax/Kimi/DeepSeek/Groq. Credentials encrypted at
  rest (per README). Provider OAuth login flow (`lib/ai/login.ts`).
- Endpoints: `pages/api/ai/{chat,generate,provider}.ts`. Uses: SEO metadata, quiz gen, courseware
  (`lib/cw-slides-v2/v3`, `lib/cw-brochure.ts`, `lib/cw-lesson-plan.ts`, `lib/cp-*`), course images (`lib/courseImage` +
  `lib/r2.ts`), doc-grounded content (`lib/ai/document.ts`).

### 5.9 Native companion apps

- iOS/Android both call `pages/api/mobile/*` (iOS: dashboard, auth OTP, device, reminders, APNs in `lib/mobile/apns.ts`
  + `reminders.ts`) and `pages/api/android/*` (OTP, dashboard, device, `lib/android/*`; class reminders optional 3-day/
  1-day Firebase). `MOBILE_APNS_ENABLED` gates iOS reminder scheduler; `ENABLE_APP_SCHEDULER` off in dev because shared
  DBs could fire prod-style APNs.

### 5.10 File storage & CDN

- Cloudflare R2 for generated course images (`lib/r2.ts`); Google Drive for class/courseware/certificate/invoice files;
  local `public/uploads/**` for attachments (served via `/uploads/*` → `/api/uploads/*` rewrite). `next.config.js`
  `outputFileTracingIncludes` pins Claude/Codex SDK and pdfjs worker into the standalone image.

---

## 6. Scheduler → external endpoint inventory (the automation backbone)

All jobs are `scheduler_config` rows; each targets a `pages/api/external/*` endpoint (or a direct handler). The
machinery is shared, so adding an automation = a new endpoint + `seedDefaults()` row. See `lib/scheduler/scheduler.ts`
for exact current cron strings and the `scripts/start-tpg-agent.bat`/`tpg-agent.mjs`/`tpg-renewal-sync.mjs` slice tools.

---

## 7. Known gaps in this reference

- **Frontend** (`pages/index.tsx` SPA shell, `layouts/`, `contexts/LmsContext.tsx` full surface, `components/*` portal
  maps, `hooks/`, `toolsData.ts`) is **line-verified** (an independent reverse-engineering pass). See §3.3.
- **Per-file internals of the Google / QuickBooks / Zoom / AI / courseware providers were not re-read** after the
  reverse-engineering sub-agent batches hit rate limits (HTTP 429 on the shared model); their shapes in §5 come from
  the lib inventory + README + the documented API routes, and a few OAuth/token nuances are inferred rather than
  line-verified. If you need exact token-refresh / request signatures there, read `lib/google-*`, `lib/quickbooks/*`,
  `lib/zoom/*`, `lib/ai/*` and `lib/cw-slides-*/orchestrator.ts` directly.
- The authoritative upstream-vs-SIT line-by-line diff belongs in git (see `../SIT_PATCHES.md`).

## 8. Related docs

- `../PROJECT.md` — overview, stack, invariants, structure, auth summary, quick start.
- `../SIT_PATCHES.md` — fork diff vs `alfredang/AI-LMS-TMS`.
- `lib/ssg/PROJECT.md` + `lib/ssg/README.md` — SSG integration reference (status: real client).
- `docs/ai-provider.md`, `docs/deployment.md`, `docs/features.md`, `docs/openclaw-course-run-skill.md`,
  `docs/openclaw-reschedule-api-spec.md`, `docs/scheduler-fetch-tgs-enrolments.md`, `docs/tpg-renewal-sync.md` — feature
  and integration runbooks.