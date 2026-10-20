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
| 2 | `components/ui/index.tsx`: added `Input`, `Checkbox`, `SearchableSelect`, `Select` (alongside existing `Button`, `Card`, `Icon`, `Spinner`, `Switch`) + `hooks/index.ts` barrel (re-exports `useDeveloperCourses` only) | Shared primitives and a path-alias barrel. | SIT |
| 3 | `types/index.ts`: added `View.Finance` and `Course.whitelistStatus`; `ClassDetailView.tsx`: added `virtualMeetingLink` / `virtualMeetingProvider` to `OperationalSummary` | Type support for the finance view, the funding-validity flag and virtual-meeting links. | SIT |
| 4 | `AllCourseRunsView.tsx`: removed import of nonexistent `../ui/Checkbox` | The module does not exist, so the import was a type error. | SIT |

## Already upstream (not SIT changes)

Verified against upstream history (Tertiary Infotech, April 2026 onward) — do not list as SIT work:

- `components/admin/FundingValidityView.tsx` and the extended `course` fields (`fundingValidityStart`, `traqomResponseRate`,
  `traqomQualityRating`, `casScore`, `esScore`, `renewalApplicationNo`).
- Course-code history: `course_code_history`, `course_code_at()` and `new_course_code` (upstream migrations
  `add_course_code_history.sql`, `add_course_code_at_function.sql`).

## Known upstream behaviour the fork works around (no patch needed)

- SSG is the system of record for enrolments/grants/claims/assessments; the LMS mirrors and reconciles locally. The
  reconciliation jobs (trainer sync to TPG, enrolment-ID backfill, cancellation reconcile, WSQ schedule push) are part of
  the upstream feature surface, not the SIT diff.
- The multi-tenant story is a *single `training_provider` row per deployment*, not row-level tenancy; tenant behaviour is
  gated by that row (`payroll_enabled`, SSG app credentials, funding rates, email toggles). See [PROJECT.md](./PROJECT.md).

## Verification

Run `git diff` between this fork and `alfredang/AI-LMS-TMS` to confirm the list is current:
```bash
git fetch https://github.com/alfredang/AI-LMS-TMS.git main
git diff FETCH_HEAD --stat
```
Anything unaccounted for above should be added to this table (or, if it's upstream, crossed off).