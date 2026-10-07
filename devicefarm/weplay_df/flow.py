"""Drive WePlay Google Sign-In on an already-installed Play Store WePlay."""

from __future__ import annotations

import logging
import os
import time

from appium.webdriver.common.appiumby import AppiumBy
from appium.webdriver.webdriver import WebDriver

from weplay_df.artifacts import artifact_dir, capture_failure
from weplay_df.classify import (
    Screen,
    ScreenKind,
    classify,
    looks_like_account_picker,
    looks_like_google_welcome,
    looks_like_region_confirm,
    looks_like_region_register,
    looks_like_signing_in,
)
from weplay_df.accounts import emails_from_ui, emails_match, is_managed_work_account
from weplay_df.constants import (
    ACCOUNT_PICKER_TIMEOUT_S,
    ADD_ACCOUNT_NEXT_LABELS,
    ADD_ACCOUNT_FROM_PICKER_LABELS,
    ADD_ANOTHER_ACCOUNT_LABELS,
    CONSENT_BUTTON_LABELS,
    DEVICE_PIN,
    GOOGLE_ADD_ACCOUNT_TIMEOUT_S,
    GOOGLE_AUTH_TIMEOUT_S,
    GOOGLE_BUTTON_TIMEOUT_S,
    GOOGLE_EMAIL_ENV,
    GOOGLE_EMAILS_ENV,
    GOOGLE_PASSWORD_ENV,
    LOGIN_SCREEN_TIMEOUT_S,
    PLAY_STORE_EMAIL_ENV,
    SELECT_ANOTHER_ACCOUNT_LABELS,
    WEPLAY_PACKAGE,
    WEPLAY_RETURN_TIMEOUT_S,
    WELCOME_ACCEPT_ONLY_LABELS,
    WELCOME_BUTTON_LABELS,
)
from weplay_df.driver import (
    activate_weplay,
    adb_shell,
    adb_type_text,
    click_point,
    current_activity,
    current_package,
    dumpsys_activity_top,
    google_account_present,
    page_source,
    press_keycode,
    screen_size,
    swipe_up,
    tap_screen,
    uiautomator_window_dump,
    unfreeze_package,
)
from weplay_df.dumpsys import (
    dump_has_inspected_login_buttons,
    dumpsys_oauth_ui_started,
    weplay_start_activity_resumed,
)
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.login_button import TapTarget, find_google_button, find_google_sign_in_via_appium
from weplay_df.poll import poll_until
from weplay_df.prompts import (
    advance_weplay_first_run,
    dismiss_guest_mode_dialog,
    dismiss_runtime_permission,
    dismiss_tourist_login_tip,
    region_register_in_progress,
    tourist_dismiss_count,
)
from weplay_df.ui import UiNode, iter_ui_nodes

log = logging.getLogger("weplay.google")

# Android keycodes: 0=7, 1=8, ... 9=16, ENTER=66
_KEYCODE_0 = 7
_KEYCODE_ENTER = 66
_NATIVE = "NATIVE_APP"


def play_store_email() -> str:
    """Trusted Workspace account used to sign into Play Store before WePlay login."""
    value = os.environ.get(PLAY_STORE_EMAIL_ENV, "").strip()
    if value:
        return value
    return required_google_email()


def required_google_email() -> str:
    emails = target_workspace_emails()
    if not emails:
        raise FlowError(
            "config",
            f"{GOOGLE_EMAIL_ENV} is missing. Set it to the Workspace account shown "
            "on the AWS device's Google account picker. Do not hard-code a personal Gmail.",
        )
    return emails[0]


