"""Appium 3 / UiAutomator2 session. Provision mode does not require WePlay to already be installed."""

from __future__ import annotations

import logging
import os
import subprocess

from appium import webdriver
from appium.webdriver.common.appiumby import AppiumBy
from appium.options.android import UiAutomator2Options
from appium.webdriver.webdriver import WebDriver

from weplay_df.constants import START_ACTIVITY, WEPLAY_PACKAGE

log = logging.getLogger("weplay.google")


def appium_url() -> str:
    explicit = os.environ.get("APPIUM_URL")
    if explicit:
        return explicit
    base = os.environ.get("APPIUM_BASE_PATH", "")
    return f"http://127.0.0.1:4723{base}"


def _base_capabilities() -> dict:
    device_name = os.environ.get("DEVICEFARM_DEVICE_NAME") or os.environ.get("ANDROID_DEVICE_NAME") or "Android"
    udid = os.environ.get("DEVICEFARM_DEVICE_UDID") or os.environ.get("ANDROID_UDID") or ""
    capabilities: dict = {
        "platformName": "Android",
        "automationName": "UiAutomator2",
        "deviceName": device_name,
        "noReset": True,
        "fullReset": False,
        "newCommandTimeout": 300,
        "ignoreHiddenApiPolicyError": True,
        "autoGrantPermissions": False,
        "disableWindowAnimation": True,
    }
    if udid:
        capabilities["udid"] = udid
    capabilities.pop("app", None)
    return capabilities


def build_options(*, provision: bool = False) -> UiAutomator2Options:
    capabilities = _base_capabilities()
    if provision:
        capabilities.update(
            {
                "autoLaunch": False,
                "dontStopAppOnReset": True,
                "forceAppLaunch": False,
            }
        )
        log.info(
            "Appium capabilities (provision): platformName=Android automationName=UiAutomator2 "
            "deviceName=%s udid=%s autoLaunch=false (no WePlay app path)",
            capabilities.get("deviceName"),
            capabilities.get("udid") or "(unset)",
        )
    else:
        capabilities.update(
            {
                "appPackage": WEPLAY_PACKAGE,
                "appActivity": START_ACTIVITY,
                "dontStopAppOnReset": True,
                "autoLaunch": True,
                "forceAppLaunch": True,
            }
        )
        log.info(
            "Appium capabilities: platformName=Android automationName=UiAutomator2 "
            "deviceName=%s udid=%s appPackage=%s noReset=true (no app path)",
            capabilities.get("deviceName"),
            capabilities.get("udid") or "(unset)",
            WEPLAY_PACKAGE,
        )
    return UiAutomator2Options().load_capabilities(capabilities)


def create_driver(*, provision: bool = False) -> WebDriver:
    url = appium_url()
    log.info("Connecting to Appium at %s (provision=%s)", url, provision)
    driver = webdriver.Remote(command_executor=url, options=build_options(provision=provision))
    driver.implicitly_wait(0)
    return driver


def current_package(driver: WebDriver) -> str:
    try:
        return driver.current_package or ""
    except Exception:  # noqa: BLE001
        return ""


def current_activity(driver: WebDriver) -> str:
    try:
        return driver.current_activity or ""
    except Exception:  # noqa: BLE001
        return ""


def page_source(driver: WebDriver) -> str:
    try:
        return driver.page_source or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("page_source failed: %s", exc)
        return ""


def screen_size(driver: WebDriver) -> tuple[int, int]:
    try:
        size = driver.get_window_size()
        return int(size.get("width", 0)), int(size.get("height", 0))
    except Exception:  # noqa: BLE001
        return 0, 0


def click_point(driver: WebDriver, x: int, y: int) -> None:
    log.info("mobile: clickGesture at %s,%s", x, y)
    try:
        driver.execute_script("mobile: clickGesture", {"x": int(x), "y": int(y)})
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("clickGesture failed (%s); falling back to tap", exc)
    driver.tap([(int(x), int(y))])


def tap_screen(x: int, y: int) -> None:
    """Absolute screen tap via adb. Used when Appium accessibility cannot see WePlay controls."""
    log.info("adb input tap %s,%s", x, y)
    adb_shell("input", "tap", str(int(x)), str(int(y)), timeout=8)


