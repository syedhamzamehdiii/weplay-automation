"""Local unit tests — no Appium / no device required."""

from __future__ import annotations

import os

import pytest

from weplay_df.classify import ScreenKind, classify
from weplay_df.constants import GOOGLE_EMAIL_ENV, GOOGLE_PASSWORD_ENV, PLAY_STORE_EMAIL_ENV, WEPLAY_PACKAGE
from weplay_df.dumpsys import (
    dumpsys_oauth_ui_started,
    find_google_button_from_dumpsys,
    parse_login_layout_buttons,
    weplay_start_activity_resumed,
)
from weplay_df.flow import add_another_account_node, play_store_email, required_google_email, target_workspace_emails
from weplay_df.google_account import (
    settings_accounts_entry_node,
    settings_add_account_node,
    settings_google_entry_node,
)
from weplay_df.login_button import find_google_button
from weplay_df.redact import redact
from weplay_df.ui import iter_ui_nodes, parse_xml_bounds

OPPO_DUMP = """
    View Hierarchy:
      DecorView@b8f2ca6[StartActivity]
        android.widget.LinearLayout{4d09d0e V.E...... ........ 0,0-720,1432}
                com.wejoy.weplay.login.WejoyLoginView{5afd817 V.E...... ........ 0,0-720,1376 #7f0a12c9 app:id/login_view}
                    android.widget.LinearLayout{ce8c70 V.E...... ........ 202,1097-518,1225 #7f0a12c1 app:id/login_horizontal_btn_layout}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{55c1be9 VFE...C.. ........ 0,0-128,128}
                    android.widget.LinearLayout{cffc57a V.E...... ........ 112,813-608,1057 #7f0a12c8 app:id/login_vertical_btn_layout}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{d6e712b VFE...C.. ........ 0,0-496,112}
                        androidx.appcompat.widget.AppCompatImageView{c37988 V.ED..... ........ 24,24-88,88}
                        com.huiwan.widget.CustomTextView{9725f21 V.ED..... ........ 126,35-369,76}
                        com.huiwan.widget.CustomTextView{334bf46 V.ED..... ........ 411,0-496,36}
                        com.huiwan.widget.CustomTextView{5e0f507 V.ED..... ........ 411,0-496,36}
                      android.widget.Space{5daa634 I.ED..... ......I. 0,112-496,132}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{cf4cc5d VFE...C.. ........ 0,132-496,244}
                        com.huiwan.widget.CustomTextView{40ddaa3 V.ED..... ........ 110,35-385,76}
"""

PIXEL_LOGIN_XML = """
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.wejoy.weplay.ar"
        bounds="[0,0][1080,2400]">
    <node class="com.wejoy.weplay.login.WejoyLoginView" resource-id="com.wejoy.weplay.ar:id/login_view"
          bounds="[0,0][1080,2400]">
      <node class="android.widget.LinearLayout" resource-id="com.wejoy.weplay.ar:id/login_vertical_btn_layout"
            bounds="[168,1368][912,1776]">
        <node class="com.wejoy.weplay.login.WejoyLargeLoginBtnView" clickable="true"
              bounds="[168,1368][912,1572]">
          <node class="android.widget.TextView" text="Google" bounds="[300,1420][600,1500]"/>
        </node>
        <node class="com.wejoy.weplay.login.WejoyLargeLoginBtnView" clickable="true"
              bounds="[168,1572][912,1776]">
          <node class="android.widget.TextView" text="Facebook" bounds="[300,1620][780,1700]"/>
        </node>
      </node>
    </node>
  </node>
</hierarchy>
"""

DUMMY_XML = """
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.wejoy.weplay.ar"
        resource-id="login_google" content-desc="login_google" bounds="[0,0][0,0]"/>
</hierarchy>
"""

PICKER_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Choose an account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true"
          text="workspace.user@example.com" bounds="[80,400][1000,520]"/>
  </node>
</hierarchy>
"""

PIN_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Enter PIN" bounds="[100,200][980,280]"/>
    <node class="android.widget.Button" clickable="true" text="1" bounds="[100,800][300,1000]"/>
    <node class="android.widget.Button" clickable="true" text="2" bounds="[400,800][600,1000]"/>
    <node class="android.widget.Button" clickable="true" text="3" bounds="[700,800][900,1000]"/>
    <node class="android.widget.Button" clickable="true" text="4" bounds="[100,1100][300,1300]"/>
  </node>
</hierarchy>
"""

CAPTCHA_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="I'm not a robot" bounds="[80,400][1000,480]"/>
  </node>
</hierarchy>
"""


def test_dummy_bounds_are_unusable():
    assert parse_xml_bounds("[0,0][0,0]") is None
    nodes = iter_ui_nodes(DUMMY_XML)
    dummy = next(n for n in nodes if "login_google" in n.haystack)
    assert dummy.bounds is None


def test_google_button_from_text_and_large_view():
    nodes = iter_ui_nodes(PIXEL_LOGIN_XML)
    target = find_google_button(nodes, PIXEL_LOGIN_XML, None, (1080, 2400), login_screen_confirmed=True)
    assert target.strategy in {"ui_hierarchy", "large_login_btn"}
    assert 168 <= target.x <= 912
    assert 1368 <= target.y <= 1572


def test_google_button_prefers_sign_in_with_google_over_create_account():
    xml = """
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="com.wejoy.weplay.login.WejoyLoginView" resource-id="com.wejoy.weplay.ar:id/login_view" bounds="[0,0][1080,2400]">
      <node class="android.widget.LinearLayout" resource-id="com.wejoy.weplay.ar:id/login_vertical_btn_layout" bounds="[168,1368][912,1880]">
        <node class="com.wejoy.weplay.login.WejoyLargeLoginBtnView" clickable="true" bounds="[168,1368][912,1572]">
          <node class="android.widget.TextView" text="Create a New Account" bounds="[300,1420][800,1500]"/>
        </node>
        <node class="com.wejoy.weplay.login.WejoyLargeLoginBtnView" clickable="true" bounds="[168,1600][912,1804]">
          <node class="android.widget.TextView" text="Sign in with Google" bounds="[300,1660][800,1740]"/>
        </node>
      </node>
    </node>
  </node>