def target_workspace_emails() -> list[str]:
    """Workspace accounts to sign into WePlay on this Pixel run, in order."""
    raw = os.environ.get(GOOGLE_EMAILS_ENV, "").strip()
    emails: list[str] = []
    seen: set[str] = set()
    if raw:
        for part in raw.replace(";", ",").split(","):
            email = part.strip().lower()
            if email and email not in seen:
                seen.add(email)
                emails.append(email)
    if not emails:
        single = os.environ.get(GOOGLE_EMAIL_ENV, "").strip().lower()
        if single:
            emails.append(single)
    if not emails:
        raise FlowError(
            "config",
            f"{GOOGLE_EMAIL_ENV} is missing. Set it to the Workspace account shown "
            "on the AWS device's Google account picker. Do not hard-code a personal Gmail.",
        )
    first = emails[0]
    if first.endswith("@gmail.com") and os.environ.get("WEPLAY_ALLOW_GMAIL", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        log.warning(
            "%s looks like consumer Gmail (%s). This test is intended for a Workspace account.",
            GOOGLE_EMAIL_ENV,
            _mask_email(first),
        )
    return emails


def google_password() -> str:
    return os.environ.get(GOOGLE_PASSWORD_ENV, "")


def _mask_email(email: str) -> str:
    if "@" not in email:
        return "(invalid-email)"
    local, _, domain = email.partition("@")
    return f"{local[:2]}***@{domain}"


def snapshot(driver: WebDriver, target_email: str = "") -> tuple[Screen, list[UiNode], str]:
    package = current_package(driver)
    activity = current_activity(driver)
    source = page_source(driver)
    nodes = iter_ui_nodes(source)
    screen = classify(package, activity, source, nodes, target_email=target_email)
    log.info(
        "Screen %s package=%s activity=%s evidence=%s",
        screen.kind.value,
        package,
        activity,
        screen.evidence,
    )
    return screen, nodes, source


def fail(driver: WebDriver | None, step: str, message: str, screenshot_ok: bool | None = None) -> None:
    package = activity = source = ""
    if screenshot_ok is None:
        blob = f"{step} {message}".lower()
        screenshot_ok = "password" not in blob
    if driver is not None:
        try:
            package = current_package(driver)
            activity = current_activity(driver)
            source = page_source(driver)
        except Exception:  # noqa: BLE001
            pass
        capture_failure(
            driver=driver,
            step=step,
            package=package,
            activity=activity,
            page_source=source,
            extra={"message": message},
            screenshot_ok=screenshot_ok,
        )
    raise FlowError(step, f"{message} (package={package} activity={activity})")


def wait_for_login_screen(driver: WebDriver, email: str) -> Screen:
    def _found() -> Screen | None:
        screen, _, source = snapshot(driver, email)
        if screen.kind in {ScreenKind.WEPLAY_MAIN, ScreenKind.WEPLAY_ROOM}:
            raise FlowError(
                "already_logged_in",
                "WePlay is already past the login screen. Log out on the device, then re-run.",
            )
        if screen.kind is not ScreenKind.WEPLAY_LOGIN:
            return None
        source_l = (source or "").lower()
        if "sign in with google" in source_l:
            return screen
        if find_google_sign_in_via_appium(driver):
            return screen
        if dump_has_inspected_login_buttons(dumpsys_activity_top()):
            return screen
        return None

    try:
        screen = poll_until(_found, timeout_s=LOGIN_SCREEN_TIMEOUT_S)
    except FlowError:
        raise
    if screen:
        return screen
    fail(driver, "login_screen", "WePlay login screen was not found")
    raise AssertionError("unreachable")


def weplay_login_focused() -> bool:
    return weplay_start_activity_resumed(dumpsys_activity_top())


def wait_for_focused_login_window(driver: WebDriver, email: str, timeout_s: float = 20.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        screen, _, _ = snapshot(driver, email)
        if screen.kind is ScreenKind.WEPLAY_LOGIN and weplay_login_focused():
            log.info("WePlay StartActivity is resumed")
            return
        time.sleep(0.4)
    log.info("WePlay StartActivity resume was not confirmed; continuing with the Google tap")


def capture_google_tap_dumpsys(label: str) -> None:
    from weplay_df.redact import redact

    folder = artifact_dir() / "apk-inspect-weplay"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"dumpsys-activity-top-{label}.txt").write_text(redact(dumpsys_activity_top()), encoding="utf-8")


def enable_google_auth_log_tags() -> None:
    for tag in ("GoogleSignIn", "Auth", "CredentialsClient", "SignInHubActivity"):
        adb_shell("setprop", f"log.tag.{tag}", "VERBOSE", timeout=8)
    unfreeze_package("com.android.chrome")
    unfreeze_package("com.google.android.gms")


def try_tap_google_once(driver: WebDriver, email: str) -> TapTarget | None:
    screen, nodes, source = snapshot(driver, email)
    if dismiss_guest_mode_dialog(driver, nodes, source):
        return None
    if dismiss_tourist_login_tip(driver, nodes, source):
        return None
    if looks_like_signing_in(source, nodes) or looks_like_region_register(source, nodes) or looks_like_region_confirm(source, nodes):
        return None
    if screen.kind is not ScreenKind.WEPLAY_LOGIN:
        return None
    appium_target = find_google_sign_in_via_appium(driver)
    if appium_target:
        tap_screen(appium_target.x, appium_target.y)
        return appium_target
    dumpsys = dumpsys_activity_top()
    try:
        target = find_google_button(
            nodes=nodes,
            page_source=source,
            dumpsys_dump=dumpsys,
            screen_size=screen_size(driver),
            login_screen_confirmed=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.info("Sign in with Google not found after login snapshot (%s)", exc)
        return None
    tap_screen(target.x, target.y)
    return target


def tap_google_button(driver: WebDriver, email: str) -> TapTarget:
    deadline = time.monotonic() + GOOGLE_BUTTON_TIMEOUT_S
    last_error = "Sign in with Google was not found"
    while time.monotonic() < deadline:
        screen, _, _ = snapshot(driver, email)
        if screen.kind is not ScreenKind.WEPLAY_LOGIN:
            last_error = f"Not on WePlay login (kind={screen.kind.value})"
            time.sleep(0.4)
            continue
        target = try_tap_google_once(driver, email)
        if target:
            return target
        last_error = "Sign in with Google was not found in UI, Appium, or dumpsys"
        time.sleep(0.5)
    fail(driver, "google_button", last_error)
    raise AssertionError("unreachable")


def _click_node(driver: WebDriver, node: UiNode) -> bool:
    if node.bounds and node.bounds.usable:
        x, y = node.bounds.center
        click_point(driver, x, y)
        return True
    locator = None
    if node.resource_id:
        locator = (AppiumBy.ID, node.resource_id)
    elif node.text:
        locator = (AppiumBy.XPATH, f'//*[@text="{node.text}"]')
    elif node.content_desc:
        locator = (AppiumBy.ACCESSIBILITY_ID, node.content_desc)
    if not locator:
        return False
    driver.find_element(*locator).click()
    return True


def picker_listed_emails(nodes: list[UiNode], source: str = "") -> list[str]:
    """Google identities visible on the current picker / Continue-as sheet."""
    found: list[str] = []
    seen: set[str] = set()
    for email in emails_from_ui(nodes, source):
        key = email.lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(email)
    return found


def picker_has_target(nodes: list[UiNode], source: str, email: str) -> bool:
    return any(emails_match(item, email) for item in picker_listed_emails(nodes, source))


def _is_add_another_node(node: UiNode) -> bool:
    text = node.text.strip().lower()
    desc = node.content_desc.strip().lower()
    if any(label == text or label == desc for label in ADD_ANOTHER_ACCOUNT_LABELS):
        return True
    return any(label in f"{text} {desc}" for label in ADD_ANOTHER_ACCOUNT_LABELS)


def select_workspace_account(driver: WebDriver, email: str) -> bool:
    _, nodes, source = snapshot(driver, email)
    matches = [
        node
        for node in nodes
        if not _is_add_another_node(node)
        and email.lower() in f"{node.text} {node.content_desc}".lower()
        and not is_managed_work_account(f"{node.text} {node.content_desc}")
    ]
    if not matches:
        if not picker_has_target(nodes, source, email):
            return False
        try:
            el = driver.find_element(AppiumBy.XPATH, f'//*[contains(@text, "{email}")]')
            label = (getattr(el, "text", None) or "").strip().lower()
            if any(token in label for token in ADD_ANOTHER_ACCOUNT_LABELS):
                return False
            el.click()
            log.info("Selected Workspace account via XPath %s", _mask_email(email))
            return True
        except Exception:  # noqa: BLE001
            pass
        try:
            el = driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiSelector().textContains("{email}")',
            )
            el.click()
            log.info("Selected Workspace account via UiSelector %s", _mask_email(email))
            return True
        except Exception:  # noqa: BLE001
            return False
    matches.sort(
        key=lambda node: (
            0 if node.text.strip().lower() == email.lower() else 1,
            0 if node.clickable else 1,
            -(node.bounds.area if node.bounds else 0),
        )
    )
    if _click_node(driver, matches[0]):
        log.info("Selected Workspace account %s", _mask_email(email))
        return True
    return False


def _digit_nodes(nodes: list[UiNode]) -> dict[str, UiNode]:
    found: dict[str, UiNode] = {}
    for node in nodes:
        digit = node.text.strip() or node.content_desc.strip()
        rid = node.resource_id.lower()
        if digit in set("0123456789") and digit not in found:
            found[digit] = node
            continue
        for d in "0123456789":
            if f"key{d}" in rid or rid.endswith(f"/{d}") or rid.endswith(f"key_{d}"):
                found.setdefault(d, node)
    return found


def enter_device_pin(driver: WebDriver) -> None:
    log.info("Google asked for the device PIN; entering the temporary Device Farm PIN (value not logged)")
    screen, nodes, _ = snapshot(driver)
    pin_field = next((n for n in nodes if n.password or "pin" in n.haystack and n.class_name.endswith("EditText")), None)
    if pin_field and pin_field.resource_id:
        try:
            el = driver.find_element(AppiumBy.ID, pin_field.resource_id)
            el.clear()
            el.send_keys(DEVICE_PIN)
            press_keycode(driver, _KEYCODE_ENTER)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("PIN EditText send_keys failed: %s", exc)

    digits = _digit_nodes(nodes)
    if len(digits) >= 4:
        for ch in DEVICE_PIN:
            node = digits.get(ch)
            if not node:
                break
            _click_node(driver, node)
        else:
            enter = next(
                (
                    n
                    for n in nodes
                    if n.clickable
                    and any(token in n.haystack for token in ("enter", "done", "ok", "checkmark", "key_enter"))
                ),
                None,
            )
            if enter:
                _click_node(driver, enter)
            else:
                press_keycode(driver, _KEYCODE_ENTER)
            return

    for ch in DEVICE_PIN:
        press_keycode(driver, _KEYCODE_0 + int(ch))
    press_keycode(driver, _KEYCODE_ENTER)


def _short_exc(exc: BaseException) -> str:
    text = str(exc).split("Stacktrace:")[0].strip().splitlines()[0][:220]
    email = os.environ.get(GOOGLE_EMAIL_ENV, "").strip()
    password = os.environ.get(GOOGLE_PASSWORD_ENV, "")
    if email:
        text = text.replace(email, _mask_email(email))
    if password:
        text = text.replace(password, "***")
    return text


def is_android_resource_id(resource_id: str) -> bool:
    return ":id/" in (resource_id or "")


def identifier_input_node(nodes: list[UiNode]) -> UiNode | None:
    """The email box, not the 'identifierId-label-id' heading Google puts in the dump."""
    edittexts = [node for node in nodes if "edittext" in node.class_name.lower() and not node.password]
    labeled = [
        node
        for node in edittexts
        if "identifier" in node.resource_id.lower() and "label" not in node.resource_id.lower()
    ]
    if labeled:
        return labeled[0]
    if edittexts:
        return edittexts[0]
    for node in nodes:
        rid = node.resource_id.lower()
        if "label" in rid:
            continue
        if rid == "identifierid" or rid.endswith("/identifierid") or rid.endswith("/email"):
            return node
    return None


def source_contains_value(source: str, nodes: list[UiNode], value: str) -> bool:
    needle = value.lower()
    if needle in (source or "").lower():
        return True
    return any(needle in f"{node.text} {node.content_desc}".lower() for node in nodes)


def _tap_field(driver: WebDriver, field: UiNode | None) -> None:
    if field and field.bounds and field.bounds.usable:
        if field.bounds.height > 600:
            x = field.bounds.left + field.bounds.width // 2
            y = field.bounds.top + int(field.bounds.height * 0.28)
            click_point(driver, x, y)
        else:
            click_point(driver, *field.bounds.center)
        return
    width, height = screen_size(driver)
    if width and height:
        click_point(driver, width // 2, int(height * 0.36))


def type_value(driver: WebDriver, value: str, field: UiNode | None = None) -> bool:
    """Click the field, then type with mobile:type / adb. send_keys/setValue fails on Google WebView labels."""
    _tap_field(driver, field)
    time.sleep(0.25)
    try:
        driver.execute_script("mobile: type", {"text": value})
        log.info("Typed via mobile:type")
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("mobile:type failed: %s", _short_exc(exc))
    if adb_type_text(value):
        log.info("Typed via adb keyboard")
        return True
    return False


def fill_edit_node(driver: WebDriver, field: UiNode, value: str) -> bool:
    """Type into a native EditText. Web resource-ids like identifierId are not Android IDs."""
    if type_value(driver, value, field):
        return True
    locators: list[tuple[str, object]] = []
    rid = (field.resource_id or "").strip()
    if is_android_resource_id(rid):
        locators.append(("android-id", lambda: driver.find_element(AppiumBy.ID, rid)))
    locators.append(("class-edittext", lambda: driver.find_element(AppiumBy.CLASS_NAME, "android.widget.EditText")))

    for name, locate in locators:
        try:
            el = locate()
            el.click()
            time.sleep(0.15)
            el.send_keys(value)
            log.info("Typed into field via %s", name)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("Fill via %s failed: %s", name, _short_exc(exc))
    return False


def _switch_native(driver: WebDriver) -> None:
    try:
        if getattr(driver, "current_context", _NATIVE) != _NATIVE:
            driver.switch_to.context(_NATIVE)
    except Exception:  # noqa: BLE001
        pass


def type_in_google_webview(driver: WebDriver, *, email: str | None = None, password: str | None = None) -> bool:
    try:
        contexts = driver.contexts
    except Exception:  # noqa: BLE001
        contexts = []
    for ctx in contexts:
        if "WEBVIEW" not in str(ctx).upper() and "CHROMIUM" not in str(ctx).upper():
            continue
        try:
            driver.switch_to.context(ctx)
            if email:
                el = None
                for selector in ("#identifierId", "input[type='email']", "input[name='identifier']", "input[type='text']"):
                    try:
                        el = driver.find_element(AppiumBy.CSS_SELECTOR, selector)
                        break
                    except Exception:  # noqa: BLE001
                        continue
                if not el:
                    _switch_native(driver)
                    continue
                el.clear()
                el.send_keys(email)
                for selector in ("#identifierNext", "#next", "button[type='submit']"):
                    try:
                        driver.find_element(AppiumBy.CSS_SELECTOR, selector).click()
                        break
                    except Exception:  # noqa: BLE001
                        continue
            elif password:
                el = driver.find_element(AppiumBy.CSS_SELECTOR, "input[type='password']")
                el.clear()
                el.send_keys(password)
                for selector in ("#passwordNext", "#submit", "button[type='submit']"):
                    try:
                        driver.find_element(AppiumBy.CSS_SELECTOR, selector).click()
                        break
                    except Exception:  # noqa: BLE001
                        continue
            else:
                _switch_native(driver)
                continue
            _switch_native(driver)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("Google WebView typing failed: %s", _short_exc(exc))
            _switch_native(driver)
    return False


def enter_workspace_password(driver: WebDriver) -> None:
    password = google_password()
    if not password:
        raise ActionRequired(
            f"Google asked for the Workspace account password, but {GOOGLE_PASSWORD_ENV} is not set. "
            "Set it in the Device Farm test spec (do not commit it) and re-run."
        )
    log.info("Google password field is visible; entering %s (value never logged)", GOOGLE_PASSWORD_ENV)

    def _type_in_native() -> bool:
        _, nodes, _ = snapshot(driver)
        field = next((n for n in nodes if n.password), None)
        if not field:
            return False
        if not fill_edit_node(driver, field, password):
            return False
        _click_labeled(driver, ("next", "sign in", "continue", "done"))
        return True

    if _type_in_native():
        return

    if type_in_google_webview(driver, password=password):
        return

    raise ActionRequired("Google password screen was detected but no password field could be filled.")


def _click_labeled(driver: WebDriver, labels: tuple[str, ...]) -> bool:
    _, nodes, _ = snapshot(driver)
    exact: list[UiNode] = []
    fuzzy: list[UiNode] = []
    for node in nodes:
        text = node.text.strip().lower()
        desc = node.content_desc.strip().lower()
        if any(label == text or label == desc for label in labels):
            exact.append(node)
        elif node.clickable and any(label in node.haystack for label in labels):
            fuzzy.append(node)
    for node in [n for n in exact if n.clickable] + [n for n in exact if not n.clickable] + fuzzy:
        if _click_node(driver, node):
            return True
    return False


def enter_google_identifier(driver: WebDriver, email: str) -> bool:
    _, nodes, source = snapshot(driver, email)
    if source_contains_value(source, nodes, email):
        _click_labeled(driver, ADD_ACCOUNT_NEXT_LABELS)
        log.info("Workspace email %s already visible; tapping Next", _mask_email(email))
        return True
    field = identifier_input_node(nodes)
    if field:
        log.info(
            "Identifier field class=%s resource-id=%s",
            field.class_name,
            field.resource_id or "(none)",
        )
    typed = type_value(driver, email, field)
    if not typed:
        typed = type_in_google_webview(driver, email=email)
    time.sleep(0.4)
    _, nodes_after, source_after = snapshot(driver, email)
    if not source_contains_value(source_after, nodes_after, email):
        log.warning("Workspace email is not visible in the identifier field yet")
        return False
    _click_labeled(driver, ADD_ACCOUNT_NEXT_LABELS)
    log.info("Entered Workspace email %s on Google identifier screen", _mask_email(email))
    return True


def _labeled_node(nodes: list[UiNode], labels: tuple[str, ...]) -> UiNode | None:
    exact: list[UiNode] = []
    fuzzy: list[UiNode] = []
    for node in nodes:
        text = node.text.strip().lower()
        desc = node.content_desc.strip().lower()
        if any(label == text or label == desc for label in labels):
            exact.append(node)
        elif any(label in f"{text} {desc}" for label in labels):
            fuzzy.append(node)
    ranked = [n for n in exact if n.clickable] + [n for n in exact if not n.clickable] + fuzzy
    return ranked[0] if ranked else None


def add_another_account_node(nodes: list[UiNode]) -> UiNode | None:
    return _labeled_node(nodes, ADD_ANOTHER_ACCOUNT_LABELS)


def add_account_from_picker_node(nodes: list[UiNode]) -> UiNode | None:
    return _labeled_node(nodes, ADD_ACCOUNT_FROM_PICKER_LABELS)


def select_another_account_node(nodes: list[UiNode]) -> UiNode | None:
    return _labeled_node(nodes, SELECT_ANOTHER_ACCOUNT_LABELS)


def picker_sheet_ready(nodes: list[UiNode], source: str) -> bool:
    """AssistedSignIn often appears with a 0-height window; do not swipe or Continue yet."""
    text = f"{source or ''} {' '.join(f'{n.text} {n.content_desc}' for n in nodes)}".lower()
    if any(
        phrase in text
        for phrase in (
            "continue as",
            "choose an account",
            "add another account",
            "add account",
            "another account",
            "select an account",
        )
    ):
        return True
    if picker_listed_emails(nodes, source):
        return True
    return any(n.clickable and n.text.strip() and n.bounds and n.bounds.usable for n in nodes)


def google_picker_plan(nodes: list[UiNode], source: str, email: str) -> str:
    """How the WePlay Google picker should treat the current hierarchy.

    select_target: required Workspace account is listed among other identities
    continue_as_target: only the required account is shown (Continue as …)
    add_another: tap Add account / Add another account
    expand_picker: tap Select/Use another account to open the full list
    wait_for_sheet: Credential Manager is up but the sheet is not laid out yet
    scroll_picker: a populated list may hide Add account below the fold
    """
    if not picker_sheet_ready(nodes, source):
        return "wait_for_sheet"
    listed = picker_listed_emails(nodes, source)
    workspace = [item for item in listed if not is_managed_work_account(item)]
    has_target = any(emails_match(item, email) for item in listed)
    others = [item for item in workspace if not emails_match(item, email)]
    if has_target and others:
        return "select_target"
    if has_target:
        return "continue_as_target"
    if add_account_from_picker_node(nodes) is not None:
        return "add_another"
    if select_another_account_node(nodes) is not None:
        return "expand_picker"
    hay = f"{source or ''} {' '.join(n.haystack for n in nodes)}".lower()
    if "continue as" in hay:
        return "expand_picker"
    if "choose an account" in hay:
        return "scroll_picker"
    return "wait_for_sheet"


def _tap_picker_label(driver: WebDriver, labels: tuple[str, ...], log_label: str) -> bool:
    _, nodes, _ = snapshot(driver)
    node = _labeled_node(nodes, labels)
    if node and _click_node(driver, node):
        log.info("Tapped %s on the Google account picker", log_label)
        return True
    for label in labels:
        display = " ".join(part.capitalize() for part in label.split())
        try:
            driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, f'new UiSelector().text("{display}")').click()
            log.info("Tapped %s via UiSelector", log_label)
            return True
        except Exception:  # noqa: BLE001
            pass
        try:
            driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiSelector().textContains("{display}")',
            ).click()
            log.info("Tapped %s via UiSelector contains", log_label)
            return True
        except Exception:  # noqa: BLE001
            pass
    return False


