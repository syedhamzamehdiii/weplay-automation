"""Install WePlay from Google Play Store on a fresh Device Farm device."""

from __future__ import annotations

import logging
import time

from appium.webdriver.webdriver import WebDriver

from weplay_df.artifacts import capture_failure
from weplay_df.classify import ScreenKind
from weplay_df.constants import (
    PLAY_STORE_ACCEPT_LABELS,
    PLAY_STORE_INSTALL_LABELS,
    PLAY_STORE_OPEN_LABELS,
    PLAY_STORE_PROGRESS_HINTS,
    PLAY_STORE_TIMEOUT_S,
    PLAY_STORE_TOS_CONTINUE_LABELS,
    PLAY_STORE_TOS_HINTS,
    PLAY_STORE_UNAVAILABLE_HINTS,
    WEPLAY_PACKAGE,
)
from weplay_df.accounts import (
    CHANNEL_DEVICEFARM_MANAGED_PLAY,
    CHANNEL_WORKSPACE,
    DeviceAccount,
    diagnostics_payload,
    emails_match,
    identity_matches_expected,
    infer_play_store_account,
    list_device_accounts,
    mask_email,
    play_store_identity_allowed,
    play_store_state_label,
    signed_in_as_from_ui,
)
from weplay_df.driver import (
    clear_play_store_data,
    force_stop_play_store,
    open_play_account_chooser,
    open_play_store_home,
    open_play_store_listing,
    screen_size,
    weplay_installed,
)
from weplay_df.errors import ActionRequired, FlowError
from weplay_df.flow import _click_node, select_workspace_account, snapshot
from weplay_df.ui import UiNode, page_text

log = logging.getLogger("weplay.google")

_BOTTOM_CHROME_RATIO = 0.90
_REOPEN_AFTER_S = 12.0
_REINSTALL_TAP_EVERY_S = 12.0
_ACCOUNT_CHIP_HINTS = (
    "account and settings",
    "google account",
    "signed in as",
    "switch account",
    "signed in",
)
_ACCOUNT_CHIP_SKIP = ("search", "navigate up", "back", "cart", "wishlist", "notifications")


def _label_match(node: UiNode, labels: tuple[str, ...]) -> bool:
    text = node.text.strip().lower()
    desc = node.content_desc.strip().lower()
    return text in labels or desc in labels


def _in_bottom_chrome(node: UiNode, screen_height: int) -> bool:
    if not node.bounds or screen_height <= 0:
        return False
    return node.bounds.center[1] >= int(screen_height * _BOTTOM_CHROME_RATIO)


def matching_label_nodes(nodes: list[UiNode], labels: tuple[str, ...]) -> list[UiNode]:
    clickable = [node for node in nodes if node.clickable and _label_match(node, labels)]
    if clickable:
        return clickable
    return [node for node in nodes if _label_match(node, labels)]


def play_store_unavailable_reason(page_source: str) -> str | None:
    text = page_text(page_source)
    for hint in PLAY_STORE_UNAVAILABLE_HINTS:
        if hint in text:
            return hint
    return None


def play_store_tos_visible(page_source: str) -> bool:
    text = page_text(page_source)
    if any(hint in text for hint in PLAY_STORE_TOS_HINTS):
        return True
    return "i agree" in text and any(
        phrase in text for phrase in ("terms of service", "privacy policy", "welcome")
    )


def play_store_install_in_progress(page_source: str) -> bool:
    text = page_text(page_source)
    return any(hint in text for hint in PLAY_STORE_PROGRESS_HINTS)


def looks_like_weplay_listing(page_source: str, nodes: list[UiNode]) -> bool:
    text = page_text(page_source)
    blob = f"{text} {page_source.lower()}"
    if "weplay" in blob or "wejoy" in blob or WEPLAY_PACKAGE.lower() in blob:
        return True
    return bool(matching_label_nodes(nodes, PLAY_STORE_INSTALL_LABELS))


