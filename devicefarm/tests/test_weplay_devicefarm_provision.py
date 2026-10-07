import logging
import os

import pytest

from weplay_df.constants import WEPLAY_PACKAGE
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.provision import run_provision

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
    from weplay_df.driver import create_driver

    session = create_driver(provision=True)
    try:
        yield session
    finally:
        try:
            session.quit()
        except Exception:  # noqa: BLE001
            pass


def test_weplay_devicefarm_provision(driver):
    """
    A fresh-device worker: sign the trusted Play Store Workspace account onto the
    Pixel, install WePlay from Play Store once, then for each assigned Workspace
    email add the Google account, Sign in with Google, and obtain a WePlay user id.
    Game-code join runs only when WEPLAY_GAME_CODE is set.
    """
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        result = run_provision(driver)
    except ActionRequired as exc:
        pytest.fail(str(exc))
    except FlowError as exc:
        pytest.fail(str(exc))
    assert result["ok"] is True
    assert result["weplayInstalled"] is True
    assert result["googleAccountPresent"] is True
    assert result["playStoreIdentityOk"] is True
    assert result["playStoreChannel"] in {"workspace", "devicefarm_managed_play"}
    if result["playStoreChannel"] == "workspace":
        assert result["playStoreAccountMatchesExpected"] is True
    assert result["weplayUserId"]
    if result.get("gameCodeSet"):
        assert result["joinedRoom"] is True
        assert result["screen"] == "weplay_room"
    else:
        assert result["screen"] in {"weplay_main", "weplay_room"}
    log.info("Provision verified for package %s screen=%s", WEPLAY_PACKAGE, result["screen"])