def tap_add_another_account(driver: WebDriver) -> bool:
    if _tap_picker_label(driver, ADD_ACCOUNT_FROM_PICKER_LABELS, "Add account"):
        return True
    if _tap_picker_label(driver, ADD_ANOTHER_ACCOUNT_LABELS, "Add another account"):
        return True
    return False


def tap_select_another_account(driver: WebDriver) -> bool:
    if _tap_picker_label(driver, SELECT_ANOTHER_ACCOUNT_LABELS, "Select another account"):
        return True
    _, nodes, _ = snapshot(driver)
    for node in nodes:
        blob = f"{node.content_desc} {node.resource_id}".lower()
        if node.clickable and any(token in blob for token in ("expand", "dropdown", "chevron", "arrow_drop", "show other")):
            if _click_node(driver, node):
                log.info("Tapped Google account-picker expand control")
                return True
    return False


def handle_google_account_picker(driver: WebDriver, email: str) -> str:
    """Sign in with Google → another account → add the provisioned user. Never Continue as Play."""
    _, nodes, source = snapshot(driver, email)
    if not picker_sheet_ready(nodes, source):
        dump = uiautomator_window_dump()
        if dump:
            dump_nodes = iter_ui_nodes(dump)
            if picker_sheet_ready(dump_nodes, dump):
                nodes, source = dump_nodes, dump
    plan = google_picker_plan(nodes, source, email)
    log.info("Google account picker plan=%s target=%s", plan, _mask_email(email))
    if plan == "wait_for_sheet":
        time.sleep(0.7)
        return "pending"
    if plan in {"select_target", "continue_as_target"}:
        if select_workspace_account(driver, email):
            return "selected"
        if plan == "continue_as_target" and _click_labeled(driver, ("continue", "allow", "ok")):
            log.info("Continued as Workspace account %s", _mask_email(email))
            return "selected"
        return "pending"
    if plan == "add_another":
        if tap_add_another_account(driver):
            return "adding"
        return "pending"
    if plan == "expand_picker":
        if tap_select_another_account(driver):
            time.sleep(0.6)
            if tap_add_another_account(driver):
                return "adding"
            return "pending"
        if tap_add_another_account(driver):
            return "adding"
        return "pending"
    if plan == "scroll_picker":
        swipe_up(driver)
        time.sleep(0.4)
        _, nodes_after, source_after = snapshot(driver, email)
        if add_account_from_picker_node(nodes_after) and tap_add_another_account(driver):
            return "adding"
        if select_another_account_node(nodes_after) and tap_select_another_account(driver):
            return "pending"
        if picker_has_target(nodes_after, source_after, email) and select_workspace_account(driver, email):
            return "selected"
        return "pending"
    return "pending"