def pick_install_node(nodes: list[UiNode], screen_height: int) -> UiNode | None:
    matches = matching_label_nodes(nodes, PLAY_STORE_INSTALL_LABELS)
    if not matches:
        return None
    ranked = sorted(
        matches,
        key=lambda node: (
            1 if _in_bottom_chrome(node, screen_height) else 0,
            node.bounds.center[1] if node.bounds else 0,
        ),
    )
    return ranked[0]


def pick_tos_node(nodes: list[UiNode], page_source: str, screen_height: int) -> UiNode | None:
    if not play_store_tos_visible(page_source):
        return None
    matches = matching_label_nodes(nodes, PLAY_STORE_ACCEPT_LABELS)
    if not matches:
        matches = matching_label_nodes(nodes, PLAY_STORE_TOS_CONTINUE_LABELS)
    if not matches:
        return None
    ranked = sorted(
        matches,
        key=lambda node: (
            0 if _label_match(node, ("i agree", "accept")) else 1,
            node.bounds.center[1] if node.bounds else 0,
        ),
    )
    return ranked[0]


def _tap_node(driver: WebDriver, node: UiNode) -> bool:
    return _click_node(driver, node)


def play_store_shows_expected_account(nodes: list[UiNode], page_source: str, email: str) -> bool:
    signed_in = signed_in_as_from_ui(nodes, page_source)
    if signed_in:
        return identity_matches_expected(signed_in, email)
    return False


def pick_play_store_account_chip(nodes: list[UiNode], screen_width: int, screen_height: int) -> UiNode | None:
    toolbar = int(screen_height * 0.16) if screen_height else 400
    right_half = int(screen_width * 0.50) if screen_width else 0
    ranked: list[tuple[int, int, UiNode]] = []
    for node in nodes:
        if not node.bounds:
            continue
        desc = node.haystack
        if any(token in desc for token in _ACCOUNT_CHIP_SKIP):
            continue
        score = 0
        if any(token in desc for token in _ACCOUNT_CHIP_HINTS):
            score += 8
        if "@" in desc:
            score += 6
        if node.bounds.top <= toolbar and node.bounds.center[0] >= right_half:
            score += 3
        if node.clickable:
            score += 2
        if "image" in node.class_name.lower() or "button" in node.class_name.lower():
            score += 1
        if score >= 5:
            ranked.append((score, node.bounds.center[0], node))
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return ranked[0][2] if ranked else None


def log_play_store_account_state(
    *,
    expected: str,
    device_accounts: list[DeviceAccount],
    play_store_account: str | None,
    play_store_state: str,
    extra: str = "",
) -> dict[str, object]:
    payload = diagnostics_payload(
        expected=expected,
        device_accounts=device_accounts,
        play_store_account=play_store_account,
        play_store_state=play_store_state,
    )
    log.info(
        "Play Store account diagnostics expected=%s active=%s matches=%s identityOk=%s channel=%s device=%s managed=%s state=%s%s",
        payload["expectedPlayStoreAccount"],
        payload["playStoreAccount"],
        payload["playStoreAccountMatchesExpected"],
        payload.get("playStoreIdentityOk"),
        payload.get("playStoreChannel"),
        payload["deviceAccounts"],
        payload["managedDeviceAccounts"],
        payload["playStoreState"],
        f" {extra}" if extra else "",
    )
    return payload


def _read_play_store_identity(
    driver: WebDriver,
    email: str,
    device_accounts: list[DeviceAccount],
) -> tuple[str | None, list[UiNode], str]:
    _, nodes, source = snapshot(driver, email)
    signed_in = signed_in_as_from_ui(nodes, source)
    active = signed_in or infer_play_store_account(
        expected=email,
        device_accounts=device_accounts,
        nodes=nodes,
        page_source=source,
    )
    return active, nodes, source


