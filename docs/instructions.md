# Instructions

Commands in this file match the repository as implemented. If a command fails, fix the repo or this file — do not leave them out of sync.

## Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable` then `corepack prepare pnpm@9.15.4 --activate`)
- JDK 17+ (Android worker only)
- Android SDK / Android Studio (Android worker only)
- PostgreSQL 15+ (production)
- SQLite (bundled via `better-sqlite3` for local/dev)

## Installation

From the repository root:

```bash
pnpm install
```

Copy environment template:

```bash
cp .env.example .env
```

Change `JWT_SECRET`, `WORKER_TOKEN_SECRET`, and `INITIAL_ADMIN_PASSWORD` before any non-local use.

## Environment variables

See `.env.example`. Important variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `sqlite:./data/weplay.db` or `postgres://user:pass@host:5432/weplay` |
| `API_PORT` | API port (default `3001`) |
| `CORS_ORIGIN` | Dashboard origin (default `http://localhost:5173`) |
| `JWT_SECRET` | Operator JWT signing secret |
| `WORKER_TOKEN_SECRET` | Worker token signing secret |
| `HEARTBEAT_TIMEOUT_MS` | Stale worker threshold (default `30000`) |
| `CONTROLLER_TICK_MS` | Controller loop (default `1000`) |
| `MAX_JOB_RETRIES` | Maximum retries per job (default `3`) |
| `DEFAULT_INTERVAL_MS` | Default gap between account jobs (default `5000`) |
| `ALLOWED_DURATIONS_MS` | Comma-separated duration options |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | First operator (seeded if no operators exist) |
| `GOOGLE_WORKSPACE_DOMAIN` | Workspace domain used to build `username@domain` (not hard-coded) |
| `GOOGLE_WORKSPACE_ADMIN_EMAIL` | Admin user impersonated via domain-wide delegation |
| `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE` | Path to service-account JSON, relative to the **repository root** (example: `secrets/workspace-service-account.json`) |
| `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON` | Optional inline JSON if a file path is not used |
| `GOOGLE_WORKSPACE_PROVISION_CONCURRENCY` | Parallel Directory API calls (default `4`) |
| `GOOGLE_WORKSPACE_PROVISION_MAX_RETRIES` | Per-user transient retries (default `5`) |
| `GOOGLE_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS` | Backoff base for `429` / `5xx` (default `1000`) |

## Database setup

Migrations run automatically on API start. To run them alone:

```bash
pnpm --filter @weplay/api db:migrate
```

Seed the admin operator (also happens on API start if the operators table is empty):

```bash
pnpm --filter @weplay/api db:seed
```

PostgreSQL (production):

```bash
createdb weplay
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/weplay pnpm --filter @weplay/api db:migrate
```

## Backend setup

```bash
pnpm --filter @weplay/api dev
```

API listens on `http://localhost:3001`. Health: `GET /api/health`.

## Frontend setup

```bash
pnpm --filter @weplay/web dev
```

Dashboard: `http://localhost:5173`. Log in with `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.

## Android worker setup

1. Open `apps/android-worker` in Android Studio.
2. Set `API_BASE_URL` in `local.properties` (for example `http://10.0.2.2:3001` on an emulator).
3. Install WePlay on the device.
4. Build and run the `app` configuration.
5. Confirm the worker appears on the **Workers** page and heartbeats.

UI selectors: ColorOS `uiautomator dump` is unusable (dummy `[0,0][0,0]` node). USB setup taps StartActivity via `dumpsys activity top` (`WejoyLargeLoginBtnView` under `login_vertical_btn_layout`). Support jobs still fail with `AUTOMATION_NOT_INSPECTED` until `WePlayUiAutomatorAdapter` is completed. A device that is already logged in fails with `ACCOUNT_ALREADY_EXISTS`. Those failures are expected and are not reported as success.

## Import owned identities and setup

1. Open **Accounts → Import identities**.
2. Choose **Google**, **Facebook**, or **X**.
3. Enter display names for logins you already own. Do not enter passwords, OTP, or phone numbers.
4. Optionally pick a default worker.
5. Click **Start sign-in**. Each identity gets a `setup` job for that provider.
6. Watch setup progress on the account page (SSE). If the worker hits a provider security screen, the account becomes **ACTION_REQUIRED**.
7. Complete that check on the phone yourself, then click **Resume Setup**.
8. READY is set only after the worker verifies a WePlay session (`MainActivity` or equivalent), not because a provider button was tapped.

The 10-account (4 Google / 3 Facebook / 3 X) case lives in `tests/fixtures/provisioning-identities.json` and `tests/integration/provisioning-ten-accounts.test.ts`. It is not special-cased in the API or dashboard.

## Create WePlay accounts from Workspace users

1. Provision users on **Google Workspace Users** if they do not already exist in the org (Directory insert). Do not use Create WePlay Accounts to create Workspace users.
2. Open **Accounts → Create WePlay Accounts**.
3. Review name, Workspace email, provider (Google), Workspace status, and current WePlay status.
4. Select one, several, or all eligible users.
5. Click **Start Device Farm worker**. The website runs the locked Pixel flow one account at a time (Play identity → Play Store install WePlay → Settings add the selected Workspace account → Welcome I agree → WePlay Google Sign-In).
6. If Google shows CAPTCHA, MFA, or Try another way, the run stops at `ACTION_REQUIRED`. Resolve it, then start the Device Farm worker again.
7. READY is stored only after the Pixel worker obtains a WePlay user id. Join a room later from Jobs.
8. If the session later fails, the account becomes **NEEDS_REAUTH**. Start Device Farm again on that account; do not recreate it.