def welcome_scroll_control_node(nodes: list[UiNode], screen_height: int = 2400) -> UiNode | None:
    """Down-chevron on Workspace Welcome. Often not marked clickable in the WebView dump."""
    height = screen_height
    for node in nodes:
        if node.bounds:
            height = max(height, node.bounds.bottom)
    labeled: list[UiNode] = []
    bottom_center: list[UiNode] = []
    for node in nodes:
        if not node.bounds or not node.bounds.usable:
            continue
        blob = f"{node.content_desc} {node.resource_id} {node.text}".lower()
        if any(token in blob for token in ("scroll down", "scroll", "chevron", "next page")):
            labeled.append(node)
            continue
        if "down" in blob and not node.text.strip():
            labeled.append(node)
            continue
        if node.text.strip():
            continue
        if node.bounds.top < int(height * 0.70) or node.bounds.bottom > int(height * 0.97):
            continue
        center_x = (node.bounds.left + node.bounds.right) / 2
        if abs(center_x - 540) <= 220 and 40 <= node.bounds.width <= 240 and 40 <= node.bounds.height <= 240:
            bottom_center.append(node)
    ranked = labeled + bottom_center
    return ranked[0] if ranked else None


def _tap_welcome_scroll_control(driver: WebDriver, nodes: list[UiNode]) -> bool:
    node = welcome_scroll_control_node(nodes)
    if node and _click_node(driver, node):
        return True
    return False


