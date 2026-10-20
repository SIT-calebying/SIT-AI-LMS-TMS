# SIT-AI-LMS-TMS — Singapore Training Group Learning Management System

## Overview

A fork of [alfredang/AI-LMS-TMS](https://github.com/alfredang/AI-LMS-TMS) adapted for Singapore Training Group's operations. Manages course enrollment, SSG (SkillsFuture Singapore) integration, invoicing, assessment tracking, and learner/trainer/admin portals.

### Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14+, React 19, TypeScript, Tailwind CSS |
| API Routes | Next.js `/api/*` handlers → PostgreSQL |
| Auth | JWT via `authService`, localStorage tokens |
| SSG Client | AES-256-CBC encrypted calls (stubbed for build without credentials) |
| Spreadsheets | Dynamic `import('xlsx')` for import/export |

## Current Modifications vs Original

1. **SSG stubbed/disabled** — All modules in `lib/ssg/api/`, `lib/ssg/services/`, `lib/ssg/models/` compile but short-circuit at runtime when `SSG_ENCRYPTION_KEY` is absent. Prevents credential-dependent failures while keeping full type coverage.
2. **Extended Course interface** — Added optional fields: `whitelistStatus`, `fundingValidityStart`, `traqomResponseRate`, `traqomQualityRating`, `casScore`, `esScore`, `renewalApplicationNo`.
3. **Funding Validity dashboard** — Full renewal status tracking with bulk Excel upload (`components/admin/FundingValidityView.tsx`).
4. **Shared UI library** — Standardized `components/ui/index.tsx` exports: Button, Card, Icon (70+ SVGs), Spinner, Switch, Input, Checkbox, SearchableSelect, Select.
5. **Hooks barrel** — `hooks/index.ts` re-exports all custom hooks under `@hooks/*` alias.

## Subsystem Projects

This project contains one subsystem with its own documentation:

| Sub-project | Path | Description |
|-------------|------|-------------|
| [ssg](./lib/ssg/) | `PROJECT.md` | SkillsFuture Gateway integration client (stubbed) |

## Quick Start

```bash
cp sit-local.env.example .env.local    # fill SSG_API_URL & SSG_ENCRYPTION_KEY if needed
npm install --no-audit --no-fund
npx tsc --noEmit                        # type-check
npm run dev                             # localhost:3000
```

## Build Notes

- Path aliases in `tsconfig.json`: `@/*`, `@app-types`, `@lib/*`, `@components/*`, `@hooks/*`, `@contexts/*`, `@styles/*`, `@utils/*`.
- All SSG API modules return typed responses but gate on credentials presence.
- Add new UI primitives to `components/ui/` rather than scattering inline SVGs across components.
