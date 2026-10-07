"""Failure artifacts: package, activity, redacted hierarchy, screenshot."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from weplay_df.redact import redact

log = logging.getLogger("weplay.google")


def artifact_dir() -> Path:
    raw = os.environ.get("DEVICEFARM_LOG_DIR") or os.environ.get("WEPLAY_ARTIFACT_DIR") or "/tmp/weplay-devicefarm"
    path = Path(raw)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def capture_failure(
    *,
    driver,
    step: str,
    package: str,
    activity: str,
    page_source: str,
    extra: dict | None = None,
    screenshot_ok: bool = True,
) -> Path:
    folder = artifact_dir() / f"failure-{_stamp()}-{_safe(step)}"
    folder.mkdir(parents=True, exist_ok=True)
    meta = {
        "step": step,
        "package": package,
        "activity": activity,
        "extra": extra or {},
    }
    (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (folder / "page_source.xml").write_text(redact(page_source), encoding="utf-8")
    log.error("Failure at %s package=%s activity=%s artifacts=%s", step, package, activity, folder)

    try:
        from weplay_df.driver import dumpsys_activity_top, uiautomator_window_dump

        (folder / "dumpsys-activity-top.txt").write_text(redact(dumpsys_activity_top()), encoding="utf-8")
        (folder / "window_dump.xml").write_text(redact(uiautomator_window_dump()), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not collect dumpsys/window dump: %s", exc)

    if screenshot_ok and driver is not None:
        try:
            driver.get_screenshot_as_file(str(folder / "screenshot.png"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Screenshot failed: %s", exc)

    try:
        if driver is not None:
            log_lines = driver.get_log("logcat")
            text = "\n".join(entry.get("message", "") for entry in log_lines[-400:])
            (folder / "logcat-tail.txt").write_text(redact(text), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not collect logcat via Appium: %s", exc)

    return folder


def capture_step(
    *,
    driver,
    step: str,
    package: str,
    activity: str,
    page_source: str,
    extra: dict | None = None,
    screenshot_ok: bool = True,
) -> Path:
    folder = artifact_dir() / f"step-{_stamp()}-{_safe(step)}"
    folder.mkdir(parents=True, exist_ok=True)
    meta = {
        "step": step,
        "package": package,
        "activity": activity,
        "extra": extra or {},
    }
    (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (folder / "page_source.xml").write_text(redact(page_source), encoding="utf-8")
    log.info("Step %s package=%s activity=%s artifacts=%s", step, package, activity, folder)
    if screenshot_ok and driver is not None:
        try:
            driver.get_screenshot_as_file(str(folder / "screenshot.png"))
        except Exception as exc:  # noqa: BLE001
            log.warning("Screenshot failed: %s", exc)
    return folder


def _safe(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in value)[:60]
