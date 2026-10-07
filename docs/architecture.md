# WePlay Automation Architecture

This document describes the production architecture used from the first 5 accounts through 300+ accounts. There is no separate demo stack.

## Overall architecture

The system is a pnpm monorepo with three runnable applications and three shared packages:

- `apps/web` — operator dashboard (React, TypeScript, Tailwind)
- `apps/api` — controller, HTTP API, job queue, persistence (Fastify, TypeScript)
- `apps/android-worker` — device worker that executes WePlay workflows (Kotlin)
- `packages/types` — shared TypeScript contracts (statuses, DTOs, error codes)
- `packages/shared` — state machines, retry policy, ID helpers (no I/O)
- `packages/config` — default configuration values and environment schema

```
Operator (browser)
    │  REST + SSE
    ▼
API / Controller  ── PostgreSQL (prod) or SQLite (local)
    │  REST (register, heartbeat, claim, report)
    ▼
Android Worker pool
    │  WePlayWorkflow interface
    ▼
WePlay (Android)
```

The API process is the source of truth. The dashboard never owns business state. Workers never own job or account records.

Capacity target: **500 concurrent managed accounts** and a configurable worker pool. Nothing in code branches on “5” or “300”.

## Implementation notes

- Local and tests use SQLite; production uses PostgreSQL. Relative `sqlite:` paths resolve from the repository root.
- The dashboard live channel is SSE (`GET /api/events?token=`). Workers use REST poll/claim.
- `tests/e2e` is an in-process API scale test (300 accounts, 8 mock workers), not a browser Playwright suite. That keeps the stack small while proving the same controller path.
- WePlay UI automation on the USB worker inspects StartActivity via `dumpsys activity top`. ColorOS `uiautomator dump` is a dummy `[0,0][0,0]` node. `login_google` is a string resource, not a view ID; Google is the first `WejoyLargeLoginBtnView` under `login_vertical_btn_layout`. `WePlayUiAutomatorAdapter` still returns `AUTOMATION_NOT_INSPECTED` until that same path is implemented on-device. Operators can still confirm one-time setup from the dashboard. A logged-in session on a new setup is `ACCOUNT_ALREADY_EXISTS`. One WePlay install / Android user holds one in-app session; this Oppo has no clone/work profile, so it cannot keep isolated sessions for multiple persisted accounts at once.

## Frontend

- React 18 + TypeScript + Vite + Tailwind CSS
- React Router for pages: Dashboard, Accounts, Create WePlay Accounts, Import identities, Google Workspace Users, Workers, Jobs, Logs, Settings
- TanStack Query for REST reads/mutations
- EventSource (SSE) for live counters and table refresh signals
- JWT stored in memory + `sessionStorage` (not baked into source)

UI components call API helpers only. State transitions, eligibility, and retries live on the server.

## Backend

Fastify application with layered responsibilities:

| Layer | Location | Allowed to do |
| --- | --- | --- |
| Routes | `apps/api/src/routes` | Auth, validate input (Zod), call services, map HTTP |
| Services | `apps/api/src/services` | Business rules, orchestration, emitting events |
| Repositories | `apps/api/src/repositories` | SQL only |
| Domain | `packages/shared` | Pure state machines and policies |
| Controller | `apps/api/src/controller` | Claim jobs, assign workers, recover, tick |

Routes must not contain SQL. Android automation must not live in the API.

Operator authentication: username/password (bcrypt) → JWT.

Worker authentication: registration returns a worker token (HMAC-signed). Heartbeat, claim, and result endpoints require that token.

## Database

Portable SQL migrations in `database/migrations`. Types used everywhere: `TEXT`, `INTEGER` (booleans as 0/1, timestamps as Unix ms).

| Environment | Engine | Connection |
| --- | --- | --- |
| Local / tests | SQLite | `DATABASE_URL=sqlite:./data/weplay.db` |
| Production | PostgreSQL | `DATABASE_URL=postgres://...` |

The database layer (`apps/api/src/db`) converts `?` placeholders to `$n` for PostgreSQL. Repositories never talk to a driver directly.

Core tables: `operators`, `accounts`, `workers`, `runs`, `jobs`, `event_logs`, `settings`, `workspace_provisioning_batches`, `workspace_user_provisionings`.

Jobs and account state are fully persisted. A process restart reloads from the database; there is no in-memory-only queue.

## Controller

The controller is a persistent loop inside the API process (`CONTROLLER_TICK_MS`, default 1000ms).

On each tick, if the global controller is `RUNNING`:

