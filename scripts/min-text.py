#!/usr/bin/env python3
"""Fail if any stylesheet sets a px font size below the 10px minimum (also inside the `font:` shorthand).
Usage: python3 scripts/min-text.py   (exit 0 when every size is >= 10px)"""
import re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
FILES = ['app.css', 'native.css', 'canvas.css', 'themes.css']
MIN = 10
SIZE = re.compile(r'font-size\s*:\s*([\d.]+)px')
SHORT = re.compile(r'font\s*:\s*(?:[a-z0-9-]+\s+)*?([\d.]+)px(?=[/\s])')
bad = []
for name in FILES:
    text = re.sub(r'/\*.*?\*/', '', (ROOT / 'src' / name).read_text(), flags=re.S)
    for rx in (SIZE, SHORT):
        for m in rx.finditer(text):
            if float(m.group(1)) < MIN:
                line = text[:m.start()].count('\n') + 1
                bad.append(f'{name}:{line}: {m.group(0)}')
if bad:
    print('Text below 10px:'); print('\n'.join(bad)); sys.exit(1)
print('All font sizes are at least 10px.')
