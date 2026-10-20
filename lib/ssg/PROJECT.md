# SIT-AI-LMS-TMS — SSG Integration (Stubbed)

## Purpose

TypeScript client for Singapore SkillsFuture Gateway / TPGW API. Provides course run CRUD, enrolment management, assessment submission, and attendance upload — stubbed at runtime so the project compiles without SSG WSSG credentials.

## Status: Stubbed at Build Time

All modules compile with full type coverage. Runtime behavior when no `SSG_ENCRYPTION_KEY` is configured:
- `getSSGCredentialsService().getSSGCredentials()` returns `undefined`
- Every API method that requires auth checks this first and short-circuits gracefully
- No runtime errors across any admin page

## Key Files

| Path | Contents |
|------|----------|
| `constants.ts` | Enum definitions (`AttendanceStatus`, `SurveyLanguage`) |
| `models/course-runs.ts` | `SSGApiResponse<T>`, search/response payloads |
| `models/enrolment.ts` | Create/Search/Update/Cancel enrolment types |
| `models/attendance.ts` | Upload attendance, view attendance records |
| `api/course-api.ts` | Course CRUD operations |
| `api/enrolment-api.ts` | Enrolment create/search/update/cancel |
| `api/assessment-api.ts` | Assessment submit/view/search |
| `api/attendance-api.ts` | Attendance upload/retrieval |
| `services/credentials-service.ts` | Reads credentials from `/api/training-provider/ssg-credentials` |
| `utils/http-utils.ts` | HttpClient, HTTPRequestBuilder, handleRequest |
| `utils/cryptography.ts` | AES-256-CBC encrypt/decrypt via Node crypto |
| `index.ts` | Barrel re-export |

## Encryption Flow

```
JSON payload → Cryptography.encryptJSON(key) → base64 ciphertext ──▶ POST SSG API
ciphertext ◀── decrypt(key) ◀──────────── raw response (base64 encoded JSON)
```

Fixed IV per WSSG spec: `"SSGAPIInitVector"`.
