# OwnKeep API

Kotlin/JDK 21 Spring Boot API backed by PostgreSQL.

## Run locally

Start PostgreSQL, then provide admin bootstrap credentials (used only when no admin exists yet):

```sh
export OWNKEEP_ADMIN_EMAIL=admin@example.com
export OWNKEEP_ADMIN_PASSWORD=change-this-password
./gradlew bootRun
```

Set `OWNKEEP_DATABASE_URL` to a Neon-style connection string
(`postgresql://user:pass@host/db?sslmode=require`) or a JDBC URL. User and password embedded
in the URI are applied automatically. Defaults for local `bootRun` remain
`jdbc:postgresql://localhost:5432/ownkeep` / `ownkeep` / `ownkeep` when unset.

The API listens on port 8080. OpenAPI is available at `/openapi.json` and health at `/health`.
When the SPA is bundled (unified Docker image), the same endpoints are also reachable
under `/api/...` — Spring strips the `/api` prefix before routing.

Markdown for notes is rendered by `MarkdownService` in `Notes.kt`:

- Full body render (TEXT notes / default preview): CommonMark + autolink + GFM
  strikethrough, images (http(s) or attachment filename → `/attachments/{id}`),
  with OWASP sanitization (including `pre` and `hr`).
- Inline render (LIST item `textRendered` and `POST /markdown/preview` with
  `inline: true`): bold, italic, inline code, links, bare URLs, strikethrough —
  no headings, lists, or images.

## Configuration

- `OWNKEEP_ADMIN_EMAIL` / `OWNKEEP_ADMIN_PASSWORD` — bootstrap the first admin when none exists; ignored once an admin is present (admin email is always verified)
- `OWNKEEP_TOKEN_TTL` — bearer-token lifetime, default `30d`
- `OWNKEEP_MAX_SYNC_LIMIT` — maximum notes/search page size, default `200`
- `OWNKEEP_LOGIN_MAX_ATTEMPTS_PER_IP` — max `/auth/login` attempts per client IP per window, default `10`
- `OWNKEEP_LOGIN_MAX_ATTEMPTS_PER_EMAIL` — max `/auth/login` attempts per email per window, default `5`
- `OWNKEEP_LOGIN_RATE_LIMIT_WINDOW` — rate-limit window, default `1m`
- `OWNKEEP_EMAIL_VERIFICATION_REQUIRED` — when `true`, non-admin users must verify email before login (default `false`)
- `OWNKEEP_PUBLIC_BASE_URL` — public origin used in verification links (required when verification is enabled)
- `OWNKEEP_MAIL_*` — SMTP settings (`HOST`, `PORT`, `USERNAME`, `PASSWORD`, `SMTP_AUTH`, `STARTTLS`, `FROM`); required when verification is enabled
- `OWNKEEP_SPA_STATIC_DIR` — filesystem SPA overlay directory (Docker default `/app/static`)
- `OWNKEEP_ATTACHMENT_STORAGE` — attachment blob backend: `filesystem` (default, NAS/Compose) or `gcs`
- `OWNKEEP_ATTACHMENT_STORAGE_ROOT` — local attachment directory when `storage=filesystem`, default `./data/attachments`
- `OWNKEEP_ATTACHMENT_GCS_BUCKET` — GCS bucket name when `storage=gcs` (required)
- `OWNKEEP_ATTACHMENT_GCS_PREFIX` — optional object key prefix inside the bucket (e.g. `ownkeep/`)
- GCS auth uses Application Default Credentials (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`)
- `OWNKEEP_ATTACHMENT_MAX_FILE_SIZE` — application-level upload limit in bytes, default 25 MiB
- `OWNKEEP_MULTIPART_MAX_FILE_SIZE` — servlet upload limit, default `25MB`
- `OWNKEEP_ATTACHMENT_PER_USER_QUOTA` — per-user attachment quota in bytes, default 1 GiB

## Container

Production uses the unified root [Dockerfile](../Dockerfile) (SPA + API). The
standalone [Dockerfile](Dockerfile) remains for the OMV dual-image stack until
that deploy is migrated.

Run verification with `./gradlew clean test bootJar`. Database integration tests use
Testcontainers and are skipped automatically only when Docker is unavailable.
