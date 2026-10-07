"""WePlay first-run prompts: Android runtime permissions and in-app onboarding."""

from __future__ import annotations

import logging
import re
import time

from appium.webdriver.common.appiumby import AppiumBy
from appium.webdriver.webdriver import WebDriver

from weplay_df.classify import (
    ScreenKind,
    looks_like_guest_login_dialog,
    looks_like_login_ui,
    looks_like_region_confirm,
    looks_like_region_register,
    looks_like_signing_in,
    looks_like_tourist_login_tip,
)
from weplay_df.constants import PERMISSION_ALLOW_LABELS, WEPLAY_ONBOARDING_LABELS, WEPLAY_PACKAGE
from weplay_df.driver import click_point
from weplay_df.ui import UiNode, iter_ui_nodes, page_text

log = logging.getLogger("weplay.google")

_CONFIRM_SURE_ID = f"{WEPLAY_PACKAGE}:id/confirm_sure"
_TOURIST_OK_ID = f"{WEPLAY_PACKAGE}:id/certificate_sure_btn"
_PAKISTAN_LABELS = ("Pakistan", "پاکستان")
_NICKNAME_HINTS = (
    "nickname",
    "nick name",
    "your name",
    "enter a name",
    "set your name",
    "please enter your nickname",
)
_BIRTHDAY_HINTS = (
    "birthday",
    "date of birth",
    "when were you born",
    "year of birth",
    "select your birthday",
    "your birthday",
)

# One Device Farm process = one first-run. Select Pakistan once, tap Register OK,
# then Confirm the "Are you sure" modal. Never re-drive the region list.
_region_pakistan_selected = False
_region_ok_taps = 0
_region_confirm_taps = 0
_tourist_tip_dismissed = 0
_last_first_run_hay = ""


def reset_region_register_state() -> None:
    """Test hook. Production runs are a fresh process per device."""
    global _region_pakistan_selected, _region_ok_taps, _region_confirm_taps, _tourist_tip_dismissed, _last_first_run_hay
    _region_pakistan_selected = False
    _region_ok_taps = 0
    _region_confirm_taps = 0
    _tourist_tip_dismissed = 0
    _last_first_run_hay = ""


def tourist_tip_dismissed() -> bool:
    return _tourist_tip_dismissed > 0


def tourist_dismiss_count() -> int:
    return _tourist_tip_dismissed


def region_register_in_progress() -> bool:
    return _region_pakistan_selected or _region_ok_taps > 0 or _region_confirm_taps > 0


def _exact_label(node: UiNode, labels: tuple[str, ...]) -> bool:
    text = node.text.strip().lower()
    desc = node.content_desc.strip().lower()
    return text in labels or desc in labels


def tap_labeled(driver: WebDriver, nodes: list[UiNode], labels: tuple[str, ...]) -> bool:
    matches = [node for node in nodes if node.clickable and _exact_label(node, labels)]
    if not matches:
        matches = [node for node in nodes if _exact_label(node, labels)]
    if not matches or not matches[0].bounds or not matches[0].bounds.usable:
        return False
    click_point(driver, *matches[0].bounds.center)
    return True


def dismiss_runtime_permission(driver: WebDriver, nodes: list[UiNode], kind: ScreenKind) -> bool:
    if kind is not ScreenKind.PERMISSION:
        return False
    if tap_labeled(driver, nodes, PERMISSION_ALLOW_LABELS):
        log.info("Accepted Android runtime permission for WePlay")
        return True
    return False


def dismiss_guest_mode_dialog(driver: WebDriver, nodes: list[UiNode], page_source: str = "") -> bool:
    blob = page_text(page_source) if page_source else " ".join(node.haystack for node in nodes)
    if "guest mode" not in blob and "mobile phone number" not in blob:
        if not looks_like_guest_login_dialog(page_source):
            return False
    if tap_labeled(driver, nodes, ("cancel",)):
        log.info("Dismissed WePlay guest-mode dialog (Cancel); continuing Google Sign-In")
        return True
    return False