</hierarchy>
"""
    nodes = iter_ui_nodes(xml)
    target = find_google_button(nodes, xml, None, (1080, 2400), login_screen_confirmed=True)
    assert 1600 <= target.y <= 1804
    assert target.strategy == "ui_hierarchy"


PIXEL_CREATE_THEN_GOOGLE_DUMP = """
    View Hierarchy:
      DecorView@b8f2ca6[StartActivity]
        android.widget.LinearLayout{4d09d0e V.E...... ........ 0,0-1080,2400}
                com.wejoy.weplay.login.WejoyLoginView{5afd817 V.E...... ........ 0,0-1080,2400}
                    android.widget.LinearLayout{ce8c70 V.E...... ........ 202,2000-878,2200 #7f0a12c1 app:id/login_horizontal_btn_layout}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{55c1be9 VFE...C.. ........ 0,0-128,128}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{66c1be9 VFE...C.. ........ 140,0-268,128}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{77c1be9 VFE...C.. ........ 280,0-408,128}
                    android.widget.LinearLayout{cffc57a V.E...... ........ 168,1368-912,1880 #7f0a12c8 app:id/login_vertical_btn_layout}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{d6e712b VFE...C.. ........ 0,0-744,204}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{cf4cc5d VFE...C.. ........ 0,232-744,436}
"""


def test_dumpsys_google_button_is_second_large_when_three_social_icons_present():
    x, y = find_google_button_from_dumpsys(PIXEL_CREATE_THEN_GOOGLE_DUMP)
    large = parse_login_layout_buttons(
        PIXEL_CREATE_THEN_GOOGLE_DUMP, "login_vertical_btn_layout", "WejoyLargeLoginBtnView"
    )
    assert len(large) == 2
    assert (x, y) == (large[1].x, large[1].y)


PIXEL_8A_STATUS_BAR_DUMP = """
    View Hierarchy:
      com.android.internal.policy.DecorView{ab26cf3 V.E...... R....... 0,0-1080,2400 aid=0}[StartActivity]
        android.widget.LinearLayout{5f910e V.E...... ........ 0,0-1080,2337}
          android.widget.FrameLayout{371bb09 V.E...... ........ 0,121-1080,2337}
            androidx.appcompat.widget.FitWindowsLinearLayout{688b410 V.E...... ........ 0,0-1080,2216}
              androidx.appcompat.widget.ContentFrameLayout{d4160d3 V.E...... ........ 0,0-1080,2216}
                android.widget.FrameLayout{915a686 V.E...... ........ 0,0-1080,2216 #7f0a1cf4 app:id/root_lay}
                  com.wejoy.weplay.login.WejoyLoginView{f2ccf24 V.E...... ........ 0,0-1080,2216 #7f0a12c9 app:id/login_view}
                    android.widget.LinearLayout{73e1289 V.E...... ........ 256,1849-824,2017 #7f0a12c1 app:id/login_horizontal_btn_layout}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{5f9b990 VFE...C.. ........ 0,0-168,168}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{868debc VFE...C.. ........ 200,0-368,168}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{e87b2cb VFE...C.. ........ 400,0-568,168}
                    android.widget.LinearLayout{161a566 V.E...... ........ 215,1476-866,1796 #7f0a12c8 app:id/login_vertical_btn_layout}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{58889c1 VFE...C.. ........ 0,0-651,147}
                        com.huiwan.widget.CustomTextView{8f44954 V.ED..... ........ 140,46-511,101}
                      android.widget.Space{95300fd I.ED..... ......I. 0,147-651,173}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{352b1f2 VFE...C.. ........ 0,173-651,320}
                        com.huiwan.widget.CustomTextView{ef6a6c0 V.ED..... ........ 163,46-488,101}
"""


def test_dumpsys_google_button_adds_status_bar_ancestor_offset():
    x, y = find_google_button_from_dumpsys(PIXEL_8A_STATUS_BAR_DUMP)
    large = parse_login_layout_buttons(
        PIXEL_8A_STATUS_BAR_DUMP, "login_vertical_btn_layout", "WejoyLargeLoginBtnView"
    )
    assert len(large) == 2
    assert (x, y) == (large[1].x, large[1].y)
    # Relative-to-layout only would tap 540,1722 (inside Create a New Account).
    assert (x, y) != (540, 1722)
    assert x == 540
    assert y == 1843
    create_account_bottom = large[0].y + 73
    assert y > create_account_bottom


def test_dumpsys_oauth_ui_ignores_launcher_chrome_icon():
    launcher = (
        "ItemInfo(id=1 type=APP targetComponent=ComponentInfo{com.android.chrome/"
        "com.google.android.apps.chrome.Main} title=Chrome)\n"
        "ACTIVITY com.wejoy.weplay.ar/com.wepie.wespy.module.login.start.StartActivity\n"
        "      mResumed=true\n"
    )
    assert dumpsys_oauth_ui_started(launcher) is False
    hub = "ACTIVITY com.google.android.gms/com.google.android.gms.auth.api.signin.internal.SignInHubActivity\n"
    assert dumpsys_oauth_ui_started(hub) is True
    assisted = "ACTIVITY com.google.android.gms/.auth.api.credentials.assistedsignin.ui.AssistedSignInActivity\n"
    assert dumpsys_oauth_ui_started(assisted) is True


def test_google_button_refuses_coordinates_without_login_screen():
    nodes = iter_ui_nodes(PIXEL_LOGIN_XML)
    with pytest.raises(RuntimeError, match="login screen was not confirmed"):
        find_google_button(nodes, PIXEL_LOGIN_XML, None, (1080, 2400), login_screen_confirmed=False)


def test_google_button_refuses_ratio_fallback_when_bounds_dummy(monkeypatch):
    monkeypatch.delenv("WEPLAY_GOOGLE_TAP_X", raising=False)
    monkeypatch.delenv("WEPLAY_GOOGLE_TAP_Y", raising=False)
    nodes = iter_ui_nodes(DUMMY_XML)
    with pytest.raises(RuntimeError, match="Sign in with Google was not found"):
        find_google_button(nodes, DUMMY_XML, None, (1080, 2400), login_screen_confirmed=True)


def test_weplay_start_activity_resumed_reads_mresumed_in_section():
    dump = """
TASK 10318:com.wejoy.weplay.ar
  ACTIVITY com.wejoy.weplay.ar/com.wepie.wespy.module.login.start.StartActivity dbdfe3b
    Local Activity a7770fd State:
      mResumed=true mStopped=false mFinished=false
  ACTIVITY com.android.vending/com.google.android.finsky.activities.MainActivity
      mResumed=false
"""
    assert weplay_start_activity_resumed(dump) is True
    assert weplay_start_activity_resumed("no start activity") is False
    x, y = find_google_button_from_dumpsys(OPPO_DUMP)
    assert (x, y) == (360, 869)
    large = parse_login_layout_buttons(OPPO_DUMP, "login_vertical_btn_layout", "WejoyLargeLoginBtnView")
    assert large[0].text_view_count == 3


def test_region_register_dialog_is_weplay_onboarding():
    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Register" bounds="[200,700][880,780]"/>
    <node class="android.widget.TextView" text="Please select the region (It cannot be changed after selection) :" bounds="[180,800][900,920]"/>
    <node class="android.widget.TextView" clickable="true" text="Arabic" bounds="[200,960][880,1080]"/>
    <node class="android.widget.TextView" clickable="true" text="Pakistan" bounds="[200,1100][880,1220]"/>
    <node class="android.widget.Button" clickable="true" text="OK" bounds="[200,1400][880,1540]"/>
  </node>
</hierarchy>
"""
    nodes = iter_ui_nodes(xml)
    screen = classify(WEPLAY_PACKAGE, ".StartActivity", xml, nodes)
    assert screen.kind is ScreenKind.WEPLAY_ONBOARDING
    from weplay_df.classify import looks_like_region_register

    assert looks_like_region_register(xml, nodes)


REGION_CONFIRM_XML = """
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout package="com.wejoy.weplay.ar" bounds="[142,977][937,1481]">
    <android.widget.TextView text="Are you sure to choose Pakistan(پاکستان)? &#10; It cannot be changed afer you've chosen it"
          resource-id="com.wejoy.weplay.ar:id/confirm_title" bounds="[205,1040][874,1250]"/>
    <android.widget.TextView text="Cancel" resource-id="com.wejoy.weplay.ar:id/confirm_cancel"
          clickable="true" bounds="[218,1313][533,1418]"/>
    <android.widget.TextView text="Confirm" resource-id="com.wejoy.weplay.ar:id/confirm_sure"
          clickable="true" bounds="[546,1313][861,1418]"/>
  </android.widget.FrameLayout>
</hierarchy>
"""


class _FakeEl:
    def __init__(self, label: str, log: list[str], text: str = ""):
        self._label = label
        self._log = log
        self.text = text or label

    def click(self) -> None:
        self._log.append(self._label)


class _FakeDriver:
    def __init__(self, elements: dict[str, _FakeEl]):
        self._elements = elements
        self.script_taps: list[tuple[int, int]] = []

    def find_element(self, _by: str, value: str) -> _FakeEl:
        if value not in self._elements:
            raise Exception(f"no element {value}")
        return self._elements[value]

    def execute_script(self, _name: str, args: dict) -> None:
        self.script_taps.append((int(args["x"]), int(args["y"])))


def test_region_confirm_dialog_is_weplay_onboarding_not_login():
    from weplay_df.classify import looks_like_region_confirm, looks_like_region_register

    nodes = iter_ui_nodes(REGION_CONFIRM_XML)
    screen = classify(WEPLAY_PACKAGE, ".StartActivity", REGION_CONFIRM_XML, nodes)
    assert screen.kind is ScreenKind.WEPLAY_ONBOARDING
    assert screen.evidence == "region confirm"
    assert looks_like_region_confirm(REGION_CONFIRM_XML, nodes)
    assert not looks_like_region_register(REGION_CONFIRM_XML, nodes)


def test_region_confirm_taps_confirm_sure_once_not_pakistan():
    from weplay_df.prompts import complete_weplay_region_register, reset_region_register_state

    reset_region_register_state()
    clicks: list[str] = []
    confirm_id = "com.wejoy.weplay.ar:id/confirm_sure"
    driver = _FakeDriver({confirm_id: _FakeEl("confirm_sure", clicks, "Confirm")})
    nodes = iter_ui_nodes(REGION_CONFIRM_XML)
    assert complete_weplay_region_register(driver, nodes, REGION_CONFIRM_XML) is True
    assert clicks == ["confirm_sure"]
    assert complete_weplay_region_register(driver, nodes, REGION_CONFIRM_XML) is True
    assert clicks == ["confirm_sure", "confirm_sure"]
    assert complete_weplay_region_register(driver, nodes, REGION_CONFIRM_XML) is False
    assert "Pakistan" not in clicks
    assert (540, 1480) not in driver.script_taps


def test_region_list_selects_pakistan_once_then_ok():
    from weplay_df.prompts import complete_weplay_region_register, reset_region_register_state

    reset_region_register_state()
    clicks: list[str] = []
    pakistan = 'new UiSelector().textContains("Pakistan").clickable(true)'
    ok = 'new UiSelector().text("OK")'
    driver = _FakeDriver(
        {
            pakistan: _FakeEl("Pakistan", clicks, "Pakistan(پاکستان)"),
            ok: _FakeEl("OK", clicks, "OK"),
        }
    )
    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Register" bounds="[200,700][880,780]"/>
    <node class="android.widget.TextView" text="Please select the region (It cannot be changed after selection) :" bounds="[180,800][900,920]"/>
    <node class="android.widget.TextView" clickable="true" text="Pakistan" bounds="[200,1100][880,1220]"/>
    <node class="android.widget.Button" clickable="true" text="OK" bounds="[200,1400][880,1540]"/>
  </node>
</hierarchy>
"""
    nodes = iter_ui_nodes(xml)
    assert complete_weplay_region_register(driver, nodes, xml) is True
    assert clicks == ["Pakistan"]
    assert complete_weplay_region_register(driver, nodes, xml) is True
    assert clicks == ["Pakistan", "OK"]
    assert complete_weplay_region_register(driver, nodes, xml) is True
    assert clicks == ["Pakistan", "OK", "OK"]
    assert (540, 1480) not in driver.script_taps


TOURIST_TIP_XML = """
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout package="com.wejoy.weplay.ar" bounds="[0,957][1080,1380]">
    <android.widget.TextView text="Tip" resource-id="com.wejoy.weplay.ar:id/id_tip_double_bt_tl" bounds="[510,1020][568,1075]"/>
    <android.widget.TextView text="Tourist login is not supported temporarily"
          resource-id="com.wejoy.weplay.ar:id/id_tip_double_bt_content_tx" clickable="true" bounds="[184,1101][884,1149]"/>
    <android.widget.TextView text="Contact Us" resource-id="com.wejoy.weplay.ar:id/certificate_cancel_btn"
          clickable="true" bounds="[211,1212][526,1317]"/>
    <android.widget.TextView text="OK" resource-id="com.wejoy.weplay.ar:id/certificate_sure_btn"
          clickable="true" bounds="[552,1212][867,1317]"/>
  </android.widget.FrameLayout>
</hierarchy>
"""


def test_tourist_login_tip_is_onboarding_and_ok_is_tapped():
    from weplay_df.classify import looks_like_tourist_login_tip
    from weplay_df.prompts import dismiss_tourist_login_tip, reset_region_register_state

    reset_region_register_state()
    nodes = iter_ui_nodes(TOURIST_TIP_XML)
    screen = classify(WEPLAY_PACKAGE, ".StartActivity", TOURIST_TIP_XML, nodes)
    assert screen.kind is ScreenKind.WEPLAY_ONBOARDING
    assert screen.evidence == "tourist login tip"
    assert looks_like_tourist_login_tip(TOURIST_TIP_XML, nodes)
    clicks: list[str] = []
    ok_id = "com.wejoy.weplay.ar:id/certificate_sure_btn"
    driver = _FakeDriver({ok_id: _FakeEl("tourist_ok", clicks, "OK")})
    assert dismiss_tourist_login_tip(driver, nodes, TOURIST_TIP_XML) is True
    assert clicks == ["tourist_ok"]
    assert "Contact Us" not in clicks


def test_google_welcome_terms_is_consent_not_account_picker():
    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome" resource-id="headingText" bounds="[63,331][1018,449]"/>
    <node class="android.widget.TextView" text="workspace.user@example.com" bounds="[147,491][643,548]"/>
    <node class="android.widget.Button" clickable="true" text="Google Terms of Service" bounds="[317,635][742,685]"/>
    <node class="android.widget.Button" clickable="true" text="Privacy Policy" bounds="[519,961][761,1010]"/>
    <node class="android.widget.Button" clickable="true" text="I agree" bounds="[63,2126][1018,2276]"/>
  </node>
</hierarchy>
"""
    nodes = iter_ui_nodes(xml)
    screen = classify(
        "com.google.android.gms",
        ".auth.uiflows.minutemaid.MinuteMaidActivity",
        xml,
        nodes,
        target_email="workspace.user@example.com",
    )
    assert screen.kind is ScreenKind.GOOGLE_WELCOME
    agree = next(n for n in nodes if n.text.strip().lower() == "i agree")
    assert agree.clickable
    login_nodes = iter_ui_nodes(PIXEL_LOGIN_XML)
    login = classify(WEPLAY_PACKAGE, ".StartActivity", PIXEL_LOGIN_XML, login_nodes)
    assert login.kind is ScreenKind.WEPLAY_LOGIN

    picker_nodes = iter_ui_nodes(PICKER_XML)
    picker = classify(
        "com.google.android.gms",
        "AccountPickerActivity",
        PICKER_XML,
        picker_nodes,
        target_email="workspace.user@example.com",
    )
    assert picker.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER

    pin_nodes = iter_ui_nodes(PIN_XML)
    pin = classify("com.android.settings", ".password.ConfirmLockPassword", PIN_XML, pin_nodes)
    assert pin.kind is ScreenKind.GOOGLE_PIN

    main = classify(
        WEPLAY_PACKAGE,
        "com.wepie.wespy.module.main.MainActivity",
        "<hierarchy/>",
        [],
    )
    assert main.kind is ScreenKind.WEPLAY_MAIN


def test_captcha_is_action_required_not_bypass():
    nodes = iter_ui_nodes(CAPTCHA_XML)
    screen = classify("com.google.android.gms", "MinuteMaidActivity", CAPTCHA_XML, nodes)
    assert screen.kind is ScreenKind.ACTION_REQUIRED


GUEST_MODE_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="com.wejoy.weplay.login.WejoyLoginView" resource-id="com.wejoy.weplay.ar:id/login_view" bounds="[0,0][1080,2400]">
      <node class="android.widget.TextView" text="Sign in with Google" bounds="[168,1600][912,1804]"/>
    </node>
    <node class="android.widget.TextView" text="You are using guest mode to log in, and the game data in this mode will be cleared after changing the device! In order to prevent data loss, it is recommended that you would better to use your mobile phone number or other methods to log in." bounds="[80,800][1000,1200]"/>
    <node class="android.widget.Button" clickable="true" text="Cancel" bounds="[80,1300][500,1420]"/>
    <node class="android.widget.Button" clickable="true" text="Confirm" bounds="[540,1300][1000,1420]"/>
  </node>
</hierarchy>
"""


def test_weplay_guest_mode_dialog_is_login_not_google_phone_mfa():
    nodes = iter_ui_nodes(GUEST_MODE_XML)
    screen = classify(
        WEPLAY_PACKAGE,
        "com.wepie.wespy.module.login.start.StartActivity",
        GUEST_MODE_XML,
        nodes,
    )
    assert screen.kind is ScreenKind.WEPLAY_LOGIN


VERIFY_PIN_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Verify it's you" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" text="Use your screen lock" bounds="[80,300][1000,380]"/>
    <node class="android.widget.Button" clickable="true" content-desc="1" bounds="[100,800][300,1000]"/>
    <node class="android.widget.Button" clickable="true" content-desc="2" bounds="[400,800][600,1000]"/>
    <node class="android.widget.Button" clickable="true" content-desc="3" bounds="[700,800][900,1000]"/>
    <node class="android.widget.Button" clickable="true" content-desc="4" bounds="[100,1100][300,1300]"/>
  </node>
</hierarchy>
"""


def test_verify_its_you_with_pin_pad_is_confirm_lock_not_mfa():
    nodes = iter_ui_nodes(VERIFY_PIN_XML)
    screen = classify(
        "com.android.settings",
        ".password.ConfirmLockPassword",
        VERIFY_PIN_XML,
        nodes,
    )
    assert screen.kind is ScreenKind.GOOGLE_PIN


def test_verify_its_you_captcha_stays_action_required():
    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Verify it's you" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" text="I'm not a robot" bounds="[80,400][1000,480]"/>
  </node>
</hierarchy>
"""
    nodes = iter_ui_nodes(xml)
    screen = classify("com.google.android.gms", "MinuteMaidActivity", xml, nodes)
    assert screen.kind is ScreenKind.ACTION_REQUIRED
    assert "robot" in screen.evidence or "captcha" in screen.evidence


def test_redact_never_keeps_password():
    secret = "super-secret-workspace-pw"
    blob = f'password="{secret}" token=abc123 Set-Cookie: SID=xyz email=user@example.com'
    out = redact(blob, secrets=(secret,))
    assert secret not in out
    assert "abc123" not in out or "[REDACTED]" in out
    assert "[REDACTED]" in out


def test_missing_email_fails_with_actionable_error(monkeypatch):
    monkeypatch.delenv(GOOGLE_EMAIL_ENV, raising=False)
    monkeypatch.delenv("WEPLAY_GOOGLE_EMAILS", raising=False)
    with pytest.raises(Exception, match="WEPLAY_GOOGLE_EMAIL"):
        required_google_email()


def test_email_is_read_from_env(monkeypatch):
    monkeypatch.setenv(GOOGLE_EMAIL_ENV, "workspace.user@example.com")
    monkeypatch.delenv("WEPLAY_GOOGLE_EMAILS", raising=False)
    assert required_google_email() == "workspace.user@example.com"


def test_target_workspace_emails_parses_batch_and_dedupes(monkeypatch):
    monkeypatch.setenv(
        "WEPLAY_GOOGLE_EMAILS",
        "hamza@example.com, arjun@example.com, HAMZA@example.com; alina@example.com",
    )
    monkeypatch.delenv(GOOGLE_EMAIL_ENV, raising=False)
    assert target_workspace_emails() == [
        "hamza@example.com",
        "arjun@example.com",
        "alina@example.com",
    ]
    assert required_google_email() == "hamza@example.com"


def test_play_store_email_falls_back_to_weplay_email(monkeypatch):
    monkeypatch.setenv(GOOGLE_EMAIL_ENV, "target.user@example.com")
    monkeypatch.delenv(PLAY_STORE_EMAIL_ENV, raising=False)
    assert play_store_email() == "target.user@example.com"


def test_play_store_email_is_read_from_env(monkeypatch):
    monkeypatch.setenv(GOOGLE_EMAIL_ENV, "target.user@example.com")
    monkeypatch.setenv(PLAY_STORE_EMAIL_ENV, "play.user@example.com")
    assert play_store_email() == "play.user@example.com"
    assert required_google_email() == "target.user@example.com"


PLAY_STORE_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="WePlay" bounds="[80,200][1000,280]"/>
    <node class="android.widget.Button" clickable="true" text="Install" bounds="[200,1800][880,1960]"/>
  </node>
</hierarchy>
"""

IDENTIFIER_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Sign in with your Google Account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.EditText" resource-id="identifierId" text="" bounds="[80,400][1000,520]"/>
    <node class="android.widget.Button" clickable="true" text="Next" bounds="[800,2000][1000,2200]"/>
  </node>
</hierarchy>
"""

ADD_ACCOUNT_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Add an account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true" text="Google" bounds="[80,400][1000,520]"/>
  </node>
</hierarchy>
"""

SETTINGS_HOME_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" clickable="true" text="Passwords, passkeys &amp; accounts" bounds="[80,1400][1000,1520]"/>
    <node class="android.widget.TextView" clickable="true" text="Google" bounds="[80,1540][1000,1660]"/>
    <node class="android.widget.TextView" clickable="true" text="System" bounds="[80,1680][1000,1800]"/>
  </node>
</hierarchy>
"""

SETTINGS_GOOGLE_PAGE_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Google" bounds="[80,80][1000,180]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@example.com" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" clickable="true" text="Add another account" bounds="[80,560][1000,680]"/>
    <node class="android.widget.TextView" clickable="true" text="Backup" bounds="[80,720][1000,840]"/>
  </node>
</hierarchy>
"""

GRANT_PERMISSIONS_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.permissioncontroller" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Allow WePlay to send you notifications?" bounds="[80,800][1000,900]"/>
    <node class="android.widget.Button" clickable="true" text="Allow" bounds="[200,1100][880,1220]"/>
    <node class="android.widget.Button" clickable="true" text="Don't allow" bounds="[200,1260][880,1380]"/>
  </node>
</hierarchy>
"""

MANAGE_ACCOUNTS_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageButton" clickable="true" content-desc="Navigate up" bounds="[16,136][136,256]"/>
    <node class="android.widget.TextView" text="Manage accounts" bounds="[160,148][700,244]"/>
    <node class="android.widget.TextView" text="Accounts for Owner" bounds="[80,300][1000,380]"/>
    <node class="android.widget.TextView" text="work-9E6F@android-for-work.gserviceaccount.com" bounds="[221,420][996,520]"/>
    <node class="android.widget.TextView" text="Managed Account" bounds="[221,520][996,580]"/>
    <node class="android.widget.TextView" text="Add account" resource-id="android:id/title" bounds="[221,649][476,705]"/>
    <node class="android.widget.TextView" text="Automatically sync app data" bounds="[80,900][800,980]"/>
  </node>
</hierarchy>
"""

ADD_ANOTHER_ACCOUNT_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Choose an account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@example.com" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" clickable="true" text="Add another account" bounds="[80,600][1000,720]"/>
  </node>
</hierarchy>
"""


def test_google_web_identifier_id_is_not_an_android_resource_id():
    from weplay_df.flow import is_android_resource_id

    nodes = iter_ui_nodes(IDENTIFIER_XML)
    field = next(n for n in nodes if "identifier" in n.resource_id.lower())
    assert field.resource_id == "identifierId"
    assert field.bounds is not None
    assert is_android_resource_id(field.resource_id) is False
    assert is_android_resource_id("com.google.android.gms:id/account_name") is True


IDENTIFIER_LABEL_BEFORE_INPUT_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.view.View" resource-id="identifierId-label-id" text="Email or phone" bounds="[80,300][1000,380]"/>
    <node class="android.widget.EditText" resource-id="identifierId" text="" bounds="[80,400][1000,520]"/>
    <node class="android.widget.Button" clickable="true" text="Next" bounds="[800,2000][1000,2200]"/>
  </node>
</hierarchy>
"""


def test_identifier_input_skips_google_label_node():
    from weplay_df.flow import identifier_input_node, source_contains_value

    nodes = iter_ui_nodes(IDENTIFIER_LABEL_BEFORE_INPUT_XML)
    naive = next(n for n in nodes if "identifier" in n.resource_id.lower())
    assert naive.resource_id == "identifierId-label-id"
    field = identifier_input_node(nodes)
    assert field is not None
    assert field.resource_id == "identifierId"
    assert "edittext" in field.class_name.lower()
    assert source_contains_value(IDENTIFIER_LABEL_BEFORE_INPUT_XML, nodes, "user@example.com") is False
    filled = IDENTIFIER_LABEL_BEFORE_INPUT_XML.replace('resource-id="identifierId" text=""', 'resource-id="identifierId" text="user@example.com"')
    assert source_contains_value(filled, iter_ui_nodes(filled), "user@example.com") is True


def test_appium_exception_redacts_workspace_email(monkeypatch):
    from weplay_df.flow import _mask_email, _short_exc

    email = "kabeer@businessdost.online"
    monkeypatch.setenv(GOOGLE_EMAIL_ENV, email)
    monkeypatch.setenv(GOOGLE_PASSWORD_ENV, "tmp-secret")
    text = _short_exc(Exception(f"Cannot set the element to '{email}'. tmp-secret"))
    assert email not in text
    assert "tmp-secret" not in text
    assert _mask_email(email) in text


GET_BUTTON_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="WePlay" bounds="[80,200][1000,280]"/>
    <node class="android.widget.Button" clickable="true" text="Get" bounds="[720,360][1000,480]"/>
    <node class="android.widget.Button" clickable="true" text="Continue" bounds="[80,2100][1000,2302]"/>
  </node>
</hierarchy>
"""

PLAY_STORE_TOS_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome to Google Play" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" text="Google Play Terms of Service" bounds="[80,400][1000,480]"/>
    <node class="android.widget.Button" clickable="true" text="I agree" bounds="[80,1800][1000,1960]"/>
  </node>
</hierarchy>
"""

PLAY_STORE_UNAVAILABLE_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="This item isn't available" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" text="Try a different account or device." bounds="[80,540][1000,620]"/>
  </node>
</hierarchy>
"""

PLAY_STORE_ADMIN_BLOCKED_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="WePlay(ويبلاي) - Game &amp; Chat" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" text="Your administrator has not given you access to this item." bounds="[80,1684][975,1790]"/>
  </node>
</hierarchy>
"""

PLAY_STORE_DOWNLOADING_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="WePlay" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" text="Downloading" bounds="[80,1800][1000,1900]"/>
  </node>
</hierarchy>
"""


def test_play_store_prefers_get_over_bottom_continue():
    from weplay_df.playstore import (
        looks_like_weplay_listing,
        pick_install_node,
        pick_tos_node,
        play_store_install_in_progress,
        play_store_tos_visible,
        play_store_unavailable_reason,
    )

    nodes = iter_ui_nodes(GET_BUTTON_XML)
    chosen = pick_install_node(nodes, 2400)
    assert chosen is not None
    assert chosen.text == "Get"
    assert pick_tos_node(nodes, GET_BUTTON_XML, 2400) is None
    assert looks_like_weplay_listing(GET_BUTTON_XML, nodes) is True
    assert play_store_tos_visible(GET_BUTTON_XML) is False
    assert play_store_unavailable_reason(GET_BUTTON_XML) is None
    assert play_store_install_in_progress(GET_BUTTON_XML) is False


def test_play_store_taps_i_agree_on_terms_not_listing_continue():
    from weplay_df.playstore import pick_tos_node, play_store_tos_visible

    nodes = iter_ui_nodes(PLAY_STORE_TOS_XML)
    assert play_store_tos_visible(PLAY_STORE_TOS_XML) is True
    chosen = pick_tos_node(nodes, PLAY_STORE_TOS_XML, 2400)
    assert chosen is not None
    assert chosen.text == "I agree"


def test_play_store_detects_unavailable_listing_and_download():
    from weplay_df.playstore import play_store_install_in_progress, play_store_unavailable_reason

    assert play_store_unavailable_reason(PLAY_STORE_UNAVAILABLE_XML) == "this item isn't available"
    assert play_store_install_in_progress(PLAY_STORE_DOWNLOADING_XML) is True
    assert play_store_unavailable_reason(PLAY_STORE_XML) is None
    assert (
        play_store_unavailable_reason(PLAY_STORE_ADMIN_BLOCKED_XML)
        == "your administrator has not given you access"
    )


def test_classify_play_store_identifier_and_add_account():
    play_nodes = iter_ui_nodes(PLAY_STORE_XML)
    play = classify("com.android.vending", ".AssetBrowserActivity", PLAY_STORE_XML, play_nodes)
    assert play.kind is ScreenKind.PLAY_STORE

    id_nodes = iter_ui_nodes(IDENTIFIER_XML)
    identifier = classify("com.google.android.gms", "MinuteMaidActivity", IDENTIFIER_XML, id_nodes)
    assert identifier.kind is ScreenKind.GOOGLE_IDENTIFIER

    add_nodes = iter_ui_nodes(ADD_ACCOUNT_XML)
    add = classify("com.android.settings", ".accounts.ChooseAccountActivity", ADD_ACCOUNT_XML, add_nodes)
    assert add.kind is ScreenKind.ADD_ACCOUNT

    picker_nodes = iter_ui_nodes(ADD_ANOTHER_ACCOUNT_XML)
    picker = classify(
        "com.google.android.gms",
        ".auth.api.credentials.assistedsignin.ui.AssistedSignInActivity",
        ADD_ANOTHER_ACCOUNT_XML,
        picker_nodes,
        target_email="aaravkhan@example.com",
    )
    assert picker.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER
    node = add_another_account_node(picker_nodes)
    assert node is not None
    assert node.text.strip().lower() == "add another account"

    empty = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]"/>
</hierarchy>
"""
    assisted = classify(
        "com.google.android.gms",
        ".auth.api.credentials.assistedsignin.ui.AssistedSignInActivity",
        empty,
        iter_ui_nodes(empty),
        target_email="aaravkhan@example.com",
    )
    assert assisted.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER

    notify = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Allow WePlay to send you notifications?" bounds="[80,800][1000,900]"/>
    <node class="android.widget.Button" clickable="true" text="Allow" bounds="[200,1100][880,1220]"/>
    <node class="android.widget.Button" clickable="true" text="Don't allow" bounds="[200,1260][880,1380]"/>
  </node>
</hierarchy>
"""
    notify_screen = classify(
        "com.wejoy.weplay.ar",
        "com.wepie.wespy.module.main.MainActivity",
        notify,
        iter_ui_nodes(notify),
    )
    assert notify_screen.kind is ScreenKind.PERMISSION

    grant = classify(
        "com.google.android.permissioncontroller",
        ".permission.ui.GrantPermissionsActivity",
        GRANT_PERMISSIONS_XML,
        iter_ui_nodes(GRANT_PERMISSIONS_XML),
    )
    assert grant.kind is ScreenKind.PERMISSION
    assert grant.kind is not ScreenKind.GOOGLE_CONSENT


def test_settings_google_add_account_prefers_add_over_heading():
    home_nodes = iter_ui_nodes(SETTINGS_HOME_XML)
    assert settings_add_account_node(home_nodes) is None
    google_row = settings_google_entry_node(home_nodes)
    assert google_row is not None
    assert google_row.text.strip() == "Google"
    accounts = settings_accounts_entry_node(home_nodes)
    assert accounts is not None
    assert "accounts" in accounts.text.lower()

    google_page = iter_ui_nodes(SETTINGS_GOOGLE_PAGE_XML)
    add = settings_add_account_node(google_page)
    assert add is not None
    assert add.text.strip().lower() == "add another account"
    assert settings_google_entry_node(google_page) is None

    choose = iter_ui_nodes(ADD_ACCOUNT_XML)
    assert settings_add_account_node(choose) is None
    google_type = settings_google_entry_node(choose)
    assert google_type is not None
    assert google_type.text.strip() == "Google"

    manage = iter_ui_nodes(MANAGE_ACCOUNTS_XML)
    add_row = settings_add_account_node(manage)
    assert add_row is not None
    assert add_row.text.strip().lower() == "add account"
    assert add_row.clickable is False
    assert settings_google_entry_node(manage) is None

    home_screen = classify(
        "com.android.settings",
        ".homepage.SettingsHomepageActivity",
        SETTINGS_HOME_XML,
        home_nodes,
    )
    assert home_screen.kind is not ScreenKind.ACTION_REQUIRED

    passkey_xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Use a passkey" bounds="[80,400][1000,520]"/>
    <node class="android.widget.Button" clickable="true" text="Continue" bounds="[80,1800][1000,1960]"/>
  </node>
</hierarchy>
"""
    passkey = classify(
        "com.google.android.gms",
        "MinuteMaidActivity",
        passkey_xml,
        iter_ui_nodes(passkey_xml),
    )
    assert passkey.kind is ScreenKind.ACTION_REQUIRED
    assert passkey.evidence == "passkey"


def test_provision_result_omits_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("WEPLAY_ARTIFACT_DIR", str(tmp_path))
    from weplay_df.provision import write_provision_result

    path = write_provision_result(
        {
            "ok": True,
            "workspaceEmail": "workspace.user@example.com",
            "password": "should-not-be-written",
            "screen": "weplay_main",
        }
    )
    text = open(path, encoding="utf-8").read()
    assert "should-not-be-written" not in text
    assert "workspace.user@example.com" in text
    assert '"ok": true' in text


SEARCH_DIALOG_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" clickable="true" text="Room ID" bounds="[80,400][400,480]"/>
    <node class="android.widget.TextView" clickable="true" text="User ID" bounds="[420,400][740,480]"/>
    <node class="android.widget.EditText" text="" bounds="[80,520][1000,620]"/>
    <node class="android.widget.Button" clickable="true" text="Confirm" bounds="[540,700][1000,820]"/>
    <node class="android.widget.Button" clickable="true" text="Cancel" bounds="[80,700][500,820]"/>
  </node>
</hierarchy>
"""

MAIN_WITH_SEARCH_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageView" clickable="true" resource-id="com.wejoy.weplay.ar:id/search_room_imv" bounds="[900,80][1040,200]"/>
    <node class="android.view.View" resource-id="com.wejoy.weplay.ar:id/tab_switch_view" bounds="[0,2200][1080,2400]"/>
    <node class="android.widget.TextView" resource-id="com.wejoy.weplay.ar:id/user_id_tv" text="ID: 88223344" bounds="[80,300][400,360]"/>
  </node>
</hierarchy>
"""


def test_extract_weplay_user_id_from_profile_and_skips_android_uid():
    from weplay_df.session import extract_weplay_user_id

    nodes = iter_ui_nodes(MAIN_WITH_SEARCH_XML)
    assert extract_weplay_user_id(MAIN_WITH_SEARCH_XML, nodes=nodes, skip_ids={"10169"}) == "88223344"
    dumpsys = "userId=10169 weplay_uid=88223344"
    assert extract_weplay_user_id(dumpsys, skip_ids={"10169"}) == "88223344"
    assert extract_weplay_user_id("userId=10169", skip_ids={"10169"}) is None


def test_join_room_helpers_use_inspected_search_dialog():
    from weplay_df.dumpsys import find_view_center
    from weplay_df.join_room import joined_target_room, node_by_id, sanitize_game_code, search_dialog_visible

    assert sanitize_game_code("N-518 546") == "N518546"
    nodes = iter_ui_nodes(SEARCH_DIALOG_XML)
    assert search_dialog_visible(SEARCH_DIALOG_XML, nodes) is True
    search_nodes = iter_ui_nodes(MAIN_WITH_SEARCH_XML)
    assert node_by_id(search_nodes, "search_room_imv") is not None
    dump = "android.widget.ImageView{e8c1234 VFED..C. ........ 544,96-608,160 #7f0a1abc app:id/search_room_imv"
    assert find_view_center(dump, "search_room_imv") == (576, 128)
    assert joined_target_room(
        "BaseVoiceRoomActivity",
        "room N518546",
        "",
        "N518546",
    )
    assert joined_target_room("MainActivity", "room N518546", "", "N518546") is False
    assert joined_target_room("BaseVoiceRoomActivity", "voice room", "", "N518546", typed=True)
    assert joined_target_room("BaseVoiceRoomActivity", "voice room", "", "N518546", typed=False) is False


DUMPSYS_TWO_ACCOUNTS = """
Accounts: 2
Account {name=kabeer@businessdost.online, type=com.google}
Account {name=work-4B580A939E098AC5F16E7C649BD014@android-for-work.gserviceaccount.com, type=com.google.android.apps.work.clouddpc}
"""

PLAY_STORE_ACCOUNT_MENU_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageView" clickable="true" content-desc="Account and settings" bounds="[930,80][1040,190]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@businessdost.online" bounds="[80,400][1000,480]"/>
    <node class="android.widget.TextView" clickable="true" text="work-4B580A939E098AC5F16E7C649BD014@android-for-work.gserviceaccount.com" bounds="[80,500][1000,580]"/>
  </node>
</hierarchy>
"""


def test_parses_device_farm_managed_account_and_masks_emails():
    from weplay_df.accounts import (
        infer_play_store_account,
        is_managed_work_account,
        mask_email,
        parse_dumpsys_accounts,
    )

    accounts = parse_dumpsys_accounts(DUMPSYS_TWO_ACCOUNTS)
    assert [row.name for row in accounts] == [
        "kabeer@businessdost.online",
        "work-4B580A939E098AC5F16E7C649BD014@android-for-work.gserviceaccount.com",
    ]
    assert accounts[0].managed is False
    assert accounts[1].managed is True
    assert mask_email("kabeer@businessdost.online") == "ka***@businessdost.online"
    assert mask_email(accounts[1].name).startswith("work-***@")
    assert "4B580A" not in mask_email(accounts[1].name)
    assert is_managed_work_account(accounts[1].name, accounts[1].type) is True
    inferred = infer_play_store_account(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        nodes=[],
        page_source="<hierarchy/>",
    )
    assert inferred == accounts[1].name


def test_play_store_ui_shows_workspace_account_over_managed_dumpsys():
    from weplay_df.accounts import infer_play_store_account, parse_dumpsys_accounts, signed_in_as_from_ui
    from weplay_df.playstore import play_store_shows_expected_account, pick_play_store_account_chip

    accounts = parse_dumpsys_accounts(DUMPSYS_TWO_ACCOUNTS)
    nodes = iter_ui_nodes(PLAY_STORE_ACCOUNT_MENU_XML)
    inferred = infer_play_store_account(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        nodes=nodes,
        page_source=PLAY_STORE_ACCOUNT_MENU_XML,
    )
    assert inferred == accounts[1].name
    assert play_store_shows_expected_account(nodes, PLAY_STORE_ACCOUNT_MENU_XML, "kabeer@businessdost.online") is False
    chip = pick_play_store_account_chip(nodes, 1080, 2400)
    assert chip is not None
    assert "account" in chip.content_desc.lower()
    assert signed_in_as_from_ui(nodes, PLAY_STORE_ACCOUNT_MENU_XML) is None


def test_play_store_signed_in_as_chip_is_identity_source_of_truth():
    from weplay_df.accounts import (
        CHANNEL_DEVICEFARM_MANAGED_PLAY,
        diagnostics_payload,
        infer_play_store_account,
        parse_dumpsys_accounts,
        play_store_identity_allowed,
        signed_in_as_from_ui,
    )
    from weplay_df.playstore import play_store_shows_expected_account

    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageView" clickable="true"
          content-desc="Signed in as work-9E6F@android-for-work.gserviceaccoun" bounds="[930,80][1040,190]"/>
  </node>
</hierarchy>
"""
    accounts = parse_dumpsys_accounts(DUMPSYS_TWO_ACCOUNTS)
    nodes = iter_ui_nodes(xml)
    signed_in = signed_in_as_from_ui(nodes, xml)
    assert signed_in is not None
    assert "android-for-work" in signed_in.lower()
    inferred = infer_play_store_account(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        nodes=nodes,
        page_source=xml,
    )
    assert inferred == signed_in
    assert play_store_shows_expected_account(nodes, xml, "kabeer@businessdost.online") is False
    payload = diagnostics_payload(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        play_store_account=inferred,
        play_store_state="account_switcher_or_home",
    )
    assert payload["playStoreAccountMatchesExpected"] is False
    assert payload["playStoreChannel"] == CHANNEL_DEVICEFARM_MANAGED_PLAY
    assert payload["playStoreIdentityOk"] is True
    assert play_store_identity_allowed(
        expected="kabeer@businessdost.online",
        active=inferred,
        device_accounts=accounts,
    )


def test_play_store_signed_in_as_workspace_is_exact_match():
    from weplay_df.accounts import CHANNEL_WORKSPACE, infer_play_store_account, parse_dumpsys_accounts
    from weplay_df.playstore import play_store_shows_expected_account

    xml = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.vending" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageView" clickable="true"
          content-desc="Signed in as kabeer@businessdost.online" bounds="[930,80][1040,190]"/>
  </node>
</hierarchy>
"""
    accounts = parse_dumpsys_accounts(DUMPSYS_TWO_ACCOUNTS)
    nodes = iter_ui_nodes(xml)
    inferred = infer_play_store_account(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        nodes=nodes,
        page_source=xml,
    )
    assert inferred == "kabeer@businessdost.online"
    assert play_store_shows_expected_account(nodes, xml, "kabeer@businessdost.online") is True
    from weplay_df.accounts import classify_play_store_channel

    assert classify_play_store_channel(inferred, "kabeer@businessdost.online") == CHANNEL_WORKSPACE


def test_admin_block_without_workspace_play_account_is_wrong_account_not_allowlist():
    from weplay_df.accounts import diagnostics_payload, parse_dumpsys_accounts

    accounts = parse_dumpsys_accounts(DUMPSYS_TWO_ACCOUNTS)
    payload = diagnostics_payload(
        expected="kabeer@businessdost.online",
        device_accounts=accounts,
        play_store_account=accounts[1].name,
        play_store_state="blocked:your administrator has not given you access",
    )
    assert payload["playStoreAccountMatchesExpected"] is False
    assert payload["playStoreIdentityOk"] is True
    assert payload["playStoreChannel"] == "devicefarm_managed_play"
    assert payload["workspaceAccountOnDevice"] is True
    assert payload["expectedPlayStoreAccount"] == "ka***@businessdost.online"


WORK_EMAIL_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Sign in with your work account" bounds="[80,200][1000,320]"/>
    <node class="android.widget.EditText" resource-id="identifierId" text="aaravkhan@businessdost.online" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" text="Forgot email?" bounds="[80,540][400,600]"/>
    <node class="android.widget.Button" clickable="true" text="Next" bounds="[80,700][1000,840]"/>
  </node>
</hierarchy>
"""

WELCOME_LONG_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome" bounds="[80,200][1000,300]"/>
    <node class="android.widget.TextView" text="Welcome to your new account" bounds="[80,320][1000,400]"/>
    <node class="android.widget.TextView" text="aaravkhan@businessdost.online" bounds="[80,420][1000,480]"/>
    <node class="android.widget.TextView"
          text="Your organization's administrator manages this account and can access, process, or delete any data."
          bounds="[80,500][1000,900]"/>
    <node class="android.widget.ImageButton" clickable="true" content-desc="Scroll down" bounds="[500,2100][580,2180]"/>
    <node class="android.widget.TextView" text="Try another way" bounds="[80,2300][1000,2380]"/>
  </node>
</hierarchy>
"""

WELCOME_WITH_STALE_PASSWORD_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome" bounds="[80,120][1000,200]"/>
    <node class="android.widget.TextView" text="Welcome to your new account" bounds="[80,220][1000,300]"/>
    <node class="android.widget.TextView" text="kabeer@businessdost.online" bounds="[80,320][1000,380]"/>
    <node class="android.widget.EditText" password="true" text="" bounds="[80,400][1000,480]"/>
    <node class="android.widget.Button" clickable="true" text="I agree" bounds="[80,2100][1000,2260]"/>
  </node>
</hierarchy>
"""

WELCOME_ACCEPT_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome to your new account" bounds="[80,200][1000,300]"/>
    <node class="android.widget.TextView" text="aaravkhan@businessdost.online" bounds="[80,320][1000,380]"/>
    <node class="android.widget.Button" clickable="true" text="Accept" bounds="[80,2100][1000,2260]"/>
  </node>
</hierarchy>
"""

MULTI_ACCOUNT_PICKER_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Choose an account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@businessdost.online" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" clickable="true" text="aaravkhan@businessdost.online" bounds="[80,540][1000,660]"/>
    <node class="android.widget.TextView" clickable="true"
          text="work-4B580A939E098AC5F16E7C649BD014@android-for-work.gserviceaccount.com"
          bounds="[80,680][1000,800]"/>
    <node class="android.widget.TextView" clickable="true" text="Add another account" bounds="[80,820][1000,940]"/>
  </node>
</hierarchy>
"""

CONTINUE_AS_PLAY_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Continue as Kabeer" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@businessdost.online" bounds="[80,400][1000,520]"/>
    <node class="android.widget.Button" clickable="true" text="Continue" bounds="[80,600][1000,720]"/>
    <node class="android.widget.TextView" clickable="true" text="Add another account" bounds="[80,760][1000,880]"/>
  </node>
</hierarchy>
"""

BIRTHDAY_XML = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.wejoy.weplay.ar" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Select your birthday" bounds="[80,400][1000,480]"/>
    <node class="android.widget.Button" clickable="true" text="Fill in later" bounds="[80,1600][1000,1740]"/>
    <node class="android.widget.Button" clickable="true" text="Save" bounds="[80,1800][1000,1940]"/>
  </node>
</hierarchy>
"""


def test_work_email_identifier_is_google_identifier():
    from weplay_df.classify import looks_like_identifier_screen

    nodes = iter_ui_nodes(WORK_EMAIL_XML)
    screen = classify(
        "com.google.android.gms",
        "MinuteMaidActivity",
        WORK_EMAIL_XML,
        nodes,
        target_email="aaravkhan@businessdost.online",
    )
    assert screen.kind is ScreenKind.GOOGLE_IDENTIFIER
    assert looks_like_identifier_screen(WORK_EMAIL_XML, nodes)


def test_long_welcome_is_not_account_picker_and_needs_scroll():
    from weplay_df.classify import looks_like_google_welcome
    from weplay_df.flow import add_another_account_node, welcome_scroll_control_node

    nodes = iter_ui_nodes(WELCOME_LONG_XML)
    screen = classify(
        "com.google.android.gms",
        ".auth.uiflows.minutemaid.MinuteMaidActivity",
        WELCOME_LONG_XML,
        nodes,
        target_email="aaravkhan@businessdost.online",
    )
    assert screen.kind is ScreenKind.GOOGLE_WELCOME
    assert screen.kind is not ScreenKind.ACTION_REQUIRED
    assert looks_like_google_welcome(WELCOME_LONG_XML, "aaravkhan@businessdost.online")
    assert add_another_account_node(nodes) is None
    chevron = welcome_scroll_control_node(nodes)
    assert chevron is not None
    assert "scroll" in f"{chevron.content_desc} {chevron.resource_id}".lower()

    silent = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Welcome to your new account" bounds="[80,200][1000,300]"/>
    <node class="android.widget.ImageView" bounds="[500,2060][580,2140]"/>
  </node>
</hierarchy>
"""
    silent_chevron = welcome_scroll_control_node(iter_ui_nodes(silent))
    assert silent_chevron is not None
    assert silent_chevron.clickable is False
    accept = classify(
        "com.google.android.gms",
        ".auth.uiflows.minutemaid.MinuteMaidActivity",
        WELCOME_ACCEPT_XML,
        iter_ui_nodes(WELCOME_ACCEPT_XML),
        target_email="aaravkhan@businessdost.online",
    )
    assert accept.kind is ScreenKind.GOOGLE_WELCOME
    from weplay_df.constants import WELCOME_ACCEPT_ONLY_LABELS, WELCOME_BUTTON_LABELS
    from weplay_df.flow import _labeled_node

    accept_btn = _labeled_node(iter_ui_nodes(WELCOME_ACCEPT_XML), WELCOME_BUTTON_LABELS)
    assert accept_btn is not None
    assert accept_btn.text.strip().lower() == "accept"
    assert "continue" not in WELCOME_ACCEPT_ONLY_LABELS
    assert _labeled_node(iter_ui_nodes(WELCOME_ACCEPT_XML), WELCOME_ACCEPT_ONLY_LABELS) is not None

    stale = classify(
        "com.google.android.gms",
        "MinuteMaidActivity",
        WELCOME_WITH_STALE_PASSWORD_XML,
        iter_ui_nodes(WELCOME_WITH_STALE_PASSWORD_XML),
        target_email="kabeer@businessdost.online",
    )
    assert stale.kind is ScreenKind.GOOGLE_WELCOME
    agree = _labeled_node(iter_ui_nodes(WELCOME_WITH_STALE_PASSWORD_XML), WELCOME_BUTTON_LABELS)
    assert agree is not None
    assert agree.text.strip().lower() == "i agree"

    challenge = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Verify it's you" bounds="[80,200][1000,280]"/>
    <node class="android.widget.Button" clickable="true" text="Try another way" bounds="[80,1800][1000,1960]"/>
  </node>
</hierarchy>
"""
    blocked = classify(
        "com.google.android.gms",
        "MinuteMaidActivity",
        challenge,
        iter_ui_nodes(challenge),
    )
    assert blocked.kind is ScreenKind.ACTION_REQUIRED


def test_google_picker_selects_listed_workspace_or_adds_another():
    from weplay_df.flow import add_another_account_node, google_picker_plan

    multi = iter_ui_nodes(MULTI_ACCOUNT_PICKER_XML)
    assert google_picker_plan(multi, MULTI_ACCOUNT_PICKER_XML, "aaravkhan@businessdost.online") == "select_target"
    assert google_picker_plan(multi, MULTI_ACCOUNT_PICKER_XML, "newuser@businessdost.online") == "add_another"
    assert add_another_account_node(multi) is not None

    play_only = iter_ui_nodes(CONTINUE_AS_PLAY_XML)
    assert google_picker_plan(play_only, CONTINUE_AS_PLAY_XML, "aaravkhan@businessdost.online") == "add_another"
    assert google_picker_plan(play_only, CONTINUE_AS_PLAY_XML, "kabeer@businessdost.online") == "continue_as_target"

    already = iter_ui_nodes(PICKER_XML)
    assert google_picker_plan(already, PICKER_XML, "workspace.user@example.com") == "continue_as_target"
    assert google_picker_plan(already, PICKER_XML, "someone.else@example.com") == "scroll_picker"

    empty = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,0]"/>
</hierarchy>
"""
    assert google_picker_plan(iter_ui_nodes(empty), empty, "aaravkhan@businessdost.online") == "wait_for_sheet"

    expand = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Continue as Kabeer" bounds="[80,1600][1000,1680]"/>
    <node class="android.widget.TextView" text="kabeer@businessdost.online" bounds="[80,1700][1000,1760]"/>
    <node class="android.widget.Button" clickable="true" text="Continue" bounds="[80,1800][1000,1920]"/>
    <node class="android.widget.TextView" clickable="true" text="Sign in with another account" bounds="[80,1960][1000,2060]"/>
  </node>
</hierarchy>
"""
    assert google_picker_plan(iter_ui_nodes(expand), expand, "aaravkhan@businessdost.online") == "expand_picker"

    add_only = """
<hierarchy>
  <node class="android.widget.FrameLayout" package="com.google.android.gms" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" text="Choose an account" bounds="[80,200][1000,280]"/>
    <node class="android.widget.TextView" clickable="true" text="kabeer@businessdost.online" bounds="[80,400][1000,520]"/>
    <node class="android.widget.TextView" clickable="true" text="Add account" bounds="[80,600][1000,720]"/>
  </node>
</hierarchy>
"""
    assert google_picker_plan(iter_ui_nodes(add_only), add_only, "aaravkhan@businessdost.online") == "add_another"


def test_weplay_birthday_fill_in_later():
    from weplay_df.prompts import _complete_birthday, reset_region_register_state

    reset_region_register_state()
    nodes = iter_ui_nodes(BIRTHDAY_XML)
    clicks: list[str] = []
    driver = _FakeDriver(
        {'new UiSelector().text("Fill in later")': _FakeEl("fill_in_later", clicks, "Fill in later")}
    )
    hay = "select your birthday fill in later save"
    assert _complete_birthday(driver, nodes, hay) is True
    assert clicks == ["fill_in_later"]
