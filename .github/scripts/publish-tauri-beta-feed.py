"""Publish only the isolated Tauri beta feed after checking public release assets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

OWNER = "juejin-cn/juejin-usage"
FEED = "releases/tauri-beta/latest.json"
API = f"https://gitee.com/api/v5/repos/{OWNER}/contents/"


def request(url, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/json", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        # Never log request URLs, bodies, or exception text containing credentials.
        return error.code, b""
    except urllib.error.URLError:
        raise SystemExit("Network request failed") from None


def checked_json(url):
    status, body = request(url)
    if status != 200:
        raise SystemExit(f"Read failed: HTTP {status}")
    return json.loads(body)


def stable_files():
    entries = checked_json(API + "releases?ref=main")
    return {entry["path"]: entry["sha"] for entry in entries if entry["type"] == "file"}


def publish():
    raw = Path(FEED).read_bytes()
    manifest = json.loads(raw)
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+-(?:next|beta)\.\d+", version):
        raise SystemExit("Only explicit prerelease versions are allowed")
    tag = f"tauri-v{version}"
    release = checked_json(f"https://api.github.com/repos/{OWNER}/releases/tags/{tag}")
    if release["draft"] or not release["prerelease"]:
        raise SystemExit("A published GitHub prerelease is required")
    assets = {asset["browser_download_url"]: asset for asset in release["assets"]}
    platforms = manifest["platforms"]
    if set(platforms) != {"darwin-aarch64", "darwin-x86_64", "windows-x86_64"}:
        raise SystemExit("Both macOS architectures and Windows x64 are required")
    for platform, item in platforms.items():
        url = item["url"]
        asset = assets.get(url)
        if not asset or url + ".sig" not in assets:
            raise SystemExit("Updater URL or signature is missing from this release")
        status, archive = request(url)
        if status != 200 or len(archive) != asset["size"]:
            raise SystemExit("Public updater download failed")
        digest = "sha256:" + hashlib.sha256(archive).hexdigest()
        if digest != asset.get("digest"):
            raise SystemExit("Public updater checksum mismatch")
        status, signature = request(url + ".sig")
        if status != 200 or signature.decode().strip() != item["signature"]:
            raise SystemExit("Public updater signature mismatch")
        print(f"Verified {platform}: {digest}")

    before = stable_files()
    status, existing = request(API + FEED + "?ref=main")
    # Gitee also represents a missing nested path as HTTP 200 with [].
    if status == 200 and json.loads(existing) == []:
        status = 404
    if status not in (200, 404):
        raise SystemExit(f"Beta feed lookup failed: HTTP {status}")
    payload = {"access_token": os.environ["GITEE_TOKEN"], "branch": "main",
               "content": base64.b64encode(raw).decode(), "message": f"release: Tauri beta {version}"}
    if status == 200:
        old = json.loads(existing)
        if not isinstance(old, dict) or old.get("type") != "file" or old.get("path") != FEED:
            raise SystemExit("Unexpected beta feed lookup response")
        if base64.b64decode(old["content"]) == raw:
            print("Beta feed already matches")
            return
        payload["sha"] = old["sha"]
    method = "PUT" if status == 200 else "POST"
    status, _ = request(API + FEED, method, payload)
    if status not in (200, 201):
        raise SystemExit(f"Beta feed publish failed: HTTP {status}")
    published = checked_json(API + FEED + "?ref=main")
    if base64.b64decode(published["content"]) != raw:
        raise SystemExit("Beta feed readback mismatch")
    if stable_files() != before:
        raise SystemExit("Existing release metadata changed during publication; investigate")
    print(f"Published {FEED} = {version}; existing Electron manifests unchanged")


if __name__ == "__main__":
    publish()