1. Mark stale workers `OFFLINE` when heartbeat is older than `HEARTBEAT_TIMEOUT_MS`.
2. Fail or requeue jobs whose assigned worker is stale (`JOB_STALE_MS`).
3. For each `ACTIVE` run still within duration, enqueue the next eligible account job if the interval has elapsed and no in-flight job exists for that account+run.
4. Assign `QUEUED` jobs to eligible idle workers.
5. Persist all transitions and emit SSE events.

Controller status (`STOPPED` / `PAUSED` / `RUNNING`) is stored in `settings`, not RAM, so it survives restart.

## Scheduler

The scheduler is not a separate service. It is the enqueue portion of the controller:

- A **run** holds room ID, support target, account selection, duration, and interval.
- Duration must be one of the configured options (default 1 / 3 / 5 / 15 minutes). Interval default is 5000ms. Both are stored on the run, never hard-coded in workflow code.
- While a run is `ACTIVE` and `now < startedAt + durationMs`, the scheduler keeps accounts cycling: after a job completes, the same account is eligible again after `intervalMs`.
- `PAUSE` stops new assignments. In-flight jobs finish unless `STOP` cancels them.

## Job queue

The queue **is** the `jobs` table.

Claiming is concurrency-safe:

- SQLite: `BEGIN IMMEDIATE` + `UPDATE … WHERE id = ? AND status = 'QUEUED'`
- PostgreSQL: `FOR UPDATE SKIP LOCKED`

A job is never claimed twice. Each execution attempt has a unique `execution_id`. Retries create a new `execution_id` and increment `attempt_count`.

## Worker

Workers are a pool. An account may record a **preferred** `worker_id` (the device that holds the WePlay session). Assignment rules:

1. If the account has a preferred worker and that worker is `IDLE`, assign it.
2. If the account has no preferred worker, assign any `IDLE` worker and persist the preference after successful setup.
3. If the preferred worker is busy or offline, the job stays queued (session must not silently move to another device).

Worker states: `OFFLINE`, `STARTING`, `IDLE`, `BUSY`, `ERROR`, `STOPPING`.

The worker process:

1. Registers (`POST /api/workers/register`)
2. Heartbeats (`POST /api/workers/heartbeat`)
3. Claims or receives a job
4. Executes `WePlayWorkflow`
5. Reports progress and a terminal result
6. Returns to `IDLE`

## Android automation layer

WePlay UI automation is isolated in `apps/android-worker` under `workflow/`.

`WePlayWorkflow` is the only API the rest of the worker may call:

- `initialize`
- `checkLoginState`
- `createAccount`
- `verifyAccountCreated`
- `startProviderLogin`
- `performInitialSetup`
- `verifySession`
- `navigateToVoiceRooms`
- `searchRoom`
- `enterRoom`
- `handlePermissions`
- `selectSupportTarget`
- `performSupport`
- `verifySupport`
- `leaveOrRemainInRoom`
- `cleanup`

Until WePlay’s accessibility tree / resource IDs are inspected on a real device, `WePlayUiAutomatorAdapter` must **not** report success. It returns a structured failure (`AUTOMATION_NOT_INSPECTED`). Google / Facebook / X login is isolated in provider adapters (`workflow/providers` on Android, `apps/usb-worker/src/providers` on USB). WePlay navigation stays in `WePlayWorkflow`. The USB worker is the live setup executor: it opens WePlay, taps the inspected provider control when bounds are found, and pauses with `VERIFICATION_REQUIRED` on provider security screens. Operators complete that check on-device and click **Resume Setup**. Tapping a provider button or reaching an OAuth screen is never `READY`. Confirm setup in the dashboard remains an explicit operator action, not a fabricated support result.

## Account lifecycle

```
Create WePlay Accounts (existing Workspace users, Google)
Import identities (choose Google / Facebook / X)
            │
            ▼
     SETUP_REQUIRED / SETUP_IN_PROGRESS
            │
            ▼
     ACTION_REQUIRED ──► Resume Setup ──► SETUP_IN_PROGRESS
            │
            ▼
     READY (worker verified WePlay session; session persisted)
            │
     NEEDS_REAUTH ──► Re-authenticate (same account, not recreate)
            │
     PROCESSING / SUCCESS / FAILED / DISABLED / OFFLINE
```

`ACTION_REQUIRED` means a provider verification, permission, or unmapped login control needs the operator on the device. The worker must not type passwords, complete CAPTCHA, or bypass OTP. After the operator finishes that check, **Resume Setup** re-queues setup with `resume: true`. READY is stored only when the worker verifies `MainActivity` / a live WePlay session (`verified=true`) and the API persists `metadata.sessionVerified`. Reaching a login or OAuth screen is not success.

