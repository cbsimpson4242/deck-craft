"""Conservative checks for this dependency-free prototype publication.

This is not a general secret scanner. Manual confidentiality review is required.
Run from the repository root with Python 3.
"""
from pathlib import Path
import base64
import json
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
errors = []
# Constructed patterns keep the scanner from matching its own examples.
patterns = {
    'private IPv4': r'\b(?:192\.168\.|10\.(?:\d{1,3})\.|172\.(?:1[6-9]|2\d|3[01])\.)\d',
    'private hostname': r'\b[\w.-]+\.ts' + r'\.net\b',
    'personal absolute path': r'/' + r'home/[^\s"<>]+',
    'GitHub token': r'gh[pousr]_' + r'[A-Za-z0-9]{20,}',
    'private key': r'-----BEGIN ' + r'(?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
}
paths = [p for p in ROOT.rglob('*') if p.is_file() and '.git' not in p.relative_to(ROOT).parts]
for path in paths:
    text = path.read_text()
    for name, pattern in patterns.items():
        if re.search(pattern, text):
            errors.append(f'{path.relative_to(ROOT)}: possible {name}')
    if path.suffix == '.html':
        if re.search(r'<(?:script|link|img)\b[^>]*(?:src|href)\s*=\s*[\'\"]https?://', text, re.I):
            errors.append(f'{path.name}: external resource')
        for script in re.findall(r'<script>(.*?)</script>', text, re.S):
            with tempfile.NamedTemporaryFile(suffix='.js', mode='w', dir=ROOT.parent) as tmp:
                tmp.write(script)
                tmp.flush()
                result = subprocess.run(['node', '--check', tmp.name], capture_output=True, text=True)
                if result.returncode:
                    errors.append(f'{path.name}: JavaScript syntax failure')
manifest = json.loads((ROOT / 'designs/manifest.json').read_text())
assert len(manifest) == 5
assert len({d['path'] for d in manifest}) == 5
bundle = (ROOT / 'designs/deck-craft-comparison.html').read_text()
match = re.search(r'<script id="design-data" type="application/json">(.*?)</script>', bundle, re.S)
assert match is not None, 'Missing embedded design manifest'
embedded = json.loads(match[1])
assert len(embedded) == 5
for item in embedded:
    assert base64.b64decode(item['html']) == (ROOT / item['path']).read_bytes(), item['path']
    assert 'UI CONCEPT' in base64.b64decode(item['html']).decode()
ET.parse(ROOT / 'assets/deck-craft.svg')
assert json.loads((ROOT / 't3.json').read_text())['iconPath'] == 'assets/deck-craft.svg'
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(paths)} files; 5 unique designs; exact embedded bytes; SVG, inline JS and privacy patterns checked. Manual review still required.')
