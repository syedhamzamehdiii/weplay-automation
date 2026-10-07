# How the system works

End-to-end operator and runtime flow. This matches the implemented controller, not a future design.

## Happy path

### 0. Operator creates WePlay accounts from existing Workspace users

On **Accounts → Create WePlay Accounts**, the operator loads users that already exist in this Google Workspace organization (name, Workspace email, Google provider, Workspace status, current WePlay status). The operator selects one, several, or all eligible users. This flow does **not** call Directory `users.insert`.

The website starts the locked Amazon Device Farm Pixel worker (`POST /api/devicefarm/provision`) one account at a time:

- Play Store identity → Play Store install WePlay → Settings add the selected Workspace account → Welcome I agree → WePlay Google Sign-In
- `loginProvider = GOOGLE`, `metadata.origin = workspace`, `metadata.workspaceEmail` / `workspaceUserId`
- a `devicefarm_provision` job is queued; USB `setup` is not used when Device Farm is configured

Events: `ACCOUNT_CREATED` (if new), `DEVICEFARM_PROVISION_STARTED`, worker progress. READY is stored only after the Pixel worker writes a WePlay user id and the API persists `metadata.sessionVerified`. If Google shows CAPTCHA, MFA, or a real Try another way challenge: `ACTION_REQUIRED`. After that is resolved, start the Device Farm worker again. If the session later fails: `NEEDS_REAUTH` and start Device Farm again on the same account.

### 1. Operator adds account

On **Accounts → Add account**, the operator enters a display name, login provider (Google, Facebook, X, Phone), and optional preferred worker. The API inserts a row with:

- `status = NEW` then immediately `SETUP_REQUIRED`
- `setup_status = REQUIRED`
- `enabled = 1`

Event: `ACCOUNT_CREATED`.

The system does not create WePlay users from **Add account**. It only records accounts the operator intends to manage. Workspace-backed WePlay setup is **Create WePlay Accounts**. Google Workspace user creation stays on the **Google Workspace Users** page.

### 1b. Operator imports owned identities

On **Accounts → Import identities**, the operator chooses Google, Facebook, or X, then registers existing logins (display name + provider + optional worker). Phone/OTP is not accepted. Passwords are not accepted. Each row queues a `setup` job for that provider adapter. The worker opens WePlay, starts the selected provider login, and must verify a WePlay session after resume. Tapping the provider button is not success.

The API inserts each row as `SETUP_REQUIRED`, then (by default) queues a `setup` job:

- `status = SETUP_IN_PROGRESS`
- `setup_status = IN_PROGRESS`
- `metadata.origin = import`
- `metadata.setupProgress` updated live via SSE

Events: `ACCOUNT_IMPORTED`, `ACCOUNT_SETUP_STARTED`, worker `ACCOUNT_SETUP_PROGRESS`.

Production code does not hard-code 10 (or any other) account count. A 4 Google / 3 Facebook / 3 X set is integration-test fixture data only.

### 2. Account setup starts

Operator clicks **Start setup**. If a worker is assigned (or one is idle and can be bound):

- Account → `SETUP_IN_PROGRESS`
- A setup job is queued (`job.configuration.kind = "setup"`)
- Event: `ACCOUNT_SETUP_STARTED`

The USB worker opens WePlay, taps the matching Google / Facebook / X control from the inspected StartActivity layout (`dumpsys activity top`), then:

- If `MainActivity` / voice room is already showing on a **new** setup: fail `ACCOUNT_ALREADY_EXISTS` (log out first).
- If a Google / Facebook / X / permission screen appears: fail `VERIFICATION_REQUIRED` or `PERMISSION_REQUIRED`. Account → `ACTION_REQUIRED`. Dashboard shows **Resume Setup**. The worker does not type credentials, complete CAPTCHA, or bypass OTP.
- After the operator finishes that check on the device and clicks **Resume Setup**, a new setup job runs with `resume: true`. If the worker then verifies a WePlay session, the account becomes `READY`.
- `AUTOMATION_NOT_INSPECTED` during setup also pauses as `ACTION_REQUIRED` so the operator can tap the provider on device and resume.
- `verified=true` from worker after `MainActivity` / live session, with `metadata.sessionVerified` persisted
- operator **Confirm setup complete** as an explicit attestation if the worker cannot verify

Unverified `complete` (`verified: false`) is rejected. Reaching an OAuth screen or tapping a provider button is not READY.

### 3. Login/setup is completed

On setup success (worker verified login state **or** operator confirmed):

- `setup_status = COMPLETED`
- `status = READY`
- preferred `worker_id` stored if missing
- Event: `ACCOUNT_SETUP_COMPLETED`, `ACCOUNT_READY`

