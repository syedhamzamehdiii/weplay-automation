# WePlay Device Farm Android worker

Website-controlled worker package. The API generates this YAML, uploads the test zip, and schedules the AWS Device Farm run. Do **not** paste this spec into the Device Farm console.

This is the **locked Pixel flow**, proven end-to-end on a fresh Device Farm Pixel 8a. Create WePlay Accounts starts **one Pixel run** for the whole selection: Play identity and Play Store WePlay install happen once, then each selected Workspace account is added and signed into WePlay on that same device.

Claim success per account only after `provisioning-result.json` includes that email with `ok: true` and a WePlay user id.

## Locked sequence on a fresh device

1. `pre_test`: `adb shell locksettings set-pin "1234"`
2. Start Appium 3 / UiAutomator2 **without** requiring WePlay to already be installed
3. Settings → Google → Add account for the Play Store identity (`WEPLAY_PLAY_STORE_EMAIL`)
4. Google Welcome TOS: scroll / down-arrow, then **I agree** / **Accept**
5. Open Google Play Store and install `com.wejoy.weplay.ar` once (never sideload)
6. For each `WEPLAY_GOOGLE_EMAILS` target:
   1. Settings → Google → Add account when it is not already on the device
   2. Welcome TOS, then **I agree** / **Accept**
   3. Open WePlay, tap Sign in with Google, and **select that target** (never Continue as the Play identity or managed Play account)
   4. Collect `weplayUserId`
   5. `pm clear` WePlay so the next identity can sign in. The Play-installed APK stays.
7. Write `provisioning-result.json` with an `accounts` array for the API
8. `post_test`: `adb shell locksettings clear --old "1234"` even if pytest failed

Join a game code only when `WEPLAY_GAME_CODE` is set. Otherwise skip join; operators start rooms later from Jobs.

If Google shows CAPTCHA, MFA, “verify it’s you”, or a real **Try another way** challenge, that account is `ACTION_REQUIRED` and remaining accounts on this Pixel stop. The worker does not try to bypass it.

## Environment variables

Injected by the API into the generated spec. Do not commit values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `WEPLAY_GOOGLE_EMAIL` | **Yes** | First Workspace account in the run (also used if `WEPLAY_GOOGLE_EMAILS` is empty) |
| `WEPLAY_GOOGLE_EMAILS` | No | Comma-separated Workspace accounts to create on this Pixel after WePlay is installed |
| `WEPLAY_PLAY_STORE_EMAIL` | **Yes** | Trusted Workspace account used to sign into Play Store first. Defaults to `GOOGLE_WORKSPACE_ADMIN_EMAIL` from the API. |
| `WEPLAY_GOOGLE_PASSWORD` | **Yes** for a fresh device | Shared Workspace password. Never logged. |
| `WEPLAY_DEVICE_PIN` | No | Defaults to `1234`. Must match `pre_test` / `post_test`. |

## Local helper checks

```bash
cd devicefarm
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m pytest tests/test_helpers.py -vv
python -c "import weplay_df, weplay_df.flow, weplay_df.provision, weplay_df.playstore, weplay_df.google_account"
```

Live tests are skipped unless `DEVICEFARM_DEVICE_UDID` or `WEPLAY_DEVICE_FARM_LIVE=1` is set.
