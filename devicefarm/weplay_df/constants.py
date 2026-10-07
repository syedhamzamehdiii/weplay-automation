"""WePlay Device Farm constants. No credentials live here."""

from __future__ import annotations

import os

WEPLAY_PACKAGE = "com.wejoy.weplay.ar"
PLAY_STORE_PACKAGE = "com.android.vending"
SETTINGS_PACKAGE = "com.android.settings"
START_ACTIVITY = "com.wepie.wespy.module.login.start.StartActivity"
MAIN_ACTIVITY = "com.wepie.wespy.module.main.MainActivity"
VOICE_ROOM_ACTIVITY = "BaseVoiceRoomActivity"

DEVICE_PIN = os.environ.get("WEPLAY_DEVICE_PIN", "1234")

GOOGLE_EMAIL_ENV = "WEPLAY_GOOGLE_EMAIL"
GOOGLE_EMAILS_ENV = "WEPLAY_GOOGLE_EMAILS"
PLAY_STORE_EMAIL_ENV = "WEPLAY_PLAY_STORE_EMAIL"
GOOGLE_PASSWORD_ENV = "WEPLAY_GOOGLE_PASSWORD"
GAME_CODE_ENV = "WEPLAY_GAME_CODE"
SUPPORT_TARGET_ENV = "WEPLAY_SUPPORT_TARGET"
RUN_MODE_ENV = "WEPLAY_RUN_MODE"

# Inspected WePlay 6.4.5 StartActivity: first WejoyLargeLoginBtnView is Google.
# On Oppo 720x1432 the Google center was ~50% x, ~61% y.
DEFAULT_GOOGLE_TAP_X_RATIO = float(os.environ.get("WEPLAY_GOOGLE_TAP_X_RATIO", "0.50"))
DEFAULT_GOOGLE_TAP_Y_RATIO = float(os.environ.get("WEPLAY_GOOGLE_TAP_Y_RATIO", "0.61"))

GOOGLE_PACKAGES = (
    "com.google.android.gms",
    "com.google.android.gsf",
    "com.google.android.gsf.login",
    "com.android.vending",
    "com.android.chrome",
    "org.chromium.chrome",
    "com.google.android.googlequicksearchbox",
)

PIN_ACTIVITY_HINTS = (
    "confirmdevice",
    "confirmlockpassword",
    "confirmlockpattern",
    "keyguard",
    "pinpad",
    "chooselock",
    "confirmcredential",
    "devicecredential",
    "confirmdevicecredential",
    "biometricprompt",
)

ACCOUNT_PICKER_HINTS = (
    "accountpicker",
    "accountchip",
    "minutemaid",
    "signinactivity",
    "auth.uiflows",
    "credentialmanager",
    "bottomsheet",
)

# Native OAuth consent is allowed. These are security challenges we must not bypass.
# Specific MFA/CAPTCHA phrases are checked before generic "verify it's you", which is
# also used by Android Confirm Device Credential (handled as a PIN screen when a keypad is present).
ACTION_REQUIRED_HINTS = (
    "2-step verification",
    "two-step verification",
    "two-factor",
    "authenticator",
    "captcha",
    "recaptcha",
    "i'm not a robot",
    "not a robot",
    "unusual activity",
    "this browser or app may not be secure",
    "couldn't sign you in",
    "couldn't verify",
    "phone number",
    "get a verification code",
    "enter the code",
    "sms code",
    "recovery email",
    "confirm your recovery",
    "try another way",
    "choose how you want to sign in",
    "passkey",
    "fingerprint",
    "face unlock",
    "verify it's you",
    "verify its you",
    "use your screen lock",  # handled as PIN if keypad is present; otherwise challenge
)

GOOGLE_TRANSIENT_ERROR_HINTS = (
    "something went wrong",
    "please go back and try again",
    "there was a problem",
    "couldn't add account",
)

WEPLAY_ACCOUNT_BLOCKED_HINTS = (
    "account has been blocked",
    "community guidelines",
    "[login failed]",
)

CONSENT_BUTTON_LABELS = (
    "continue",
    "allow",
    "agree",
    "i agree",
    "accept",
    "yes",
    "ok",
    "next",
)
WELCOME_BUTTON_LABELS = (
    "i agree",
    "agree",
    "accept",
    "continue",
    "i understand",
)
WELCOME_ACCEPT_ONLY_LABELS = (
    "i agree",
    "agree",
    "accept",
    "i understand",
)