One WePlay install on one Android user holds one in-app session. The inspected Oppo (user 0 only, no clone/work profile, package `com.wejoy.weplay.ar` once) cannot keep isolated sessions for multiple persisted WePlay accounts at the same time. Switching identities requires logout (the previous session is replaced). Device Google accounts are shared with the GMS picker and are not WePlay session slots.

Once setup is `COMPLETED` and the session is persisted, later jobs skip onboarding. If the worker later reports `AUTH_REQUIRED` / `NEEDS_REAUTH`, the account moves to `NEEDS_REAUTH`. **Re-authenticate** queues a `reauth` job on the existing account.

`OFFLINE` is used when the preferred worker is stale and the account cannot run. Preferred-worker binding is a pool hint after a successful session, not a permanent 1:1 device lock unless the live WePlay session requires that device.

Eligible for support jobs: `enabled = 1`, setup completed, status in `READY` or `SUCCESS`, not `NEEDS_REAUTH` / `DISABLED` / `SETUP_*` / `ACTION_REQUIRED`.

The system never creates Google, Facebook, or X identities. **Import identities** (`POST /api/accounts/import`) registers display name + chosen provider (Google, Facebook, or X) for logins the operator already owns, then queues a `setup` job. Phone/OTP identities are rejected. Passwords and OTP fields are rejected. Count is not fixed in production code.

