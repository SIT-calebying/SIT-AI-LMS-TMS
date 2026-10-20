# SIT-AI-LMS-TMS — SSG Integration

## Purpose

TypeScript client for the SkillsFuture Singapore (SSG) / TPGateway API: course run CRUD, enrolment management, assessment submission, attendance upload. Full endpoint tables are in [`README.md`](./README.md).

## Status: real client, not stubbed

Nothing in the SSG client is stubbed or disabled:

- `services/credentials-service.ts` reads credentials (UEN, encryption key, cert/key files, API base URL, OAuth client) from the `training_provider` table in PostgreSQL via `DATABASE_URL`, and returns `null` when none are found.
- `utils/encryption-service.ts` takes the key from the caller or `SSG_ENCRYPTION_KEY`, and **throws** if neither is set.
- The API base URL comes from the stored `ssg_api_base_url`, then `SSG_API_URL`, then defaults to `https://api.ssg-wsg.sg` (the real SSG). Note that for local work the DB value takes precedence over the env var.

### Unused stub

`services/stub-credentials.ts` is an SIT-added stub that returns `undefined` credentials (with a placeholder UEN). **Nothing imports it.** It is not wired in, so it changes no runtime behaviour. Either wire it in deliberately or delete it.

## Key files

| Path | Contents |
|------|----------|
| `constants.ts` | Enum definitions |
| `models/` | Request/response types: `course-runs`, `add-course-run`, `edit-delete-course-run`, `enrolment`, `assessment`, `attendance` |
| `api/` | `course-api`, `enrolment-api`, `assessment-api`, `attendance-api`, `direct-course-application-api` |
| `services/credentials-service.ts` | Loads credentials from the DB |
| `services/encryption-service.ts`, `services/enrolment-service.ts` | Encryption and enrolment helpers |
| `utils/cryptography.ts` | AES-256-CBC encrypt/decrypt via Node crypto |
| `utils/encryption-service.ts` | Key resolution (argument or `SSG_ENCRYPTION_KEY`) |
| `utils/http-utils.ts` | HttpClient, request builder |
| `utils/validators.ts`, `utils/sync-enrolment-to-db.ts`, `utils/attendance-decrypt.ts` | Validation and DB sync |
| top-level `push*.ts`, `reconcileEnrolmentIds.ts`, `syncRunSessions.ts`, … | Workflows that push or reconcile data with SSG/TPG |
| `index.ts` | Barrel re-export |

## Encryption flow

```
JSON payload → Cryptography.encryptJSON(key) → base64 ciphertext ──▶ POST SSG API
ciphertext ◀── decrypt(key) ◀──────────── raw response (base64 encoded JSON)
```

The IV is fixed per the SSG spec; see `utils/cryptography.ts` for the value in use.