Later runs skip onboarding unless the account enters `NEEDS_REAUTH`.

### 4. Account becomes READY

Dashboard counters include the account in **Ready**. It is eligible for support jobs.

### 5. Operator creates a run

On **Jobs → New run**:

- Room ID
- Support target identifier/name
- Account selection (explicit IDs; “all ready” is a UI helper that expands to IDs)
- Duration: one of configured durations (1, 3, 5, 15 minutes by default)
- Interval: default 5000ms unless overridden
- Optional notes

Saved as a `runs` row with `status = DRAFT` and a JSON `configuration` blob. Nothing is hard-coded in executors.

### 6. Configuration is saved

`POST /api/runs` validates:

- duration is in `allowedDurationsMs`
- interval ≥ 0
- at least one account ID
- room ID and target non-empty

### 7. Controller creates jobs

Operator clicks **START** on the dashboard (global controller) and **Start** on the run.

Run → `ACTIVE`, `started_at` set, `ends_at = started_at + durationMs`.

Controller tick enqueues a `QUEUED` support job per eligible selected account that does not already have an in-flight job for this run.

Event: `JOB_CREATED`.

### 8. Jobs enter queue

Jobs sit in PostgreSQL/SQLite until an eligible worker claims them. Restart-safe.

### 9. Worker receives job

Idle worker: `POST /api/workers/jobs/claim`.

API transaction:

- select queued job whose account prefers this worker (or has no preference, setup jobs only)
- `status = ASSIGNED`, `worker_id` set, `started_at` still null
- worker → `BUSY`, `current_job_id` set
- account → `PROCESSING`

Worker then `POST .../jobs/:id/start` → `RUNNING`.

Events: `JOB_ASSIGNED`, `JOB_STARTED`.

### 10. Worker executes WePlay workflow

Support job sequence (modular methods, not one mega-function):

1. `initialize`
2. `checkLoginState` — if logged out → fail `AUTH_REQUIRED`
3. `navigateToVoiceRooms`
4. `searchRoom(roomId)`
5. `enterRoom`
6. `handlePermissions`
7. `selectSupportTarget(target)`
8. `performSupport`
9. `verifySupport` — **required for SUCCESS**
10. `cleanup`

Progress events may be sent (`ROOM_OPENED`, `SUPPORT_STARTED`, …).

### 11. Worker reports result

`POST /api/workers/jobs/:id/complete` or `.../fail` with `execution_id` so stale reports cannot complete the wrong attempt.

### 12. Backend updates database

Success:

- job `SUCCEEDED`
- account `SUCCESS`, `last_success_at`, `last_used_at`
- worker `IDLE`, `current_job_id` cleared
- events `SUPPORT_SUCCEEDED`, `JOB_COMPLETED`

Failure: job `FAILED` or `RETRYING`; account `FAILED` or `NEEDS_REAUTH`; error fields persisted.

### 13. Controller schedules next account

If the run is still `ACTIVE` and `now < ends_at`:

- after `intervalMs` from job completion, that account (and others) may receive a new job
- work is parallel across idle workers; sequential per account

When duration elapses: run `COMPLETED`; remaining `QUEUED` jobs for that run `CANCELLED`.

### 14. Dashboard updates

SSE `stats` / `changed` events trigger refetch. Refresh without SSE still shows correct state from REST.

---

## Failure and recovery paths

### Account needs re-authentication

Worker reports `AUTH_REQUIRED` / `NEEDS_REAUTH`:

- account → `NEEDS_REAUTH` (dashboard attention)
- job failed, **not** retried as a support job
- account is **not** deleted or recreated
- operator starts **Re-authenticate**, which behaves like setup (`SETUP_IN_PROGRESS` + setup job)

### Worker disconnects

Missed heartbeats beyond `HEARTBEAT_TIMEOUT_MS`:

- worker → `OFFLINE`
- in-flight job → failed `WORKER_OFFLINE`
- retry policy may requeue with a new `execution_id`
- event `WORKER_DISCONNECTED`

If the account required that device, new jobs wait until it returns.

### Network fails

Worker: retry heartbeat/claim with backoff; do not report SUCCESS.

API: job claim is transactional; a timed-out HTTP call without a commit does not assign the job.

Retryable job errors use `NETWORK_ERROR` until `maxRetries`.

### App crashes

Worker process dies → heartbeats stop → same as disconnect. If the worker recovers quickly with the same `execution_id` still `RUNNING`, it may report the real outcome. It must not mark SUCCESS without `verifySupport()`.

Error code `APP_CRASHED` when the worker detects WePlay died mid-job.

### Job fails

Logged, persisted, shown on Jobs and Account history. Retry only for retryable codes and `attempt_count < maxRetries`. Unknown UI state → `UNKNOWN_STATE`, no retry loop.

