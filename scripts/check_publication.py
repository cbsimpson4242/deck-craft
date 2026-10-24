"""Conservative checks for this dependency-free prototype publication.

This is not a general secret scanner. Manual confidentiality review is required.
Run from the repository root with Python 3.
"""
from pathlib import Path
import base64
import hashlib
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
rounds = [
    ('designs/manifest.json', 'designs/deck-craft-comparison.html', 'UI CONCEPT', None),
    ('designs/round-two/manifest.json', 'designs/round-two/deck-craft-studies-02.html', 'VISUAL PROTOTYPE', None),
    ('designs/round-three/manifest.json', 'designs/round-three/deck-craft-refinements-03.html', 'VISUAL PROTOTYPE', 'designs/round-three/references.json'),
]
checked_designs = 0
checked_references = 0
for manifest_path, bundle_path, label, reference_path in rounds:
    manifest = json.loads((ROOT / manifest_path).read_text())
    assert len(manifest) == 5
    assert len({d['path'] for d in manifest}) == 5
    bundle = (ROOT / bundle_path).read_text()
    match = re.search(r'<script id="design-data" type="application/json">(.*?)</script>', bundle, re.S)
    assert match is not None, 'Missing embedded design manifest'
    embedded = json.loads(match[1])
    references = json.loads((ROOT / reference_path).read_text()) if reference_path else []
    if reference_path:
        assert len(references) == 2
        assert all(d['role'] == 'reference' for d in references)
        assert all(d['role'] == 'new' for d in manifest)
    assert len(embedded) == len(manifest) + len(references)
    assert [d['path'] for d in embedded] == [d['path'] for d in manifest + references]
    for item in embedded:
        decoded = base64.b64decode(item['html'])
        assert decoded == (ROOT / item['path']).read_bytes(), item['path']
        assert label in decoded.decode()
        if 'sha256' in item:
            assert hashlib.sha256(decoded).hexdigest() == item['sha256']
    for ref in references:
        assert hashlib.sha256((ROOT / ref['path']).read_bytes()).hexdigest() == ref['sha256']
    checked_designs += len(manifest)
    checked_references += len(references)
ET.parse(ROOT / 'assets/deck-craft.svg')
assert json.loads((ROOT / 't3.json').read_text())['iconPath'] == 'assets/deck-craft.svg'
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(paths)} files; {checked_designs} designs across {len(rounds)} rounds plus {checked_references} unchanged references; exact embedded bytes; SVG, inline JS and privacy patterns checked. Manual review still required.')
