"""Inspect the Play-installed WePlay APK for a real Google OAuth / Sign-In implementation.

Does not change login, region, or Confirm behavior. Results are written to DEVICEFARM_LOG_DIR.
The APK itself is pulled to a temp directory and discarded — it is not uploaded as an artifact.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from weplay_df.artifacts import artifact_dir
from weplay_df.constants import WEPLAY_PACKAGE
from weplay_df.dex_xref import xref_apk
from weplay_df.driver import adb_shell
from weplay_df.redact import redact

log = logging.getLogger("weplay.google")

GOOGLE_AUTH_NEEDLES = (
    "play-services-auth",
    "play-services-auth-base",
    "play-services-auth-api-phone",
    "GoogleSignInClient",
    "GoogleSignInOptions",
    "GoogleSignInAccount",
    "GoogleSignInStatusCodes",
    "SignInHubActivity",
    "auth.api.signin",
    "com.google.android.gms.auth.api.signin",
    "com.google.android.gms.auth.api.identity",
    "IdentityGetCredential",
    "IdentityGetSignInIntent",
    "GetSignInIntent",
    "GetSignInIntentRequest",
    "GetGoogleIdOption",
    "BeginSignInRequest",
    "SignInCredential",
    "CredentialManager",
    "androidx.credentials",
    "com.google.android.libraries.identity.googleid",
    "com.google.android.gms.common.account.CHOOSE_ACCOUNT",
    "oauth2.googleapis.com",
    "accounts.google.com/o/oauth2",
    "DEFAULT_SIGN_IN",
    "requestIdToken",
    "requestServerAuthCode",
    "requestEmail",
)

RELATED_LOGIN_NEEDLES = (
    "WejoyLargeLoginBtnView",
    "login_google",
    "Sign in with Google",
    "Tourist login",
    "tourist",
    "com.facebook.FacebookActivity",
    "com.facebook.login",
    "CustomTabActivity",
    "com.google.android.gms.measurement",
)

ZIP_NAME_NEEDLES = (
    "play-services-auth",
    "play-services-auth-base",
    "identity.googleid",
    "credentials",
    "googleid",
    "signin",
)

DUMPSYS_ACTIVITY_NEEDLES = (
    "signin",
    "sign_in",
    "oauth",
    "credential",
    "google",
    "hub",
    "facebook",
    "customtab",
    "browser",
    "chrome",
)


def parse_pm_paths(pm_path_output: str) -> list[str]:
    paths: list[str] = []
    for line in (pm_path_output or "").splitlines():
        line = line.strip()
        if line.lower().startswith("package:"):
            path = line.split(":", 1)[1].strip()
            if path:
                paths.append(path)
    return paths


def _utf16le_needle(needle: str) -> bytes:
    return needle.encode("utf-16le")


def find_needles_in_bytes(blob: bytes, needles: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for needle in needles:
        utf8 = needle.encode("utf-8")
        if utf8 in blob or _utf16le_needle(needle) in blob:
            found.append(needle)
    return found


def scan_apk_file(apk_path: Path, *, needles: tuple[str, ...] = GOOGLE_AUTH_NEEDLES) -> dict[str, Any]:
    """Search a local APK zip for Google auth classes, properties files, and manifest strings."""
    result: dict[str, Any] = {
        "apkPath": str(apk_path),
        "apkSizeBytes": apk_path.stat().st_size if apk_path.is_file() else 0,
        "zipOk": False,
        "entries": 0,
        "matchingZipEntries": [],
        "needlesInZipNames": [],
        "needlesInManifest": [],
        "needlesInDex": [],
        "needlesInOther": [],
        "relatedNeedles": [],
        "dexFiles": [],
        "error": None,
    }
    if not apk_path.is_file():
        result["error"] = "apk missing"
        return result
    try:
        with zipfile.ZipFile(apk_path) as zf:
            names = zf.namelist()
            result["zipOk"] = True
            result["entries"] = len(names)
            matching_names = [
                name
                for name in names
                if any(token in name.lower() for token in ZIP_NAME_NEEDLES)
            ]
            result["matchingZipEntries"] = matching_names[:80]
            result["needlesInZipNames"] = [
                needle for needle in needles if any(needle.lower() in name.lower() for name in names)
            ]
            dex_hits: set[str] = set()
            other_hits: set[str] = set()
            related: set[str] = set()
            for name in names:
                lower = name.lower()
                try:
                    data = zf.read(name)
                except Exception as exc:  # noqa: BLE001
                    log.warning("Could not read APK entry %s: %s", name, exc)
                    continue
                hits = find_needles_in_bytes(data, needles)
                related_hits = find_needles_in_bytes(data, RELATED_LOGIN_NEEDLES)
                related.update(related_hits)
                if lower == "androidmanifest.xml":
                    result["needlesInManifest"] = hits
                    continue
                if lower.endswith(".dex") or "/classes" in lower and lower.endswith(".dex"):
                    result["dexFiles"].append({"name": name, "size": len(data), "needles": hits})
                    dex_hits.update(hits)
                    continue
                if hits:
                    other_hits.update(hits)
            result["needlesInDex"] = sorted(dex_hits)
            result["needlesInOther"] = sorted(other_hits)
            result["relatedNeedles"] = sorted(related)
    except zipfile.BadZipFile as exc:
        result["error"] = f"not a zip: {exc}"
        raw = apk_path.read_bytes()
        result["needlesInOther"] = find_needles_in_bytes(raw, needles)
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)
    return result


def extract_dumpsys_facts(dumpsys: str) -> dict[str, Any]:
    facts: dict[str, Any] = {
        "versionName": None,
        "versionCode": None,
        "targetSdk": None,
        "minSdk": None,
        "declaredPermissions": [],
        "requestedPermissions": [],
        "installPermissions": [],
        "queriesPackages": [],
        "queriesIntents": [],
        "matchingActivities": [],
        "matchingServices": [],
        "matchingProviders": [],
        "matchingReceivers": [],
        "hasGetAccounts": False,
        "hasUseCredentials": False,
        "hasInternet": False,
        "hasQueriesGms": False,
        "hasSignInHubActivity": False,
        "hasCredentialManagerActivity": False,
    }
    if not dumpsys:
        return facts

    version_name = re.search(r"versionName=(\S+)", dumpsys)
    version_code = re.search(r"versionCode=(\d+)", dumpsys)
    target_sdk = re.search(r"targetSdk=(\d+)", dumpsys)
    min_sdk = re.search(r"minSdk=(\d+)", dumpsys)
    if version_name:
        facts["versionName"] = version_name.group(1)
    if version_code:
        facts["versionCode"] = int(version_code.group(1))
    if target_sdk:
        facts["targetSdk"] = int(target_sdk.group(1))
    if min_sdk:
        facts["minSdk"] = int(min_sdk.group(1))

    requested = re.findall(r"requested permissions:\n((?:    .+\n)+)", dumpsys)
    if requested:
        facts["requestedPermissions"] = [
            line.strip() for line in requested[0].splitlines() if line.strip()
        ]
    else:
        facts["requestedPermissions"] = sorted(
            set(re.findall(r"android\.permission\.[A-Z0-9_]+", dumpsys))
        )

    perms = "\n".join(facts["requestedPermissions"]).upper()
    facts["hasGetAccounts"] = "GET_ACCOUNTS" in perms or "GET_ACCOUNTS" in dumpsys.upper()
    facts["hasUseCredentials"] = "USE_CREDENTIALS" in dumpsys.upper()
    facts["hasInternet"] = "INTERNET" in perms or "android.permission.INTERNET" in dumpsys

    facts["queriesPackages"] = _dumpsys_query_packages(dumpsys)
    facts["hasQueriesGms"] = any("com.google.android.gms" in pkg for pkg in facts["queriesPackages"])

    facts["matchingActivities"] = _dumpsys_component_hits(dumpsys, "Activity")
    facts["matchingServices"] = _dumpsys_component_hits(dumpsys, "Service")
    facts["matchingProviders"] = _dumpsys_component_hits(dumpsys, "Provider")
    facts["matchingReceivers"] = _dumpsys_component_hits(dumpsys, "Receiver")
    blob = dumpsys.lower()
    facts["hasSignInHubActivity"] = "signinhubactivity" in blob
    facts["hasCredentialManagerActivity"] = "credentialmanager" in blob or "hiddenactivity" in blob
    return facts


def _dumpsys_query_packages(dumpsys: str) -> list[str]:
    packages: list[str] = []
    in_queries = False
    for line in dumpsys.splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if lower.startswith("queries:") or lower == "package visibility queries:" or "queries via" in lower:
            in_queries = True
            continue
        if in_queries:
            if not line.startswith(" ") and stripped.endswith(":") and "quer" not in lower:
                in_queries = False
                continue
            if stripped.startswith("com.") or stripped.startswith("org.") or stripped.startswith("android."):
                packages.append(stripped.split()[0])
            if lower.startswith("hidden") or lower.startswith("user ") or lower.startswith("installer"):
                if not stripped.startswith("com."):
                    in_queries = False
    # Also grab explicit "queries:" package blocks used by some Android versions.
    for match in re.findall(r"queries:\s*((?:.+\n)+?)(?:\n[A-Z]|\Z)", dumpsys, flags=re.IGNORECASE):
        for token in re.findall(r"com\.[A-Za-z0-9_.]+", match):
            packages.append(token)
    seen: set[str] = set()
    ordered: list[str] = []
    for pkg in packages:
        if pkg not in seen:
            seen.add(pkg)
            ordered.append(pkg)
    return ordered[:80]


def _dumpsys_component_hits(dumpsys: str, kind: str) -> list[str]:
    hits: list[str] = []
    pattern = re.compile(rf"{kind}\s+#?\d*\s*\n?\s*(?:[A-Za-z]+=\S+\s+)*name=(\S+)", re.IGNORECASE)
    for name in pattern.findall(dumpsys):
        lower = name.lower()
        if any(token in lower for token in DUMPSYS_ACTIVITY_NEEDLES):
            hits.append(name)
    # dumpsys also prints "Activity Resolver Table" / component names on their own lines.
    for line in dumpsys.splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if any(token in lower for token in DUMPSYS_ACTIVITY_NEEDLES) and (
            "activity" in lower
            or "service" in lower
            or "provider" in lower
            or "receiver" in lower
            or stripped.startswith("com.")
            or "/" in stripped
        ):
            if stripped not in hits and len(stripped) < 240:
                hits.append(stripped)
    seen: set[str] = set()
    ordered: list[str] = []
    for item in hits:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered[:120]


def adb_run_to_path(*args: str, dest: Path, timeout: int = 90) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["adb", "exec-out", *args],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        dest.write_bytes(result.stdout or b"")
        return (result.stderr or b"").decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        log.warning("adb exec-out %s -> %s failed: %s", " ".join(args), dest, exc)
        return str(exc)


def _u32le(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def _u64le(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 8], "little")


def _len_prefixed(data: bytes, offset: int) -> tuple[bytes, int]:
    if offset + 4 > len(data):
        return b"", offset
    size = _u32le(data, offset)
    start = offset + 4
    end = start + size
    if size < 0 or end > len(data):
        return b"", offset
    return data[start:end], end


def _certs_from_apk_signature_scheme(value: bytes) -> list[bytes]:
    signers, _ = _len_prefixed(value, 0)
    certs: list[bytes] = []
    offset = 0
    while offset < len(signers):
        signer, offset = _len_prefixed(signers, offset)
        if not signer:
            break
        signed_data, _ = _len_prefixed(signer, 0)
        _digests, after_digests = _len_prefixed(signed_data, 0)
        cert_seq, _ = _len_prefixed(signed_data, after_digests)
        cert_offset = 0
        while cert_offset < len(cert_seq):
            cert, cert_offset = _len_prefixed(cert_seq, cert_offset)
            if cert:
                certs.append(cert)
    return certs


def extract_apk_v2_certs(apk_path: Path) -> list[bytes]:
    """Read X.509 certs from the APK Signing Block (v2/v3). Play App Signing often has no META-INF/*.RSA."""
    blob = apk_path.read_bytes()
    magic = b"APK Sig Block 42"
    magic_at = blob.rfind(magic)
    if magic_at < 8:
        return []
    block_size = _u64le(blob, magic_at - 8)
    block_start = magic_at + 16 - block_size
    if block_start < 0 or block_start + 8 > magic_at - 8:
        return []
    pairs = blob[block_start + 8 : magic_at - 8]
    certs: list[bytes] = []
    offset = 0
    while offset + 12 <= len(pairs):
        pair_len = _u64le(pairs, offset)
        if pair_len < 4 or offset + 8 + pair_len > len(pairs):
            break
        pair_id = _u32le(pairs, offset + 8)
        value = pairs[offset + 12 : offset + 8 + pair_len]
        offset += 8 + pair_len
        if pair_id in (0x7109871A, 0xF05368C0) and value:
            certs.extend(_certs_from_apk_signature_scheme(value))
    return certs


def _openssl_der_fingerprints(der: bytes, dest: Path) -> dict[str, str]:
    dest.write_bytes(der)
    out: dict[str, str] = {}
    for flag, key in (("-sha1", "sha1"), ("-sha256", "sha256")):
        fp = subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-noout", "-fingerprint", flag, "-in", str(dest)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        value = (fp.stdout or "").strip()
        if value:
            out[key] = value
    subj = subprocess.run(
        ["openssl", "x509", "-inform", "DER", "-noout", "-subject", "-issuer", "-in", str(dest)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if subj.stdout:
        out["subject"] = subj.stdout.strip()
    return out


def extract_signing_fingerprints(apk_path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"files": [], "sha1": [], "sha256": [], "subject": [], "scheme": None, "error": None}
    try:
        with zipfile.ZipFile(apk_path) as zf, tempfile.TemporaryDirectory(prefix="weplay-cert-") as tmp:
            tmp_path = Path(tmp)
            for name in zf.namelist():
                lower = name.lower()
                if not lower.startswith("meta-inf/") or not lower.endswith((".rsa", ".dsa", ".ec")):
                    continue
                local = tmp_path / Path(name).name
                local.write_bytes(zf.read(name))
                info["files"].append(name)
                printed = subprocess.run(
                    ["openssl", "pkcs7", "-inform", "DER", "-in", str(local), "-print_certs"],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                pem = printed.stdout or b""
                if not pem.strip():
                    continue
                pem_file = tmp_path / f"{local.stem}.pem"
                pem_file.write_bytes(pem)
                for flag, key in (("-sha1", "sha1"), ("-sha256", "sha256")):
                    fp = subprocess.run(
                        ["openssl", "x509", "-noout", "-fingerprint", flag, "-in", str(pem_file)],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    value = (fp.stdout or "").strip()
                    if value:
                        info[key].append(value)
                subj = subprocess.run(
                    ["openssl", "x509", "-noout", "-subject", "-issuer", "-in", str(pem_file)],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                if subj.stdout:
                    info["subject"].append(subj.stdout.strip())
                info["scheme"] = "jar_v1"
        if not info["sha1"]:
            v2_certs = extract_apk_v2_certs(apk_path)
            if v2_certs:
                info["scheme"] = "apk_v2_v3"
                info["files"] = [f"apk-signing-block[{i}]" for i in range(len(v2_certs))]
                with tempfile.TemporaryDirectory(prefix="weplay-v2-cert-") as tmp:
                    tmp_path = Path(tmp)
                    for index, der in enumerate(v2_certs):
                        fps = _openssl_der_fingerprints(der, tmp_path / f"cert-{index}.der")
                        if fps.get("sha1"):
                            info["sha1"].append(fps["sha1"])
                        if fps.get("sha256"):
                            info["sha256"].append(fps["sha256"])
                        if fps.get("subject"):
                            info["subject"].append(fps["subject"])
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def _adb_pull(remote: str, local: Path, timeout: int = 180) -> str:
    local.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["adb", "pull", remote, str(local)],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return ((result.stdout or "") + (result.stderr or "")).strip()
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def _copy_apk_via_sdcard(remote: str, local: Path) -> str:
    staging = "/data/local/tmp/weplay-inspect.apk"
    copied = adb_shell("cp", remote, staging, timeout=60)
    adb_shell("chmod", "644", staging, timeout=10)
    pulled = _adb_pull(staging, local)
    adb_shell("rm", "-f", staging, timeout=10)
    return f"cp={copied.strip()[:200]} pull={pulled[:200]}"


def select_apk_paths(remote_paths: list[str]) -> list[str]:
    """Prefer base.apk only for Google-auth decompile; skip config/asset splits."""
    base = [remote for remote in remote_paths if Path(remote).name.lower() == "base.apk" or remote.endswith("/base.apk")]
    return base or list(remote_paths[:1])


def pull_and_scan_apks(remote_paths: list[str], workdir: Path) -> list[dict[str, Any]]:
    scans: list[dict[str, Any]] = []
    for index, remote in enumerate(select_apk_paths(remote_paths)):
        name = Path(remote).name or f"split-{index}.apk"
        local = workdir / name
        pull_log = _adb_pull(remote, local)
        if not local.is_file() or local.stat().st_size < 64:
            pull_log = _copy_apk_via_sdcard(remote, local) + f" first_pull={pull_log[:180]}"
        scan = scan_apk_file(local)
        scan["remotePath"] = remote
        scan["pullLog"] = pull_log[:500]
        scan["pulled"] = local.is_file() and local.stat().st_size > 64
        scans.append(scan)
    return scans


def summarize_google_auth(dumpsys_facts: dict[str, Any], apk_scans: list[dict[str, Any]]) -> dict[str, Any]:
    needles: set[str] = set()
    zip_entries: list[str] = []
    related: set[str] = set()
    pulled = False
    for scan in apk_scans:
        pulled = pulled or bool(scan.get("pulled"))
        needles.update(scan.get("needlesInManifest") or [])
        needles.update(scan.get("needlesInDex") or [])
        needles.update(scan.get("needlesInOther") or [])
        needles.update(scan.get("needlesInZipNames") or [])
        zip_entries.extend(scan.get("matchingZipEntries") or [])
        related.update(scan.get("relatedNeedles") or [])
    play_services_auth = "play-services-auth" in needles or any(
        "play-services-auth" in (entry or "").lower() for entry in zip_entries
    )
    has_client = "GoogleSignInClient" in needles or "GoogleSignInOptions" in needles
    has_hub = bool(dumpsys_facts.get("hasSignInHubActivity")) or "SignInHubActivity" in needles
    has_identity = any(
        token in needles
        for token in (
            "IdentityGetCredential",
            "GetGoogleIdOption",
            "BeginSignInRequest",
            "com.google.android.gms.auth.api.identity",
            "com.google.android.libraries.identity.googleid",
        )
    )
    has_credential_manager = "CredentialManager" in needles or "androidx.credentials" in needles
    has_oauth_endpoints = any(
        token in needles for token in ("oauth2.googleapis.com", "accounts.google.com/o/oauth2", "requestIdToken")
    )
    real_google_oauth = bool(
        play_services_auth or has_client or has_hub or has_identity or has_credential_manager or has_oauth_endpoints
    )
    if real_google_oauth:
        verdict = "play_google_oauth_present"
        detail = (
            "The Play-installed APK contains Google Sign-In / Identity / Credential Manager "
            "classes or play-services-auth. A Device Farm tourist fallback is not because the "
            "library is absent from this build."
        )
    elif pulled:
        verdict = "no_play_google_oauth_in_apk"
        detail = (
            "The Play-installed APK was pulled and searched; GoogleSignInClient, SignInHubActivity, "
            "play-services-auth, IdentityGetCredential, and related OAuth classes/strings were not found. "
            "The on-screen Google button is an in-app/backend login path, not Play services OAuth."
        )
    else:
        verdict = "apk_pull_failed_dumpsys_only"
        detail = (
            "Could not pull the APK; conclusion is limited to dumpsys package. "
            "Re-run if dumpsys does not list SignInHubActivity or GMS queries."
        )
    return {
        "verdict": verdict,
        "realGoogleOauthInApk": real_google_oauth,
        "playServicesAuth": play_services_auth,
        "googleSignInClient": has_client,
        "signInHubActivity": has_hub,
        "identityApi": has_identity,
        "credentialManager": has_credential_manager,
        "oauthEndpoints": has_oauth_endpoints,
        "needlesFound": sorted(needles),
        "relatedNeedlesFound": sorted(related),
        "matchingZipEntries": zip_entries[:80],
        "apkPulled": pulled,
        "detail": detail,
    }


def capture_play_installed_weplay() -> dict[str, Any]:
    folder = artifact_dir() / "apk-inspect-weplay"
    folder.mkdir(parents=True, exist_ok=True)
    pm_path = adb_shell("pm", "path", WEPLAY_PACKAGE, timeout=15)
    dumpsys_path = folder / "dumpsys-package.txt"
    adb_run_to_path("dumpsys", "package", WEPLAY_PACKAGE, dest=dumpsys_path, timeout=120)
    dumpsys = dumpsys_path.read_text(encoding="utf-8", errors="replace") if dumpsys_path.is_file() else ""
    (folder / "pm-path.txt").write_text(redact(pm_path), encoding="utf-8")
    if dumpsys:
        dumpsys_path.write_text(redact(dumpsys), encoding="utf-8")
    remote_paths = parse_pm_paths(pm_path)
    dumpsys_facts = extract_dumpsys_facts(dumpsys)
    excerpt_keys = (
        "signin",
        "sign_in",
        "google",
        "oauth",
        "credential",
        "queries",
        "permission",
        "version",
        "hub",
        "facebook",
        "customtab",
        "targetsdk",
        "minsdk",
    )
    excerpt_lines = [
        line for line in dumpsys.splitlines() if any(key in line.lower() for key in excerpt_keys)
    ]
    (folder / "dumpsys-google-auth-excerpt.txt").write_text(
        redact("\n".join(excerpt_lines[:500])),
        encoding="utf-8",
    )
    apk_scans: list[dict[str, Any]] = []
    xref: dict[str, Any] = {}
    signing: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="weplay-apk-") as tmp:
        if remote_paths:
            apk_scans = pull_and_scan_apks(remote_paths, Path(tmp))
            pulled = next((Path(scan["apkPath"]) for scan in apk_scans if scan.get("pulled")), None)
            if pulled and pulled.is_file():
                try:
                    xref = xref_apk(pulled)
                    (folder / "google-button-xref.json").write_text(json.dumps(xref, indent=2), encoding="utf-8")
                except Exception as exc:  # noqa: BLE001
                    xref = {"error": str(exc)}
                    log.warning("DEX xref failed: %s", exc)
                signing = extract_signing_fingerprints(pulled)
                (folder / "signing-cert.json").write_text(json.dumps(signing, indent=2), encoding="utf-8")
        else:
            log.warning("pm path %s returned no package: lines: %s", WEPLAY_PACKAGE, pm_path[:300])
    summary = summarize_google_auth(dumpsys_facts, apk_scans)
    payload = {
        "package": WEPLAY_PACKAGE,
        "pmPath": remote_paths,
        "dumpsys": dumpsys_facts,
        "signing": signing,
        "oauthClientIds": (xref or {}).get("oauthClientIds") or [],
        "buttonMethods": (xref or {}).get("buttonMethods") or [],
        "oauthMethods": (xref or {}).get("oauthMethods") or [],
        "xrefError": (xref or {}).get("error"),
        "apkScans": [
            {k: v for k, v in scan.items() if k != "pullLog"} | {"pullLog": (scan.get("pullLog") or "")[:240]}
            for scan in apk_scans
        ],
        "summary": summary,
    }
    (folder / "google-auth-scan.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    log.info(
        "Play-installed WePlay inspect versionName=%s versionCode=%s verdict=%s buttonMethods=%s oauthClientIds=%s pulled=%s",
        dumpsys_facts.get("versionName"),
        dumpsys_facts.get("versionCode"),
        summary.get("verdict"),
        len(payload["buttonMethods"]),
        len(payload["oauthClientIds"]),
        summary.get("apkPulled"),
    )
    return payload


def clear_device_logcat() -> None:
    try:
        subprocess.run(["adb", "logcat", "-c"], capture_output=True, text=True, timeout=15, check=False)
        log.info("Cleared device logcat before the WePlay Google-button tap")
    except Exception as exc:  # noqa: BLE001
        log.warning("logcat -c failed: %s", exc)


def dump_google_tap_logcat() -> Path | None:
    folder = artifact_dir() / "apk-inspect-weplay"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "google-tap-logcat.txt"
    try:
        result = subprocess.run(
            ["adb", "logcat", "-d", "-v", "threadtime"],
            capture_output=True,
            timeout=60,
            check=False,
        )
        text = redact((result.stdout or b"").decode("utf-8", errors="replace"))
        path.write_text(text, encoding="utf-8")
        keys = (
            "apiexception",
            "developer_error",
            "12500",
            "12501",
            "signinhub",
            "getsigninintent",
            "credentialmanager",
            "disposed",
            "activitynotfound",
            "googlesignin",
            "status{statuscode",
            "com.google.android.gms.common.api",
            "tourist",
        )
        excerpt = "\n".join(
            line for line in text.splitlines() if any(key in line.lower() for key in keys)
        )
        (folder / "google-tap-exceptions.txt").write_text(excerpt, encoding="utf-8")
        log.info("Wrote one-tap Google logcat to %s (%s bytes)", path, path.stat().st_size)
        return path
    except Exception as exc:  # noqa: BLE001
        log.warning("logcat dump failed: %s", exc)
        return None