def _switch_play_store_to_workspace(
    driver: WebDriver,
    email: str,
    nodes: list[UiNode],
    page_source: str,
    screen_width: int,
    screen_height: int,
) -> None:
    """One structured attempt to make Play use the Workspace account. Does not add the account again."""
    del page_source
    if select_workspace_account(driver, email):
        log.info("Tapped expected Workspace account %s in a Play / Google picker", mask_email(email))
        time.sleep(1.2)
        return
    chip = pick_play_store_account_chip(nodes, screen_width, screen_height)
    if chip:
        log.info(
            "Opening Play Store account menu via chip %r",
            (chip.content_desc or chip.text or chip.class_name)[:80],
        )
        _tap_node(driver, chip)
        time.sleep(1.6)
        _, nodes_after, _ = snapshot(driver, email)
        log.info("Play Store labels after account-chip tap: %s", _visible_action_labels(nodes_after))
        if select_workspace_account(driver, email):
            log.info("Selected Workspace account %s from the Play Store account menu", mask_email(email))
            time.sleep(1.2)
            return
        log.info(
            "Workspace account %s was not listed as a Play Store identity after opening the account menu",
            mask_email(email),
        )
    log.info("Requesting Google account chooser for Play Store (Workspace already on device)")
    open_play_account_chooser()
    time.sleep(1.4)
    if select_workspace_account(driver, email):
        log.info("Selected Workspace account %s from the Google account chooser", mask_email(email))
        time.sleep(1.2)
        return
    log.info("Restarting Play Store with authAccount extra for %s", mask_email(email))
    force_stop_play_store()
    time.sleep(0.6)
    open_play_store_home(account=email)
    time.sleep(1.8)
    _, nodes_home, _ = snapshot(driver, email)
    if select_workspace_account(driver, email):
        time.sleep(1.0)
        return
    if signed_in_as_from_ui(nodes_home, "") and identity_matches_expected(
        signed_in_as_from_ui(nodes_home, ""), email
    ):
        return
    cleared = clear_play_store_data()
    if "success" in (cleared or "").lower():
        time.sleep(0.8)
        open_play_store_home(account=email)
        time.sleep(2.0)
        select_workspace_account(driver, email)
        time.sleep(1.0)


