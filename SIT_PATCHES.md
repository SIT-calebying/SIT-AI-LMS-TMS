# SIT patch queue on top of alfredang/AI-LMS-TMS

This fork (origin `git@github.com:SIT-calebying/SIT-AI-LMS-TMS.git`) stays as close to upstream
[alfredang/AI-LMS-TMS](https://github.com/alfredang/AI-LMS-TMS) as possible, adapted for Singapore Training Group's
operations. Every known SIT change is listed here with why it exists. Anything **not** on this list should be treated as
upstream.

> **Scope note.** This queue was assembled by reverse-engineering the checked-out tree at the `main` / feature branches
> (see [PROJECT.md](./PROJECT.md) for the canonical structure). Where an item could not be verified as SIT-specific vs
> upstream, it is marked *unverified*. The authoritative git diff lives in the repo history — this document is the
> human-readable rationale, not a substitute for `git diff` against `alfredang/AI-LMS-TMS`.

| # | Change | Why | Upstream? |
|---|---|---|---|
| 1 | `lib/ssg/services/stub-credentials.ts` added (returns `undefined` credentials + placeholder UEN) | Provides a friendlier empty-credentials path for the SSG integration when building/running without live SkillsFuture credentials. **Currently unimplemented/inert — nothing imports it** (see `lib/ssg/PROJECT.md`). | not filed — SIT-only scaffolding |
| 2 | Extended `course` fields: `whitelist_status`, `funding_validity_start`, `traqom_response_rate`, `traqom_quality_rating`, `cas_score`, `es_score`, `renewal_application_no`, `actual_renew_date` | Backs the Course Funding Validity & renewal tracking feature (WSQ/CASL/IBF validity + TRAQOM quality signals on the course catalog). | SIT feature |
| 3 | `components/admin/FundingValidityView.tsx` + `components/ui/` primitives (`Input`, `Checkbox`, `SearchableSelect`, `Select`, alongside `Button`, `Card`, `Icon`, `Spinner`, `Switch`) + `hooks/index.ts` barrel | Standard shared UI library and funding-renewal dashboard. | SIT feature |
| 4 | `types/index.ts`: added `View.Finance` and `Course.whitelistStatus` | Type support for the finance view and funding-validity flag. | SIT |
| 5 | `course` column dual-code handling (`course_code` original + `new_course_code` current) | SSG funding renewal issues a *new* reference code for the same course; the fork keeps both and resolves by era (`course_code_history`, `course_code_at()`) so past records stay findable under their old code. | SIT hardening |

## Known upstream behaviour the fork works around (no patch needed)

- SSG is the system of record for enrolments/grants/claims/assessments; the LMS mirrors and reconciles locally. Much of
  the fork's work is day-2 reconciliation (trainer sync to TPG, enrolment-ID backfill, cancellation reconcile,
  WSQ schedule push) rather than core app changes — these live in the upstream feature surface, not the SIT diff.
- The multi-tenant story is a *single `training_provider` row per deployment*, not row-level tenancy; tenant behaviour is
  gated by that row (`payroll_enabled`, SSG app credentials, funding rates, email toggles). See [PROJECT.md](./PROJECT.md).

## Verification

Run `git diff` between this fork and `alfredang/AI-LMS-TMS` to confirm the list is current:
```bash
git fetch https://github.com/alfredang/AI-LMS-TMS.git main
git diff FETCH_HEAD -- lib/ssg components/ui components/admin/FundingValidityView.tsx types hooks hooks/index.ts
```
Anything unaccounted for above should be added to this table (or, if it's upstream, crossed off).