"""Add a Google Workspace account to a fresh Android device (Play Store identity first)."""

from __future__ import annotations

import logging
import time

from appium.webdriver.webdriver import WebDriver

from weplay_df.artifacts import capture_failure
from weplay_df.classify import ScreenKind, looks_like_google_transient_error, looks_like_google_welcome
from weplay_df.constants import (
    ADD_ACCOUNT_NEXT_LABELS,
    GOOGLE_ADD_ACCOUNT_TIMEOUT_S,
    SETTINGS_ACCOUNTS_ENTRY_LABELS,
    SETTINGS_ADD_ACCOUNT_LABELS,
    SETTINGS_PACKAGE,
)
from weplay_df.driver import (
    google_account_present,
    open_add_google_account,
    open_settings,
    press_keycode,
    scroll_into_view,
    swipe_up,
)
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.flow import (
    _click_labeled,
    _click_node,
    _labeled_node,
    complete_google_welcome,
    enter_device_pin,
    enter_google_identifier,
    enter_workspace_password,
    handle_consent,
    snapshot,
)
from weplay_df.prompts import dismiss_runtime_permission
from weplay_df.ui import UiNode

log = logging.getLogger("weplay.google")

_KEYCODE_BACK = 4
_MAX_GOOGLE_TRANSIENT_RETRIES = 3


def _mask_email(email: str) -> str:
    if "@" not in email:
        return "(invalid-email)"
    local, _, domain = email.partition("@")
    return f"{local[:2]}***@{domain}"


APP_BAR_MAX_BOTTOM = 280


def _is_app_bar(node: UiNode) -> bool:
    desc = node.content_desc.strip().lower()
    if desc in {"navigate up", "back", "close"}:
        return True
    if node.bounds and node.bounds.bottom <= APP_BAR_MAX_BOTTOM:
        return True
    return False


def settings_add_account_node(nodes: list[UiNode]) -> UiNode | None:
    """Add account row. Settings preference titles are often not marked clickable."""
    node = _labeled_node(nodes, SETTINGS_ADD_ACCOUNT_LABELS)
    if not node or _is_app_bar(node):
        return None
    # ChooseAccountActivity page title, not the action row.
    if node.text.strip().lower() == "add an account" and not node.clickable:
        if node.bounds and node.bounds.top < 320:
            return None
    return node


def settings_google_entry_node(nodes: list[UiNode]) -> UiNode | None:
    """Settings home 'Google' row, not toolbar chrome or 'Google Account'."""
    for node in nodes:
        if node.text.strip().lower() != "google":
            continue
        if _is_app_bar(node):
            continue
        if "google account" in node.haystack or "google play" in node.haystack:
            continue
        return node
    return None


def settings_accounts_entry_node(nodes: list[UiNode]) -> UiNode | None:
    node = _labeled_node(nodes, SETTINGS_ACCOUNTS_ENTRY_LABELS)
    if not node or _is_app_bar(node):
        return None
    return node


def _tap_google_row(driver: WebDriver, nodes: list[UiNode]) -> bool:
    entry = settings_google_entry_node(nodes)
    if entry and _click_node(driver, entry):
        return True
    return False


def _tap_settings_add_account(driver: WebDriver, nodes: list[UiNode]) -> bool:
    """Settings → Google → Add account. Prefer Add account over the Google heading."""
    node = settings_add_account_node(nodes)
    if node and _click_node(driver, node):
        log.info("Tapped Add account in Settings")
        return True
    return False


def _tap_settings_accounts_entry(driver: WebDriver, nodes: list[UiNode]) -> bool:
    node = settings_accounts_entry_node(nodes)
    if node and _click_node(driver, node):
        log.info("Opened Passwords & accounts in Settings")
        return True
    return False


def _in_settings(package: str, activity: str) -> bool:
    blob = f"{package} {activity}".lower()
    return SETTINGS_PACKAGE in blob or "settings" in blob