def bind_play_store_identity(
    driver: WebDriver,
    email: str,
    device_accounts: list[DeviceAccount] | None = None,
) -> dict[str, object]:
    """
    Make Play Store use the Workspace account when Play allows it.

    Public AWS Device Farm Pixels bind Play to a Managed Google Play Account
    (com.google.work / *@android-for-work.gserviceaccount.com). That identity is
    owned by Device Farm's EMM and cannot be replaced with a Workspace user from
    the test session. In that case the supported approach is: install WePlay from
    that managed Play catalog, then Sign in with Google as the Workspace account.
    """
    accounts = device_accounts if device_accounts is not None else list_device_accounts()
    width, height = screen_size(driver)
    if height <= 0:
        width, height = 1080, 2400
    open_play_store_home()
    time.sleep(1.4)
    active, nodes, source = _read_play_store_identity(driver, email, accounts)
    last_payload = log_play_store_account_state(
        expected=email,
        device_accounts=accounts,
        play_store_account=active,
        play_store_state=play_store_state_label(
            page_source=source,
            weplay_listing=looks_like_weplay_listing(source, nodes),
            install_visible=pick_install_node(nodes, height) is not None,
            unavailable=play_store_unavailable_reason(source),
        ),
        extra="before_switch",
    )
    if identity_matches_expected(active, email):
        last_payload["playStoreAccountMatchesExpected"] = True
        last_payload["playStoreChannel"] = CHANNEL_WORKSPACE
        last_payload["playStoreIdentityOk"] = True
        last_payload["playStoreAccount"] = mask_email(email)
        log.info("Play Store is already signed in as the expected Workspace account %s", mask_email(email))
        return last_payload

    _switch_play_store_to_workspace(driver, email, nodes, source, width, height)
    open_play_store_home(account=email)
    time.sleep(1.6)
    active, nodes, source = _read_play_store_identity(driver, email, accounts)
    last_payload = log_play_store_account_state(
        expected=email,
        device_accounts=accounts,
        play_store_account=active,
        play_store_state=play_store_state_label(
            page_source=source,
            weplay_listing=looks_like_weplay_listing(source, nodes),
            install_visible=pick_install_node(nodes, height) is not None,
            unavailable=play_store_unavailable_reason(source),
        ),
        extra="after_switch",
    )
    matches = identity_matches_expected(active, email)
    identity_ok = play_store_identity_allowed(expected=email, active=active, device_accounts=accounts)
    last_payload["playStoreAccountMatchesExpected"] = matches
    last_payload["playStoreIdentityOk"] = identity_ok
    if matches:
        last_payload["playStoreChannel"] = CHANNEL_WORKSPACE
        last_payload["playStoreAccount"] = mask_email(email)
        log.info("Play Store identity after switch matches Workspace account %s", mask_email(email))
        return last_payload
    if identity_ok:
        last_payload["playStoreChannel"] = CHANNEL_DEVICEFARM_MANAGED_PLAY
        log.info(
            "Play Store remains on Device Farm Managed Google Play (%s). "
            "The Workspace account %s is on the device as com.google but is not a Play identity. "
            "Public Device Farm devices bind Play to a work-*@android-for-work.gserviceaccount.com "
            "account (com.google.work); that account cannot be switched from this session. "
            "Supported approach: install WePlay from this managed Play catalog, then Sign in with "
            "Google as %s.",
            last_payload.get("playStoreAccount"),
            mask_email(email),
            mask_email(email),
        )
        return last_payload
    expected_m = mask_email(email)
    active_m = mask_email(active or "")
    raise FlowError(
        "play_store",
        "Play Store identity is "
        f"{active_m}, which is not the required Workspace account {expected_m} and is not "
        "Device Farm Managed Google Play. Refusing to install WePlay until Play is on "
        f"{expected_m}. Device accounts: {last_payload.get('deviceAccounts')}.",
    )


def ensure_play_store_workspace_account(
    driver: WebDriver,
    email: str,
    device_accounts: list[DeviceAccount] | None = None,
) -> dict[str, object]:
    return bind_play_store_identity(driver, email, device_accounts)


def _visible_action_labels(nodes: list[UiNode]) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()
    for node in nodes:
        for raw in (node.text, node.content_desc):
            value = raw.strip()
            if not value or len(value) > 48 or value in seen:
                continue
            seen.add(value)
            labels.append(value)
            if len(labels) >= 20:
                return labels
    return labels


def _raise_play_store_blocked(
    driver: WebDriver,
    email: str,
    screen,
    source: str,
    nodes: list[UiNode],
    device_accounts: list[DeviceAccount],
    unavailable: str,
    *,
    workspace_confirmed: bool,
) -> None:
    active = infer_play_store_account(
        expected=email,
        device_accounts=device_accounts,
        nodes=nodes,
        page_source=source,
    )
    if play_store_shows_expected_account(nodes, source, email):
        active = email
        workspace_confirmed = True
    state = play_store_state_label(
        page_source=source,
        weplay_listing=looks_like_weplay_listing(source, nodes),
        install_visible=False,
        unavailable=unavailable,
    )
    payload = log_play_store_account_state(
        expected=email,
        device_accounts=device_accounts,
        play_store_account=active,
        play_store_state=state,
        extra="before_fail",
    )
    capture_failure(
        driver=driver,
        step="play_store",
        package=screen.package,
        activity=screen.activity,
        page_source=source,
        extra={"message": unavailable, **payload},
        screenshot_ok=True,
    )
    expected_m = mask_email(email)
    active_m = mask_email(active or "")
    device_m = payload["deviceAccounts"]
    if not workspace_confirmed or (active and not identity_matches_expected(active, email)):
        if active and not emails_match(active, email) and "android-for-work" in (active or "").lower():
            raise FlowError(
                "play_store",
                "Google Play blocked WePlay while signed in as Device Farm Managed Google Play "
                f"({active_m}). That Play identity cannot be switched to {expected_m} on public "
                "Device Farm devices. Enable WePlay in the managed Play catalog (Google Admin "
                "mobile management) or use a private device whose Play Store is the Workspace "
                f"account. Device accounts: {device_m}. Do not upload a WePlay APK.",
            )
        raise FlowError(
            "play_store",
            "Play Store showed an administrator-access error, but the active Google account "
            f"is {active_m}, not the required Workspace account {expected_m}. "
            f"Accounts on the device: {device_m}. Switch Play Store to {expected_m} and retry. "
            "Do not upload a WePlay APK.",
        )
    raise FlowError(
        "play_store",
        "Google Play blocked WePlay while the required Workspace account "
        f"{expected_m} was the active Play Store account (state={state}). "
        f"Device accounts: {device_m}. Do not upload a WePlay APK.",
    )


