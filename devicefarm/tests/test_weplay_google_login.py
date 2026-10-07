import logging
import os

import pytest

from weplay_df.constants import WEPLAY_PACKAGE
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.flow import run_google_login

log = logging.getLogger("weplay.google")


def _has_live_session() -> bool:
    if os.environ.get("DEVICEFARM_DEVICE_UDID"):
        return True
    if os.environ.get("WEPLAY_DEVICE_FARM_LIVE", "").lower() in {"1", "true", "yes"}:
        return True
    return False


@pytest.fixture(scope="module")
def driver():
    if not _has_live_session():
        pytest.skip(
            "Live Appium session not configured. Set DEVICEFARM_DEVICE_UDID "
            "(Device Farm) or WEPLAY_DEVICE_FARM_LIVE=1 with a local Appium server."
        )
    from weplay_df.driver import create_driver, weplay_installed

    if os.environ.get("DEVICEFARM_DEVICE_UDID") or os.environ.get("ANDROID_UDID"):
        if not weplay_installed():
            pytest.fail(
                f"{WEPLAY_PACKAGE} is not installed. This test launches the Play Store "
                "WePlay already on the device and must not install from DEVICEFARM_APP_PATH."
            )
    session = create_driver()
    try:
        yield session
    finally:
        try:
            session.quit()
        except Exception:  # noqa: BLE001
            pass


def test_weplay_google_login(driver):
    """
    Launch already-installed WePlay, tap Google, pick the Workspace account,
    enter device PIN 1234 if asked, and verify a post-login WePlay session.

    This test does not install or uninstall com.wejoy.weplay.ar.
    """
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        screen = run_google_login(driver)
    except ActionRequired as exc:
        pytest.fail(str(exc))
    except FlowError as exc:
        pytest.fail(str(exc))
    assert screen.kind.value in {"weplay_main", "weplay_room", "weplay_onboarding"}
    log.info("WePlay Google Sign-In reached %s", screen.kind.value)