def _tap_welcome_down_arrow_fallback(driver: WebDriver) -> None:
    width, height = screen_size(driver)
    if width <= 0 or height <= 0:
        width, height = 1080, 2400
    x = width // 2
    y = int(height * 0.86)
    log.info("Tapping Welcome down-arrow at %s,%s", x, y)
    click_point(driver, x, y)


def welcome_shows_target(source: str, nodes: list[UiNode], email: str) -> bool:
    return source_contains_value(source, nodes, email)


def complete_google_welcome(driver: WebDriver, email: str, *, accept_only: bool = False) -> bool:
    """Scroll the long Workspace Welcome page and tap Continue/Accept/I agree."""
    labels = WELCOME_ACCEPT_ONLY_LABELS if accept_only else WELCOME_BUTTON_LABELS
    _, nodes, source = snapshot(driver, email)
    if email and not welcome_shows_target(source, nodes, email):
        listed = picker_listed_emails(nodes, source)
        workspace = [item for item in listed if not is_managed_work_account(item)]
        if workspace and not any(emails_match(item, email) for item in workspace):
            raise FlowError(
                "account_picker",
                "Google Welcome/TOS is for a different account than the one being provisioned. "
                f"Expected {_mask_email(email)}.",
            )
    used_point_tap = False
    for attempt in range(8):
        if _click_labeled(driver, labels):
            log.info("Accepted Google Welcome / new-account terms")
            return True
        _, nodes, _ = snapshot(driver, email)
        if _tap_welcome_scroll_control(driver, nodes):
            log.info("Tapped Welcome down-arrow (%s/8)", attempt + 1)
        elif not used_point_tap:
            _tap_welcome_down_arrow_fallback(driver)
            used_point_tap = True
        else:
            swipe_up(driver)
            log.info("Scrolled Google Welcome to reveal Accept (%s/8)", attempt + 1)
        time.sleep(0.45)
    return False