def install_weplay_from_play_store(driver: WebDriver, email: str = "") -> dict[str, object]:
    diagnostics: dict[str, object] = {
        "playStoreAccountMatchesExpected": False,
        "playStoreIdentityOk": False,
        "playStoreChannel": "unknown",
        "playStoreState": "not_opened",
    }
    device_accounts = list_device_accounts()
    if email:
        diagnostics.update(bind_play_store_identity(driver, email, device_accounts))
        if not diagnostics.get("playStoreIdentityOk"):
            raise FlowError(
                "play_store",
                "Play Store identity was not confirmed before installing WePlay. "
                f"Expected {mask_email(email)}; active={diagnostics.get('playStoreAccount')}.",
            )

    if weplay_installed():
        log.info("%s is already installed; skipping Play Store install", WEPLAY_PACKAGE)
        diagnostics["playStoreState"] = "already_installed"
        return diagnostics

    open_play_store_listing(account=email)
    time.sleep(1.2)
    deadline = time.monotonic() + PLAY_STORE_TIMEOUT_S
    tapped_install = False
    saw_play_store = False
    used_https_listing = False
    last_install_tap = 0.0
    last_open = time.monotonic()
    last_label_log = 0.0
    last_screen = None
    last_source = ""
    last_package = ""
    last_activity = ""
    last_nodes: list[UiNode] = []
    width, screen_height = screen_size(driver)
    if screen_height <= 0:
        width, screen_height = 1080, 2400

    while time.monotonic() < deadline:
        if weplay_installed():
            log.info("WePlay install finished")
            screen, nodes, source = snapshot(driver, email)
            diagnostics.update(
                log_play_store_account_state(
                    expected=email,
                    device_accounts=device_accounts,
                    play_store_account=infer_play_store_account(
                        expected=email,
                        device_accounts=device_accounts,
                        nodes=nodes,
                        page_source=source,
                    ),
                    play_store_state="installed",
                )
            )
            open_node = next(iter(matching_label_nodes(nodes, PLAY_STORE_OPEN_LABELS)), None)
            if open_node:
                _tap_node(driver, open_node)
            return diagnostics

        screen, nodes, source = snapshot(driver, email)
        last_screen = screen
        last_source = source
        last_nodes = nodes
        last_package = screen.package
        last_activity = screen.activity
        if screen.kind is ScreenKind.ACTION_REQUIRED:
            raise ActionRequired(
                f"Play Store / Google presented a security challenge ({screen.evidence}). "
                "Not attempting to bypass CAPTCHA, MFA, or anti-abuse checks."
            )
        if screen.kind is ScreenKind.GOOGLE_ACCOUNT_PICKER:
            log.info("Play Store presented a Google account picker; selecting %s", mask_email(email))
            select_workspace_account(driver, email)
            time.sleep(0.8)
            continue
        if screen.kind is ScreenKind.GOOGLE_IDENTIFIER or screen.kind is ScreenKind.GOOGLE_PASSWORD:
            raise FlowError(
                "play_store",
                "Play Store is asking for a Google sign-in even though the Workspace account "
                "should already be on the device. Not adding an account from Play Store classification.",
            )
        if screen.kind is not ScreenKind.PLAY_STORE and "vending" not in screen.package:
            time.sleep(0.8)
            continue

        saw_play_store = True
        ui_has_expected = play_store_shows_expected_account(nodes, source, email)
        install_node = pick_install_node(nodes, screen_height)
        unavailable = play_store_unavailable_reason(source)
        active = infer_play_store_account(
            expected=email,
            device_accounts=device_accounts,
            nodes=nodes,
            page_source=source,
        )
        if ui_has_expected:
            diagnostics["playStoreAccountMatchesExpected"] = True
            diagnostics["playStoreAccount"] = mask_email(email)
        diagnostics["playStoreState"] = play_store_state_label(
            page_source=source,
            weplay_listing=looks_like_weplay_listing(source, nodes),
            install_visible=install_node is not None,
            unavailable=unavailable,
        )

        if unavailable:
            _raise_play_store_blocked(
                driver,
                email,
                screen,
                source,
                nodes,
                device_accounts,
                unavailable,
                workspace_confirmed=bool(diagnostics.get("playStoreAccountMatchesExpected")),
            )

        now = time.monotonic()
        if now - last_label_log > 15:
            log.info("Play Store visible labels: %s", _visible_action_labels(nodes))
            last_label_log = now

        tos_node = pick_tos_node(nodes, source, screen_height)
        if tos_node:
            log.info("Tapping Play Store terms control %r", tos_node.text or tos_node.content_desc)
            _tap_node(driver, tos_node)
            time.sleep(0.8)
            continue

        if install_node and (
            not tapped_install
            or _label_match(install_node, ("try again",))
            or now - last_install_tap >= _REINSTALL_TAP_EVERY_S
        ):
            label = (install_node.text or install_node.content_desc or "install").strip()
            log.info("Tapping Play Store %s for %s", label, WEPLAY_PACKAGE)
            _tap_node(driver, install_node)
            tapped_install = True
            last_install_tap = now
            time.sleep(1.5)
            continue

        if play_store_install_in_progress(source) or tapped_install:
            time.sleep(1.5)
            continue

        if not looks_like_weplay_listing(source, nodes) and now - last_open >= _REOPEN_AFTER_S:
            log.info("Play Store is not on the WePlay listing; re-opening details https=%s", used_https_listing)
            open_play_store_listing(https=used_https_listing, account=email)
            used_https_listing = True
            last_open = now
            time.sleep(1.5)
            continue

        time.sleep(0.8)

    if weplay_installed():
        diagnostics["playStoreState"] = "installed"
        return diagnostics

    capture_failure(
        driver=driver,
        step="play_store",
        package=last_package,
        activity=last_activity,
        page_source=last_source,
        extra={
            "message": "timeout",
            "tappedInstall": tapped_install,
            "sawPlayStore": saw_play_store,
            "kind": last_screen.kind.value if last_screen else None,
            **log_play_store_account_state(
                expected=email,
                device_accounts=device_accounts,
                play_store_account=infer_play_store_account(
                    expected=email,
                    device_accounts=device_accounts,
                    nodes=last_nodes,
                    page_source=last_source,
                ),
                play_store_state="timeout",
            ),
        },
        screenshot_ok=True,
    )
    hint = "Play Store listing was never reached" if not saw_play_store else "Install did not finish in time"
    if tapped_install:
        hint = "Install was tapped but did not finish in time"
    raise FlowError(
        "play_store",
        f"{hint}. {WEPLAY_PACKAGE} is still missing. Do not upload a WePlay APK; install from Play Store.",
    )
