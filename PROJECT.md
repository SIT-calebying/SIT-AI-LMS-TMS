# SIT-AI-LMS-TMS — Singapore Training Group Learning & Training Management System

## Overview

A fork of [alfredang/AI-LMS-TMS](https://github.com/alfredang/AI-LMS-TMS) (Tertiary Infotech), adapted for Singapore
Training Group's operations. A full-stack, multi-tenant web application that manages the complete WSQ/SkillsFuture
training lifecycle — course cataloguing, class (course-run) scheduling, learner enrolment, SSG/TPGateway compliance,
assessment and grading, certification, grant/claim tracking, invoicing and trainer payroll — through dedicated Learner,
Trainer, Admin, Developer, Finance, Payroll and Training Provider portals.

It is both an **LMS** (learners take courses, track progress, sit assessments, earn certificates) and a **TMS**
(training providers run classes, manage trainers, and stay SSG-compliant) in a single Next.js application.

### Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (Pages Router), React 18, TypeScript 5, Tailwind CSS 3 — a client-side SPA whose view switching happens in JS |
| API Routes | Next.js `pages/api/*` handlers (619 routes) → PostgreSQL (`pg` pool) |
| Database | PostgreSQL 17 (local or Supabase/cloud; SSL when production or Supabase) |
| Auth | bcryptjs passwords + one-time-passwords; DB-backed opaque `lms_…` session tokens (SHA-256 hash in `user_session`); machine `x-api-key` service keys |
| SSG Client | AES-256-CBC encrypted + mTLS calls to SkillsFuture/TPGateway (`lib/ssg/`); credentials read from the `training_provider` DB row |
| AI | Claude Agent SDK + Anthropic SDK + OpenAI (Codex SDK) + Google Gemini, with MiniMax / Kimi / DeepSeek / Groq |
| Finance | QuickBooks Online (OAuth2 + proxy), Bizfile (ACRA), SFC claim import, TPG grant import |
| Automation | In-process node-cron scheduler (DB-driven), "Run Now", webhooks, n8n, external OpenClaw/Hermes agent |
| Docs/gen | docxtemplater, pptxgenjs, pdf-lib, pdfjs-dist, xlsx — courseware, invoices, certificates, SEO |
| Deploy | Docker / Docker Compose on Coolify (self-hosted), multi-tenant |

### Design Invariants

1. **The API route is the only trusted boundary.** Every route is authenticated (user session **or** machine key);
   `scripts/check-api-auth.js` fails the build if a route lacks auth or a justified public-allowlist entry.
2. **Persistence is the source of truth; the scheduler is a thin driver.** `scheduler_config` rows drive cron; each
   job calls an authenticated business function or an `/api/external/*` endpoint. Jobs are idempotent and single-flight
   (globalThis in-process lock + PostgreSQL advisory lock).
3. **The platform is a shell around the SSG SkillsFuture ecosystem.** TPG/SSG is the system of record for enrolments,
   grants, claims, assessments and attendance; the LMS mirrors locally and reconciles. All SSG calls are AES-256-CBC
   encrypted and mTLS-signed.
4. **External agents stay outside the app.** The operational chatbot (OpenClaw/Hermes) runs over WhatsApp/Telegram and
   drives the platform through the authenticated `/api/external/*` surface — never the database, and it upgrades
   independently of a deploy.
5. **Multi-tenancy by config, not fork.** One shared codebase; tenant behaviour is gated by the `training_provider` DB
   row (SSG app credentials, `payroll_enabled`-style feature flags, funding rates, email toggles, brand colours).

## Changes vs upstream `main`

Only what differs from upstream `main` (see also `SIT_PATCHES.md`):

1. **SSG stub is inert** — `lib/ssg/services/stub-credentials.ts` is an SIT-added stub that **nothing imports**; the
   SSG client is a real client. When credentials are absent, `utils/encryption-service.ts` throws and
   `services/credentials-service.ts` returns `null` (see `lib/ssg/PROJECT.md`).
2. **Shared UI primitives** — `components/ui/index.tsx` additionally exports `Input`, `Checkbox`, `SearchableSelect`,
   `Select` (alongside the existing `Button`, `Card`, `Icon`, `Spinner`, `Switch`). Same-named standalone files in
   `components/ui/` are separate and not shared.
3. **Hooks barrel** — `hooks/index.ts` re-exports `useDeveloperCourses` only; the other hooks
   (`useCourses`, `useProfile`, `useSessionReschedule`, `useScheduleChangeConfirm`, `useTrainerCourses`,
   `useCourseValidityFeature`, `useAppVersion`, `useTrainerProfile`) are standalone `hooks/*.ts(x)` files imported
   directly via the `@hooks/*` alias.
4. **Type additions** — `View.Finance` and `Course.whitelistStatus` in `types/index.ts`;
   `virtualMeetingLink` / `virtualMeetingProvider` on `OperationalSummary` in `ClassDetailView.tsx`.
5. **Dead import removed** — `AllCourseRunsView.tsx` no longer imports the nonexistent `../ui/Checkbox`.

Not SIT changes (already upstream, by Tertiary Infotech): the Funding Validity dashboard
(`components/admin/FundingValidityView.tsx`), the extended `course` fields (`fundingValidityStart`, `traqom*`,
`casScore`, `esScore`, `renewalApplicationNo`) and course-code history (`course_code_history`, `course_code_at()`).

## Subsystem Projects

| Sub-project | Path | Description |
|-------------|------|-------------|
| [ssg](./lib/ssg/) | `PROJECT.md`, `README.md` | SkillsFuture/TPGateway client: typed API modules, AES-256-CBC crypto, mTLS HTTP, credentials service |
| [auth](./lib/auth/) | — | Session tokens, role guards, course-run-scoped trainer auth, machine service keys |
| [scheduler](./lib/scheduler/) | — | DB-driven node-cron scheduler with cross-instance advisory locking |
| [cw-slides-v2 / v3](./lib/cw-slides-v2/) | — | Two generations of AI courseware slide-generation pipelines |

## Project Structure (Canonical)

```
SIT-AI-LMS-TMS/
├── pages/                     # Next.js Pages Router
│   ├── index.tsx              # SPA shell entry — view switching happens in JS
│   └── api/                   # 619 API handlers, grouped by domain
│       ├── auth/  admin/  external/  training-provider/  finance/  trainer/
│       ├── ssg/  course(s)/  course-runs/  enrolment(s)/  assessments/  grading/  submissions/
│       ├── quickbooks/  integrations/  mobile/  android/  payroll/  billing/
│       ├── grant-import/  sfc-import/  sf-credits/  certificates/  ai/  config/
│       ├── webhooks/  uploads/  files/  download/  virtual-meetings/ …
├── components/                # 241 React components (role portals + shared UI)
│   ├── admin|trainer|training-provider|developer|finance|payroll|ssg/  # role portal views
│   │   (no `components/learner/` dir — learner views live in top-level + layouts/LearnerLayout, reusing trainer tools pages)
│   ├── ui/  common/           # primitives + shared
│   ├── AiChatbot.tsx + chatTemplates.ts   # external-agent WhatsApp/Telegram launcher + ~44 templates
│   └── toolsData.ts           # shared trainer/learner tool catalogue
├── contexts/                  # LmsContext.tsx — client auth/user/mode/nav state core
├── lib/                       # server-side libraries & business logic (289 files)
│   ├── auth/  ssg/  tpg/  ai/  cw-slides-v2/  cw-slides-v3/
│   ├── google-(auth|calendar|drive)/  zoom/  virtual-meetings/
│   ├── quickbooks/  payroll/  billing/  mobile/  android/  scheduler/
│   ├── services/              # auth, email, certificate, invoices, grants, imports, n8n webhook
│   ├── db.ts                  # pg pool + startup auto-migrations
│   └── config.ts  smtp.ts  gmailOauthSend.ts  r2.ts  …
├── hooks/                     # useCourses, useProfile, useSessionReschedule, … (barrel `index.ts`)
├── types/  utils/  styles/  public/  tests/
├── database/                  # 01-schema.sql (pg_dump) + migrations/ + seeds/
├── instrumentation.ts         # Next.js instrument: boots scheduler, table ensures, Gmail OAuth warm-up
├── scripts/                   # check-api-auth.js, migrate.js, seed.js, tpg-agent.mjs, generators
└── next.config.js             # standalone output, /uploads/* rewrite, path aliases
```

## Runtime Topology

```
Browser SPA (Next.js Pages Router + React)
   │  Bearer `lms_…` session token (attached globally by lib/clientAuthFetch.ts)
   ▼
Next.js server ── /api/* handlers, guarded by lib/auth/*
   │            browser session → withAuth(roles)
   │            machine caller  → withServiceAuth / x-api-key service key
   ▼
PostgreSQL 17  (pg Pool; SSL in prod/Supabase; startup auto-migrations)
   ▲
next process ALSO hosts:
   ├─ lib/scheduler (node-cron, DB-driven, SGT, advisory-locked)
   ├─ /api/external/* (called by scheduler directly, by n8n, and by OpenClaw/Hermes over HTTPS)
   └─ instrumentation.ts boot (Android reminder scheduler, table ensures, Gmail OAuth warm-up)
```

## Data Model (core spine)

```
 training_provider ──< (one tenant per deploy; config gates behaviour)
        │
   app_user ──< user_role_map (Learner | Trainer | Developer | Admin | Finance | Payroll | Training Provider)
        │
   learner|trainer|developer|admin|finance _profile
        │
  enrollment ──> course_run ──> course   (template)
        │             └── course_session, course_run_trainer, course_run_calendar_event
        └─── submission / assessment_grade / trainer_assessment_grading / attendance
             learning_unit / subtopic / assessment / quiz_attempt
 SSG mirrors: ssg_course_runs, ssg_enrolments, ssg_enrolment_record, ssg_grants, ssg_claims
 Company applications / Direct applications: company_application, da_application, da_automation_run
 Finance: invoice_jobs, company_invoice_batch, grant_import_*, sfc_import_*, payroll tiers/bills/payouts
 Ops: scheduler_config, webhooks + webhook_logs, auto_*_log tables, support_ticket(+reply), otp_codes, user_session
```

## Auth Model (summary)

- **User sessions:** login (password `bcryptjs` verify **or** OTP against `otp_codes`) → opaque `lms_` + 64-hex token;
  only its **SHA-256 hash** is stored in `user_session` (30-day TTL). Revoked on logout, password change, admin reset,
  expiry. Legacy `mock-jwt-token-*` rejected outright.
- **Route guards:** `withAuth(handler, {roles})` / `withServiceAuth(handler)` / `requireRole(req,res,roles)` /
  `getAuthedUser(req)`. Roles normalized (`Training Provider`→`trainingProvider`), per-user in `user_role_map`.
- **Machine keys:** `x-api-key` (or `?authKey`/`?key`) matched **timing-safe** against server-only env secrets
  `EXTERNAL_API_KEY_FOR_CLAWDBOT` and `SCHEDULER_SECRET`. Service callers pass every role check.
- **Class-level trainer scoping:** a trainer may only open/grade classes they are assigned to
  (`course_run_trainer` junction + legacy assigned columns) matched by id **or** any of the user's emails.

## Quick start

```bash
cp sit-local.env.example .env.local    # fill SSG_API_URL & SSG_ENCRYPTION_KEY only for live SSG
npm install --no-audit --no-fund
npx tsc --noEmit        # type-check
npm run dev             # localhost:3000 — startup scheduler disabled
npm run dev:scheduler   # with the startup cron scheduler enabled
```

> `npm run dev` sets `ENABLE_APP_SCHEDULER=false` so developers on shared/prod databases never fire production jobs.
> Only ONE app instance on a shared DB should run with it true.

## Build notes

- Path aliases (`tsconfig.json` + Turbopack/webpack in `next.config.js`): `@/*`, `@components/*`, `@lib/*`,
  `@hooks/*`, `@contexts/*`, `@app-types`, `@styles/*`, `@utils/*`.
- `output: 'standalone'`; `/uploads/*` rewrites to `/api/uploads/*` for Docker-volume file serving.
- SSG modules are a real typed client; missing credentials throw / return null (no silent stubbing) — see `lib/ssg/PROJECT.md`.
- `ENABLE_APP_SCHEDULER` gates startup cron (auto-on in production unless `false`); `MOBILE_APNS_ENABLED` gates iOS reminders.