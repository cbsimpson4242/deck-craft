"""Real Electron/native integration with private display, D-Bus and XDG state.

The default suite injects only the OS file-selection result. Set
DECKCRAFT_TEST_NATIVE_DIALOG=1 to additionally automate the real GTK chooser.
No mount, user service, default profile, or physical audio device is modified.
"""
import os
from pathlib import Path
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if not os.environ.get('ALSA_CONFIG_PATH') or not os.environ.get('PULSE_SERVER', '').startswith('unix:'):
    raise SystemExit('Configure the isolated native integration null sink first; physical output is never selected implicitly.')
base = Path(os.environ.get('DECKCRAFT_EVIDENCE_DIR', os.environ.get('TMPDIR', tempfile.gettempdir())))
base.mkdir(parents=True, exist_ok=True)
directory = Path(tempfile.mkdtemp(prefix='deckcraft-desktop-', dir=base))
runtime = Path(tempfile.mkdtemp(prefix='dc-run-', dir=os.environ.get('TMPDIR')))
for name in ['cache', 'config', 'data']:
    (directory / name).mkdir(mode=0o700)
services = []
keys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'ALSA_CONFIG_PATH', 'ALSA_PLUGIN_DIR', 'PULSE_SERVER', 'PULSE_RUNTIME_PATH', 'DECKCRAFT_TEST_ENGINE', 'DECKCRAFT_TEST_NATIVE_DIALOG']
base_env = {key: os.environ[key] for key in keys if key in os.environ}


def stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)


with open(directory / 'desktop-runtime.log', 'wb') as log:
    display = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], env=base_env, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
    services.append(display)
    try:
        assert display.stdout is not None
        display_name = ':' + display.stdout.readline().decode().strip()
        if display_name == ':':
            raise RuntimeError('Private Xvfb did not start')
        for phase in ['first', 'restore']:
            env = {**base_env, 'DISPLAY': display_name, 'DECKCRAFT_TEST_DIR': str(directory), 'DECKCRAFT_TEST_PHASE': phase,
                   'XDG_RUNTIME_DIR': str(runtime), 'XDG_CACHE_HOME': str(directory / 'cache'),
                   'XDG_CONFIG_HOME': str(directory / 'config'), 'XDG_DATA_HOME': str(directory / 'data')}
            bus = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--nopidfile', '--address=unix:path=' + str(runtime / ('bus-' + phase)), '--print-address=1'], env=env, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            services.append(bus)
            assert bus.stdout is not None
            address = bus.stdout.readline().decode().strip()
            if not address:
                raise RuntimeError('Private D-Bus did not start')
            env['DBUS_SESSION_BUS_ADDRESS'] = address
            app = subprocess.Popen([str(ROOT / 'node_modules/electron/dist/electron'), str(ROOT / 'tests/desktop-harness.cjs'), '--disable-gpu', '--xdg-portal-required-version=999'], env=env, stdout=log, stderr=log, start_new_session=True)
            services.append(app)
            try:
                code = app.wait(timeout=45)
            except subprocess.TimeoutExpired:
                raise RuntimeError('Electron did not close cleanly; evidence: ' + str(directory))
            stop(bus)
            if code != 0:
                raise RuntimeError('Desktop phase ' + phase + ' failed (' + str(code) + '): ' + (directory / 'desktop-runtime.log').read_text()[-8000:])
            print((directory / ('desktop-' + phase + '.json')).read_text(), flush=True)
        print('Native desktop evidence: ' + str(directory), flush=True)
    finally:
        for service in reversed(services):
            stop(service)