def swipe_up(driver: WebDriver, percent: float = 0.8) -> None:
    """Scroll a long Google Welcome / TOS page so Continue/Accept becomes visible."""
    width, height = screen_size(driver)
    if width <= 0 or height <= 0:
        width, height = 1080, 2400
    try:
        driver.execute_script(
            "mobile: swipeGesture",
            {
                "left": max(1, width // 8),
                "top": int(height * 0.28),
                "width": max(8, (width * 3) // 4),
                "height": int(height * 0.5),
                "direction": "up",
                "percent": min(0.95, max(0.4, percent)),
            },
        )
        log.info("Swiped up via mobile:swipeGesture")
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("swipeGesture failed (%s); falling back to adb swipe", exc)
    start_y = int(height * 0.78)
    end_y = int(height * 0.28)
    adb_shell("input", "swipe", str(width // 2), str(start_y), str(width // 2), str(end_y), "450", timeout=8)


def scroll_into_view(driver: WebDriver, text: str) -> bool:
    """RecyclerView Settings rows are often missing from the dump until scrolled into view."""
    safe = text.replace("\\", "\\\\").replace('"', '\\"')
    selector = (
        "new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView("
        f'new UiSelector().text("{safe}"))'
    )
    try:
        driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
        log.info("Scrolled Settings into view: %s", text)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("scrollIntoView %s failed: %s", text, exc)
        return False


def unfreeze_package(package: str) -> None:
    """Undo Android cached-app freezer so Custom Tabs / GMS can start from WePlay."""
    for args in (
        ("cmd", "activity", "unfreeze", package),
        ("am", "unfreeze", package),
        ("cmd", "activity", "unfreeze-app", package),
    ):
        adb_shell(*args, timeout=8)


def press_keycode(driver: WebDriver, keycode: int) -> None:
    driver.press_keycode(keycode)


def activate_weplay(driver: WebDriver) -> None:
    log.info("Activating already-installed package %s", WEPLAY_PACKAGE)
    driver.activate_app(WEPLAY_PACKAGE)


def dumpsys_activity_top() -> str:
    try:
        result = subprocess.run(
            ["adb", "shell", "dumpsys", "activity", "top"],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
        return result.stdout or result.stderr or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("dumpsys activity top failed: %s", exc)
        return ""


def adb_shell(*args: str, timeout: int = 20) -> str:
    try:
        result = subprocess.run(
            ["adb", "shell", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return (result.stdout or "") + (result.stderr or "")
    except Exception as exc:  # noqa: BLE001
        log.warning("adb shell %s failed: %s", " ".join(args), exc)
        return ""


def adb_type_text(text: str) -> bool:
    """Type into the focused field. Avoids Appium setValue on WebView-hosted Google fields."""
    keyboard = adb_shell("input", "keyboard", "text", text, timeout=15)
    if "error" not in keyboard.lower() and "unknown" not in keyboard.lower():
        return True
    escaped = (
        text.replace("\\", "\\\\")
        .replace("%", "%%")
        .replace(" ", "%s")
        .replace("@", "\\@")
        .replace("'", "\\'")
    )
    adb_shell("input", "text", escaped, timeout=15)
    return True


def weplay_installed() -> bool:
    output = adb_shell("pm", "path", WEPLAY_PACKAGE, timeout=10)
    return WEPLAY_PACKAGE.replace(".", "/") in output or "package:" in output


def google_account_present(email: str) -> bool:
    if not email:
        return False
    output = adb_shell("dumpsys", "account", timeout=15)
    return email.lower() in output.lower()


def open_play_store_home(account: str = "") -> None:
    log.info("Opening Play Store home to inspect the active Google account")
    args = [
        "am",
        "start",
        "-n",
        "com.android.vending/com.google.android.finsky.activities.MainActivity",
    ]
    if account:
        args.extend(["--es", "authAccount", account])
    adb_shell(*args, timeout=15)


def force_stop_play_store() -> None:
    adb_shell("am", "force-stop", "com.android.vending", timeout=10)


def clear_weplay_app_data() -> str:
    """Wipe the WePlay session so the next Google identity can sign in. Keeps the Play-installed APK."""
    adb_shell("am", "force-stop", WEPLAY_PACKAGE, timeout=10)
    output = adb_shell("pm", "clear", WEPLAY_PACKAGE, timeout=20)
    log.info("pm clear %s: %s", WEPLAY_PACKAGE, (output or "").strip()[:200] or "(no output)")
    return output


def clear_play_store_data() -> str:
    output = adb_shell("pm", "clear", "com.android.vending", timeout=20)
    log.info("pm clear com.android.vending: %s", (output or "").strip()[:200] or "(no output)")
    return output


def open_play_account_chooser() -> None:
    """Ask Google Play / GMS to show an account chooser without adding a new account."""
    adb_shell(
        "am",
        "start",
        "-a",
        "com.google.android.gms.common.account.CHOOSE_ACCOUNT",
        "--es",
        "allowableAccountTypes",
        "com.google",
        timeout=15,
    )


def uiautomator_window_dump() -> str:
    adb_shell("uiautomator", "dump", "/sdcard/window_dump.xml", timeout=15)
    return adb_shell("cat", "/sdcard/window_dump.xml", timeout=15)


def open_play_store_listing(*, https: bool = False, account: str = "") -> None:
    listing = (
        f"https://play.google.com/store/apps/details?id={WEPLAY_PACKAGE}"
        if https
        else f"market://details?id={WEPLAY_PACKAGE}"
    )
    log.info("Opening Play Store listing for %s via %s", WEPLAY_PACKAGE, listing.split("?")[0])
    args = [
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        listing,
        "-p",
        "com.android.vending",
    ]
    if account:
        args.extend(["--es", "authAccount", account])
    adb_shell(*args, timeout=15)


def open_settings() -> None:
    log.info("Opening Android Settings")
    adb_shell("am", "start", "-a", "android.settings.SETTINGS", timeout=15)


def open_add_google_account() -> None:
    log.info("Opening Android add-account flow for Google")
    adb_shell(
        "am",
        "start",
        "-a",
        "android.settings.ADD_ACCOUNT_SETTINGS",
        "--esa",
        "account_types",
        "com.google",
        timeout=15,
    )
