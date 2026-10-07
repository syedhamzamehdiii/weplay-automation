"""Cross-reference interesting strings to DEX methods in a Play-installed WePlay APK."""

from __future__ import annotations

import json
import re
import struct
import zipfile
from pathlib import Path
from typing import Any, Iterable

INTERESTING_SUBSTRINGS = (
    "WejoyLargeLoginBtnView",
    "login_google",
    "Sign in with Google",
    "SignInHubActivity",
    "GetSignInIntent",
    "GetSignInIntentRequest",
    "GoogleSignInOptions",
    "GoogleSignInClient",
    "GoogleSignInAccount",
    "CredentialManager",
    "BeginSignInRequest",
    "accounts.google.com/o/oauth2",
    "oauth2.googleapis.com",
    "apps.googleusercontent.com",
    "requestIdToken",
    "requestServerAuthCode",
    "DEVELOPER_ERROR",
    "ApiException",
    "12500",
    "12501",
    "tourist",
    "Tourist login",
    "google_login",
    "loginType",
    "LoginType",
    "GOOGLE",
)

OAUTH_HINTS = (
    "SignInHub",
    "GetSignInIntent",
    "GoogleSignIn",
    "CredentialManager",
    "oauth2",
    "googleusercontent",
    "requestIdToken",
    "BeginSignIn",
)
FALLBACK_HINTS = ("tourist", "Tourist", "guest", "register")
BUTTON_HINTS = ("WejoyLargeLoginBtnView", "login_google", "Sign in with Google", "google_login")


def _u32(data: bytes, off: int) -> int:
    return struct.unpack_from("<I", data, off)[0]


def _u16(data: bytes, off: int) -> int:
    return struct.unpack_from("<H", data, off)[0]


def _uleb128(data: bytes, off: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        byte = data[off]
        off += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            return result, off
        shift += 7
        if shift > 35:
            raise ValueError("uleb128 too long")


def _mutf8(data: bytes, off: int) -> str:
    size, off = _uleb128(data, off)
    end = data.find(b"\x00", off)
    if end < 0:
        end = min(off + size * 3 + 1, len(data))
    raw = data[off:end]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="replace")


def parse_dex_strings_and_methods(dex: bytes) -> dict[str, Any] | None:
    if len(dex) < 0x70 or not dex.startswith(b"dex\n"):
        return None
    endian = _u32(dex, 40)
    if endian != 0x12345678:
        return None
    string_ids_size = _u32(dex, 56)
    string_ids_off = _u32(dex, 60)
    type_ids_size = _u32(dex, 64)
    type_ids_off = _u32(dex, 68)
    method_ids_size = _u32(dex, 88)
    method_ids_off = _u32(dex, 92)
    class_defs_size = _u32(dex, 96)
    class_defs_off = _u32(dex, 100)

    strings: list[str] = []
    for i in range(string_ids_size):
        data_off = _u32(dex, string_ids_off + i * 4)
        strings.append(_mutf8(dex, data_off))

    def type_name(idx: int) -> str:
        if idx < 0 or idx >= type_ids_size:
            return "?"
        return strings[_u32(dex, type_ids_off + idx * 4)]

    def method_name(idx: int) -> tuple[str, str]:
        if idx < 0 or idx >= method_ids_size:
            return "?", "?"
        base = method_ids_off + idx * 8
        class_idx = _u16(dex, base)
        name_idx = _u32(dex, base + 4)
        owner = type_name(class_idx)
        name = strings[name_idx] if name_idx < len(strings) else "?"
        return owner, name

    interesting: dict[int, str] = {}
    oauth_ids: list[str] = []
    for i, s in enumerate(strings):
        if ".apps.googleusercontent.com" in s:
            oauth_ids.append(s)
        if any(token in s for token in INTERESTING_SUBSTRINGS):
            interesting[i] = s

    hits: list[dict[str, Any]] = []
    for c in range(class_defs_size):
        cdef = class_defs_off + c * 32
        class_idx = _u32(dex, cdef)
        class_data_off = _u32(dex, cdef + 24)
        owner = type_name(class_idx)
        if class_data_off == 0:
            continue
        try:
            hits.extend(
                _class_method_hits(dex, class_data_off, owner, interesting, method_name)
            )
        except Exception:  # noqa: BLE001
            continue
    return {
        "stringCount": len(strings),
        "interestingStrings": sorted(set(interesting.values())),
        "oauthClientIds": sorted(set(oauth_ids)),
        "methods": hits,
    }


