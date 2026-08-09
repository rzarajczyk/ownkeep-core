# OwnKeep Core

Self-hosted, open-source notes app — text and checklist notes, labels, pinning,
attachments, search, Google Keep import, and multi-user accounts. A small Google
Keep-style alternative you run with Docker.

---

WARNING!

THIS SERVICE IS IN ACTIVE DEVELOPMENT PHASE

IT'S NOT SUPPOSED TO BE USED BY ANYONE - ONLY FOR TESTING

EXPECT BREAKING CHANGES, CRASHES AND DATA LOSS

YOU HAVE BEEN WARNED!

---

**License:** [Apache License 2.0](LICENSE). The OwnKeep name and logos are
trademarks and are **not** covered by the code license (see [NOTICE](NOTICE)).

**Stack:** React SPA + Kotlin/Spring Boot API in a single container image ·
PostgreSQL (bring your own, or run via Compose)

**Image:** [`rzarajczyk/ownkeep-core`](https://hub.docker.com/r/rzarajczyk/ownkeep-core)
on Docker Hub (published by CI on `main`).

Accounts use **email addresses** as usernames. Set `OWNKEEP_ADMIN_EMAIL` /
`OWNKEEP_ADMIN_PASSWORD` to bootstrap the first admin; manage other users in the
app. Optional email verification is off by default.

---

## Choose a deployment

| Method | When to use |
|--------|-------------|
| [Docker + bring-your-own Postgres](#1-docker--bring-your-own-postgres) | You already have Postgres (Neon, managed DB, existing server) |
| [Docker Compose](#2-docker-compose-core--postgres) | All-in-one local / VPS stack (app + Postgres) |
| [OpenMediaVault Compose](#3-openmediavault-compose) | OMV Compose plugin with bind-mounted data paths |

All three run the same unified image: SPA at `/` and API under `/api` on port
**8080** inside the container.

---

## 1. Docker + bring-your-own Postgres

No Compose. Point OwnKeep at any PostgreSQL that is reachable from the
container, then run the image with `docker run`.

### Prerequisites

- Docker
- A Postgres database (15+ recommended) and a connection string
- A host directory for attachment blobs (writable by container UID **10001**)

### Prepare the attachments directory

```sh
mkdir -p ./data/attachments
sudo chown -R 10001:10001 ./data/attachments
```

### Run

```sh
docker pull docker.io/rzarajczyk/ownkeep-core:latest

docker run -d \
  --name ownkeep \
  --restart unless-stopped \
  -p 8080:8080 \
  -e OWNKEEP_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require' \
  -e OWNKEEP_ADMIN_EMAIL='admin@example.com' \
  -e OWNKEEP_ADMIN_PASSWORD='choose_a_strong_admin_password' \
  -e OWNKEEP_TOKEN_TTL=PT24H \
  -e OWNKEEP_ATTACHMENT_STORAGE_ROOT=/data/attachments \
  -v "$(pwd)/data/attachments:/data/attachments" \
  docker.io/rzarajczyk/ownkeep-core:latest
```

Open **http://localhost:8080**.

### Notes

- Database connection strin is in a sinle `OWNKEEP_DATABASE_URL` variable (`postgresql://…` or `jdbc:postgresql://…`).
  User and password embedded in the URI are applied automatically. Quote the value
  when it contains `&` (common with Neon).
- If Postgres runs on the Docker host and the app is in a container, use a host
  that the container can resolve (for Linux Docker often `host.docker.internal`
  or the host LAN IP — not `localhost` unless you use `--network host`).
- For Neon / cloud Postgres, include `sslmode=require` (and `channel_binding=require`
  when the provider requires it).
- Health: `GET /api/health` · OpenAPI: `GET /api/openapi.json`

### Stop / logs

```sh
docker logs -f ownkeep
docker stop ownkeep && docker rm ownkeep
```

---

## 2. Docker Compose (core + Postgres)

Uses the published Compose file and image. Postgres is the `db` service; the app
is `app`.

### Quick start

```sh
curl -fsSLO https://raw.githubusercontent.com/rzarajczyk/ownkeep-core/main/docker-compose.yaml
curl -fsSLO https://raw.githubusercontent.com/rzarajczyk/ownkeep-core/main/.env.example
cp .env.example .env
# Edit .env — replace every CHANGE_ME; keep the DB host as "db"
docker compose up -d
open http://localhost:8080
```

From a git clone (builds locally via `compose.yaml` instead of pulling):

```sh
cp .env.example .env
# Edit .env — DB host must be "db" for the Compose network
docker compose up -d --build
```

### `.env` essentials

```sh
OWNKEEP_PORT=8080
OWNKEEP_DATABASE_URL='postgresql://ownkeep:YOUR_DB_PASSWORD@db:5432/ownkeep'
OWNKEEP_ADMIN_EMAIL=admin@example.com
OWNKEEP_ADMIN_PASSWORD=YOUR_ADMIN_PASSWORD
```

Generate secrets with `openssl rand -base64 32`. Never commit `.env`.

The Compose Postgres entrypoint derives `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB` from `OWNKEEP_DATABASE_URL`, so one URL configures both services.

### Useful commands

```sh
docker compose ps
docker compose logs -f app db
docker compose down          # keeps named volumes
docker compose down -v       # also deletes Postgres + attachments volumes
```

Named volumes: `ownkeep-postgres`, `ownkeep-attachments`.

---

## 3. OpenMediaVault Compose

Run OwnKeep from the OMV **Compose** plugin with bind-mounted data under the
stack data path. This flavor uses OMV placeholders
`CHANGE_TO_COMPOSE_DATA_PATH` and `${{ tz }}`.

Note: OpenMediaVault uses the special `CHANGE_TO_COMPOSE_DATA_PATH` placeholder in it's compose files. Do **not** change it manually.

Replace every `choose_a_strong_password` before deploying. Generate secrets with:

```sh
openssl rand -base64 32
```

### Before first start

The app container runs as UID **10001** and must write to the attachments bind
mount. Create the directory and fix ownership **before** starting (otherwise the
API crashes with `AccessDeniedException: /data/attachments/.tmp`):

```sh
sudo mkdir -p CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments
sudo mkdir -p CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/postgres
sudo chown -R 10001:10001 CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments
```

### Compose file

Paste into the OMV Compose plugin:

```yaml
services:
  app:
    image: rzarajczyk/ownkeep-core:latest
    container_name: ownkeep
    ports:
      - "7001:8080"
    environment:
      - OWNKEEP_DATABASE_URL=postgresql://ownkeep:choose_a_strong_database_password@db:5432/ownkeep
      - SPRING_JPA_OPEN_IN_VIEW=false
      - SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE=26214400B
      - SPRING_SERVLET_MULTIPART_MAX_REQUEST_SIZE=27262976B
      - SERVER_FORWARD_HEADERS_STRATEGY=framework
      - OWNKEEP_ADMIN_EMAIL=admin@example.com
      - OWNKEEP_ADMIN_PASSWORD=choose_a_strong_admin_password
      - OWNKEEP_TOKEN_TTL=PT24H
      - OWNKEEP_ATTACHMENT_STORAGE_ROOT=/data/attachments
      - OWNKEEP_ATTACHMENT_MAX_FILE_SIZE=26214400
      - OWNKEEP_ATTACHMENT_PER_USER_QUOTA=1073741824
      - OWNKEEP_SPA_STATIC_DIR=/app/static
      - TZ=${{ tz }}
    volumes:
      - CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments:/data/attachments
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:18-alpine
    container_name: ownkeep-postgres
    environment:
      - POSTGRES_DB=ownkeep
      - POSTGRES_USER=ownkeep
      - POSTGRES_PASSWORD=choose_a_strong_database_password
      - TZ=${{ tz }}
    volumes:
      - CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/postgres:/var/lib/postgresql
    shm_size: 128mb
    restart: unless-stopped
```

Use the **same** password in `OWNKEEP_DATABASE_URL` and `POSTGRES_PASSWORD`.

### After deploy

Open **http://\<your-omv-ip\>:7001**. The container listens on 8080 internally;
only the host mapping uses 7001.

- Postgres data: `CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/postgres`
- Attachments: `CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments`
- Keep Takeout import stages under that attachments volume (`.imports`) unless
  you set `OWNKEEP_TAKEOUT_IMPORT_STAGING_ROOT`

### OMV troubleshooting

**`AccessDeniedException: /data/attachments/.tmp`**

```sh
sudo mkdir -p CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments
sudo chown -R 10001:10001 CHANGE_TO_COMPOSE_DATA_PATH/ownkeep/attachments
# then restart the app service in OMV / Compose
```

**Invalid email or password in the browser, but `curl` to `/api/auth/login` works**

Confirm bootstrap credentials, then:

```sh
docker exec ownkeep printenv OWNKEEP_ADMIN_EMAIL
curl -i -X POST http://localhost:7001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your_admin_password"}'
```

If `curl` succeeds but the browser fails, check DevTools → Network for
`POST /api/auth/login`. An external reverse proxy must forward `/api` (not only `/`).

**Large Keep Takeout ZIPs**

Raise the servlet multipart limit above the default 25 MiB and set
`OWNKEEP_IMPORT_MAX_UPLOAD_SIZE` accordingly.

---

## Environment variables

Values are read from the process environment (Compose `.env`, `docker run -e`,
or Secret Manager in hosted setups). Durations use Spring/`java.time` forms such
as `PT24H`, `30d`, or `1m`.

### Required for first boot

| Variable | Description |
|----------|-------------|
| `OWNKEEP_DATABASE_URL` | Postgres URL: `postgresql://user:pass@host:port/db` or `jdbc:postgresql://…`. Embedded credentials are extracted automatically. For Compose with the bundled `db` service, host must be `db`. |
| `OWNKEEP_ADMIN_EMAIL` | Bootstrap admin email (must be a valid email). Used only when no admin exists yet; ignored afterwards. Always treated as verified. |
| `OWNKEEP_ADMIN_PASSWORD` | Bootstrap admin password (same lifecycle as above). |

### Optional — database overrides

Usually unnecessary when credentials are embedded in `OWNKEEP_DATABASE_URL`.

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_DATABASE_USER` | `ownkeep` | Datasource username when not taken from the URL |
| `OWNKEEP_DATABASE_PASSWORD` | `ownkeep` | Datasource password when not taken from the URL |

### Auth and sessions

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_TOKEN_TTL` | `30d` | Bearer token lifetime |
| `OWNKEEP_LOGIN_MAX_ATTEMPTS_PER_IP` | `10` | Max `/auth/login` attempts per client IP per window |
| `OWNKEEP_LOGIN_MAX_ATTEMPTS_PER_EMAIL` | `5` | Max `/auth/login` attempts per email per window |
| `OWNKEEP_LOGIN_RATE_LIMIT_WINDOW` | `1m` | Login rate-limit window |
| `OWNKEEP_MAX_SYNC_LIMIT` | `200` | Maximum notes/search page size |

### Email verification (optional)

Disabled by default. When `OWNKEEP_EMAIL_VERIFICATION_REQUIRED=true`, non-admin
users must verify before login, and `OWNKEEP_PUBLIC_BASE_URL` plus SMTP settings
are required.

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_EMAIL_VERIFICATION_REQUIRED` | `false` | Gate login on verified email for non-admins |
| `OWNKEEP_PUBLIC_BASE_URL` | _(empty)_ | Public origin for verification links (e.g. `https://notes.example.com`) |
| `OWNKEEP_EMAIL_VERIFICATION_TOKEN_TTL` | `24h` | Verification token lifetime |
| `OWNKEEP_EMAIL_VERIFY_MAX_ATTEMPTS_PER_IP` | `10` | Resend/verify rate limit per IP |
| `OWNKEEP_EMAIL_VERIFY_MAX_ATTEMPTS_PER_EMAIL` | `5` | Resend/verify rate limit per email |
| `OWNKEEP_EMAIL_VERIFY_RATE_LIMIT_WINDOW` | `1m` | Verification rate-limit window |
| `OWNKEEP_MAIL_HOST` | _(empty)_ | SMTP host |
| `OWNKEEP_MAIL_PORT` | `587` | SMTP port |
| `OWNKEEP_MAIL_USERNAME` | _(empty)_ | SMTP username |
| `OWNKEEP_MAIL_PASSWORD` | _(empty)_ | SMTP password |
| `OWNKEEP_MAIL_SMTP_AUTH` | `true` | Enable SMTP AUTH |
| `OWNKEEP_MAIL_STARTTLS` | `true` | Use STARTTLS |
| `OWNKEEP_MAIL_FROM` | _(empty)_ | From header (falls back to username when unset) |

### Attachments

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_ATTACHMENT_STORAGE` | `filesystem` | Blob backend: `filesystem` or `gcs` |
| `OWNKEEP_ATTACHMENT_STORAGE_ROOT` | `./data/attachments` (Docker: `/data/attachments`) | Directory for filesystem storage |
| `OWNKEEP_ATTACHMENT_MAX_FILE_SIZE` | `26214400` (25 MiB) | Application-level max upload size (bytes) |
| `OWNKEEP_ATTACHMENT_PER_USER_QUOTA` | `1073741824` (1 GiB) | Per-user attachment quota (bytes) |
| `OWNKEEP_ATTACHMENT_GCS_BUCKET` | _(empty)_ | Required when `storage=gcs` |
| `OWNKEEP_ATTACHMENT_GCS_PREFIX` | _(empty)_ | Optional object key prefix (e.g. `ownkeep/`) |
| `OWNKEEP_MULTIPART_MAX_FILE_SIZE` | `100MB` | Servlet multipart max file size |
| `OWNKEEP_MULTIPART_MAX_REQUEST_SIZE` | `101MB` | Servlet multipart max request size |

GCS auth uses Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`
or the runtime service account).

### Google Keep Takeout import

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_IMPORT_MAX_UPLOAD_SIZE` | `104857600` (100 MiB) | Max Takeout ZIP size (also capped by servlet multipart limits) |
| `OWNKEEP_IMPORT_MAX_ENTRIES` | `5000` | Max entries in a Takeout ZIP |
| `OWNKEEP_IMPORT_MAX_ENTRY_SIZE` | `52428800` (50 MiB) | Max single ZIP entry size |
| `OWNKEEP_IMPORT_MAX_UNCOMPRESSED_SIZE` | `524288000` (500 MiB) | Max total uncompressed ZIP size |
| `OWNKEEP_IMPORT_MAX_WARNINGS` | `100` | Max stored import warnings |
| `OWNKEEP_TAKEOUT_IMPORT_STAGING_ROOT` | `<attachment-storage-root>/.imports` | Optional override for ZIP extraction staging |

### Runtime / image

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_SPA_STATIC_DIR` | unset locally; Docker `/app/static` | Filesystem SPA overlay before classpath static assets |
| `LOADER_PATH` | Docker `/app/extensions` | Extra classpath for extension JARs (SaaS overlays) |
| `SERVER_FORWARD_HEADERS_STRATEGY` | Compose sets `framework` | Trust `X-Forwarded-*` behind a reverse proxy |

### Compose / host helpers (not read by the JVM)

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNKEEP_PORT` | `8080` | Host port mapping in Compose (`HOST:8080`) |
| `OWNKEEP_IMAGE_TAG` | `latest` | Tag for `rzarajczyk/ownkeep-core` in `docker-compose.yaml` |

---

## Development

```sh
# Optional: local Postgres only (or use Neon via .env)
docker compose up -d db

# Load OWNKEEP_* from .env, then:
cd api && ./gradlew bootRun
cd web && npm ci && npm run dev
```

Open **http://localhost:5173** (Vite proxies `/api` → `:8080`). Prefer Neon in
`.env` unless you explicitly want a local database.

- API health: `GET http://localhost:8080/api/health` (or `/health` without the prefix)
- OpenAPI: `GET /api/openapi.json`

More detail: [api/README.md](api/README.md), [web/README.md](web/README.md).

---

## Security

- Notes and attachments are zero-knowledge encrypted in the browser; the API stores opaque ciphertext only
- On first unlock, each user receives a **recovery key** — store it offline. Admin password reset clears the password wrap; recovery is required to regain vault access
- Configure secrets only via environment / `.env` (never commit secrets)
- Use HTTPS and a reverse proxy in production; bind `OWNKEEP_PORT=127.0.0.1:8080` if the proxy runs on the same host
- Rotate any credential that was ever committed or shared

---

## Image publishing

CI on `main` builds and pushes `rzarajczyk/ownkeep-core` to Docker Hub (plus
version/timestamp tags). It then dispatches `core-image-published` to the
private `ownkeep-saas` repository, which builds the SaaS image and deploys to
Cloud Run.

Repository secret required on `ownkeep-core`:

| Secret | Purpose |
|--------|---------|
| `SAAS_DISPATCH_TOKEN` | GitHub PAT with `repo` scope (or fine-grained access to `ownkeep-saas` workflows) used to trigger `repository_dispatch` after each core image publish |
