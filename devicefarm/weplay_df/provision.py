"""Locked WePlay Device Farm provision (proven on Pixel 8a).

One Pixel run:

1. Settings → Google → Add account for the Play Store identity (WEPLAY_PLAY_STORE_EMAIL)
2. Welcome TOS: down-arrow / scroll, then I agree / Accept
3. Install WePlay from Play Store once (never sideload)
4. For each WEPLAY_GOOGLE_EMAILS target: Settings add account, Welcome I agree,
   WePlay Google Sign-In selecting that target (never Continue as Play identity)
5. After each verified WePlay user id, `pm clear` WePlay so the next identity can
   sign in. The Play-installed APK stays. Skip join unless WEPLAY_GAME_CODE is set.

Do not bypass CAPTCHA, MFA, or a real Try another way challenge.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from appium.webdriver.webdriver import WebDriver

from weplay_df.accounts import emails_match, list_device_accounts, mask_email as mask_account_email
from weplay_df.apk_inspect import (
    capture_play_installed_weplay,
    clear_device_logcat,
    dump_google_tap_logcat,
)
from weplay_df.artifacts import artifact_dir, capture_failure, capture_step
from weplay_df.constants import PROVISION_RESULT_FILENAME, RUN_MODE_ENV, WEPLAY_PACKAGE
from weplay_df.driver import (
    adb_shell,
    clear_weplay_app_data,
    dumpsys_activity_top,
    google_account_present,
    weplay_installed,
)
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.flow import play_store_email, run_google_login, snapshot, target_workspace_emails
from weplay_df.google_account import add_workspace_account
from weplay_df.join_room import configured_game_code, configured_support_target, join_configured_game, joined_target_room
from weplay_df.support import click_show_support
from weplay_df.playstore import install_weplay_from_play_store
from weplay_df.session import collect_weplay_user_id

log = logging.getLogger("weplay.google")


def _mask_email(email: str) -> str:
    return mask_account_email(email)


def write_provision_result(payload: dict[str, Any]) -> str:
    path = artifact_dir() / PROVISION_RESULT_FILENAME
    safe = dict(payload)
    for key in ("password", "pin", "token", "cookie"):
        safe.pop(key, None)
    path.write_text(json.dumps(safe, indent=2), encoding="utf-8")
    log.info("Wrote provision result to %s ok=%s", path, safe.get("ok"))
    return str(path)


def _record_step(driver: WebDriver, email: str, result: dict[str, Any], step: str, extra: dict[str, Any] | None = None) -> None:
    screen, _, source = snapshot(driver, email)
    result["screen"] = screen.kind.value
    result["package"] = screen.package
    result["activity"] = screen.activity
    capture_step(
        driver=driver,
        step=step,
        package=screen.package,
        activity=screen.activity,
        page_source=source,
        extra=extra or {},
        screenshot_ok="password" not in step,
    )


def _grant_weplay_account_permissions() -> None:
    adb_shell("pm", "grant", WEPLAY_PACKAGE, "android.permission.GET_ACCOUNTS", timeout=10)
    adb_shell("pm", "grant", WEPLAY_PACKAGE, "android.permission.USE_CREDENTIALS", timeout=10)


def _account_entry(
    email: str,
    *,
    ok: bool,
    weplay_user_id: str | None = None,
    google_account_present: bool = False,
    screen: str | None = None,
    activity: str | None = None,
    error: str | None = None,
    error_message: str | None = None,
    joined_room: bool = False,
    support_clicked: bool = False,
    duration_ms: int | None = None,
    join_duration_ms: int | None = None,
) -> dict[str, Any]:
    return {
        "workspaceEmail": email,
        "ok": ok,
        "weplayUserId": weplay_user_id,
        "googleAccountPresent": google_account_present,
        "screen": screen,
        "activity": activity,
        "error": error,
        "errorMessage": error_message,
        "joinedRoom": joined_room,
        "supportClicked": support_clicked,
        "durationMs": duration_ms,
        "joinDurationMs": join_duration_ms,
    }


def _sync_top_level_from_accounts(result: dict[str, Any]) -> None:
    accounts: list[dict[str, Any]] = result.get("accounts") or []
    succeeded = [row for row in accounts if row.get("ok") and row.get("weplayUserId")]
    result["ok"] = bool(accounts) and all(row.get("ok") for row in accounts)
    if succeeded:
        last = succeeded[-1]
        result["workspaceEmail"] = last.get("workspaceEmail") or result.get("workspaceEmail")
        result["weplayUserId"] = last.get("weplayUserId")
        result["googleAccountPresent"] = bool(last.get("googleAccountPresent"))
        result["screen"] = last.get("screen") or result.get("screen")
        result["activity"] = last.get("activity") or result.get("activity")
    elif accounts:
        first = accounts[0]
        result["workspaceEmail"] = first.get("workspaceEmail") or result.get("workspaceEmail")
        result["error"] = first.get("error") or result.get("error")
        result["errorMessage"] = first.get("errorMessage") or result.get("errorMessage")


def _provision_one_target(
    driver: WebDriver,
    email: str,
    play_email: str,
    result: dict[str, Any],
    *,
    reset_weplay: bool,
) -> dict[str, Any]:
    if reset_weplay:
        result["step"] = "weplay_reset"
        clear_weplay_app_data()
        _grant_weplay_account_permissions()
        log.info("Cleared WePlay app data before signing in %s (APK kept)", _mask_email(email))

    if not emails_match(email, play_email) and not google_account_present(email):
        result["step"] = "google_account_target"
        add_workspace_account(driver, email)
        if not google_account_present(email):
            raise FlowError(
                "google_account_target",
                "Target Workspace account is not on the device after Settings → Google → Add account. "
                "WePlay Sign-In needs both the Play identity and the target account listed.",
            )
        device_accounts = list_device_accounts()
        result["deviceAccounts"] = [row.masked for row in device_accounts]
        log.info(
            "Target Workspace account %s is on the device. All accounts: %s",
            _mask_email(email),
            result["deviceAccounts"],
        )
        _record_step(
            driver,
            email,
            result,
            "google_account_target",
            {"googleAccountPresent": True, "deviceAccounts": result["deviceAccounts"]},
        )

    result["step"] = "weplay_google_login"
    clear_device_logcat()
    try:
        screen = run_google_login(driver, email)
    finally:
        dump_google_tap_logcat()
        try:
            result["apkInspect"] = capture_play_installed_weplay()
        except Exception as exc:  # noqa: BLE001
            log.warning("Play-installed WePlay inspect after Google tap failed: %s", exc)
    present = google_account_present(email)
    if screen.kind.value not in {"weplay_main", "weplay_room"}:
        raise FlowError(
            "weplay_google_login",
            f"WePlay Google login ended on {screen.kind.value}, not an authenticated session",
        )
    if not emails_match(email, play_email) and not present:
        raise FlowError(
            "weplay_google_login",
            "WePlay Google Sign-In did not add the target Workspace account to the device. "
            "The Play Store account may have been used instead.",
        )
    _record_step(driver, email, result, "weplay_google_login", {"screen": screen.kind.value})

    result["step"] = "weplay_session"
    weplay_user_id = collect_weplay_user_id(driver, email)
    if not weplay_user_id:
        snap_screen, _, source = snapshot(driver, email)
        capture_failure(
            driver=driver,
            step="weplay_session",
            package=snap_screen.package,
            activity=snap_screen.activity,
            page_source=source,
            extra={"message": "WePlay user id was not present in UI, dumpsys, or logcat"},
            screenshot_ok=True,
        )
        raise FlowError(
            "weplay_session",
            "WePlay opened after Google Sign-In but a WePlay user id/session was not obtained. "
            "Not marking READY.",
        )
    _record_step(driver, email, result, "weplay_session", {"weplayUserId": weplay_user_id})
    return _account_entry(
        email,
        ok=True,
        weplay_user_id=weplay_user_id,
        google_account_present=present,
        screen=screen.kind.value,
        activity=screen.activity,
    )


def _join_and_support(
    driver: WebDriver,
    email: str,
    game_code: str,
    support_target: str,
    result: dict[str, Any],
) -> tuple[bool, bool, int]:
    started = time.monotonic()
    result["step"] = "join_room"
    join_configured_game(driver, email, game_code)
    screen, _, source = snapshot(driver, email)
    dumpsys = dumpsys_activity_top()
    joined = joined_target_room(screen.activity, source, dumpsys, game_code, typed=True)
    support_clicked = False
    if joined and screen.kind.value == "weplay_room":
        result["step"] = "show_support"
        click_show_support(driver, email, support_target)
        support_clicked = True
    join_ms = int((time.monotonic() - started) * 1000)
    _record_step(
        driver,
        email,
        result,
        "join_room",
        {"joinedRoom": joined, "supportClicked": support_clicked, "joinDurationMs": join_ms},
    )
    if not joined or screen.kind.value != "weplay_room":
        raise FlowError(
            "join_room",
            f"Game-code join was not confirmed (screen={screen.kind.value} activity={screen.activity}).",
        )
    return joined, support_clicked, join_ms


def run_mode() -> str:
    return (os.environ.get(RUN_MODE_ENV, "provision") or "provision").strip().lower()


def join_batch_mode() -> bool:
    return run_mode() in {"join", "join_batch"}


def run_provision(driver: WebDriver) -> dict[str, Any]:
    emails = target_workspace_emails()
    email = emails[0]
    play_email = play_store_email()
    game_code = configured_game_code()
    support_target = configured_support_target()
    batch_join = join_batch_mode()
    result: dict[str, Any] = {
        "ok": False,
        "workspaceEmail": email,
        "workspaceEmails": emails,
        "playStoreEmail": play_email,
        "weplayInstalled": weplay_installed(),
        "googleAccountPresent": google_account_present(email),
        "playStoreGoogleAccountPresent": google_account_present(play_email),
        "playStoreAccountMatchesExpected": False,
        "playStoreIdentityOk": False,
        "playStoreChannel": None,
        "playStoreAccount": None,
        "deviceAccounts": [],
        "playStoreState": None,
        "weplayUserId": None,
        "joinedRoom": False,
        "supportClicked": False,
        "gameCodeSet": bool(game_code),
        "supportTargetSet": bool(support_target),
        "runMode": run_mode(),
        "startedAtMs": int(time.time() * 1000),
        "screen": None,
        "package": None,
        "activity": None,
        "error": None,
        "step": "start",
        "apkInspect": None,
        "accounts": [],
    }
    log.info(
        "Locked Pixel batch for %s WePlay account(s) with Play Store identity %s: Play add once, Play Store install once, then Add account + WePlay picker per target",
        len(emails),
        _mask_email(play_email),
    )
    try:
        result["step"] = "google_account"
        add_workspace_account(driver, play_email)
        result["playStoreGoogleAccountPresent"] = google_account_present(play_email)
        result["googleAccountPresent"] = google_account_present(email)
        device_accounts = list_device_accounts()
        result["deviceAccounts"] = [row.masked for row in device_accounts]
        if not result["playStoreGoogleAccountPresent"]:
            raise FlowError(
                "google_account",
                "Play Store Workspace account is not present on the device after add-account flow",
            )
        log.info(
            "Play Store account %s is on the device. All accounts: %s",
            _mask_email(play_email),
            result["deviceAccounts"],
        )
        _record_step(
            driver,
            email,
            result,
            "google_account",
            {
                "googleAccountPresent": result["googleAccountPresent"],
                "playStoreGoogleAccountPresent": True,
                "deviceAccounts": result["deviceAccounts"],
            },
        )

        result["step"] = "play_store"
        play_diag = install_weplay_from_play_store(driver, play_email)
        result["weplayInstalled"] = weplay_installed()
        result["playStoreAccountMatchesExpected"] = bool(play_diag.get("playStoreAccountMatchesExpected"))
        result["playStoreIdentityOk"] = bool(play_diag.get("playStoreIdentityOk"))
        result["playStoreChannel"] = play_diag.get("playStoreChannel") or "unknown"
        result["playStoreAccount"] = play_diag.get("playStoreAccount")
        result["playStoreState"] = play_diag.get("playStoreState")
        if play_diag.get("deviceAccounts"):
            result["deviceAccounts"] = play_diag.get("deviceAccounts")
        if not result["weplayInstalled"]:
            raise FlowError("play_store", f"{WEPLAY_PACKAGE} is not installed after Play Store automation")
        _grant_weplay_account_permissions()
        if not result["playStoreIdentityOk"]:
            raise FlowError(
                "play_store",
                "Play Store identity was not confirmed. "
                f"Expected { _mask_email(play_email) }; active={result.get('playStoreAccount')}; "
                f"channel={result.get('playStoreChannel')}.",
            )
        _record_step(
            driver,
            email,
            result,
            "play_store",
            {
                "weplayInstalled": True,
                "playStoreAccountMatchesExpected": result["playStoreAccountMatchesExpected"],
                "playStoreIdentityOk": result["playStoreIdentityOk"],
                "playStoreChannel": result["playStoreChannel"],
                "playStoreAccount": result["playStoreAccount"],
                "playStoreState": result["playStoreState"],
            },
        )

        stop_remaining = False
        stop_error = "ACTION_REQUIRED"
        stop_message = "Stopped after a Google challenge on this Pixel"
        for index, target in enumerate(emails):
            if stop_remaining:
                result["accounts"].append(
                    _account_entry(
                        target,
                        ok=False,
                        error=stop_error,
                        error_message=stop_message,
                    )
                )
                continue
            try:
                account_started = time.monotonic()
                entry = _provision_one_target(
                    driver,
                    target,
                    play_email,
                    result,
                    reset_weplay=index > 0,
                )
                if game_code and entry.get("ok"):
                    joined, support_clicked, join_ms = _join_and_support(
                        driver, target, game_code, support_target, result
                    )
                    entry["joinedRoom"] = joined
                    entry["supportClicked"] = support_clicked
                    entry["joinDurationMs"] = join_ms
                    result["joinedRoom"] = joined
                    result["supportClicked"] = support_clicked
                    result["screen"] = "weplay_room"
                entry["durationMs"] = int((time.monotonic() - account_started) * 1000)
                if batch_join and game_code:
                    entry["ok"] = bool(entry.get("joinedRoom"))
                result["accounts"].append(entry)
                _sync_top_level_from_accounts(result)
                write_provision_result(result)
            except ActionRequired as exc:
                result["accounts"].append(
                    _account_entry(
                        target,
                        ok=False,
                        google_account_present=google_account_present(target),
                        error="ACTION_REQUIRED",
                        error_message=str(exc),
                    )
                )
                stop_remaining = True
                stop_error = "ACTION_REQUIRED"
                stop_message = "Stopped after a Google challenge on this Pixel"
                result["error"] = "ACTION_REQUIRED"
                result["errorMessage"] = str(exc)
                _sync_top_level_from_accounts(result)
                write_provision_result(result)
            except FlowError as exc:
                result["accounts"].append(
                    _account_entry(
                        target,
                        ok=False,
                        google_account_present=google_account_present(target),
                        error=exc.step,
                        error_message=str(exc),
                    )
                )
                result["error"] = exc.step
                result["errorMessage"] = str(exc)
                _sync_top_level_from_accounts(result)
                write_provision_result(result)

        if game_code and not batch_join and result["accounts"] and result["accounts"][-1].get("ok"):
            last_email = str(result["accounts"][-1]["workspaceEmail"])
            if not result["accounts"][-1].get("joinedRoom"):
                joined, support_clicked, join_ms = _join_and_support(
                    driver, last_email, game_code, support_target, result
                )
                result["accounts"][-1]["joinedRoom"] = joined
                result["accounts"][-1]["supportClicked"] = support_clicked
                result["accounts"][-1]["joinDurationMs"] = join_ms
                result["joinedRoom"] = joined
                result["supportClicked"] = support_clicked
        elif not game_code:
            log.info("WEPLAY_GAME_CODE is not set; skipping game-code join")

        _sync_top_level_from_accounts(result)
        result["totalDurationMs"] = int(time.time() * 1000) - int(result.get("startedAtMs") or 0)
        result["step"] = "verified" if result["ok"] else result.get("step") or "partial"
        write_provision_result(result)
        if result["ok"]:
            return result
        failed = next((row for row in result["accounts"] if not row.get("ok")), None)
        if failed and failed.get("error") == "ACTION_REQUIRED":
            raise ActionRequired(str(failed.get("errorMessage") or "Google presented a security challenge"))
        raise FlowError(
            str((failed or {}).get("error") or "weplay_google_login"),
            str((failed or {}).get("errorMessage") or "One or more WePlay accounts were not created on this Pixel"),
        )
    except ActionRequired as exc:
        result["error"] = "ACTION_REQUIRED"
        result["errorMessage"] = str(exc)
        _sync_top_level_from_accounts(result)
        write_provision_result(result)
        raise
    except FlowError as exc:
        result["error"] = exc.step
        result["errorMessage"] = str(exc)
        _sync_top_level_from_accounts(result)
        write_provision_result(result)
        raise
    except Exception as exc:  # noqa: BLE001
        result["error"] = "unknown"
        result["errorMessage"] = str(exc)
        write_provision_result(result)
        raise
