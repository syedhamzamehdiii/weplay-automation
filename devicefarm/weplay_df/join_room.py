"""Join the configured WePlay voice room / game code on a fresh Pixel."""

from __future__ import annotations

import logging
import os
import re
import time

from appium.webdriver.webdriver import WebDriver

from weplay_df.artifacts import capture_failure
from weplay_df.classify import ScreenKind
from weplay_df.constants import (
    GAME_CODE_ENV,
    JOIN_CONFIRM_LABELS,
    JOIN_ROOM_TAB_LABELS,
    JOIN_ROOM_TIMEOUT_S,
    JOIN_USER_TAB_LABELS,
    SEARCH_ROOM_VIEW_ID,
    SUPPORT_TARGET_ENV,
    TAB_SWITCH_VIEW_ID,
)
from weplay_df.driver import activate_weplay, adb_type_text, click_point, dumpsys_activity_top, press_keycode
from weplay_df.dumpsys import find_view_center
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.flow import _click_node, snapshot
from weplay_df.prompts import dismiss_runtime_permission
from weplay_df.ui import UiNode, page_text

log = logging.getLogger("weplay.google")

_KEYCODE_BACK = 4
_KEYCODE_ENTER = 66


def sanitize_game_code(raw: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", raw or "")


def configured_game_code() -> str:
    return sanitize_game_code(os.environ.get(GAME_CODE_ENV, ""))


def required_game_code() -> str:
    return configured_game_code()


def _rid(node: UiNode) -> str:
    return node.resource_id.lower()


def _exact(node: UiNode, labels: tuple[str, ...]) -> bool:
    return node.text.strip().lower() in labels or node.content_desc.strip().lower() in labels


def node_by_id(nodes: list[UiNode], view_id: str) -> UiNode | None:
    token = view_id.lower()
    matches = [node for node in nodes if token in _rid(node)]
    if not matches:
        return None
    matches.sort(key=lambda node: (0 if node.clickable else 1, -(node.bounds.area if node.bounds else 0)))
    return matches[0]


def search_dialog_visible(page_source: str, nodes: list[UiNode]) -> bool:
    text = page_text(page_source)
    if "search room" in text or "room id" in text:
        return True
    return any(_exact(node, JOIN_ROOM_TAB_LABELS + JOIN_USER_TAB_LABELS + JOIN_CONFIRM_LABELS) for node in nodes)


def in_voice_room(activity: str, page_source: str, dumpsys: str) -> bool:
    blob = f"{activity} {page_source} {dumpsys}".lower()
    return "basevoiceroom" in blob or "voiceroom.main" in blob


def room_mentions_code(page_source: str, dumpsys: str, game_code: str) -> bool:
    needle = sanitize_game_code(game_code).lower()
    hay = sanitize_game_code(f"{page_source} {dumpsys}").lower()
    return bool(needle) and needle in hay


def joined_target_room(
    activity: str,
    page_source: str,
    dumpsys: str,
    game_code: str,
    *,
    typed: bool = False,
) -> bool:
    if not in_voice_room(activity, page_source, dumpsys):
        return False
    if room_mentions_code(page_source, dumpsys, game_code):
        return True
    return typed


def _tap_search(driver: WebDriver, nodes: list[UiNode]) -> bool:
    search = node_by_id(nodes, SEARCH_ROOM_VIEW_ID)
    if search:
        return _click_node(driver, search)
    center = find_view_center(dumpsys_activity_top(), SEARCH_ROOM_VIEW_ID)
    if center:
        click_point(driver, center[0], center[1])
        return True
    return False


def _tap_voice_room_tab(driver: WebDriver, nodes: list[UiNode]) -> bool:
    tabs = [node for node in nodes if TAB_SWITCH_VIEW_ID in _rid(node) and node.clickable]
    if len(tabs) >= 2:
        return _click_node(driver, tabs[1])
    parent = node_by_id(nodes, TAB_SWITCH_VIEW_ID)
    if parent and parent.bounds:
        width = parent.bounds.width
        x = parent.bounds.left + (width * 3 // 10)
        y = parent.bounds.center[1]
        click_point(driver, x, y)
        return True
    for node in nodes:
        if node.clickable and any(token in node.haystack for token in ("voice", "room")):
            if "search" in node.haystack:
                continue
            return _click_node(driver, node)
    return False


def _ensure_room_id_tab(driver: WebDriver, nodes: list[UiNode]) -> None:
    if any(_exact(node, JOIN_ROOM_TAB_LABELS) for node in nodes):
        room_tab = next((node for node in nodes if _exact(node, JOIN_ROOM_TAB_LABELS)), None)
        if room_tab:
            _click_node(driver, room_tab)


def _type_game_code(driver: WebDriver, nodes: list[UiNode], game_code: str) -> bool:
    fields = [node for node in nodes if "edittext" in node.class_name.lower()]
    target = next((node for node in fields if node.bounds and node.bounds.usable), None)
    if target:
        _click_node(driver, target)
        time.sleep(0.3)
    adb_type_text(game_code)
    time.sleep(0.3)
    press_keycode(driver, _KEYCODE_ENTER)
    return True


def _tap_confirm(driver: WebDriver, nodes: list[UiNode]) -> bool:
    matches = [node for node in nodes if node.clickable and _exact(node, JOIN_CONFIRM_LABELS)]
    if not matches:
        matches = [node for node in nodes if _exact(node, JOIN_CONFIRM_LABELS)]
    if matches:
        return _click_node(driver, matches[0])
    return False


def configured_support_target() -> str:
    return (os.environ.get(SUPPORT_TARGET_ENV, "") or "").strip()


def join_configured_game(driver: WebDriver, email: str, game_code: str) -> None:
    activate_weplay(driver)
    time.sleep(0.45)
    deadline = time.monotonic() + JOIN_ROOM_TIMEOUT_S
    opened_search = False
    typed = False
    last_screen = None
    last_source = ""
    last_package = ""
    last_activity = ""

    while time.monotonic() < deadline:
        screen, nodes, source = snapshot(driver, email)
        last_screen = screen
        last_source = source
        last_package = screen.package
        last_activity = screen.activity
        dumpsys = dumpsys_activity_top()
        if screen.kind is ScreenKind.ACTION_REQUIRED:
            raise ActionRequired(
                f"Google presented a security challenge during room join ({screen.evidence}). "
                "Not attempting to bypass CAPTCHA, MFA, or anti-abuse checks."
            )
        if dismiss_runtime_permission(driver, nodes, screen.kind):
            time.sleep(0.35)
            continue
        if joined_target_room(screen.activity, source, dumpsys, game_code, typed=typed):
            log.info("Joined WePlay room for configured game code")
            return
        if screen.kind is ScreenKind.WEPLAY_ROOM and not typed:
            press_keycode(driver, _KEYCODE_BACK)
            time.sleep(0.45)
            continue
        if search_dialog_visible(source, nodes):
            opened_search = True
            _ensure_room_id_tab(driver, nodes)
            if not typed:
                _type_game_code(driver, nodes, game_code)
                typed = True
                time.sleep(0.25)
            if _tap_confirm(driver, nodes):
                time.sleep(1.0)
                continue
            time.sleep(0.35)
            continue
        if screen.kind is ScreenKind.WEPLAY_MAIN:
            if not opened_search:
                if _tap_search(driver, nodes):
                    opened_search = True
                    time.sleep(0.65)
                    continue
                if _tap_voice_room_tab(driver, nodes):
                    time.sleep(0.55)
                    continue
            elif not typed:
                if _tap_search(driver, nodes):
                    time.sleep(0.65)
                    continue
            time.sleep(0.35)
            continue
        time.sleep(0.35)

    capture_failure(
        driver=driver,
        step="join_room",
        package=last_package,
        activity=last_activity,
        page_source=last_source,
        extra={"gameCodeSet": True, "openedSearch": opened_search, "typed": typed},
        screenshot_ok=True,
    )
    kind = last_screen.kind.value if last_screen else "unknown"
    raise FlowError(
        "join_room",
        f"Did not enter the configured WePlay room (screen={kind} activity={last_activity}).",
    )
