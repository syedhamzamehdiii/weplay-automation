"""In-room Show Support on Pixel (Voice Room)."""

from __future__ import annotations

import logging
import time

from appium.webdriver.webdriver import WebDriver

from weplay_df.artifacts import capture_failure
from weplay_df.classify import ScreenKind
from weplay_df.constants import SUPPORT_CLICK_TIMEOUT_S, SUPPORT_LABELS
from weplay_df.errors import FlowError
from weplay_df.flow import _click_node, snapshot
from weplay_df.join_room import in_voice_room
from weplay_df.ui import UiNode

log = logging.getLogger("weplay.google")


def _label(node: UiNode) -> str:
    return f"{node.text} {node.content_desc}".strip().lower()


def _matches_support(node: UiNode) -> bool:
    hay = _label(node)
    return any(token in hay for token in SUPPORT_LABELS)


def _matches_target(node: UiNode, target: str) -> bool:
    needle = target.strip().lower()
    if not needle:
        return False
    return needle in _label(node)


def click_show_support(driver: WebDriver, email: str, support_target: str = "") -> bool:
    """Tap Show Support in the voice room. Optionally tap a named support target."""
    deadline = time.monotonic() + SUPPORT_CLICK_TIMEOUT_S
    opened = False
    last_package = ""
    last_activity = ""
    last_source = ""

    while time.monotonic() < deadline:
        screen, nodes, source = snapshot(driver, email)
        last_package = screen.package
        last_activity = screen.activity
        last_source = source
        if not in_voice_room(screen.activity, source, ""):
            time.sleep(0.35)
            continue

        support_nodes = [node for node in nodes if node.clickable and _matches_support(node)]
        if not support_nodes:
            support_nodes = [node for node in nodes if _matches_support(node)]
        if support_nodes:
            support_nodes.sort(key=lambda node: (0 if "show" in _label(node) else 1, -node.bounds.area if node.bounds else 0))
            if _click_node(driver, support_nodes[0]):
                opened = True
                log.info("Tapped Show Support in voice room")
                time.sleep(0.8)
                continue

        if opened and support_target.strip():
            screen, nodes, source = snapshot(driver, email)
            targets = [node for node in nodes if node.clickable and _matches_target(node, support_target)]
            if not targets:
                targets = [node for node in nodes if _matches_target(node, support_target)]
            if targets and _click_node(driver, targets[0]):
                log.info("Selected support target")
                return True

        if opened and not support_target.strip():
            return True

        time.sleep(0.35)

    capture_failure(
        driver=driver,
        step="show_support",
        package=last_package,
        activity=last_activity,
        page_source=last_source,
        extra={"supportTargetSet": bool(support_target.strip()), "openedSupport": opened},
        screenshot_ok=True,
    )
    raise FlowError(
        "show_support",
        "Show Support was not confirmed in the voice room"
        + (f" (target={support_target.strip()!r})" if support_target.strip() else ""),
    )