### Backend restarts

1. Open database (jobs/accounts intact).
2. Recovery pass (stale workers/jobs, expired runs).
3. Resume controller from saved `controller.status`.
4. Do **not** duplicate unknown executions; new work uses new `execution_id`.

### Frontend refresh

JWT still in `sessionStorage` → reload pages from API. No client-side job queue.

### Operator STOP / PAUSE / RESUME

- **PAUSE**: controller skips assignment; in-flight jobs continue.
- **RESUME**: assignment continues.
- **STOP**: controller stopped; `ACTIVE` runs → `STOPPED`; `QUEUED`/`ASSIGNED` jobs → `CANCELLED`. Running jobs are cancelled at next worker poll if still cancellable; otherwise they finish and are recorded.

---

## Google Workspace user provisioning

This flow creates users **inside the administered Workspace domain** with Google’s Admin SDK Directory API. It does not sign up consumer Google accounts.

### Happy path

1. Administrator enables Admin SDK, creates a service account, and grants domain-wide delegation with scope `https://www.googleapis.com/auth/admin.directory.user`.
2. Operator sets backend env vars (`GOOGLE_WORKSPACE_DOMAIN`, `GOOGLE_WORKSPACE_ADMIN_EMAIL`, service-account file or JSON). The dashboard never receives the key.
3. On **Google Workspace Users**, the operator imports a CSV (`firstName,lastName,username` plus optional `displayName`).
4. The API stores a `workspace_provisioning_batches` row and one `workspace_user_provisionings` row per user. Email is `username@GOOGLE_WORKSPACE_DOMAIN`.
5. **Validate** checks usernames and, when credentials are present, Directory `users.get` for existing accounts.
6. **Preview** shows requested / valid / already exists / failed.
7. **Start** queues `workspace_provision` jobs. The API controller executes them in-process with configurable concurrency (this does not require the WePlay device controller to be START/RUNNING).
8. For each user: persist `CREATING` → `users.get` → if missing, `users.insert` → store Google user id as `CREATED`. If present, `ALREADY_EXISTS`.
9. Transient API errors (`429`, `5xx`, timeouts) mark `RETRYING` and requeue with exponential backoff.
10. Dashboard counters update over SSE. **Pause** stops claiming new jobs; in-flight Directory calls finish. **Cancel** fails remaining `PENDING`/`RETRYING` rows and does not undo `CREATED` / `ALREADY_EXISTS`.
11. **Export result** downloads CSV status (no passwords).

Events: `PROVISIONING_IMPORT_STARTED`, `PROVISIONING_VALIDATION_COMPLETED`, `USER_CREATE_STARTED`, `USER_CREATED`, `USER_ALREADY_EXISTS`, `USER_CREATE_FAILED`, `PROVISIONING_COMPLETED`.

### Licensing

The UI warns that success depends on available Workspace licenses, org limits, Admin API quotas, and domain setup. Directory `users.list` is the live user count. Remaining seats come from Reports customer usage (`*_total_licenses`) when Google publishes those fields. Many current Workspace plans omit them; in that case the dashboard shows **—** and points to Admin Console → Billing. Google may still reject `users.insert` with a license or quota error, which is stored as `FAILED`.

### Restart

If the API stops mid-batch, `CREATING` rows are reconciled with `users.get`. Existing Directory users are marked created/already-exists instead of inserting again.

## Workspace users to WePlay

Create WePlay Accounts does not provision Directory users. It lists existing org users and starts the locked Pixel Device Farm worker:

1. `GET /api/accounts/workspace-candidates` joins Directory `users.list` with local `accounts` by `metadata.workspaceEmail`.
2. The website queues selected emails and calls `POST /api/devicefarm/provision` one Pixel at a time. When Device Farm is configured, `POST /api/accounts/weplay-create` starts the same worker for the first eligible email instead of USB `setup`.
3. READY requires a WePlay user id from `provisioning-result.json` and persists `metadata.sessionVerified`.
4. `ACTION_REQUIRED` pauses for on-device Google verification. Start the Device Farm worker again after it is resolved.
5. Invalid session → `NEEDS_REAUTH` → Device Farm again on the existing account, never a new Workspace user and never a duplicate WePlay account.

### Session isolation on one Android environment

The attached Oppo (user 0 only, no clone/work profile, one `com.wejoy.weplay.ar` install) cannot keep two WePlay logins isolated at the same time. WePlay stores a single in-app session; logging in as another identity replaces it. Device Google accounts are shared with the GMS picker and are not WePlay sessions. Switching persisted WePlay accounts on this phone requires logout / re-auth on that same install, or a separate device/worker. Do not assume READY accounts stay live on this environment after another identity signs in.