## Google Workspace user provisioning

1. In Google Cloud, enable **Admin SDK API** for the project that owns the service account.
2. Create a service account. Enable **domain-wide delegation**. In Workspace Admin → Security → API controls → Domain-wide delegation, add the service account **client ID** (numeric, from the JSON key `client_id`, not the `client_email`) with scopes `https://www.googleapis.com/auth/admin.directory.user` (create users) and `https://www.googleapis.com/auth/admin.reports.usage.readonly` (usage reports). Remaining seat count still shows **—** when Google does not publish `*_total_licenses` for the plan; that is not a missing-scope error. Do not put both scopes on the same JWT used for user insert; the API uses a separate token for reports.
3. Put the JSON key on the API host (or the JSON in `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON`). Set `GOOGLE_WORKSPACE_DOMAIN` and `GOOGLE_WORKSPACE_ADMIN_EMAIL` (a Super Admin or User Management admin).
4. Restart the API. Open **Google Workspace Users**. Confirm domain and credential flags (the key itself is never shown).
5. Import a CSV:

```csv
firstName,lastName,username
Hamza,Ahmed,user001
Arjun,Khan,user002
```

Emails become `user001@YOUR_DOMAIN`. Optional column: `displayName`.
6. Read the license/quota warning. Validate, preview, then Start. Pause / Resume / Cancel apply to this batch. Cancel does not delete users Google already created.
7. Export the result CSV. Temporary Directory passwords are generated for `users.insert` with **change password at next login** and are not stored.

Workspace tests use a mock Directory client (`tests/helpers/mockDirectory.ts`). They never create real Workspace users.

## Create a WePlay account

Use **Create WePlay Accounts** (Workspace users) or **Import identities** (Google / Facebook / X). The standalone provider+phone signup form is no longer the operator path.

1. Open **Accounts**.
2. Click **Create WePlay Accounts**.
3. Select existing Workspace users and start Google WePlay setup.
4. Watch the account page for live progress via SSE.
5. After verified session, the account is READY. Re-authenticate if the session later expires.

## Development commands

```bash
pnpm install          # install all workspaces
pnpm dev              # API + web together
pnpm --filter @weplay/api dev
pnpm --filter @weplay/web dev
pnpm --filter @weplay/api build
pnpm --filter @weplay/web build
pnpm --filter @weplay/shared build
pnpm --filter @weplay/types build
pnpm --filter @weplay/config build
```

## Test commands

```bash
pnpm test                 # unit + integration
pnpm test:unit
pnpm test:integration
pnpm test:e2e             # requires API+web or Playwright webServer
```

Integration tests use a temporary SQLite file and generic accounts (including a 10-identity OAuth import fixture). They do not special-case production code for n=5 or n=10.

## Production build

```bash
pnpm build
```

Outputs:

- `apps/api/dist`
- `apps/web/dist` (static files; serve behind any static host or the API static plugin if enabled)

Run API:

```bash
NODE_ENV=production DATABASE_URL=postgres://... pnpm --filter @weplay/api start
```

Serve `apps/web/dist` with nginx or similar; point `CORS_ORIGIN` at that origin.

## Deployment

1. Provision PostgreSQL.
2. Set production secrets (`JWT_SECRET`, `WORKER_TOKEN_SECRET`, admin password).
3. Run migrations.
4. Run `apps/api` as a supervised process (systemd, Docker, etc.).
5. Serve the web build.
6. Install the Android worker APK on each device; configure `API_BASE_URL` and register.

Do not run the API as multiple unsupervised replicas until job claiming is confirmed against PostgreSQL `SKIP LOCKED` (supported). SQLite is for single-process local use only.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| API will not start | `DATABASE_URL`, file permissions for SQLite `data/` directory |
| Login fails | Seed ran; password from `.env`; `JWT_SECRET` unchanged since token was issued |
| Worker stays OFFLINE | Device clock, `API_BASE_URL`, network, heartbeat logs |
| Jobs stuck RUNNING | API recovery on restart; heartbeat timeout; Workers page |
| `ACTION_REQUIRED` / `VERIFICATION_REQUIRED` | Complete Google/Facebook/X check on the device; click Resume Setup |
| `AUTOMATION_NOT_INSPECTED` | Expected until WePlay UI is inspected; for setup, tap the provider on device then Resume Setup |
| Dashboard not live-updating | SSE blocked by proxy; REST still correct on refresh |
| Postgres placeholder errors | Ensure API dialect detection sees `postgres://` |
| Workspace “not configured” | Domain, admin email, and service-account JSON/file on the API process |
| `users.insert` 403 | Domain-wide delegation / scope / admin email impersonation |
| `WORKSPACE_LICENSE_EXHAUSTED` / quota | Buy or free a Workspace license; wait out Admin API quota |
| Duplicate Workspace users after restart | Should not happen; recovery uses `users.get` before insert. Inspect `ALREADY_EXISTS` |
