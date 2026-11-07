#!/usr/bin/env python3
"""Build a standalone native preview. Never install or switch the normal release."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent

def sha256(p):
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""): h.update(b)
    return h.hexdigest()

def build(allow_dirty=False):
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        raise ValueError("The portable preview targets Linux x86-64")
    subprocess.run(["node", str(ROOT / "scripts/desktop-package.mjs"), *(["--allow-dirty"] if allow_dirty else [])], cwd=ROOT, check=True)
    version = json.loads((ROOT / "package.json").read_text())["version"]
    package = ROOT / "release" / ("deck-craft-" + version + "-linux-x64")
    m = json.loads((package / "manifest.json").read_text())
    # Verify the reviewed allowlisted application payload before copying it.
    for name, item in m["files"].items():
        f = package / "app" / name
        if f.is_symlink() or not f.resolve().is_relative_to((package / "app").resolve()) or sha256(f) != item["sha256"]:
            raise ValueError("Invalid preview payload")
    spec = importlib.util.spec_from_file_location("deckcraft_installer", ROOT / "scripts/install-desktop.py")
    installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
    runtime = m["runtime"]
    # Reuse only an exact SHA-256 match for the pinned official Electron ZIP.
    filename = "electron-v" + runtime["version"] + "-linux-x64.zip"
    candidates = list((Path.home() / ".cache/electron").glob("*/" + filename))
    zipfile = next((p for p in candidates if p.is_file() and sha256(p) == runtime["sha256"]), None)
    if zipfile is None:
        zipfile = ROOT / "release" / filename
        if not zipfile.is_file() or sha256(zipfile) != runtime["sha256"]:
            installer.download(runtime, zipfile)
    folder = ROOT / "release" / ("deck-craft-preview-" + m["release"] + "-linux-x64")
    if folder.is_symlink(): raise ValueError("Invalid preview output")
    if folder.exists(): shutil.rmtree(folder)
    folder.mkdir()
    shutil.copytree(package / "app", folder / "app")
    shutil.copyfile(ROOT / "desktop/preview.cjs", folder / "app/desktop/preview.cjs")
    (folder / "app/preview.json").write_text(json.dumps({"release": m["release"]}) + "\n")
    installer.extract_runtime(zipfile, folder / "runtime")
    launcher = folder / "start-preview"
    launcher.write_text('''#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  echo "Run Deck Craft Preview as your desktop user, without sudo." >&2
  exit 1
fi
preview_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$preview_root/runtime/electron" --class=deck-craft-preview "$preview_root/app/desktop/preview.cjs" "$@"
''')
    launcher.chmod(0o755)
    (folder / "README.txt").write_text('''Deck Craft — standalone native audio preview (Linux x86-64)

Extract this folder and run ./start-preview as your normal desktop user.
No installer, sudo, system changes, menu registration or runtime download is needed.
The normal Deck Craft release and its saved library are untouched.
Preview library/settings are separate under the application config directory:
  deck-craft-preview/<release>/ (normally ~/.config/deck-craft-preview/<release>/)
Your selected music stays in place. No music is copied into this bundle or uploaded.
The release identifier appears in the preview window title.

Test on your Linux desktop with its normal output selected:
1. Start with a comfortable system volume. Add two of your own tracks.
2. Existing tracks: select rows and choose Analyze BPM / artwork as needed.
3. Select a row, then click a deck LOAD button (or drag it onto the deck).
4. Press Play. Toggle PITCH LOCK and move TEMPO; lock should preserve pitch.
5. Load a second track with a similar BPM. Choose MASTER on A and SYNC on B.
   Sync requires reliable detected grids and a rate within the +/-8% range.
   Independent transport changes clear Sync; click Sync again when needed.
6. Switch layouts during playback, pause/seek, then close and reopen.
   The preview should restore paused, retaining its own library/settings.

Current limits: constant grids from the first 60 seconds, 60–200 BPM;
no variable-tempo/downbeat/key analysis; basic pitch lock can produce artifacts.
Audio output follows your desktop default. Routing/EQ/FX remain unimplemented.
This is a development snapshot, not acceptance of physical output or latency.

Quit the preview before moving/deleting this folder. Deleting the extracted
folder removes the preview runtime; separate preview settings remain in config.
No source music or normal Deck Craft installation is removed.
''')
    files = {str(p.relative_to(folder)): {"sha256": sha256(p), "mode": p.stat().st_mode & 0o777} for p in sorted(folder.rglob("*")) if p.is_file()}
    (folder / "preview-manifest.json").write_text(json.dumps({"schema": 1, "release": m["release"], "developmentSnapshot": m["developmentSnapshot"], "runtime": runtime, "files": files}, indent=2) + "\n")
    archive = folder.parent / (folder.name + ".tar.gz")
    def public_member(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info
    with tarfile.open(archive, "w:gz") as t: t.add(folder, arcname=folder.name, filter=public_member)
    checksum = sha256(archive)
    archive.with_suffix(archive.suffix + ".sha256").write_text(checksum + "  " + archive.name + "\n")
    print(json.dumps({"archive": str(archive), "sha256": checksum, "bytes": archive.stat().st_size, "release": m["release"]}))
    return archive

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-dirty", action="store_true", help="Create a development snapshot from reviewed uncommitted source")
    build(parser.parse_args().allow_dirty)
