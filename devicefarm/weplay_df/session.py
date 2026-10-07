"""Extract a genuine WePlay user/session id from UI and dumpsys — never invent one."""

from __future__ import annotations

import logging
import re
import time

from weplay_df.constants import WEPLAY_PACKAGE
from weplay_df.ui import UiNode

log = logging.getLogger("weplay.google")

_ID_ATTR_RE = re.compile(
    r"(?:weplay[_-]?u?id|user[_-]?id|uid)\s*[=:\"'\s]+(\d{6,12})",
    re.IGNORECASE,
)
_ID_LABEL_RE = re.compile(r"\bid[:\s]+(\d{6,12})\b", re.IGNORECASE)
_RESOURCE_ID_HINTS = (
    "user_id",
    "userid",
    "weplay_id",
    "weplayid",
    "me_id",
    "my_id",
    "uid_tv",
    "id_tv",
)


def android_package_uid(package_dump: str) -> str | None:
    match = re.search(r"userId=(\d+)", package_dump)
    return match.group(1) if match else None


def _plausible(value: str, *, skip: set[str]) -> bool:
    if not value.isdigit() or not (6 <= len(value) <= 12):
        return False
    if value in skip:
        return False
    if value in {"1080", "1920", "2400", "1440", "720", "10800"}:
        return False
    return True


def extract_weplay_user_id(
    *blobs: str,
    nodes: list[UiNode] | None = None,
    skip_ids: set[str] | None = None,
) -> str | None:
    skip = set(skip_ids or ())
    for node in nodes or []:
        rid = node.resource_id.lower()
        if any(hint in rid for hint in _RESOURCE_ID_HINTS):
            for raw in (node.text, node.content_desc):
                digits = re.sub(r"\D", "", raw)
                if _plausible(digits, skip=skip):
                    return digits
    combined = "\n".join(blob for blob in blobs if blob)
    for pattern in (_ID_ATTR_RE, _ID_LABEL_RE):
        for match in pattern.finditer(combined):
            value = match.group(1)
            if _plausible(value, skip=skip):
                return value
    return None


def collect_weplay_user_id(driver, email: str = "") -> str | None:
    from weplay_df.driver import adb_shell, dumpsys_activity_top, click_point
    from weplay_df.flow import snapshot

    package_dump = adb_shell("dumpsys", "package", WEPLAY_PACKAGE, timeout=12)
    skip = set()
    android_uid = android_package_uid(package_dump)
    if android_uid:
        skip.add(android_uid)
    logcat = adb_shell("logcat", "-d", "-t", "200", timeout=12)
    dumpsys = dumpsys_activity_top()
    screen, nodes, source = snapshot(driver, email)
    found = extract_weplay_user_id(source, dumpsys, logcat, nodes=nodes, skip_ids=skip)
    if found:
        return found
    tabs = [node for node in nodes if "tab_switch" in node.resource_id.lower() and node.clickable]
    if tabs and tabs[-1].bounds and tabs[-1].bounds.usable:
        click_point(driver, *tabs[-1].bounds.center)
        time.sleep(1.0)
        dumpsys = dumpsys_activity_top()
        screen, nodes, source = snapshot(driver, email)
        found = extract_weplay_user_id(source, dumpsys, logcat, nodes=nodes, skip_ids=skip)
    return found
