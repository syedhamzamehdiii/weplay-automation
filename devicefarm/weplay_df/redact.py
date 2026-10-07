"""Redact secrets from logs, page source, and artifacts."""

from __future__ import annotations

import os
import re

from weplay_df.constants import DEVICE_PIN, GOOGLE_PASSWORD_ENV

_PASSWORD_ATTR = re.compile(r'(password\s*=\s*")[^"]*(")', re.IGNORECASE)
_PASSWORD_FIELD = re.compile(r"(pwd|passwd|password)\s*[:=]\s*\S+", re.IGNORECASE)
_COOKIE = re.compile(r"(set-cookie|cookie)\s*[:=]\s*\S+", re.IGNORECASE)
_TOKEN = re.compile(
    r"((?:access|refresh|id|session|auth|bearer|oauth)[-_ ]?token)\s*[:=]\s*\S+",
    re.IGNORECASE,
)
_OTP = re.compile(r"\b(\d{6})\b")
_EMAIL_PASS_QUERY = re.compile(r"(password=)[^&\s\"]+", re.IGNORECASE)


def extra_secrets() -> tuple[str, ...]:
    secrets: list[str] = []
    password = os.environ.get(GOOGLE_PASSWORD_ENV, "")
    if password:
        secrets.append(password)
    pin = DEVICE_PIN
    if pin and pin != "1234":
        secrets.append(pin)
    return tuple(secrets)


def redact(text: str | None, secrets: tuple[str, ...] | None = None) -> str:
    if not text:
        return ""
    redacted = text
    for secret in secrets or extra_secrets():
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = _PASSWORD_ATTR.sub(r"\1[REDACTED]\2", redacted)
    redacted = _PASSWORD_FIELD.sub(r"\1=[REDACTED]", redacted)
    redacted = _COOKIE.sub(r"\1=[REDACTED]", redacted)
    redacted = _TOKEN.sub(r"\1=[REDACTED]", redacted)
    redacted = _EMAIL_PASS_QUERY.sub(r"\1[REDACTED]", redacted)
    return redacted