def dismiss_tourist_login_tip(driver: WebDriver, nodes: list[UiNode], page_source: str = "") -> bool:
    """Dismiss WePlay's 'Tourist login is not supported temporarily' tip. Never tap Contact Us."""
    global _tourist_tip_dismissed
    if not looks_like_tourist_login_tip(page_source, nodes):
        try:
            driver.find_element(AppiumBy.ID, f"{WEPLAY_PACKAGE}:id/id_tip_double_bt_content_tx")
        except Exception:  # noqa: BLE001
            return False
        hay = _combined_hay(page_source, nodes)
        if "tourist login" not in hay:
            return False
    if _click_resource_id(driver, _TOURIST_OK_ID):
        _tourist_tip_dismissed += 1
        log.info("Dismissed WePlay tourist-login tip via %s", _TOURIST_OK_ID)
        return True
    if _click_node_id(driver, nodes, "certificate_sure_btn"):
        _tourist_tip_dismissed += 1
        log.info("Dismissed WePlay tourist-login tip via certificate_sure_btn bounds")
        return True
    if _click_uiautomator(driver, 'new UiSelector().resourceId("' + _TOURIST_OK_ID + '")'):
        _tourist_tip_dismissed += 1
        log.info("Dismissed WePlay tourist-login tip via UiSelector OK")
        return True
    if tap_labeled(driver, nodes, ("ok",)):
        _tourist_tip_dismissed += 1
        log.info("Dismissed WePlay tourist-login tip via labeled OK")
        return True
    return False


def _combined_hay(page_source: str, nodes: list[UiNode], extra: str = "") -> str:
    return f"{page_text(page_source)} {extra} {' '.join(n.haystack for n in nodes)}".lower()


def _click_uiautomator(driver: WebDriver, selector: str) -> bool:
    try:
        el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
        text = (getattr(el, "text", None) or "").strip()
        if "are you sure" in text.lower():
            return False
        el.click()
        return True
    except Exception:  # noqa: BLE001
        return False


def _click_resource_id(driver: WebDriver, resource_id: str) -> bool:
    try:
        driver.find_element(AppiumBy.ID, resource_id).click()
        return True
    except Exception:  # noqa: BLE001
        return False


def _click_node_id(driver: WebDriver, nodes: list[UiNode], resource_id: str) -> bool:
    needle = resource_id.lower()
    for node in nodes:
        if needle not in node.resource_id.lower():
            continue
        if not node.bounds or not node.bounds.usable:
            continue
        click_point(driver, *node.bounds.center)
        return True
    return False


def _click_exact_text_from_xml(driver: WebDriver, xml: str, label: str) -> bool:
    wanted = label.strip().lower()
    for node in iter_ui_nodes(xml):
        if node.text.strip().lower() != wanted and node.content_desc.strip().lower() != wanted:
            continue
        if not node.bounds or not node.bounds.usable:
            continue
        click_point(driver, *node.bounds.center)
        return True
    return False


def _confirm_visible(page_source: str, nodes: list[UiNode], dump_xml: str) -> bool:
    dump_nodes = iter_ui_nodes(dump_xml) if dump_xml else []
    return (
        looks_like_region_confirm(page_source, nodes)
        or looks_like_region_confirm(dump_xml, dump_nodes)
        or any("confirm_sure" in n.resource_id.lower() for n in nodes + dump_nodes)
    )


def _region_list_visible(page_source: str, nodes: list[UiNode], dump_xml: str) -> bool:
    if _confirm_visible(page_source, nodes, dump_xml):
        return False
    dump_nodes = iter_ui_nodes(dump_xml) if dump_xml else []
    return looks_like_region_register(page_source, nodes) or looks_like_region_register(dump_xml, dump_nodes)