def handle_consent(driver: WebDriver) -> None:
    if _click_labeled(driver, ("i agree",)) or _click_labeled(driver, CONSENT_BUTTON_LABELS):
        log.info("Accepted Google terms / OAuth consent")
        return
    log.info("Consent screen visible but no known button matched yet")


def google_picker_overlay_visible(source: str, nodes: list[UiNode], email: str) -> bool:
    """Credential Manager often overlays WePlay StartActivity without changing the top activity."""
    if looks_like_account_picker("", "", source, email) or picker_sheet_ready(nodes, source):
        return True
    dump = uiautomator_window_dump()
    if not dump:
        return False
    dump_nodes = iter_ui_nodes(dump)
    return picker_sheet_ready(dump_nodes, dump) or looks_like_account_picker("", "", dump, email)


def wait_for_google_then_complete(driver: WebDriver, email: str) -> None:
    selected = False
    pin_entered = False
    password_entered = False
    typed_email = False
    adding_another = False
    welcome_seen = False
    play_email = play_store_email()
    same_play_account = emails_match(email, play_email)
    auth_timeout_s = GOOGLE_ADD_ACCOUNT_TIMEOUT_S if not same_play_account else max(
        ACCOUNT_PICKER_TIMEOUT_S, GOOGLE_AUTH_TIMEOUT_S
    )
    deadline = time.monotonic() + auth_timeout_s

    while time.monotonic() < deadline:
        screen, nodes, source = snapshot(driver, email)
        if dismiss_guest_mode_dialog(driver, nodes, source):
            time.sleep(0.5)
            continue
        if dismiss_tourist_login_tip(driver, nodes, source):
            if region_register_in_progress() and tourist_dismiss_count() >= 2:
                fail(
                    driver,
                    "weplay_google_login",
                    "WePlay rejected Google Sign-In with 'Tourist login is not supported temporarily' "
                    "after the Pakistan region was confirmed. Not retrying Google in a loop.",
                )
            log.info("Tourist-login tip dismissed; waiting for WePlay instead of immediately re-tapping Google")
            time.sleep(1.0)
            continue
        if looks_like_signing_in(source, nodes):
            time.sleep(0.4)
            continue
        if dismiss_runtime_permission(driver, nodes, screen.kind):
            time.sleep(0.4)
            continue
        if advance_weplay_first_run(driver, nodes, source, screen.kind, email):
            time.sleep(0.8)
            continue
        if screen.kind in {ScreenKind.WEPLAY_MAIN, ScreenKind.WEPLAY_ROOM}:
            if selected or typed_email or (same_play_account and google_account_present(email)):
                log.info("WePlay post-login screen already visible during Google flow")
                return
            fail(
                driver,
                "weplay_google_login",
                "WePlay continued after Google Sign-In without selecting the target Workspace account. "
                f"Do not continue as the Play identity {_mask_email(play_email)} or the Device Farm managed Play account.",
            )
        if screen.kind is ScreenKind.ACTION_REQUIRED:
            evidence = (screen.evidence or "").lower()
            confirm_lock = evidence in {"verify it's you", "verify its you", "use your screen lock"}
            if confirm_lock and not pin_entered:
                log.info("Google confirm-device-credential screen during WePlay login; entering temporary device PIN")
                enter_device_pin(driver)
                pin_entered = True
                time.sleep(0.5)
                continue
            capture_failure(
                driver=driver,
                step="ACTION_REQUIRED",
                package=screen.package,
                activity=screen.activity,
                page_source=page_source(driver),
                extra={"challenge": screen.evidence},
                screenshot_ok="password" not in screen.evidence.lower(),
            )
            raise ActionRequired(
                f"Google presented a security challenge ({screen.evidence}). "
                "Not attempting to bypass CAPTCHA, MFA, or anti-abuse checks."
            )
        if screen.kind is ScreenKind.GOOGLE_IDENTIFIER or (
            adding_another and screen.kind is ScreenKind.GOOGLE_GENERIC and not typed_email
        ):
            if enter_google_identifier(driver, email):
                typed_email = True
                time.sleep(0.6)
                continue
        if screen.kind is ScreenKind.GOOGLE_WELCOME or looks_like_google_welcome(source, email):
            welcome_seen = True
            complete_google_welcome(driver, email)
            time.sleep(0.5)
            continue
        if screen.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER or (
            screen.kind in {ScreenKind.GOOGLE_GENERIC, ScreenKind.WEPLAY_LOGIN} and not selected and not typed_email
        ):
            if screen.kind is ScreenKind.WEPLAY_LOGIN:
                if region_register_in_progress():
                    time.sleep(0.4)
                    continue
                if looks_like_signing_in(source, nodes):
                    time.sleep(0.4)
                    continue
                if google_picker_overlay_visible(source, nodes, email):
                    outcome = handle_google_account_picker(driver, email)
                    if outcome == "selected":
                        selected = True
                        time.sleep(0.4)
                        continue
                    if outcome == "adding":
                        adding_another = True
                        time.sleep(1.0)
                        continue
                # Do not re-tap Google on a timer. Dumpsys still shows the login
                # layout for ~15s after the first tap, until the region dialog.
                time.sleep(0.4)
                continue
            outcome = handle_google_account_picker(driver, email)
            if outcome == "selected":
                selected = True
                time.sleep(0.4)
                continue
            if outcome == "adding":
                adding_another = True
                time.sleep(1.0)
                continue
            if screen.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER:
                time.sleep(0.4)
                continue
        if screen.kind is ScreenKind.GOOGLE_PIN and not pin_entered:
            enter_device_pin(driver)
            pin_entered = True
            time.sleep(0.5)
            continue
        if screen.kind is ScreenKind.GOOGLE_PASSWORD:
            if password_entered:
                raise ActionRequired(
                    "Google still shows a password screen after one attempt. "
                    "Not retrying credentials. Check the Workspace account."
                )
            enter_workspace_password(driver)
            password_entered = True
            time.sleep(0.5)
            continue
        if screen.kind is ScreenKind.GOOGLE_CONSENT:
            handle_consent(driver)
            time.sleep(0.4)
            continue
        if screen.kind is ScreenKind.PERMISSION:
            if dismiss_runtime_permission(driver, nodes, screen.kind):
                time.sleep(0.4)
                continue
            raise ActionRequired(
                "Android permission dialog is blocking Google Sign-In. Grant it on the device profile, then re-run."
            )
        if screen.kind is ScreenKind.WEPLAY_ONBOARDING:
            if selected or typed_email or (same_play_account and google_account_present(email)):
                log.info("WePlay onboarding after verified Google account %s", _mask_email(email))
                return
            fail(
                driver,
                "weplay_google_login",
                "WePlay continued after Google Sign-In without selecting the target Workspace account. "
                f"Do not continue as the Play identity {_mask_email(play_email)}.",
            )
        time.sleep(0.4)

    if welcome_seen:
        fail(
            driver,
            "google_welcome",
            f"Google Welcome/TOS for {_mask_email(email)} did not finish (scroll to Continue/Accept and return to WePlay).",
        )
    fail(
        driver,
        "account_picker",
        f"Google account picker did not list {_mask_email(email)} and Add another account was not completed. "
        "Do not treat the Device Farm Play identity as the provisioned Workspace account.",
    )


