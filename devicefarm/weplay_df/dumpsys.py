"""Parse dumpsys activity top when uiautomator bounds are unusable."""

from __future__ import annotations

from dataclasses import dataclass

from weplay_df.ui import Bounds, parse_dumpsys_bounds


@dataclass(frozen=True)
class LoginLayoutButton:
    x: int
    y: int
    text_view_count: int


def weplay_start_activity_resumed(dump: str) -> bool:
    """True when StartActivity is in the dumpsys activity top dump with mResumed=true."""
    marker = "com.wepie.wespy.module.login.start.StartActivity"
    idx = dump.find(marker)
    if idx < 0:
        return False
    window = dump[idx : idx + 2500]
    next_activity = window.find("\n  ACTIVITY ", 10)
    if next_activity > 0:
        window = window[:next_activity]
    return "mResumed=true" in window


def dump_has_inspected_login_buttons(dump: str) -> bool:
    return "login_vertical_btn_layout" in dump and "WejoyLargeLoginBtnView" in dump


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def _count_descendant_text_views(lines: list[str], button_index: int, button_indent: int) -> int:
    count = 0
    for line in lines[button_index + 1 :]:
        indent = _indent_of(line)
        if indent <= button_indent and line.strip():
            break
        if "CustomTextView" in line or "android.widget.TextView{" in line:
            count += 1
    return count


def absolute_dumpsys_bounds(lines: list[str], index: int) -> Bounds | None:
    """Convert a dumpsys view's parent-relative bounds to screen coordinates.

    Android View.toString() prints bounds relative to the immediate parent.
    Adding only the login_vertical_btn_layout origin misses ancestors such as
    the status-bar FrameLayout at 0,121-1080,2337 on Pixel, so the Google
    button center lands inside 'Create a New Account'.
    """
    own = parse_dumpsys_bounds(lines[index])
    if not own:
        return None
    left, top = own.left, own.top
    indent = _indent_of(lines[index])
    for j in range(index - 1, -1, -1):
        line = lines[j]
        if not line.strip():
            continue
        ancestor_indent = _indent_of(line)
        if ancestor_indent >= indent:
            continue
        indent = ancestor_indent
        ancestor = parse_dumpsys_bounds(line)
        if ancestor:
            left += ancestor.left
            top += ancestor.top
        if "DecorView" in line:
            break
    width = own.right - own.left
    height = own.bottom - own.top
    return Bounds(left=left, top=top, right=left + width, bottom=top + height)


def parse_login_layout_buttons(dump: str, layout_id: str, child_class: str) -> list[LoginLayoutButton]:
    lines = dump.splitlines()
    parent_index = next((i for i, line in enumerate(lines) if layout_id in line), -1)
    if parent_index < 0:
        return []
    parent_indent = _indent_of(lines[parent_index])
    buttons: list[LoginLayoutButton] = []
    for i in range(parent_index + 1, len(lines)):
        line = lines[i]
        indent = _indent_of(line)
        if indent <= parent_indent and line.strip():
            break
        if child_class not in line:
            continue
        absolute = absolute_dumpsys_bounds(lines, i)
        if not absolute:
            continue
        x, y = absolute.center
        buttons.append(
            LoginLayoutButton(
                x=x,
                y=y,
                text_view_count=_count_descendant_text_views(lines, i, indent),
            )
        )
    return buttons


def find_google_button_from_dumpsys(dump: str, page_source: str = "") -> tuple[int, int] | None:
    large = parse_login_layout_buttons(dump, "login_vertical_btn_layout", "WejoyLargeLoginBtnView")
    if not large:
        return None
    small = parse_login_layout_buttons(dump, "login_horizontal_btn_layout", "WejoySmallLoginBtnView")
    hay = f"{dump} {page_source}".lower()
    create_then_google = "create a new account" in hay and "sign in with google" in hay
    # Current WePlay Pixel login: "Create a New Account" then "Sign in with Google",
    # plus three small social buttons. Legacy Oppo layout had Google as the first large button.
    if len(large) >= 2 and (len(small) >= 3 or create_then_google):
        return large[1].x, large[1].y
    if len(small) <= 1:
        return large[0].x, large[0].y
    return None


_OAUTH_ACTIVITY_NEEDLES = (
    "signinhubactivity",
    "minutemaidactivity",
    "customtabactivity",
    "chrometabbedactivity",
    "com.android.chrome/",
    "hiddenactivity",
    "gms.auth.api.signin",
    "assistedsigninactivity",
    "com.google.android.gms/.auth",
    "accounts.google.com/o/oauth2",
)


def dumpsys_oauth_ui_started(dump: str, package: str = "", activity: str = "") -> bool:
    """True when a real Google Sign-In / Custom Tabs activity is in the dump.

    Ignore launcher ItemInfo lines that mention Chrome as a home-screen icon.
    """
    current = f"{package}/{activity}".lower()
    if any(token in current for token in _OAUTH_ACTIVITY_NEEDLES):
        return True
    for line in dump.splitlines():
        stripped = line.lstrip()
        if not stripped.startswith("ACTIVITY "):
            continue
        lower = stripped.lower()
        if any(token in lower for token in _OAUTH_ACTIVITY_NEEDLES):
            return True
    return False


def find_view_center(dump: str, view_id: str) -> tuple[int, int] | None:
    token = view_id if "/" in view_id else f"id/{view_id}"
    lines = dump.splitlines()
    for i, line in enumerate(lines):
        if token not in line:
            continue
        bounds = absolute_dumpsys_bounds(lines, i) or parse_dumpsys_bounds(line)
        if bounds:
            return bounds.center
    return None
