import { describe, expect, it } from "vitest";
import {
  classifyWePlayScreen,
  dumpHasInspectedLoginButtons,
  findLoginButtonCenter,
  findViewCenter,
  isWePlayPhoneOtpDump,
  parseLoginLayoutButtons,
  providerPauseCode,
  selectActivityDump
} from "../../apps/usb-worker/src/weplayWindow.js";

/** Live dumpsys excerpt from Oppo CPH2083 WePlay 6.4.5 StartActivity. No app:id/login_google. */
const OPPO_STARTACTIVITY_DUMP = `
    View Hierarchy:
      DecorView@b8f2ca6[StartActivity]
        android.widget.LinearLayout{4d09d0e V.E...... ........ 0,0-720,1432}
          android.widget.FrameLayout{ac2ed3c V.E...... ........ 0,56-720,1432}
            androidx.appcompat.widget.ContentFrameLayout{7ad703e V.E...... ........ 0,0-720,1376 #1020002 android:id/content}
                com.wejoy.weplay.login.WejoyLoginView{5afd817 V.E...... ........ 0,0-720,1376 #7f0a12c9 app:id/login_view}
                    android.widget.LinearLayout{ce8c70 V.E...... ........ 202,1097-518,1225 #7f0a12c1 app:id/login_horizontal_btn_layout}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{55c1be9 VFE...C.. ........ 0,0-128,128}
                        androidx.appcompat.widget.AppCompatImageView{7ef106e V.ED..... ........ 8,8-120,120}
                      android.widget.Space{adfb30f I.ED..... ......I. 128,0-188,112}
                      com.wejoy.weplay.login.WejoySmallLoginBtnView{667ff9c VFE...C.. ........ 188,0-316,128}
                        androidx.appcompat.widget.AppCompatImageView{8d18da5 V.ED..... ........ 8,8-120,120}
                    android.widget.LinearLayout{cffc57a V.E...... ........ 112,813-608,1057 #7f0a12c8 app:id/login_vertical_btn_layout}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{d6e712b VFE...C.. ........ 0,0-496,112}
                        androidx.appcompat.widget.AppCompatImageView{c37988 V.ED..... ........ 24,24-88,88}
                        com.huiwan.widget.CustomTextView{9725f21 V.ED..... ........ 126,35-369,76}
                        com.huiwan.widget.CustomTextView{334bf46 V.ED..... ........ 411,0-496,36}
                        com.huiwan.widget.CustomTextView{5e0f507 V.ED..... ........ 411,0-496,36}
                      android.widget.Space{5daa634 I.ED..... ......I. 0,112-496,132}
                      com.wejoy.weplay.login.WejoyLargeLoginBtnView{cf4cc5d VFE...C.. ........ 0,132-496,244}
                        androidx.appcompat.widget.AppCompatImageView{76d89d2 V.ED..... ........ 24,24-88,88}
                        com.huiwan.widget.CustomTextView{40ddaa3 V.ED..... ........ 110,35-385,76}
`;

describe("WePlay screen classification", () => {
  it("detects login, main, provider, and status bar focus lines", () => {
    expect(classifyWePlayScreen("mCurrentFocus=Window{a u0 com.wepie.wespy.module.login.start.StartActivity}").kind).toBe(
      "weplay_login"
    );
    expect(classifyWePlayScreen("mCurrentFocus=Window{a u0 com.wepie.wespy.module.main.MainActivity}").kind).toBe(
      "weplay_main"
    );
    expect(classifyWePlayScreen("mCurrentFocus=Window{a u0 com.google.android.gms/com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity}").kind).toBe(
      "provider_google"
    );
    expect(
      classifyWePlayScreen(
        "mCurrentFocus=Window{61a02a1 u0 com.android.chrome/org.chromium.chrome.browser.customtabs.CustomTabActivity}"
      ).kind
    ).toBe("provider_google");
    expect(classifyWePlayScreen("mCurrentFocus=Window{a u0 com.facebook.katana}").kind).toBe("provider_facebook");
    expect(classifyWePlayScreen("mCurrentFocus=Window{a u0 com.twitter.android}").kind).toBe("provider_x");
    expect(classifyWePlayScreen("mCurrentFocus=Window{9d27186 u0 StatusBar}").kind).toBe("status_bar");
  });

  it("maps provider and permission screens to human-action errors", () => {
    expect(providerPauseCode("provider_google")).toBe("VERIFICATION_REQUIRED");
    expect(providerPauseCode("provider_facebook")).toBe("VERIFICATION_REQUIRED");
    expect(providerPauseCode("permission")).toBe("PERMISSION_REQUIRED");
    expect(providerPauseCode("weplay_login")).toBeNull();
  });

  it("parses generic view-id bounds from dumpsys lines", () => {
    const dump = `
      android.widget.ImageView{e8c1234 VFED..C. ........ 544,96-608,160 #7f0a1abc app:id/search_room_imv
    `;
    expect(findViewCenter(dump, "search_room_imv")).toEqual({ x: 576, y: 128 });
    expect(findViewCenter(dump, "login_google")).toBeNull();
  });

  it("does not treat login_google as a view ID on the live StartActivity dump", () => {
    expect(findViewCenter(OPPO_STARTACTIVITY_DUMP, "login_google")).toBeNull();
    expect(findViewCenter(OPPO_STARTACTIVITY_DUMP, "login_facebook")).toBeNull();
    expect(findViewCenter(OPPO_STARTACTIVITY_DUMP, "login_twitter")).toBeNull();
    expect(dumpHasInspectedLoginButtons(OPPO_STARTACTIVITY_DUMP)).toBe(true);
    expect(findLoginButtonCenter(OPPO_STARTACTIVITY_DUMP, "GOOGLE")).toEqual({ x: 360, y: 869 });
    expect(findLoginButtonCenter(OPPO_STARTACTIVITY_DUMP, "FACEBOOK")).toEqual({ x: 360, y: 1001 });
    expect(findLoginButtonCenter(OPPO_STARTACTIVITY_DUMP, "X")).toEqual({ x: 266, y: 1161 });
    const large = parseLoginLayoutButtons(
      OPPO_STARTACTIVITY_DUMP,
      "login_vertical_btn_layout",
      "WejoyLargeLoginBtnView"
    );
    expect(large[0]?.textViewCount).toBe(3);
    expect(large[1]?.textViewCount).toBe(1);
  });

  it("ignores package dumps that only mention StartActivity without login buttons", () => {
    const pkgDump = `
      ACTIVITY com.wejoy.weplay.ar/com.wepie.wespy.module.login.start.StartActivity 39737fc pid=25982
        mResumed=true
        app:id/login_view
    `;
    const topDump = OPPO_STARTACTIVITY_DUMP;
    expect(dumpHasInspectedLoginButtons(pkgDump)).toBe(false);
    expect(selectActivityDump(pkgDump, topDump)).toBe(topDump);
    expect(isWePlayPhoneOtpDump("android.widget.EditText{... app:id/login_phone_number}")).toBe(true);
    expect(isWePlayPhoneOtpDump(OPPO_STARTACTIVITY_DUMP)).toBe(false);
  });
});