def wait_for_weplay_session(driver: WebDriver, email: str) -> Screen:
    def _found() -> Screen | None:
        screen, nodes, source = snapshot(driver, email)
        if screen.kind in {ScreenKind.WEPLAY_MAIN, ScreenKind.WEPLAY_ROOM}:
            return screen
        if screen.kind is ScreenKind.ACTION_REQUIRED:
            raise ActionRequired(screen.evidence)
        if dismiss_guest_mode_dialog(driver, nodes, source):
            return None
        if dismiss_tourist_login_tip(driver, nodes, source):
            if region_register_in_progress() and tourist_dismiss_count() >= 2:
                fail(
                    driver,
                    "weplay_google_login",
                    "WePlay rejected Google Sign-In with 'Tourist login is not supported temporarily' "
                    "after the Pakistan region was confirmed.",
                )
            return None
        if screen.kind is ScreenKind.GOOGLE_WELCOME or looks_like_google_welcome(source, email):
            complete_google_welcome(driver, email)
            return None
        if screen.kind is ScreenKind.GOOGLE_CONSENT:
            handle_consent(driver)
            return None
        if screen.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER:
            handle_google_account_picker(driver, email)
            return None
        if looks_like_signing_in(source, nodes):
            return None
        if dismiss_runtime_permission(driver, nodes, screen.kind):
            return None
        if advance_weplay_first_run(driver, nodes, source, screen.kind, email):
            return None
        if screen.kind in {ScreenKind.WEPLAY_LOGIN, ScreenKind.WEPLAY_ONBOARDING}:
            return None
        return None

    screen = poll_until(_found, timeout_s=WEPLAY_RETURN_TIMEOUT_S)
    if screen:
        return screen
    fail(
        driver,
        "weplay_return",
        "WePlay did not return to MainActivity or a voice room after Google authentication",
    )
    raise AssertionError("unreachable")