def _confirm_region_choice(driver: WebDriver, nodes: list[UiNode], page_source: str, dump_xml: str) -> bool:
    """Tap Confirm on the 'Are you sure to choose Pakistan?' modal. Never Cancel, never Pakistan."""
    global _region_confirm_taps
    if _region_confirm_taps >= 2:
        return False
    dump_nodes = iter_ui_nodes(dump_xml) if dump_xml else []
    all_nodes = list(nodes) + dump_nodes
    if _click_resource_id(driver, _CONFIRM_SURE_ID):
        _region_confirm_taps += 1
        log.info("Confirmed WePlay region Pakistan via %s", _CONFIRM_SURE_ID)
        return True
    if _click_node_id(driver, all_nodes, "confirm_sure"):
        _region_confirm_taps += 1
        log.info("Confirmed WePlay region Pakistan via confirm_sure bounds")
        return True
    if _click_uiautomator(driver, 'new UiSelector().resourceId("' + _CONFIRM_SURE_ID + '")'):
        _region_confirm_taps += 1
        log.info("Confirmed WePlay region Pakistan via UiSelector confirm_sure")
        return True
    if _click_uiautomator(driver, 'new UiSelector().text("Confirm")'):
        _region_confirm_taps += 1
        log.info("Confirmed WePlay region Pakistan via Confirm")
        return True
    if tap_labeled(driver, all_nodes, ("confirm",)):
        _region_confirm_taps += 1
        log.info("Confirmed WePlay region Pakistan via labeled Confirm")
        return True
    return False


def _select_pakistan_once(driver: WebDriver, nodes: list[UiNode], dump_xml: str) -> bool:
    global _region_pakistan_selected
    if _region_pakistan_selected:
        return False
    dump_nodes = iter_ui_nodes(dump_xml) if dump_xml else []
    if _click_uiautomator(
        driver,
        'new UiSelector().textContains("Pakistan").clickable(true)',
    ):
        _region_pakistan_selected = True
        log.info("Selected WePlay register region Pakistan")
        time.sleep(0.4)
        return True
    for label in _PAKISTAN_LABELS:
        if _click_uiautomator(driver, f'new UiSelector().textContains("{label}").clickable(true)'):
            _region_pakistan_selected = True
            log.info("Selected WePlay register region %s", label)
            time.sleep(0.4)
            return True
    if tap_labeled(driver, list(nodes) + dump_nodes, ("pakistan", "پاکستان")):
        _region_pakistan_selected = True
        log.info("Selected WePlay register region Pakistan via node bounds")
        time.sleep(0.4)
        return True
    return False


def _tap_region_ok(driver: WebDriver, nodes: list[UiNode], page_source: str, dump_xml: str) -> bool:
    global _region_ok_taps
    if _region_ok_taps >= 3:
        return False
    dump_nodes = iter_ui_nodes(dump_xml) if dump_xml else []
    all_nodes = list(nodes) + dump_nodes
    if _click_uiautomator(driver, 'new UiSelector().text("OK")'):
        _region_ok_taps += 1
        log.info("Tapped WePlay register region OK (%s)", _region_ok_taps)
        return True
    if tap_labeled(driver, all_nodes, ("ok",)):
        _region_ok_taps += 1
        log.info("Tapped WePlay register region OK via node bounds (%s)", _region_ok_taps)
        return True
    for xml in (page_source, dump_xml):
        if xml and _click_exact_text_from_xml(driver, xml, "OK"):
            _region_ok_taps += 1
            log.info("Tapped WePlay register region OK via XML bounds (%s)", _region_ok_taps)
            return True
    return False


def _probe_confirm_id(driver: WebDriver) -> bool:
    try:
        driver.find_element(AppiumBy.ID, _CONFIRM_SURE_ID)
        return True
    except Exception:  # noqa: BLE001
        return False


def _probe_pakistan_option(driver: WebDriver) -> bool:
    try:
        el = driver.find_element(
            AppiumBy.ANDROID_UIAUTOMATOR,
            'new UiSelector().textContains("Pakistan").clickable(true)',
        )
        text = (getattr(el, "text", None) or "").lower()
        return "are you sure" not in text
    except Exception:  # noqa: BLE001
        return False


