# AGENTS.md

Guidance for AI coding agents working in **ownkeep-core** — the source-available
OwnKeep notes app (React SPA + Kotlin/Spring Boot API, single Docker image).

## Project overview

OwnKeep is a self-hosted Google Keep-style notes app: text and checklist notes,
labels, pinning, attachments, search, Google Keep import, and multi-user accounts.

| Layer | Stack |
|-------|-------|
| Web | React 19, TypeScript, Vite, Vitest, Playwright |
| API | Kotlin, JDK 21, Spring Boot 3.5, JPA, Flyway, PostgreSQL |
| Deploy | Unified Docker image (`rzarajczyk/ownkeep-core`) — SPA + API on port 8080 |

**Security model:** notes and attachments are **zero-knowledge encrypted in the
browser**. The API stores opaque ciphertext only; vault keys never leave the
client. See `web/src/crypto/` and `api/src/main/kotlin/com/ownkeep/api/CryptoSupport.kt`.

**Out of scope for this repo:** hosted SaaS deploy lives in the private
`ownkeep-saas` repository (triggered by CI after each core image publish).

## Repository layout

```
api/          Kotlin/Spring Boot API (Gradle)
  src/main/kotlin/com/ownkeep/api/   controllers, services, entities
  src/main/resources/db/migration/   Flyway migrations (V1__, V2__, …)
web/          React SPA (npm)
  src/        components, crypto, vault, API client
  e2e/        Playwright smoke tests
compose.yaml          local dev / build (git clone)
docker-compose.yaml   published quick-start (pulls image)
Dockerfile            unified production image
.env.example          template for local and Compose config
```

Key API modules are flat Kotlin files (`Notes.kt`, `Auth.kt`, `Attachments.kt`,
`Users.kt`, …) rather than deep package hierarchies. Web crypto lives under
`web/src/crypto/`; vault unlock/setup under `web/src/vault/`.

## Local development

**Default:** use Neon Postgres via repo-root `.env` (see `.env.example`). Do not
start the local `db` Compose service unless the user explicitly wants local Postgres.

| Component | Command | URL |
|-----------|---------|-----|
| API | `cd api && ./gradlew bootRun` | `http://localhost:8080` |
| Web | `cd web && npm ci && npm run dev` | `http://localhost:5173` |

- Load `OWNKEEP_*` from `.env` before `bootRun`. Neon URLs contain `&` — quote
  `OWNKEEP_DATABASE_URL` in `.env` (single quotes).
- Vite proxies `/api` → `:8080` and strips the `/api` prefix (same as production).
- Open the app at **http://localhost:5173** during dev, not `:8080`.
- Bootstrap admin: `OWNKEEP_ADMIN_EMAIL` + `OWNKEEP_ADMIN_PASSWORD` (first boot only).

Full-stack Docker (not dev): `docker compose up -d --build` from repo root.

More detail: [README.md](README.md), [api/README.md](api/README.md),
[web/README.md](web/README.md).

## Running checks

Run the relevant suite before finishing a change:

```sh
# API (from api/)
./gradlew test

# Web (from web/)
npm run typecheck
npm test
npm run lint
npm run build
npx playwright install chromium   # first run
npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs API tests, web unit tests, Playwright e2e,
and on `main` builds/pushes the Docker image.

## Architecture notes

### `/api` prefix

The SPA and Vite dev server call endpoints under `/api/...`. Spring strips the
prefix before routing (`ApiPrefixFilter.kt`). Controllers map to root paths
(`/health`, `/notes`, `/auth/login`, …). OpenAPI: `/api/openapi.json`.

### Zero-knowledge vault

- Client generates a vault key; password and recovery key each wrap it (AES-GCM).
- Note bodies, list items, labels, and attachment blobs are encrypted client-side.
- Server stores `kdf_salt`, `kdf_params`, `wrapped_vault_key`,
  `wrapped_vault_key_recovery` — never plaintext note content.
- Admin password reset clears the password wrap; user must unlock with recovery key.

When changing crypto or vault flows, update both `web/src/crypto/` and any
server-side validation in `CryptoSupport.kt`. Never add server-side decryption.

### Database

- Flyway migrations in `api/src/main/resources/db/migration/`.
- Name new files `V{n}__description.sql` with the next version number.
- Integration tests use Testcontainers (skipped only when Docker is unavailable).

### Attachments

Blob storage is pluggable: `filesystem` (default) or `gcs`. Implementations in
`api/.../storage/`. Attachment bytes are encrypted client-side before upload.

### Markdown

Server-side rendering in `Notes.kt` (`MarkdownService`): CommonMark + GFM
strikethrough, OWASP sanitization. Client preview uses `POST /markdown/preview`.

## Coding conventions

- **Minimize scope** — focused diffs; match existing style in each area.
- **API:** Kotlin idioms, Spring Boot patterns already in use; keep controllers
  and services in the flat `com.ownkeep.api` package unless there is a clear reason
  to split.
- **Web:** functional React components, TypeScript strict mode; colocate tests
  as `*.test.ts(x)` next to source. Lint with oxlint (`npm run lint`).
- **Config:** environment variables use the `OWNKEEP_` prefix; document new ones
  in [README.md](README.md) environment table.
- **Comments:** only for non-obvious business logic; prefer self-explanatory code.
- **Tests:** add meaningful coverage for real behavior; skip trivial assertions.
- **Secrets:** never commit `.env`, credentials, or recovery keys. Do not log
  or print secret values.

## Common pitfalls

- Do not point the browser at `:8080` during Vite dev (SPA is served by Vite).
- Do not start `docker compose up -d db` when using Neon (default dev setup).
- Compose `db` hostname works inside Docker; use `127.0.0.1` for host `bootRun`.
- Attachment directory in Docker must be writable by UID **10001**.
- `OWNKEEP_ADMIN_EMAIL` must be a valid email (not a username).
- Changing encryption formats requires migration strategy for existing user data.

## Git and PRs

- Do not commit unless explicitly asked.
- Do not push or open PRs unless explicitly asked.
- Follow existing commit message style (concise, imperative, explain why).
- CI must pass: API tests, web unit tests, Playwright e2e.

## License

Elastic License 2.0 (`Elastic-2.0`). OwnKeep is source-available, not OSI
open-source. The OwnKeep name and logos are trademarks (see [NOTICE](NOTICE)).