def _class_method_hits(
    dex: bytes,
    class_data_off: int,
    owner: str,
    interesting: dict[int, str],
    method_name,
) -> list[dict[str, Any]]:
    off = class_data_off
    static_fields_size, off = _uleb128(dex, off)
    instance_fields_size, off = _uleb128(dex, off)
    direct_methods_size, off = _uleb128(dex, off)
    virtual_methods_size, off = _uleb128(dex, off)
    for _ in range(static_fields_size + instance_fields_size):
        _, off = _uleb128(dex, off)
        _, off = _uleb128(dex, off)
    hits: list[dict[str, Any]] = []
    method_idx = 0
    for kind, count in (("direct", direct_methods_size), ("virtual", virtual_methods_size)):
        method_idx = 0
        for _ in range(count):
            idx_diff, off = _uleb128(dex, off)
            access_flags, off = _uleb128(dex, off)
            code_off, off = _uleb128(dex, off)
            method_idx += idx_diff
            owner_m, name = method_name(method_idx)
            if code_off == 0:
                continue
            found = _scan_code_item(dex, code_off, interesting, method_name)
            if not found["strings"] and not found["invokes"]:
                continue
            if not _method_is_relevant(owner_m or owner, name, found):
                continue
            hits.append(
                {
                    "class": owner_m or owner,
                    "method": name,
                    "kind": kind,
                    "accessFlags": access_flags,
                    "strings": found["strings"][:40],
                    "invokes": found["invokes"][:40],
                    "pathGuess": _path_guess(found),
                }
            )
    return hits


def _method_is_relevant(owner: str, name: str, found: dict[str, Any]) -> bool:
    blob = f"{owner} {name} {' '.join(found['strings'])} {' '.join(found['invokes'])}"
    if any(token in blob for token in BUTTON_HINTS):
        return True
    if any(token in blob for token in OAUTH_HINTS) and (
        "login" in blob.lower() or "wejoy" in blob.lower() or "wespy" in blob.lower() or "google" in blob.lower()
    ):
        return True
    if any(token in blob for token in FALLBACK_HINTS) and "login" in blob.lower():
        return True
    return False


def _path_guess(found: dict[str, Any]) -> str:
    blob = " ".join(found["strings"] + found["invokes"])
    oauth = any(token in blob for token in OAUTH_HINTS)
    fallback = any(token in blob for token in FALLBACK_HINTS)
    button = any(token in blob for token in BUTTON_HINTS)
    if oauth and fallback:
        return "oauth_with_tourist_fallback"
    if oauth:
        return "oauth"
    if button and fallback:
        return "button_to_tourist"
    if button:
        return "button"
    if fallback:
        return "tourist"
    return "other"