def complete_weplay_region_register(driver: WebDriver, nodes: list[UiNode], page_source: str = "") -> bool:
    """Drive Register region → OK → 'Are you sure to choose Pakistan?' Confirm.

    Live evidence (run 88844087): Pakistan selected, Register OK opened a Confirm/Cancel
    modal (confirm_sure). Re-selecting Pakistan matched that title and never advanced.
    """
    global _region_pakistan_selected
    dump_xml = ""
    confirm_now = _confirm_visible(page_source, nodes, dump_xml) or _probe_confirm_id(driver)
    list_now = _region_list_visible(page_source, nodes, dump_xml) or (
        not confirm_now and _probe_pakistan_option(driver)
    )
    if not confirm_now and not list_now:
        if not region_register_in_progress():
            return False
        from weplay_df.driver import uiautomator_window_dump

        dump_xml = uiautomator_window_dump()
        confirm_now = _confirm_visible(page_source, nodes, dump_xml)
        list_now = _region_list_visible(page_source, nodes, dump_xml)

    if confirm_now:
        return _confirm_region_choice(driver, nodes, page_source, dump_xml)

    if not list_now:
        return False

    if not _region_pakistan_selected:
        if _select_pakistan_once(driver, nodes, dump_xml):
            return True
        # Pakistan is often already highlighted; still need OK.
        _region_pakistan_selected = True
        log.info("Treating Pakistan as selected on WePlay register region list")

    return _tap_region_ok(driver, nodes, page_source, dump_xml)


def _complete_birthday(driver: WebDriver, nodes: list[UiNode], hay: str) -> bool:
    """WePlay birthday prompt after region. Prefer Fill in later; otherwise Save."""
    if not any(hint in hay for hint in _BIRTHDAY_HINTS):
        return False
    if _click_uiautomator(driver, 'new UiSelector().text("Fill in later")') or tap_labeled(
        driver, nodes, ("fill in later",)
    ):
        log.info("Skipped WePlay birthday via Fill in later")
        return True
    if _click_uiautomator(driver, 'new UiSelector().text("Skip")') or tap_labeled(driver, nodes, ("skip",)):
        log.info("Skipped WePlay birthday via Skip")
        return True
    if _click_uiautomator(driver, 'new UiSelector().text("Save")') or tap_labeled(driver, nodes, ("save", "next", "ok")):
        log.info("Advanced WePlay birthday prompt")
        return True
    return False


def _complete_personal_profile(driver: WebDriver, nodes: list[UiNode], hay: str) -> bool:
    """Finish WejoyCompleteUserInfoActivity after Google Sign-In (gender + Save)."""
    if "complete personal profile" not in hay and "gender cannot be changed" not in hay:
        return False
    if _click_uiautomator(driver, 'new UiSelector().text("Fill in later")') or tap_labeled(
        driver, nodes, ("fill in later",)
    ):
        log.info("Skipped WePlay personal profile via Fill in later")
        return True
    if tap_labeled(driver, nodes, ("male",)) or _click_uiautomator(driver, 'new UiSelector().text("Male")'):
        log.info("Selected WePlay profile gender")
        time.sleep(0.3)
    if _click_uiautomator(driver, 'new UiSelector().text("Save")') or tap_labeled(driver, nodes, ("save",)):
        log.info("Saved WePlay personal profile")
        return True
    return False


