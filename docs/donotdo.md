# Do not do

Hard rules for this repository. If a change violates this list, reject it.

## Secrets and credentials

- Do not hard-code credentials, JWT secrets, or worker tokens.
- Do not store WePlay or dashboard passwords in plaintext.
- Do not import or persist Google / Facebook / X passwords, OTP codes, or CAPTCHA tokens.
- Do not automate creation of consumer Google, Facebook, or X identities (signup.google.com, phone/CAPTCHA bypass, scraping).
- Official Google Workspace Admin SDK Directory provisioning **inside this organization’s domain**, using administrator-authorized credentials, is allowed.
- Do not put service-account keys, OAuth client secrets, refresh tokens, or Directory passwords in frontend source, logs, or the `workspace_user_provisionings` table.
- Do not automate or bypass CAPTCHA, OTP, phone verification, rate limits, or provider security checks.
- Do not commit `.env`, device keystores, or session dumps.
- Do not put authentication secrets in frontend source.
- Do not log passwords, tokens, cookies, or SMS/OTP codes.

## Architecture

- Do not duplicate business logic across web, API, and Android.
- Do not put database queries in UI components.
- Do not put business logic or SQL in route handlers.
- Do not put controller, scheduling, or account-management logic in Android UI.
- Do not mix WePlay UI automation with database, dashboard, or API route code.
- Do not use an in-memory-only job queue.
- Do not depend only on process memory for jobs or account state.

## Scale and demos

- Do not hard-code 5 accounts.
- Do not hard-code 10 accounts.
- Do not hard-code 300 accounts.
- Do not write `if (accounts.length === 5)` or `if (accounts.length === 10)` or `if (accounts.length === 300)`.
- Do not create a separate demo architecture for the first five accounts.
- Do not assume one worker equals one account forever; use a pool plus preferred-device binding.
- Do not hard-code a 4 Google / 3 Facebook / 3 X identity template in production UI.

## Execution integrity

- Do not silently swallow errors.
- Do not retry infinitely.
- Do not blindly execute unknown jobs twice.
- Do not report job `SUCCEEDED` unless the worker verified the action (support, join, or a live WePlay session after setup).
- Do not mark an account `READY` only because a login or OAuth screen appeared, or because a Google / Facebook / X button was tapped.
- Do not fabricate WePlay UI success when selectors have not been inspected.
- Do not treat `login_google` (a string resource) or ColorOS `uiautomator dump` as a tap target on StartActivity.
- Do not assume one Android user / WePlay install can keep isolated sessions for multiple persisted accounts; this Oppo has no clone/work profile.
- Do not create Google Workspace users from **Create WePlay Accounts**; those users must already exist in the organization.
- Do not create WePlay sessions except through existing `setup` / `reauth` (and legacy `create_account`) jobs on the worker pool.
- Do not repeat account onboarding when the account is already `READY` with a persisted verified session.
- Do not auto-recreate accounts that need re-authentication; use **Re-authenticate**.

## Scope

- Do not create unnecessary infrastructure (Redis, Kubernetes, extra brokers) unless a measured need appears.
- Do not add fashionable frameworks that are not required.
- Do not rewrite working code without a concrete defect or requirement.
- Do not claim an integration works without testing it.
- Do not skip recovery on API startup.