def _scan_code_item(dex: bytes, code_off: int, interesting: dict[int, str], method_name) -> dict[str, list[str]]:
    insns_size = _u32(dex, code_off + 12)
    insns_off = code_off + 16
    insns = dex[insns_off : insns_off + insns_size * 2]
    strings_found: list[str] = []
    invokes: list[str] = []
    i = 0
    while i + 1 < len(insns):
        op = insns[i]
        width = _INSN_WIDTH.get(op, 1) * 2
        if op == 0x1A and i + 3 < len(insns):
            sidx = insns[i + 2] | (insns[i + 3] << 8)
            if sidx in interesting:
                strings_found.append(interesting[sidx])
        elif op == 0x1B and i + 5 < len(insns):
            sidx = insns[i + 2] | (insns[i + 3] << 8) | (insns[i + 4] << 16) | (insns[i + 5] << 24)
            if sidx in interesting:
                strings_found.append(interesting[sidx])
        elif 0x6E <= op <= 0x72 and i + 3 < len(insns):
            midx = insns[i + 2] | (insns[i + 3] << 8)
            owner, name = method_name(midx)
            label = f"{owner}->{name}"
            if any(token.lower() in label.lower() for token in (*OAUTH_HINTS, "signIn", "SignIn", "getClient", "getCredential", "startActivity")):
                invokes.append(label)
        if op in {0x26, 0x2B, 0x2C} and i + 5 < len(insns):
            rel = struct.unpack_from("<i", insns, i + 2)[0]
            i = max(i + width, i + rel * 2)
            continue
        i += max(width, 2)
    return {
        "strings": list(dict.fromkeys(strings_found)),
        "invokes": list(dict.fromkeys(invokes)),
    }


# Widths in 16-bit code units. Unknown opcodes default to 1 in the walker.
_INSN_WIDTH = {
    0x00: 1, 0x01: 1, 0x02: 2, 0x03: 3, 0x04: 1, 0x05: 2, 0x06: 3, 0x07: 1, 0x08: 2, 0x09: 3,
    0x0A: 1, 0x0B: 1, 0x0C: 1, 0x0D: 1, 0x0E: 1, 0x0F: 1, 0x10: 1, 0x11: 1, 0x12: 1, 0x13: 2,
    0x14: 3, 0x15: 2, 0x16: 2, 0x17: 3, 0x18: 5, 0x19: 2, 0x1A: 2, 0x1B: 3, 0x1C: 2, 0x1D: 1,
    0x1E: 1, 0x1F: 2, 0x20: 2, 0x21: 1, 0x22: 2, 0x23: 2, 0x24: 3, 0x25: 3, 0x26: 3, 0x27: 1,
    0x28: 1, 0x29: 2, 0x2A: 3, 0x2B: 3, 0x2C: 3, 0x2D: 2, 0x2E: 2, 0x2F: 2, 0x30: 2, 0x31: 2,
    0x32: 2, 0x33: 2, 0x34: 2, 0x35: 2, 0x36: 2, 0x37: 2, 0x38: 2, 0x39: 2, 0x3A: 2, 0x3B: 2,
    0x3C: 2, 0x3D: 2, 0x44: 2, 0x45: 2, 0x46: 2, 0x47: 2, 0x48: 2, 0x49: 2, 0x4A: 2, 0x4B: 2,
    0x4C: 2, 0x4D: 2, 0x4E: 2, 0x4F: 2, 0x50: 2, 0x51: 2, 0x52: 2, 0x53: 2, 0x54: 2, 0x55: 2,
    0x56: 2, 0x57: 2, 0x58: 2, 0x59: 2, 0x5A: 2, 0x5B: 2, 0x5C: 2, 0x5D: 2, 0x5E: 2, 0x5F: 2,
    0x60: 2, 0x61: 2, 0x62: 2, 0x63: 2, 0x64: 2, 0x65: 2, 0x66: 2, 0x67: 2, 0x68: 2, 0x69: 2,
    0x6A: 2, 0x6B: 2, 0x6C: 2, 0x6D: 2, 0x6E: 3, 0x6F: 3, 0x70: 3, 0x71: 3, 0x72: 3, 0x74: 3,
    0x75: 3, 0x76: 3, 0x77: 3, 0x78: 3, 0x7B: 1, 0x7C: 1, 0x7D: 1, 0x7E: 1, 0x7F: 1, 0x80: 1,
    0x81: 1, 0x82: 1, 0x83: 1, 0x84: 1, 0x85: 1, 0x86: 1, 0x87: 1, 0x88: 1, 0x89: 1, 0x8A: 1,
    0x8B: 1, 0x8C: 1, 0x8D: 1, 0x8E: 1, 0x8F: 1, 0x90: 2, 0x91: 2, 0x92: 2, 0x93: 2, 0x94: 2,
    0x95: 2, 0x96: 2, 0x97: 2, 0x98: 2, 0x99: 2, 0x9A: 2, 0x9B: 2, 0x9C: 2, 0x9D: 2, 0x9E: 2,
    0x9F: 2, 0xA0: 2, 0xA1: 2, 0xA2: 2, 0xA3: 2, 0xA4: 2, 0xA5: 2, 0xA6: 2, 0xA7: 2, 0xA8: 2,
    0xA9: 2, 0xAA: 2, 0xAB: 2, 0xAC: 2, 0xAD: 2, 0xAE: 2, 0xAF: 2, 0xB0: 1, 0xB1: 1, 0xB2: 1,
    0xB3: 1, 0xB4: 1, 0xB5: 1, 0xB6: 1, 0xB7: 1, 0xB8: 1, 0xB9: 1, 0xBA: 1, 0xBB: 1, 0xBC: 1,
    0xBD: 1, 0xBE: 1, 0xBF: 1, 0xC0: 1, 0xC1: 1, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1,
    0xC7: 1, 0xC8: 1, 0xC9: 1, 0xCA: 1, 0xCB: 1, 0xCC: 1, 0xCD: 1, 0xCE: 1, 0xCF: 1, 0xD0: 2,
    0xD1: 2, 0xD2: 2, 0xD3: 2, 0xD4: 2, 0xD5: 2, 0xD6: 2, 0xD7: 2, 0xD8: 2, 0xD9: 2, 0xDA: 2,
    0xDB: 2, 0xDC: 2, 0xDD: 2, 0xDE: 2, 0xDF: 2, 0xE0: 2, 0xE1: 2, 0xE2: 2, 0xFA: 4, 0xFB: 4,
    0xFC: 3, 0xFD: 3, 0xFE: 2, 0xFF: 2,
}


