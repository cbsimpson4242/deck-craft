#!/usr/bin/env python3
"""Verified user-local installer. No sudo, system services or music-file writes."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import tempfile
import urllib.parse
import urllib.request
import uuid
import zipfile

MARKER = 'deck-craft-installer-v1\n'

def sha256(filename):
    h = hashlib.sha256()
    with open(filename, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def relative(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name:
        raise ValueError('Unsafe package path')
    return Path(*p.parts)

def atomic_text(filename, text, mode=0o600):
    temporary = filename.with_name('.' + filename.name + '-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)

def point(base, release):
    if not release or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-' for c in release):
        raise ValueError('Invalid release identifier')
    target = base / 'releases' / release
    if target.is_symlink() or not target.is_dir():
        raise ValueError('Release is unavailable')
    current = base / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('Refusing to replace an unmanaged current path')
    temporary = base / ('.current-' + uuid.uuid4().hex)
    temporary.symlink_to(Path('releases') / release)
    os.replace(temporary, current)

def download(runtime, destination):
    parsed = urllib.parse.urlparse(runtime['url'])
    expected = f"https://github.com/electron/electron/releases/download/v{runtime['version']}/electron-v{runtime['version']}-linux-x64.zip"
    if runtime['url'] != expected or parsed.scheme != 'https':
        raise ValueError('Unexpected runtime origin')
    class Redirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            u = urllib.parse.urlparse(newurl)
            if u.scheme != 'https' or not (u.hostname == 'github.com' or (u.hostname or '').endswith('.githubusercontent.com')):
                raise ValueError('Unexpected runtime redirect')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        count = 0
        opener = urllib.request.build_opener(Redirects())
        with opener.open(runtime['url'], timeout=45) as response, open(temporary, 'xb') as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                count += len(chunk)
                if count > 512 * 1024 * 1024:
                    raise ValueError('Runtime download is too large')
                output.write(chunk)
        if sha256(temporary) != runtime['sha256']:
            raise ValueError('Runtime checksum mismatch')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)

def extract_runtime(archive, target):
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if sum(i.file_size for i in entries) > 2 * 1024**3:
            raise ValueError('Runtime archive is too large')
        for info in entries:
            rel = relative(info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('Runtime contains a non-regular entry')
            out = target / rel
            if info.is_dir():
                out.mkdir(parents=True, exist_ok=True)
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(out, 'xb') as dst:
                shutil.copyfileobj(src, dst)
            out.chmod((mode & 0o777) or 0o644)


def install(args):
    if os.geteuid() == 0:
        raise ValueError('Run as your desktop user, not sudo/root')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise ValueError('This preview is for Linux x86-64 only')
    home = Path.home().resolve()
    base = home / '.local/share/deck-craft'
    launcher = home / '.local/bin/deck-craft'
    desktop = home / '.local/share/applications/deck-craft.desktop'
    for p in (base, launcher, desktop):
        if not p.resolve().is_relative_to(home):
            raise ValueError('Install paths must remain inside your home directory')
    if base.is_symlink():
        raise ValueError('Refusing a symlink installation root')
    if base.exists() and (not (base / '.managed').is_file() or (base / '.managed').read_text() != MARKER):
        raise ValueError('Existing installation root is unmanaged; no files changed')
    for file in (launcher, desktop):
        if file.is_symlink() or (file.exists() and 'deck-craft-managed' not in file.read_text()):
            raise ValueError('Refusing to overwrite an unrelated launcher')
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_text(base / '.managed', MARKER)
    lock = os.open(base / '.install.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as lockfile:
        fcntl.flock(lockfile, fcntl.LOCK_EX)
        statefile = base / 'install-state.json'
        state = json.loads(statefile.read_text()) if statefile.exists() else {'current': None, 'previous': None}
        if args.rollback:
            if not state.get('previous'):
                raise ValueError('No previous release is available; no active release changed')
            point(base, state['previous'])
            state = {'current': state['previous'], 'previous': state.get('current')}
            atomic_text(statefile, json.dumps(state))
            print('Rolled back. Restart Deck Craft to use the previous release. Music and preferences are unchanged.')
            return
        bundle = Path(__file__).resolve().parent
        manifest = json.loads((bundle / 'manifest.json').read_text())
        if manifest.get('schema') != 1 or manifest.get('platform') != 'linux-x64':
            raise ValueError('Unsupported package manifest')
        if sha256(Path(__file__)) != manifest['installerSha256']:
            raise ValueError('Installer checksum mismatch')
        payload = bundle / 'app'
        for name, item in manifest['files'].items():
            source = payload / relative(name)
            if source.is_symlink() or not source.resolve().is_relative_to(payload.resolve()) or not source.is_file() or sha256(source) != item['sha256']:
                raise ValueError('Package content checksum mismatch: ' + name)
        release = manifest['release']
        if not release or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-' for c in release):
            raise ValueError('Invalid release identifier')
        runtime = manifest['runtime']
        if not re.fullmatch(r'[0-9a-f]{64}', runtime.get('sha256', '')) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', runtime.get('version', '')):
            raise ValueError('Invalid pinned runtime identity')
        cache = base / 'downloads'
        if cache.is_symlink():
            raise ValueError('Refusing a symlink runtime cache')
        cache.mkdir(exist_ok=True, mode=0o700)
        archive = Path(args.runtime_zip).resolve() if args.runtime_zip else cache / (runtime['sha256'] + '.zip')
        if archive.is_symlink():
            raise ValueError('Runtime archive may not be a symlink')
        if not archive.exists():
            if args.runtime_zip:
                raise ValueError('Specified runtime archive does not exist')
            print('Downloading pinned Electron runtime from its official GitHub release…', flush=True)
            download(runtime, archive)
        if sha256(archive) != runtime['sha256']:
            raise ValueError('Runtime checksum mismatch; current release unchanged')
        releases = base / 'releases'
        if releases.is_symlink():
            raise ValueError('Refusing a symlink release directory')
        releases.mkdir(exist_ok=True, mode=0o700)
        destination = releases / release
        if not destination.exists():
            stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=releases))
            try:
                extract_runtime(archive, stage)
                (stage / 'electron').rename(stage / 'deck-craft')
                for name, item in manifest['files'].items():
                    source = payload / relative(name)
                    out = stage / 'resources/app' / relative(name)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, out)
                    out.chmod(item['mode'] & 0o777)
                (stage / 'deck-craft').chmod(0o755)
                atomic_text(stage / 'release-manifest.json', json.dumps(manifest))
                stage.rename(destination)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        elif destination.is_symlink() or json.loads((destination / 'release-manifest.json').read_text()) != manifest:
            raise ValueError('Existing release does not match this package')
        launcher.parent.mkdir(parents=True, exist_ok=True)
        desktop.parent.mkdir(parents=True, exist_ok=True)
        launch_text = '#!/bin/sh\n# deck-craft-managed\nexec "$HOME/.local/share/deck-craft/current/deck-craft" "$@"\n'
        executable = str(launcher).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
        desktop_text = '\n'.join(['[Desktop Entry]', '# deck-craft-managed', 'Version=1.0', 'Type=Application', 'Name=Deck Craft', 'Comment=Open-source DJ audio foundation', f'Exec="{executable}"', 'Icon=' + str(base / 'current/resources/app/assets/deck-craft.svg'), 'Terminal=false', 'Categories=AudioVideo;Audio;Mixer;', 'StartupWMClass=deck-craft', ''])
        atomic_text(launcher, launch_text, 0o755)
        atomic_text(desktop, desktop_text, 0o644)
        atomic_text(base / 'installer.py', Path(__file__).read_text(), 0o700)
        point(base, release)
        previous = state.get('current') if state.get('current') != release else state.get('previous')
        atomic_text(statefile, json.dumps({'current': release, 'previous': previous}))
        print('Installed Deck Craft ' + manifest['version'] + ' for this user only.')
        print('Launch Deck Craft from the application menu, or run ~/.local/bin/deck-craft.')
        print('Rollback: python3 ~/.local/share/deck-craft/installer.py --rollback')
        print('Restart an already running copy to use this release. No music or preferences were changed.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-zip', help='Use the exact pinned runtime ZIP offline')
    parser.add_argument('--rollback', action='store_true', help='Restore the preceding installed release')
    try:
        install(parser.parse_args())
    except Exception as error:
        parser.exit(1, 'Installation stopped: ' + str(error) + '\n')