**Create WePlay Accounts** (`GET /api/accounts/workspace-candidates`, website `POST /api/devicefarm/provision`) lists users that already exist in this Google Workspace organization and starts the locked Pixel Device Farm worker one account at a time. It does not call Directory `users.insert`. See [How it works](working.md#workspace-users-to-weplay).

A separate **Google Workspace Users** flow provisions users **inside this organization’s Workspace domain** through Google’s official Admin SDK Directory API (`users.get` / `users.insert`). It does not create consumer Google accounts, scrape Google, or bypass signup protections. Credentials stay on the API. See [How it works](working.md#google-workspace-user-provisioning).

`Add account` still only records a login the operator already has (`SETUP_REQUIRED`).

## Job lifecycle

```
QUEUED → ASSIGNED → RUNNING → SUCCEEDED
                    │              └→ (run still active → new job after interval)
                    ├→ FAILED → RETRYING → QUEUED (attempt_count < max)
                    ├→ FAILED (terminal)
                    └→ CANCELLED
```

Job fields: `id`, `account_id` (nullable for Workspace jobs), `worker_id`, `run_id`, `execution_id`, `configuration`, `status`, `attempt_count`, timestamps, `error_code`, `error_message`.

`workspace_provision` jobs are executed by the API controller (not Android workers) against the Admin SDK. `SUCCESS` for WePlay support jobs is recorded only when the worker reports that `verifySupport()` passed.

## Data flow

1. Operator creates/enables accounts and completes setup.
2. Operator creates a run (room ID, target, accounts, duration, interval).
3. Operator starts the controller and the run.
4. Controller inserts `QUEUED` jobs.
5. Idle workers claim jobs; API marks `ASSIGNED` / `RUNNING`.
6. Worker runs `WePlayWorkflow` and reports.
7. API updates job, account, event log, SSE.
8. Scheduler waits `intervalMs` and continues until duration elapses or STOP.

## Communication

| Channel | Use |
| --- | --- |
| REST | CRUD, auth, worker register/heartbeat/claim/report |
| SSE | Dashboard live stats and “data changed” pings |
| Worker REST poll | Reliable job delivery if push is unavailable |

Workers poll `POST /api/workers/jobs/claim` on each idle tick. This stays correct with dozens of devices; 300 accounts do not imply 300 pollers.

## Error handling

Canonical error codes live in `@weplay/types`:

`AUTH_REQUIRED`, `SETUP_REQUIRED`, `WORKER_OFFLINE`, `NETWORK_ERROR`, `TIMEOUT`, `ROOM_NOT_FOUND`, `TARGET_NOT_FOUND`, `SUPPORT_FAILED`, `APP_CRASHED`, `INVALID_CONFIGURATION`, `UNKNOWN_STATE`, `AUTOMATION_NOT_INSPECTED`, `NEEDS_REAUTH`, `MAX_RETRIES_EXCEEDED`, `SIGNUP_FAILED`, `UNEXPECTED_SCREEN`, `PERMISSION_REQUIRED`, `VERIFICATION_REQUIRED`, `ACCOUNT_ALREADY_EXISTS`, `RATE_LIMITED`, `WORKSPACE_NOT_CONFIGURED`, `WORKSPACE_USER_INVALID`, `WORKSPACE_DUPLICATE_USERNAME`, `WORKSPACE_LICENSE_EXHAUSTED`, `WORKSPACE_QUOTA_EXCEEDED`.

Every failure is logged (`event_logs`), stored on the job and account, and shown in the UI. Exceptions are not swallowed.

Retry policy (configurable, default max 3):

- Retry: `NETWORK_ERROR`, `TIMEOUT`, `APP_CRASHED`, `WORKER_OFFLINE` (requeue), `RATE_LIMITED` (Workspace Directory calls, exponential backoff)
- No retry, mark account `NEEDS_REAUTH`: `AUTH_REQUIRED`, `NEEDS_REAUTH`
- No retry, mark account `SETUP_REQUIRED`: `SETUP_REQUIRED`
- No retry, mark account `ACTION_REQUIRED` when setup/reauth hits `VERIFICATION_REQUIRED`, `PERMISSION_REQUIRED`, or (for setup) `AUTOMATION_NOT_INSPECTED` / `UNEXPECTED_SCREEN`
- No retry, mark account `CREATION_FAILED` when job kind is `create_account`: `SIGNUP_FAILED`, `ACCOUNT_ALREADY_EXISTS`, `UNEXPECTED_SCREEN`, `AUTOMATION_NOT_INSPECTED`, `PERMISSION_REQUIRED`, `VERIFICATION_REQUIRED`
- Terminal job failure: `ROOM_NOT_FOUND`, `TARGET_NOT_FOUND`, `SUPPORT_FAILED`, `INVALID_CONFIGURATION`, `UNKNOWN_STATE`, `AUTOMATION_NOT_INSPECTED`

## Recovery

On API startup:

1. Workers with stale heartbeats → `OFFLINE`.
2. `RUNNING` / `ASSIGNED` jobs whose worker is offline or heartbeat stale → `FAILED` with `WORKER_OFFLINE` (retry if policy allows, new `execution_id`). Workspace Directory jobs are not failed as worker-offline.
3. `SETUP_IN_PROGRESS` accounts whose worker is gone → `SETUP_REQUIRED`.
4. Controller status reloaded from `settings`.
5. Active runs whose duration has passed → `COMPLETED`.
6. Interrupted Workspace `CREATING` rows are reconciled against Directory `users.get` so a restart does not insert duplicates.

## Google Workspace provisioning

Workspace user creation is a first-class job kind (`workspace_provision`) in the same persistent `jobs` table and controller loop. It is not a second application and not an Android worker workflow.

```
Operator dashboard (CSV import / preview / start)
    │
    ▼
API ── workspace_provisioning_batches + workspace_user_provisionings
    │
    ▼
Controller tick (configurable concurrency)
    │
    ▼
Google Admin SDK Directory API (users.get, users.insert)
```

Authentication is a Workspace admin service account with domain-wide delegation. Scope: `https://www.googleapis.com/auth/admin.directory.user`. Private keys, JSON credentials, and refresh tokens stay in backend environment variables or a server-side file. The dashboard only sees whether the domain and credentials are present.

Per-user records persist `PENDING` / `VALIDATING` / `CREATING` / `CREATED` / `ALREADY_EXISTS` / `FAILED` / `RETRYING`. Before `users.insert`, the controller calls `users.get`. If the user exists, the row is `ALREADY_EXISTS`. Transient `429` / `5xx` errors retry with exponential backoff. Passwords required by Directory `users.insert` are generated ephemerally, sent with `changePasswordAtNextLogin: true`, and never stored or logged.

## Scaling to 300 accounts

Workers that restart register with the same `device_identifier` and resume heartbeats. They do not invent job success for work they did not verify.

Frontend refresh re-fetches REST state; SSE is a hint, not the store.

## Scaling to 300 accounts

- Accounts, jobs, and workers are unbounded rows. Indexes on `jobs(status, scheduled_at)`, `accounts(status, enabled)`, `workers(status, last_heartbeat)`.
- Throughput ≈ idle workers, not account count. 300 accounts with 10 workers means a queue, not 300 threads.
- Preferred-worker assignment avoids thrashing sessions across devices.
- Synthetic tests enqueue hundreds of jobs against mock workers to prove there is no 5/10/300 special case.

## Security

- Dashboard JWT auth; role `admin` for mutating operations
- Worker token distinct from operator JWT
- Passwords hashed with bcrypt; no password columns on `accounts`
- WePlay sessions stay on the Android device; API never stores account passwords
- Secrets only via environment variables; `.env` is gitignored
- Zod validation on all write endpoints
- Structured logs omit secrets
- CORS restricted to `CORS_ORIGIN`