def find_oauth_client_ids(blob: bytes) -> list[str]:
    text = blob.decode("latin-1", errors="ignore")
    ids = re.findall(r"[0-9]+-[a-zA-Z0-9_]+\.apps\.googleusercontent\.com", text)
    utf16 = blob.decode("utf-16le", errors="ignore")
    ids.extend(re.findall(r"[0-9]+-[a-zA-Z0-9_]+\.apps\.googleusercontent\.com", utf16))
    return sorted(set(ids))


def xref_apk(apk_path: Path) -> dict[str, Any]:
    methods: list[dict[str, Any]] = []
    client_ids: list[str] = []
    dex_files: list[str] = []
    with zipfile.ZipFile(apk_path) as zf:
        for name in zf.namelist():
            if name.endswith(".dex"):
                dex_files.append(name)
                parsed = parse_dex_strings_and_methods(zf.read(name))
                if parsed:
                    client_ids.extend(parsed.get("oauthClientIds") or [])
                    for row in parsed["methods"]:
                        row["dex"] = name
                        methods.append(row)
            lower = name.lower()
            if lower.endswith((".xml", ".properties", ".json")) or name == "resources.arsc":
                try:
                    client_ids.extend(find_oauth_client_ids(zf.read(name)))
                except Exception:  # noqa: BLE001
                    continue
    client_ids = sorted(set(client_ids))
    button_methods = [m for m in methods if m.get("pathGuess") in {"button", "button_to_tourist", "oauth_with_tourist_fallback"} or any(h in " ".join(m.get("strings") or []) for h in BUTTON_HINTS)]
    return {
        "dexFiles": dex_files,
        "oauthClientIds": client_ids,
        "methodCount": len(methods),
        "buttonMethods": button_methods[:80],
        "oauthMethods": [m for m in methods if m.get("pathGuess") in {"oauth", "oauth_with_tourist_fallback"}][:80],
        "methods": methods[:200],
    }