LOGIN_SCREEN_MARKERS = (
    "login_view",
    "login_vertical_btn_layout",
    "WejoyLoginView",
    "WejoyLargeLoginBtnView",
    "StartActivity",
)

POST_LOGIN_MARKERS = (
    "MainActivity",
    "module.main.MainActivity",
    "BaseVoiceRoomActivity",
    "voiceroom.main",
    "tab_switch_view",
    "search_room_imv",
    "voice_room_list_rv",
)

POLL_INTERVAL_S = 0.4
LOGIN_SCREEN_TIMEOUT_S = 45
GOOGLE_BUTTON_TIMEOUT_S = 45
ACCOUNT_PICKER_TIMEOUT_S = 45
GOOGLE_AUTH_TIMEOUT_S = 120
WEPLAY_RETURN_TIMEOUT_S = 120
PLAY_STORE_TIMEOUT_S = 180
GOOGLE_ADD_ACCOUNT_TIMEOUT_S = 180
JOIN_ROOM_TIMEOUT_S = 60
SUPPORT_CLICK_TIMEOUT_S = 25
PROVISION_RESULT_FILENAME = "provisioning-result.json"

SUPPORT_LABELS = ("show support", "support")

SEARCH_ROOM_VIEW_ID = "search_room_imv"
TAB_SWITCH_VIEW_ID = "tab_switch_view"
PERMISSION_ALLOW_LABELS = ("while using the app", "allow only this time", "allow")
WEPLAY_ONBOARDING_LABELS = ("skip", "next", "start", "get started", "enter", "done")
JOIN_CONFIRM_LABELS = ("confirm",)
JOIN_ROOM_TAB_LABELS = ("room id",)
JOIN_USER_TAB_LABELS = ("user id",)

# Exact button labels. Do not include "continue": Play Store listings keep a
# bottom Continue / chrome control that would be tapped instead of Get/Install.
PLAY_STORE_INSTALL_LABELS = ("install", "get", "update", "download", "enable", "try again")
PLAY_STORE_OPEN_LABELS = ("open",)
PLAY_STORE_ACCEPT_LABELS = ("accept", "install anyway", "i agree")
PLAY_STORE_TOS_CONTINUE_LABELS = ("continue",)
PLAY_STORE_UNAVAILABLE_HINTS = (
    "this item isn't available",
    "this item is not available",
    "item isn't available",
    "item is not available",
    "your administrator has not given you access",
    "administrator has not given you access to this item",
    "your device isn't compatible",
    "your device is not compatible",
    "not available in your country",
    "isn't available in your country",
    "isn't available in your region",
    "can't find this item",
    "cannot find this item",
    "we're sorry, the requested url was not found",
)
PLAY_STORE_TOS_HINTS = (
    "welcome to google play",
    "google play terms",
    "play terms of service",
)
PLAY_STORE_PROGRESS_HINTS = (
    "downloading",
    "installing",
    "pending",
    "waiting to download",
    "waiting for wifi",
)
ADD_ACCOUNT_LABELS = ("google",)
ADD_ACCOUNT_NEXT_LABELS = ("next", "continue")
SETTINGS_ADD_ACCOUNT_LABELS = (
    "add another account",
    "add account",
    "add an account",
)
SETTINGS_ACCOUNTS_ENTRY_LABELS = (
    "passwords, passkeys & accounts",
    "passwords & accounts",
    "passwords and accounts",
    "users & accounts",
)
# Credential Manager: tap these to leave "Continue as <Play identity>".
SELECT_ANOTHER_ACCOUNT_LABELS = (
    "select another account",
    "choose another account",
    "use another account",
    "use a different account",
    "sign in with another account",
    "show other accounts",
    "switch account",
    "none of the above",
)
ADD_ACCOUNT_FROM_PICKER_LABELS = (
    "add another account",
    "add account",
    "add an account",
)
ADD_ANOTHER_ACCOUNT_LABELS = SELECT_ANOTHER_ACCOUNT_LABELS + ADD_ACCOUNT_FROM_PICKER_LABELS
GOOGLE_NEXT_LABELS = ("next", "continue", "done", "i agree", "agree", "accept", "skip", "no thanks")