def is_weplay_foreground(screen: Screen) -> bool:
    return WEPLAY_PACKAGE in screen.package or "com.wepie.wespy" in f"{screen.package} {screen.activity}"


def verify_logged_in(driver: WebDriver, screen: Screen) -> None:
    source = page_source(driver)
    if screen.kind is ScreenKind.WEPLAY_LOGIN or "login_view" in source:
        fail(driver, "verify", "Still on WePlay login after Google Sign-In")
    if screen.kind not in {ScreenKind.WEPLAY_MAIN, ScreenKind.WEPLAY_ROOM}:
        fail(
            driver,
            "verify",
            f"Expected MainActivity or voice room, got {screen.kind.value} {screen.package}/{screen.activity}",
        )
    log.info("Login verified: %s %s/%s", screen.kind.value, screen.package, screen.activity)


def run_google_login(driver: WebDriver, email: str | None = None) -> Screen:
    from weplay_df.apk_inspect import clear_device_logcat

    target = (email or required_google_email()).strip()
    if target:
        os.environ[GOOGLE_EMAIL_ENV] = target
    log.info("Target Workspace account: %s Play Store identity: %s", _mask_email(target), _mask_email(play_store_email()))
    activate_weplay(driver)
    wait_for_login_screen(driver, target)
    wait_for_focused_login_window(driver, target)
    enable_google_auth_log_tags()
    capture_google_tap_dumpsys("before-tap")
    clear_device_logcat()
    tap_target = tap_google_button(driver, target)
    log.info("Tapped Google with strategy=%s evidence=%s", tap_target.strategy, tap_target.evidence)
    time.sleep(1.5)
    after = dumpsys_activity_top()
    oauth_ui = dumpsys_oauth_ui_started(after, current_package(driver), current_activity(driver))
    if dump_has_inspected_login_buttons(after) and weplay_start_activity_resumed(after) and not oauth_ui:
        log.info("Google tap did not start OAuth UI; sending one recovery adb tap at %s,%s", tap_target.x, tap_target.y)
        tap_screen(tap_target.x, tap_target.y)
        time.sleep(2.0)
    capture_google_tap_dumpsys("after-tap")
    wait_for_google_then_complete(driver, target)
    screen = wait_for_weplay_session(driver, target)
    if not google_account_present(target):
        fail(
            driver,
            "account_picker",
            f"WePlay returned but device accounts do not include {_mask_email(target)}. "
            "The Device Farm Play identity was used instead of the provisioned Workspace account.",
        )
    verify_logged_in(driver, screen)
    return screen
