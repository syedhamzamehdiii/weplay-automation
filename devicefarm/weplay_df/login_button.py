"""Locate the WePlay 'Sign in with Google' control. No coordinate-ratio fallback."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from weplay_df.dumpsys import find_google_button_from_dumpsys
from weplay_df.ui import UiNode

log = logging.getLogger("weplay.google")

GOOGLE_TEXT_EXACT = ("sign in with google", "continue with google")
GOOGLE_TEXT_HINTS = ("sign in with google", "continue with google", "google")
GOOGLE_ID_HINTS = ("login_google", "google_login", "btn_google")
GOOGLE_NEGATIVE_HINTS = (
    "create a new account",
    "create account",
    "facebook",
    "twitter",
    "phone",
)


@dataclass(frozen=True)
class TapTarget:
    x: int
    y: int
    strategy: str
    evidence: str


def _center_if_usable(node: UiNode) -> tuple[int, int] | None:
    if node.bounds and node.bounds.usable:
        return node.bounds.center
    return None


def _score_google_node(node: UiNode) -> int:
    hay = node.haystack
    score = 0
    if any(hint in node.resource_id.lower() for hint in GOOGLE_ID_HINTS):
        score += 50
    if any(hint in node.content_desc.lower() for hint in GOOGLE_ID_HINTS):
        score += 40
    text = node.text.strip().lower()
    if text in GOOGLE_TEXT_EXACT:
        score += 80
    elif text == "google":
        score += 30
    elif "sign in with google" in hay:
        score += 70
    elif "google" in hay:
        score += 10
    if "WejoyLargeLoginBtnView" in node.class_name:
        score += 20
    if node.clickable:
        score += 5
    if any(hint in hay for hint in GOOGLE_NEGATIVE_HINTS):
        score -= 80
    return score


def find_google_sign_in_via_appium(driver) -> TapTarget | None:
    """Find the labeled Sign in with Google control even when XML dumps have dummy bounds."""
    try:
        from appium.webdriver.common.appiumby import AppiumBy
    except Exception:  # noqa: BLE001
        return None
    selectors = [
        (AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().textContains("Sign in with Google")'),
        (AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().descriptionContains("Sign in with Google")'),
        (
            AppiumBy.XPATH,
            '//*[contains(@text, "Sign in with Google") or contains(@content-desc, "Sign in with Google")]',
        ),
        (AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("Sign in with Google")'),
        (
            AppiumBy.ANDROID_UIAUTOMATOR,
            'new UiSelector().className("com.wejoy.weplay.login.WejoyLargeLoginBtnView").instance(1)',
        ),
    ]
    for by, value in selectors:
        try:
            el = driver.find_element(by, value)
            loc = el.location
            size = el.size
            width = int(size.get("width") or 0)
            height = int(size.get("height") or 0)
            if width < 8 or height < 8:
                continue
            target = TapTarget(
                x=int(loc["x"]) + width // 2,
                y=int(loc["y"]) + height // 2,
                strategy="appium_sign_in_with_google",
                evidence=str(value)[:120],
            )
            log.info("Google button via Appium Sign in with Google: %s", target)
            return target
        except Exception:  # noqa: BLE001
            continue
    return None


def find_google_button(
    nodes: list[UiNode],
    page_source: str,
    dumpsys_dump: str | None,
    screen_size: tuple[int, int],
    login_screen_confirmed: bool,
) -> TapTarget:
    del screen_size
    if not login_screen_confirmed:
        raise RuntimeError(
            "Refusing to tap Google coordinates: WePlay login screen was not confirmed "
            "(package/activity/UI evidence missing)."
        )

    scored: list[tuple[int, UiNode]] = []
    for node in nodes:
        score = _score_google_node(node)
        if score >= 15:
            scored.append((score, node))
    scored.sort(key=lambda item: item[0], reverse=True)

    for score, node in scored:
        center = _center_if_usable(node)
        if center:
            target = TapTarget(
                x=center[0],
                y=center[1],
                strategy="ui_hierarchy",
                evidence=f"score={score} class={node.class_name} id={node.resource_id} text={node.text!r}",
            )
            log.info("Google button via UI hierarchy: %s", target)
            return target

    if dumpsys_dump:
        dumpsys_center = find_google_button_from_dumpsys(dumpsys_dump, page_source)
        if dumpsys_center:
            target = TapTarget(
                x=dumpsys_center[0],
                y=dumpsys_center[1],
                strategy="dumpsys_activity_top",
                evidence="WejoyLargeLoginBtnView Sign in with Google (not Create account)",
            )
            log.info("Google button via dumpsys: %s", target)
            return target

    large = [
        node
        for node in nodes
        if "WejoyLargeLoginBtnView" in node.class_name and node.bounds and node.bounds.usable
    ]
    large.sort(key=lambda node: (node.bounds.top if node.bounds else 0, node.bounds.left if node.bounds else 0))
    google_large = [
        node
        for node in large
        if "google" in node.haystack and not any(hint in node.haystack for hint in GOOGLE_NEGATIVE_HINTS)
    ]
    chosen = google_large[0] if google_large else None
    if chosen is None and len(large) >= 2:
        first_hay = large[0].haystack
        if any(hint in first_hay for hint in ("create a new account", "create account")):
            chosen = large[1]
    if chosen and chosen.bounds:
        x, y = chosen.bounds.center
        target = TapTarget(
            x=x,
            y=y,
            strategy="large_login_btn",
            evidence=f"class={chosen.class_name} bounds={chosen.bounds} hay={chosen.haystack[:80]!r}",
        )
        log.info("Google button via large login view: %s", target)
        return target

    raise RuntimeError(
        "Sign in with Google was not found in the UI hierarchy, Appium locators, or dumpsys layout. "
        "Not using a screen-ratio tap."
    )
