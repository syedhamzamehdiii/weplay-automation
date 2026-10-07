package com.weplay.worker.workflow

/**
 * Selectors inspected on the attached device (Oppo CPH2083, Android 9 / API 28).
 *
 * WePlay package: com.wejoy.weplay.ar (versionName 6.4.5, versionCode 60452)
 *
 * Notes:
 * - `adb shell uiautomator dump` returns a dummy node bounds [0,0][0,0] on this
 *   ColorOS build (no resource-id, no content-desc). Accessibility cannot tap login.
 * - `login_google` / `login_facebook` / `login_twitter` / `login_phone` are string
 *   resources (R.string), not view IDs. They never appear as app:id/ on StartActivity.
 * - StartActivity buttons are WejoyLargeLoginBtnView under login_vertical_btn_layout
 *   (Google then Facebook) and WejoySmallLoginBtnView under login_horizontal_btn_layout
 *   (X then Phone). USB worker taps those via `dumpsys activity top`.
 * - The Room ID search UI is a dialog: tabs "Room ID" / "User ID", placeholder
 *   "Search Room", buttons Cancel / Confirm. Dialog widget IDs were not present
 *   on the activity view tree (separate window).
 * - In-room Support button has not been inspected yet.
 */
object WePlaySelectors {
    const val PACKAGE = "com.wejoy.weplay.ar"
    const val LAUNCHER_ACTIVITY = "com.wepie.wespy.module.login.start.StartActivity"
    const val MAIN_ACTIVITY = "com.wepie.wespy.module.main.MainActivity"

    const val TAB_SWITCH = "tab_switch_view"
    const val SEARCH_ROOM = "search_room_imv"
    const val CREATE_ROOM = "create_room_imv"
    const val VOICE_ROOM_TYPE_PAGER = "wejoy_voice_room_type_vp"
    const val ROOM_LIST = "voice_room_list_rv"
    const val ROOM_LIST_ITEM = "voice_room_list_lay"
    const val ROOM_NAME = "room_name_tv"
    const val ROOM_LABEL = "room_label_tv"

    /** Voice Room is the second bottom tab (index 1) on 720px width. */
    const val VOICE_ROOM_TAB_INDEX = 1

    /** String resources only — not StartActivity view IDs. */
    const val LOGIN_GOOGLE = "login_google"
    const val LOGIN_FACEBOOK = "login_facebook"
    const val LOGIN_TWITTER = "login_twitter"
    const val LOGIN_PHONE = "login_phone"
    const val LOGIN_BY_PHONE = "login_by_phone_tv"
    const val LOGIN_VERTICAL_BUTTONS = "login_vertical_btn_layout"
    const val LOGIN_HORIZONTAL_BUTTONS = "login_horizontal_btn_layout"
    const val LOGIN_PHONE_NUMBER = "login_phone_number"
    const val LOGIN_GET_CODE = "login_get_code_btn"
}
