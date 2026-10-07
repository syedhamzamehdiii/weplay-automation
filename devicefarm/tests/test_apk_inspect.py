"""Unit tests for Play-installed WePlay Google-auth APK inspection (no device)."""

from __future__ import annotations

import zipfile
from pathlib import Path

from weplay_df.apk_inspect import (
    extract_dumpsys_facts,
    parse_pm_paths,
    scan_apk_file,
    select_apk_paths,
    summarize_google_auth,
)
from weplay_df.dex_xref import find_oauth_client_ids, _path_guess


def test_parse_pm_paths_handles_split_apks():
    output = (
        "package:/data/app/~~abc/com.wejoy.weplay.ar-xyz/base.apk\n"
        "package:/data/app/~~abc/com.wejoy.weplay.ar-xyz/split_config.arm64_v8a.apk\n"
    )
    paths = parse_pm_paths(output)
    assert paths[0].endswith("base.apk")
    assert paths[1].endswith("split_config.arm64_v8a.apk")
    selected = select_apk_paths(paths)
    assert selected == [paths[0]]


def test_scan_apk_detects_play_services_auth(tmp_path: Path):
    apk = tmp_path / "weplay.apk"
    with zipfile.ZipFile(apk, "w") as zf:
        zf.writestr("AndroidManifest.xml", "SignInHubActivity".encode("utf-16le"))
        zf.writestr("classes.dex", b"xxGoogleSignInClient\x00GoogleSignInOptions\x00")
        zf.writestr("play-services-auth.properties", "version=21.0.0\n")
    scan = scan_apk_file(apk)
    assert "GoogleSignInClient" in scan["needlesInDex"]
    assert "GoogleSignInOptions" in scan["needlesInDex"]
    assert "SignInHubActivity" in scan["needlesInManifest"]
    assert any("play-services-auth" in name for name in scan["matchingZipEntries"])
    summary = summarize_google_auth({"hasSignInHubActivity": False}, [scan | {"pulled": True}])
    assert summary["verdict"] == "play_google_oauth_present"
    assert summary["realGoogleOauthInApk"] is True


def test_scan_apk_without_google_oauth(tmp_path: Path):
    apk = tmp_path / "weplay.apk"
    with zipfile.ZipFile(apk, "w") as zf:
        zf.writestr("AndroidManifest.xml", b"com.wejoy.weplay.login.WejoyLargeLoginBtnView")
        zf.writestr("classes.dex", b"Tourist login is not supported\x00WejoyLargeLoginBtnView")
        zf.writestr("classes2.dex", b"com.facebook.FacebookActivity")
    scan = scan_apk_file(apk)
    assert scan["needlesInDex"] == []
    assert scan["needlesInManifest"] == []
    assert "WejoyLargeLoginBtnView" in scan["relatedNeedles"]
    summary = summarize_google_auth({"hasSignInHubActivity": False}, [scan | {"pulled": True}])
    assert summary["verdict"] == "no_play_google_oauth_in_apk"
    assert summary["realGoogleOauthInApk"] is False


def test_extract_dumpsys_facts_version_permissions_and_hub():
    dumpsys = """
Package [com.wejoy.weplay.ar] (abc):
    versionCode=60452 minSdk=24 targetSdk=35
    versionName=6.4.5
    requested permissions:
      android.permission.INTERNET
      android.permission.ACCESS_NETWORK_STATE
    queries:
      com.google.android.gms
      com.facebook.katana
    Activity #1:
      name=com.google.android.gms.auth.api.signin.internal.SignInHubActivity
"""
    facts = extract_dumpsys_facts(dumpsys)
    assert facts["versionCode"] == 60452
    assert facts["versionName"] == "6.4.5"
    assert facts["targetSdk"] == 35
    assert facts["hasInternet"] is True
    assert facts["hasSignInHubActivity"] is True
    assert facts["hasQueriesGms"] is True


def test_path_guess_and_oauth_client_ids():
    assert _path_guess({"strings": ["login_google", "SignInHubActivity"], "invokes": []}) == "oauth"
    assert (
        _path_guess({"strings": ["login_google", "Tourist login"], "invokes": []}) == "button_to_tourist"
    )
    ids = find_oauth_client_ids(b"id=1234567890-abcdef.apps.googleusercontent.com\n")
    assert ids == ["1234567890-abcdef.apps.googleusercontent.com"]