def _fill_nickname_if_present(driver: WebDriver, nodes: list[UiNode], hay: str, email: str) -> bool:
    if not any(hint in hay for hint in _NICKNAME_HINTS):
        return False
    local = re.sub(r"[^A-Za-z0-9]", "", (email.split("@")[0] if email else ""))[:12]
    nickname = local or "player"
    fields = [
        n
        for n in nodes
        if "edittext" in n.class_name.lower() or "edit_text" in n.resource_id.lower()
    ]
    if not fields:
        try:
            el = driver.find_element(AppiumBy.CLASS_NAME, "android.widget.EditText")
            el.clear()
            el.send_keys(nickname)
            log.info("Entered WePlay nickname from Workspace local-part")
            return True
        except Exception:  # noqa: BLE001
            return False
    try:
        el = driver.find_element(AppiumBy.CLASS_NAME, "android.widget.EditText")
        el.clear()
        el.send_keys(nickname)
        log.info("Entered WePlay nickname from Workspace local-part")
        return True
    except Exception:  # noqa: BLE001
        return False


def advance_weplay_profile_prompts(
    driver: WebDriver,
    nodes: list[UiNode],
    page_source: str = "",
    email: str = "",
) -> bool:
    """Handle first-run screens that actually appear after region Confirm.

    Only acts on labels/fields present in the current hierarchy. Does not guess taps.
    """
    global _last_first_run_hay
    hay = _combined_hay(page_source, nodes)
    if looks_like_guest_login_dialog(page_source):
        return False
    if looks_like_tourist_login_tip(page_source, nodes) or looks_like_signing_in(page_source, nodes):
        return False
    if looks_like_region_confirm(page_source, nodes) or looks_like_region_register(page_source, nodes):
        return False
    if looks_like_login_ui(page_source, nodes) and not region_register_in_progress():
        return False
    if not hay.strip() and not region_register_in_progress():
        return False
    if hay and hay != _last_first_run_hay:
        log.info("WePlay first-run UI: %s", hay[:400])
        _last_first_run_hay = hay

    if _fill_nickname_if_present(driver, nodes, hay, email):
        time.sleep(0.3)
        for label in ("next", "done", "ok", "confirm", "enter"):
            if _click_uiautomator(driver, f'new UiSelector().text("{label.capitalize()}")'):
                log.info("Advanced WePlay nickname prompt via %s", label)
                return True
            if tap_labeled(driver, nodes, (label,)):
                log.info("Advanced WePlay nickname prompt via labeled %s", label)
                return True
        return True

    if _complete_birthday(driver, nodes, hay):
        return True

    if _complete_personal_profile(driver, nodes, hay):
        return True

    for label in WEPLAY_ONBOARDING_LABELS + ("i agree", "agree"):
        display = " ".join(part.capitalize() for part in label.split())
        if _click_uiautomator(driver, f'new UiSelector().text("{display}")'):
            log.info("Advanced WePlay first-run via %s", display)
            return True
        if tap_labeled(driver, nodes, (label,)):
            log.info("Advanced WePlay first-run via labeled %s", label)
            return True
    if region_register_in_progress() and _click_uiautomator(driver, 'new UiSelector().text("Confirm")'):
        log.info("Advanced WePlay first-run via Confirm")
        return True
    return False


def advance_weplay_first_run(
    driver: WebDriver,
    nodes: list[UiNode],
    page_source: str = "",
    kind: ScreenKind | None = None,
    email: str = "",
) -> bool:
    if kind is ScreenKind.PERMISSION:
        return dismiss_runtime_permission(driver, nodes, kind)
    if dismiss_tourist_login_tip(driver, nodes, page_source):
        return True
    if looks_like_signing_in(page_source, nodes):
        return False
    if complete_weplay_region_register(driver, nodes, page_source):
        return True
    if kind is ScreenKind.WEPLAY_LOGIN and not region_register_in_progress():
        return False
    if kind is not None and kind not in {
        ScreenKind.WEPLAY_ONBOARDING,
        ScreenKind.WEPLAY_LOGIN,
        ScreenKind.PERMISSION,
    }:
        return False
    return advance_weplay_profile_prompts(driver, nodes, page_source, email)


def advance_weplay_onboarding(driver: WebDriver, nodes: list[UiNode], kind: ScreenKind) -> bool:
    if kind is not ScreenKind.WEPLAY_ONBOARDING:
        return False
    return advance_weplay_first_run(driver, nodes, kind=kind)