def add_workspace_account(driver: WebDriver, email: str) -> None:
    if google_account_present(email):
        log.info("Workspace account %s is already on the device", _mask_email(email))
        return

    open_settings()
    time.sleep(1.0)
    deadline = time.monotonic() + GOOGLE_ADD_ACCOUNT_TIMEOUT_S
    typed_email = False
    typed_password = False
    entered_pin = False
    used_intent_fallback = False
    used_scroll_into_view = False
    settings_swipes = 0
    google_error_retries = 0
    last_activity = ""
    last_screen = None
    last_package = ""
    last_source = ""
    started = time.monotonic()

    while time.monotonic() < deadline:
        if google_account_present(email):
            log.info("Workspace account %s added to the device", _mask_email(email))
            return

        screen, nodes, source = snapshot(driver, email)
        last_screen = screen
        last_package = screen.package
        last_source = source
        if looks_like_google_transient_error(source):
            google_error_retries += 1
            if google_error_retries > _MAX_GOOGLE_TRANSIENT_RETRIES:
                raise ActionRequired(
                    "Google showed 'Something went wrong' while adding the Workspace account on this Pixel. "
                    "This usually means Google blocked or rate-limited sign-in on the Device Farm device. "
                    "Wait and retry with one account, or sign in the Play Store identity on a real phone first."
                )
            log.warning(
                "Google transient error while adding %s; backing out and retrying (%s/%s)",
                _mask_email(email),
                google_error_retries,
                _MAX_GOOGLE_TRANSIENT_RETRIES,
            )
            press_keycode(driver, _KEYCODE_BACK)
            time.sleep(0.8)
            typed_email = False
            typed_password = False
            open_settings()
            time.sleep(0.8)
            continue
        if screen.activity != last_activity:
            settings_swipes = 0
            last_activity = screen.activity
        if "com.android.systemui" in (screen.package or "").lower() and not entered_pin:
            log.info("System UI credential prompt while adding the account; entering temporary device PIN")
            enter_device_pin(driver)
            entered_pin = True
            time.sleep(0.6)
            continue
        if screen.kind is ScreenKind.ACTION_REQUIRED:
            evidence = (screen.evidence or "").lower()
            confirm_lock = evidence in {
                "verify it's you",
                "verify its you",
                "use your screen lock",
                "fingerprint",
                "face unlock",
            }
            if confirm_lock and not entered_pin:
                log.info("Google confirm-device-credential screen while adding the account; entering temporary device PIN")
                enter_device_pin(driver)
                entered_pin = True
                time.sleep(0.6)
                continue
            if looks_like_google_welcome(source, email):
                complete_google_welcome(driver, email)
                time.sleep(1.0)
                continue
            if typed_password and evidence in {"try another way", "choose how you want to sign in"}:
                log.info(
                    "Password was submitted; scrolling for Accept before treating Try another way as MFA"
                )
                if complete_google_welcome(driver, email, accept_only=True):
                    time.sleep(1.0)
                    continue
            raise ActionRequired(
                f"Google presented a security challenge while adding the Workspace account ({screen.evidence}). "
                "Not attempting to bypass CAPTCHA, MFA, or anti-abuse checks."
            )
        if screen.kind is ScreenKind.GOOGLE_IDENTIFIER or (
            screen.kind is ScreenKind.GOOGLE_GENERIC and not typed_email
        ):
            if enter_google_identifier(driver, email):
                typed_email = True
                time.sleep(0.6)
                continue
        if screen.kind is ScreenKind.GOOGLE_PASSWORD:
            if typed_password:
                log.info("Password already entered; looking for I agree / Accept instead of retrying the password")
                if complete_google_welcome(driver, email):
                    time.sleep(1.0)
                    continue
                raise ActionRequired(
                    "Google still shows a password screen after one attempt while adding the device account. "
                    "Not retrying credentials."
                )
            enter_workspace_password(driver)
            typed_password = True
            time.sleep(0.8)
            continue
        if screen.kind is ScreenKind.GOOGLE_PIN and not entered_pin:
            enter_device_pin(driver)
            entered_pin = True
            time.sleep(0.5)
            continue
        if screen.kind is ScreenKind.PERMISSION:
            if dismiss_runtime_permission(driver, nodes, screen.kind):
                time.sleep(0.4)
                continue
        if screen.kind is ScreenKind.GOOGLE_CONSENT:
            handle_consent(driver)
            time.sleep(1.0)
            continue
        if screen.kind is ScreenKind.GOOGLE_WELCOME or looks_like_google_welcome(source, email):
            complete_google_welcome(driver, email)
            time.sleep(1.0)
            continue
        if not typed_email and (
            _in_settings(screen.package, screen.activity)
            or screen.kind in {ScreenKind.ADD_ACCOUNT, ScreenKind.GOOGLE_ACCOUNT_PICKER}
        ):
            if _tap_settings_add_account(driver, nodes):
                time.sleep(1.0)
                continue
            if _tap_google_row(driver, nodes):
                log.info("Opened Google from Settings")
                time.sleep(1.2)
                continue
            if _tap_settings_accounts_entry(driver, nodes):
                time.sleep(1.0)
                continue
            if _in_settings(screen.package, screen.activity) and not used_scroll_into_view:
                used_scroll_into_view = True
                if scroll_into_view(driver, "Google") or scroll_into_view(driver, "Add account"):
                    time.sleep(0.6)
                    continue
            if _in_settings(screen.package, screen.activity) and settings_swipes < 6:
                swipe_up(driver)
                settings_swipes += 1
                log.info("Scrolled Settings to find Google / Add account (%s/6)", settings_swipes)
                time.sleep(0.5)
                continue
            if not used_intent_fallback and time.monotonic() - started > 12:
                log.info("Settings Google row was not found; falling back to add-account intent")
                open_add_google_account()
                used_intent_fallback = True
                time.sleep(1.0)
                continue
        if typed_email and screen.kind in {
            ScreenKind.GOOGLE_GENERIC,
            ScreenKind.GOOGLE_ACCOUNT_PICKER,
            ScreenKind.ADD_ACCOUNT,
            ScreenKind.OTHER,
        }:
            if _click_labeled(driver, ("i agree", *ADD_ACCOUNT_NEXT_LABELS)):
                time.sleep(0.8)
                continue
        time.sleep(0.5)

    capture_failure(
        driver=driver,
        step="google_account",
        package=last_package,
        activity=getattr(last_screen, "activity", "") if last_screen else "",
        page_source=last_source,
        extra={"message": f"Could not add Workspace account {_mask_email(email)} in time"},
        screenshot_ok=True,
    )
    if not google_account_present(email):
        raise FlowError(
            "google_account",
            f"Could not add Workspace account {_mask_email(email)} to the device in time.",
        )
