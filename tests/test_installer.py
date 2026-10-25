"""Installer safety tests use explicit tiny fixture packages, never as app evidence."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

INSTALLER = Path(__file__).resolve().parents[1] / 'scripts/install-desktop.py'

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='deckcraft-installer-', dir=os.environ.get('TMPDIR'))
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.bundle = self.root / 'fixture-package'
        (self.bundle / 'app').mkdir(parents=True)
        shutil.copyfile(INSTALLER, self.bundle / 'install.py')
        self.runtime = self.root / 'fixture-runtime.zip'
        with zipfile.ZipFile(self.runtime, 'w') as archive:
            archive.writestr('electron', 'fixture only; never executed')
        self.version('fixture-a')

    def tearDown(self):
        self.temporary.cleanup()

    def version(self, release):
        app = self.bundle / 'app'
        files = {}
        for name, text in [('package.json', '{}'), ('native/deck-craft-audio', 'fixture only')]:
            filename = app / name
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text(text)
            files[name] = {'sha256': hashlib.sha256(filename.read_bytes()).hexdigest(), 'mode': 0o644}
        manifest = {'schema': 1, 'platform': 'linux-x64', 'version': '0.2.0', 'release': release,
                    'installerSha256': hashlib.sha256((self.bundle / 'install.py').read_bytes()).hexdigest(),
                    'runtime': {'version': '45.0.0', 'url': 'https://github.com/electron/electron/releases/download/v45.0.0/electron-v45.0.0-linux-x64.zip',
                                'sha256': hashlib.sha256(self.runtime.read_bytes()).hexdigest()}, 'files': files}
        (self.bundle / 'manifest.json').write_text(json.dumps(manifest))
        return manifest

    def run_installer(self, *args):
        env = {**os.environ, 'HOME': str(self.home)}
        return subprocess.run([sys.executable, str(self.bundle / 'install.py'), '--runtime-zip', str(self.runtime), *args], env=env, text=True, capture_output=True)

    def test_user_local_install_upgrade_rollback_and_idempotence(self):
        for release in ['fixture-a', 'fixture-a', 'fixture-b']:
            self.version(release)
            result = self.run_installer()
            self.assertEqual(result.returncode, 0, result.stderr)
        base = self.home / '.local/share/deck-craft'
        self.assertEqual((base / 'current').resolve().name, 'fixture-b')
        self.assertTrue((self.home / '.local/bin/deck-craft').stat().st_mode & 0o111)
        self.assertIn('Terminal=false', (self.home / '.local/share/applications/deck-craft.desktop').read_text())
        result = self.run_installer('--rollback')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((base / 'current').resolve().name, 'fixture-a')
        self.assertFalse((self.home / '.config').exists())

    def test_unrelated_launcher_is_not_overwritten(self):
        launcher = self.home / '.local/bin/deck-craft'
        launcher.parent.mkdir(parents=True)
        launcher.write_text('unrelated user file')
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(launcher.read_text(), 'unrelated user file')

    def test_tampered_payload_and_runtime_do_not_replace_active_release(self):
        self.assertEqual(self.run_installer().returncode, 0)
        base = self.home / '.local/share/deck-craft'
        self.version('fixture-b')
        (self.bundle / 'app/package.json').write_text('tampered')
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((base / 'current').resolve().name, 'fixture-a')
        self.version('fixture-b')
        self.runtime.write_bytes(b'changed runtime')
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((base / 'current').resolve().name, 'fixture-a')

    def test_unsafe_manifest_and_symlink_release_directory_are_refused(self):
        manifest = self.version('fixture-a')
        manifest['files']['../../outside'] = manifest['files']['package.json']
        (self.bundle / 'manifest.json').write_text(json.dumps(manifest))
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse((self.root / 'outside').exists())
        self.version('fixture-a')
        base = self.home / '.local/share/deck-craft'
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        (base / 'releases').symlink_to(elsewhere)
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_unsafe_zip_entries_never_escape_staging(self):
        with zipfile.ZipFile(self.runtime, 'w') as archive:
            archive.writestr('../outside', 'must not escape')
        self.version('fixture-b')
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse((self.home / '.local/share/deck-craft/releases/outside').exists())

if __name__ == '__main__':
    unittest.main()
