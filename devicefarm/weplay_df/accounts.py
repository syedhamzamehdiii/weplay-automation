"""Inspect Android Google accounts and which one Play Store is using."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from weplay_df.driver import adb_shell
from weplay_df.ui import UiNode, page_text

log = logging.getLogger("weplay.google")

_ACCOUNT_RE = re.compile(
    r"Account\s*\{name=([^,}]+),\s*type=([^}]+)\}",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.IGNORECASE)
_SIGNED_IN_RE = re.compile(
    r"signed in as\s+([A-Z0-9._%+\-]+@[A-Z0-9.\-]+)",
    re.IGNORECASE,
)
_WORK_HOST = "android-for-work.gserviceaccount.com"
CHANNEL_WORKSPACE = "workspace"
CHANNEL_DEVICEFARM_MANAGED_PLAY = "devicefarm_managed_play"
CHANNEL_WRONG_CONSUMER = "wrong_consumer_account"
CHANNEL_UNKNOWN = "unknown"
_MANAGED_TYPE_HINTS = (
    "android-for-work",
    "clouddpc",
    "enterprise.dmagent",
    "android.work",
    "com.google.work",
    "managed",
)


@dataclass(frozen=True)
class DeviceAccount:
    name: str
    type: str = ""

    @property
    def masked(self) -> str:
        return mask_email(self.name)

    @property
    def managed(self) -> bool:
        return is_managed_work_account(self.name, self.type)


def mask_email(email: str) -> str:
    value = (email or "").strip()
    if not value:
        return "(none)"
    if "@" not in value:
        return f"{value[:4]}***" if len(value) > 4 else "***"
    local, _, domain = value.partition("@")
    if domain.lower() == _WORK_HOST or local.lower().startswith("work-"):
        return f"work-***@{domain}"
    return f"{local[:2]}***@{domain}"


def emails_match(left: str, right: str) -> bool:
    return (left or "").strip().lower() == (right or "").strip().lower()


def identity_matches_expected(active: str | None, expected: str) -> bool:
    """Exact Workspace match, allowing Play Store chip truncation of the same address."""
    if not active or not expected:
        return False
    if is_managed_work_account(active):
        return False
    if emails_match(active, expected):
        return True
    left = active.strip().lower().rstrip(".,;")
    right = expected.strip().lower()
    if "@" not in left:
        return False
    return left.startswith(right) or right.startswith(left)


def is_managed_work_account(name: str, account_type: str = "") -> bool:
    blob = f"{name} {account_type}".lower()
    if _WORK_HOST in blob or "android-for-work" in blob:
        return True
    if (name or "").lower().startswith("work-") and "@" in (name or ""):
        return True
    return any(hint in blob for hint in _MANAGED_TYPE_HINTS)


def parse_dumpsys_accounts(raw: str) -> list[DeviceAccount]:
    found: list[DeviceAccount] = []
    seen: set[tuple[str, str]] = set()
    for match in _ACCOUNT_RE.finditer(raw or ""):
        name = match.group(1).strip()
        account_type = match.group(2).strip()
        key = (name.lower(), account_type.lower())
        if not name or key in seen:
            continue
        seen.add(key)
        found.append(DeviceAccount(name=name, type=account_type))
    if found:
        return found
    for email in _EMAIL_RE.findall(raw or ""):
        key = (email.lower(), "")
        if key in seen:
            continue
        seen.add(key)
        found.append(DeviceAccount(name=email))
    return found


def list_device_accounts() -> list[DeviceAccount]:
    raw = adb_shell("dumpsys", "account", timeout=20)
    accounts = parse_dumpsys_accounts(raw)
    log.info(
        "Device accounts from dumpsys: %s",
        [f"{row.masked} type={row.type or '(unknown)'} managed={row.managed}" for row in accounts] or "(none)",
    )
    return accounts


def signed_in_as_from_ui(nodes: list[UiNode], page_source: str = "") -> str | None:
    """Play Store 'Signed in as' chip is the identity source of truth, not AccountManager order."""
    blobs: list[str] = [page_source or ""]
    blobs.extend(f"{node.text} {node.content_desc}" for node in nodes)
    for blob in blobs:
        match = _SIGNED_IN_RE.search(blob or "")
        if match:
            return match.group(1).rstrip(".,;")
    return None


def classify_play_store_channel(active: str | None, expected: str) -> str:
    if identity_matches_expected(active, expected):
        return CHANNEL_WORKSPACE
    if active and is_managed_work_account(active):
        return CHANNEL_DEVICEFARM_MANAGED_PLAY
    if active:
        return CHANNEL_WRONG_CONSUMER
    return CHANNEL_UNKNOWN


def play_store_identity_allowed(
    *,
    expected: str,
    active: str | None,
    device_accounts: list[DeviceAccount],
) -> bool:
    channel = classify_play_store_channel(active, expected)
    if channel == CHANNEL_WORKSPACE:
        return True
    return channel == CHANNEL_DEVICEFARM_MANAGED_PLAY and account_on_device(device_accounts, expected)


def emails_from_ui(nodes: list[UiNode], page_source: str = "") -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    blobs = [page_source or "", page_text(page_source)]
    blobs.extend(f"{node.text} {node.content_desc}" for node in nodes)
    for blob in blobs:
        for email in _EMAIL_RE.findall(blob or ""):
            key = email.lower()
            if key in seen:
                continue
            seen.add(key)
            found.append(email)
    return found


def account_on_device(accounts: list[DeviceAccount], email: str) -> bool:
    return any(emails_match(row.name, email) for row in accounts)


def infer_play_store_account(
    *,
    expected: str,
    device_accounts: list[DeviceAccount],
    nodes: list[UiNode],
    page_source: str,
) -> str | None:
    """Best-effort current Play Store identity. Prefers the Signed-in-as chip over dumpsys order."""
    signed_in = signed_in_as_from_ui(nodes, page_source)
    if signed_in:
        return signed_in
    ui_emails = emails_from_ui(nodes, page_source)
    ui_managed = [email for email in ui_emails if is_managed_work_account(email)]
    ui_expected = [email for email in ui_emails if identity_matches_expected(email, expected)]
    # A listing of both accounts is not a signed-in identity. Prefer the DF work account.
    if ui_managed:
        return ui_managed[0]
    if len(ui_emails) == 1 and ui_expected:
        return ui_expected[0]
    managed = [row.name for row in device_accounts if row.managed]
    workspace = [row.name for row in device_accounts if emails_match(row.name, expected)]
    others = [row.name for row in device_accounts if not row.managed and not emails_match(row.name, expected)]
    if managed:
        return managed[0]
    if workspace:
        return workspace[0]
    if others:
        return others[0]
    return None


def play_store_state_label(
    *,
    page_source: str,
    weplay_listing: bool,
    install_visible: bool,
    unavailable: str | None,
) -> str:
    if unavailable:
        return f"blocked:{unavailable}"
    if install_visible:
        return "listing_install_visible"
    if weplay_listing:
        return "listing_no_install"
    text = page_text(page_source)
    if "account" in text or "signed in" in text:
        return "account_switcher_or_home"
    return "play_store"


def diagnostics_payload(
    *,
    expected: str,
    device_accounts: list[DeviceAccount],
    play_store_account: str | None,
    play_store_state: str,
) -> dict[str, object]:
    matches = identity_matches_expected(play_store_account, expected)
    channel = classify_play_store_channel(play_store_account, expected)
    identity_ok = play_store_identity_allowed(
        expected=expected,
        active=play_store_account,
        device_accounts=device_accounts,
    )
    return {
        "expectedPlayStoreAccount": mask_email(expected),
        "playStoreAccount": mask_email(play_store_account or ""),
        "playStoreAccountMatchesExpected": matches,
        "playStoreChannel": channel,
        "playStoreIdentityOk": identity_ok,
        "deviceAccounts": [row.masked for row in device_accounts],
        "managedDeviceAccounts": [row.masked for row in device_accounts if row.managed],
        "workspaceAccountOnDevice": account_on_device(device_accounts, expected),
        "playStoreState": play_store_state,
    }
