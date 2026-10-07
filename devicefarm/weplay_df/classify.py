"""Classify the current Android screen from package/activity/UI evidence."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from weplay_df.constants import (
    ACTION_REQUIRED_HINTS,
    GOOGLE_PACKAGES,
    GOOGLE_TRANSIENT_ERROR_HINTS,
    LOGIN_SCREEN_MARKERS,
    MAIN_ACTIVITY,
    PIN_ACTIVITY_HINTS,
    POST_LOGIN_MARKERS,
    START_ACTIVITY,
    WEPLAY_PACKAGE,
)
from weplay_df.ui import UiNode, page_text


class ScreenKind(str, Enum):
    WEPLAY_LOGIN = "weplay_login"
    WEPLAY_MAIN = "weplay_main"
    WEPLAY_ROOM = "weplay_room"
    WEPLAY_ONBOARDING = "weplay_onboarding"
    GOOGLE_ACCOUNT_PICKER = "google_account_picker"
    GOOGLE_IDENTIFIER = "google_identifier"
    GOOGLE_PIN = "google_pin"
    GOOGLE_PASSWORD = "google_password"
    GOOGLE_WELCOME = "google_welcome"
    GOOGLE_CONSENT = "google_consent"
    GOOGLE_GENERIC = "google_generic"
    PLAY_STORE = "play_store"
    ADD_ACCOUNT = "add_account"
    ACTION_REQUIRED = "action_required"
    PERMISSION = "permission"
    OTHER = "other"


@dataclass(frozen=True)
class Screen:
    kind: ScreenKind
    package: str
    activity: str
    evidence: str


def _norm(value: str | None) -> str:
    return (value or "").strip()


def _joined(*parts: str) -> str:
    return " ".join(p for p in parts if p).lower()


def is_weplay_package(package: str) -> bool:
    return WEPLAY_PACKAGE in package or "com.wepie.wespy" in package


def is_google_package(package: str, activity: str = "") -> bool:
    blob = _joined(package, activity)
    if any(pkg in blob for pkg in GOOGLE_PACKAGES):
        return True
    return "accounts.google" in blob or "customtab" in blob


def looks_like_signing_in(page_source: str, nodes: list[UiNode] | None = None) -> bool:
    hay = f"{page_text(page_source)} {page_source or ''} {' '.join(n.haystack for n in (nodes or []))}".lower()
    if looks_like_tourist_login_tip(page_source, nodes):
        return False
    return "signing in" in hay or "id_tv_loadingmsg" in hay


def looks_like_tourist_login_tip(page_source: str, nodes: list[UiNode] | None = None) -> bool:
    hay = f"{page_text(page_source)} {page_source or ''} {' '.join(n.haystack for n in (nodes or []))}".lower()
    return "tourist login is not supported" in hay


def looks_like_region_confirm(page_source: str, nodes: list[UiNode] | None = None) -> bool:
    """WePlay asks 'Are you sure to choose Pakistan?' after Register OK. Confirm/Cancel, not OK."""
    blob = f"{page_source or ''} {' '.join(n.haystack for n in (nodes or []))}".lower()
    text = page_text(page_source)
    hay = f"{text} {blob}"
    if "confirm_sure" in hay or "id/confirm_title" in hay:
        return True
    if "are you sure to choose" in hay:
        return True
    if "select the region" in hay:
        return False
    return (
        "cannot be changed" in hay
        and "confirm" in hay
        and "cancel" in hay
        and ("pakistan" in hay or "arabic" in hay)
    )


def looks_like_region_register(page_source: str, nodes: list[UiNode] | None = None) -> bool:
    if looks_like_region_confirm(page_source, nodes):
        return False
    text = page_text(page_source)
    hay = f"{text} {' '.join(n.haystack for n in (nodes or []))}".lower()
    return "select the region" in hay or (
        "register" in hay and ("pakistan" in hay or "arabic" in hay or "cannot be changed after selection" in hay)
    )


def looks_like_login_ui(page_source: str, nodes: list[UiNode] | None = None) -> bool:
    hay = page_source or ""
    if any(marker in hay for marker in LOGIN_SCREEN_MARKERS):
        return True
    texts = [n.text.lower() for n in (nodes or []) if n.text]
    return "google" in texts and ("facebook" in texts or "sign in" in " ".join(texts))


def looks_like_post_login(package: str, activity: str, page_source: str) -> bool:
    blob = _joined(package, activity, page_source)
    if not is_weplay_package(package) and "com.wepie.wespy" not in blob:
        return False
    if START_ACTIVITY.split(".")[-1].lower() in activity.lower() and "login_view" in page_source:
        return False
    return any(marker.lower() in blob for marker in POST_LOGIN_MARKERS)


def _pin_digit_count(nodes: list[UiNode]) -> int:
    digits: set[str] = set()
    for node in nodes:
        for raw in (node.text, node.content_desc):
            token = (raw or "").strip()
            if token in set("0123456789"):
                digits.add(token)
        rid = node.resource_id.lower()
        for digit in "0123456789":
            if f"key{digit}" in rid or f"key_{digit}" in rid or rid.endswith(f"/{digit}"):
                digits.add(digit)
    return len(digits)


def looks_like_pin_screen(package: str, activity: str, page_source: str, nodes: list[UiNode]) -> bool:
    blob = _joined(package, activity)
    if any(hint in blob for hint in PIN_ACTIVITY_HINTS):
        return True
    text = page_text(page_source)
    digit_count = _pin_digit_count(nodes)
    if digit_count >= 4 and any(
        phrase in text
        for phrase in (
            "verify it's you",
            "verify its you",
            "use your screen lock",
            "confirm your screen lock",
            "enter pin",
            "enter your pin",
            "device pin",
            "enter your device pin",
            "enter lock screen pin",
            "confirm pin",
        )
    ):
        return True
    pin_text = any(
        phrase in text
        for phrase in (
            "enter pin",
            "enter your pin",
            "confirm pin",
            "device pin",
            "confirm your screen lock",
            "use your screen lock",
            "enter your device pin",
            "enter lock screen pin",
        )
    )
    if not pin_text:
        return False
    return digit_count >= 4 or any("key" in n.resource_id.lower() and n.clickable for n in nodes)


def looks_like_play_store(package: str, activity: str) -> bool:
    blob = _joined(package, activity)
    return "com.android.vending" in blob or "play.core" in blob


def looks_like_add_account(package: str, activity: str, page_source: str) -> bool:
    blob = _joined(package, activity, page_source)
    text = page_text(page_source)
    if "addaccount" in blob or "chooseaccounttype" in blob or "add_account" in blob:
        return True
    return "add an account" in text or "add account" in text


def looks_like_identifier_screen(page_source: str, nodes: list[UiNode]) -> bool:
    text = page_text(page_source)
    if any(n.password for n in nodes):
        return False
    if any(
        phrase in text
        for phrase in (
            "email or phone",
            "enter your email",
            "sign in with your google account",
            "sign in with your work account",
            "work email",
            "forgot email",
            "create account",
        )
    ):
        return True
    return any("identifier" in n.resource_id.lower() or n.resource_id.endswith("/email") for n in nodes)


def looks_like_password_screen(page_source: str, nodes: list[UiNode]) -> bool:
    text = page_text(page_source)
    if looks_like_google_welcome(page_source):
        return False
    if "i agree" in text and "welcome" in text:
        return False
    if any(n.password for n in nodes):
        if "pin" in text and "password" not in text:
            return False
        return True
    return any(
        phrase in text
        for phrase in ("enter your password", "show password", "forgot password")
    )


def looks_like_google_welcome(page_source: str, target_email: str = "") -> bool:
    """Workspace 'Welcome to your new account' TOS. Continue/Accept is often below the fold."""
    text = page_text(page_source)
    if "welcome to google play" in text:
        return False
    if "choose an account" in text or "add another account" in text:
        return False
    if "welcome to your new account" in text:
        return True
    if "i agree" in text and ("welcome" in text or "administrator" in text):
        return True
    if "welcome" not in text:
        return False
    if any(
        phrase in text
        for phrase in (
            "your organization's administrator",
            "your organisation's administrator",
            "administrator manages this account",
            "administrator can access",
            "decides which google workspace",
        )
    ):
        return True
    if target_email and target_email.lower() in text:
        return "administrator" in text or "terms of service" in text or "privacy notice" in text
    return False


def looks_like_account_picker(package: str, activity: str, page_source: str, target_email: str) -> bool:
    if looks_like_google_welcome(page_source, target_email):
        return False
    text = page_text(page_source)
    if any(
        phrase in text
        for phrase in (
            "choose an account",
            "add another account",
            "add account",
            "use another account",
            "use a different account",
            "select another account",
            "select an account",
            "sign in with another account",
            "continue as",
        )
    ):
        return True
    blob = _joined(package, activity)
    if any(hint in blob for hint in ("accountpicker", "accountchip", "assistedsignin", "credentialmanager")):
        return True
    # The Workspace email also appears on the TOS "Welcome" screen. That is not a picker.
    if target_email and target_email.lower() in text:
        return "choose" in text or "another account" in text
    return False


def looks_like_consent(page_source: str) -> bool:
    if looks_like_google_welcome(page_source):
        return False
    text = page_text(page_source)
    if "i agree" in text and any(
        phrase in text
        for phrase in (
            "terms of service",
            "privacy policy",
            "welcome",
            "google play terms",
        )
    ):
        return True
    return any(
        phrase in text
        for phrase in (
            "wants to access",
            "access your google account",
            "see your email",
            "google account",
        )
    ) and any(label in text for label in ("allow", "continue", "accept", "agree"))


def looks_like_guest_login_dialog(page_source: str) -> bool:
    text = page_text(page_source)
    return "guest mode" in text or (
        "mobile phone number" in text and "log in" in text and ("cancel" in text or "confirm" in text)
    )


PASSKEY_CHALLENGE_PHRASES = (
    "use a passkey",
    "use your passkey",
    "sign in with a passkey",
    "sign in with passkey",
    "create a passkey",
    "create passkey",
    "save a passkey",
    "passkey created",
    "choose a passkey",
)


def looks_like_google_transient_error(page_source: str) -> bool:
    hay = page_text(page_source).lower()
    return any(hint in hay for hint in GOOGLE_TRANSIENT_ERROR_HINTS)


def looks_like_weplay_account_blocked(page_source: str) -> bool:
    from weplay_df.constants import WEPLAY_ACCOUNT_BLOCKED_HINTS

    hay = page_text(page_source).lower()
    return any(hint in hay for hint in WEPLAY_ACCOUNT_BLOCKED_HINTS)


def looks_like_action_required(page_source: str, nodes: list[UiNode], package: str = "") -> str | None:
    text = page_text(page_source)
    hay = f"{text} {page_source.lower()}"
    pin_context = looks_like_pin_screen("", "", page_source, nodes)
    weplay = is_weplay_package(package)
    for hint in ACTION_REQUIRED_HINTS:
        if hint in ("use your screen lock", "verify it's you", "verify its you") and pin_context:
            continue
        if hint in ("passkey", "fingerprint", "face unlock") and pin_context:
            continue
        if hint not in hay:
            continue
        if hint in ("phone number", "enter the code") and "choose an account" in text:
            continue
        # WePlay's guest-mode dialog mentions a phone number. That is not Google MFA.
        if weplay and hint == "phone number" and looks_like_guest_login_dialog(page_source):
            continue
        if weplay and hint == "phone number":
            continue
        # Settings homepage "Passwords, passkeys & accounts" contains "passkey". That is not a Google passkey challenge.
        if hint == "passkey" and not any(phrase in hay for phrase in PASSKEY_CHALLENGE_PHRASES):
            continue
        # Workspace Welcome TOS / password Next often still expose "Try another way" in the WebView.
        if hint in ("try another way", "choose how you want to sign in") and looks_like_google_welcome(page_source):
            continue
        if hint == "try another way" and looks_like_password_screen(page_source, nodes):
            continue
        return hint
    return None


def classify(
    package: str,
    activity: str,
    page_source: str,
    nodes: list[UiNode],
    target_email: str = "",
) -> Screen:
    package = _norm(package)
    activity = _norm(activity)
    blob = _joined(package, activity)

    if looks_like_google_welcome(page_source, target_email) and not is_weplay_package(package):
        return Screen(ScreenKind.GOOGLE_WELCOME, package, activity, "welcome to your new account")

    if is_weplay_package(package) and looks_like_weplay_account_blocked(page_source):
        return Screen(ScreenKind.ACTION_REQUIRED, package, activity, "weplay account blocked")

    challenge = looks_like_action_required(page_source, nodes, package)
    if challenge and not looks_like_pin_screen(package, activity, page_source, nodes):
        return Screen(ScreenKind.ACTION_REQUIRED, package, activity, challenge)

    if looks_like_pin_screen(package, activity, page_source, nodes):
        return Screen(ScreenKind.GOOGLE_PIN, package, activity, "pin keypad or confirm-lock")

    if looks_like_password_screen(page_source, nodes) and not is_weplay_package(package):
        return Screen(ScreenKind.GOOGLE_PASSWORD, package, activity, "password field")

    if looks_like_identifier_screen(page_source, nodes) and not is_weplay_package(package):
        return Screen(ScreenKind.GOOGLE_IDENTIFIER, package, activity, "email identifier")

    if (
        "packageinstaller" in blob
        or "permissioncontroller" in blob
        or "grantpermissions" in blob
        or "allow weplay to send you notifications" in page_text(page_source)
    ):
        return Screen(ScreenKind.PERMISSION, package, activity, "permission")

    if looks_like_consent(page_source) and not is_weplay_package(package):
        return Screen(ScreenKind.GOOGLE_CONSENT, package, activity, "google terms or oauth consent")

    if looks_like_play_store(package, activity):
        return Screen(ScreenKind.PLAY_STORE, package, activity, "play store")

    if looks_like_add_account(package, activity, page_source) and not is_weplay_package(package):
        return Screen(ScreenKind.ADD_ACCOUNT, package, activity, "add account")

    if looks_like_account_picker(package, activity, page_source, target_email):
        return Screen(ScreenKind.GOOGLE_ACCOUNT_PICKER, package, activity, "account picker")

    if is_google_package(package, activity):
        return Screen(ScreenKind.GOOGLE_GENERIC, package, activity, "google package")

    if is_weplay_package(package) or "com.wepie.wespy" in blob:
        if START_ACTIVITY.split(".")[-1].lower() in activity.lower() or looks_like_login_ui(page_source, nodes):
            if looks_like_tourist_login_tip(page_source, nodes):
                return Screen(ScreenKind.WEPLAY_ONBOARDING, package, activity, "tourist login tip")
            if looks_like_signing_in(page_source, nodes):
                return Screen(ScreenKind.WEPLAY_ONBOARDING, package, activity, "signing in")
            if looks_like_region_confirm(page_source, nodes):
                return Screen(ScreenKind.WEPLAY_ONBOARDING, package, activity, "region confirm")
            if looks_like_region_register(page_source, nodes):
                return Screen(ScreenKind.WEPLAY_ONBOARDING, package, activity, "region register")
            if looks_like_post_login(package, activity, page_source) and "login_view" not in page_source:
                return Screen(ScreenKind.WEPLAY_MAIN, package, activity, "main after start")
            return Screen(ScreenKind.WEPLAY_LOGIN, package, activity, "StartActivity / login_view")
        if MAIN_ACTIVITY.split(".")[-1].lower() in activity.lower() or "module.main.mainactivity" in blob:
            return Screen(ScreenKind.WEPLAY_MAIN, package, activity, "MainActivity")
        if "voiceroom" in blob or "basevoiceroom" in blob:
            return Screen(ScreenKind.WEPLAY_ROOM, package, activity, "voice room")
        if looks_like_post_login(package, activity, page_source):
            return Screen(ScreenKind.WEPLAY_MAIN, package, activity, "post-login ui")
        return Screen(ScreenKind.WEPLAY_ONBOARDING, package, activity, "weplay other")

    return Screen(ScreenKind.OTHER, package, activity, blob[:120])
