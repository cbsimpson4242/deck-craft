#!/usr/bin/env python3
"""Generate the minimum-text-size section of src/themes.css from the cascade (approved, app, native, canvas).
Every px font-size (also inside the `font:` shorthand) is re-emitted in the same order as max(10px, N) so the
cascade is unchanged except that nothing renders below 10px."""
import re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
FILES = ['approved.css', 'app.css', 'native.css', 'canvas.css']
MIN = 10
MARK = '/* ---- Minimum text size (generated; see scripts/min-text.py) ---- */'

def strip_comments(s): return re.sub(r'/\*.*?\*/', '', s, flags=re.S)

def parse(css):
    """Yield (at_rule_prefix or None, selector, body) for style rules, descending into @media/@container/@supports."""
    out = []
    def block(text, ctx):
        i = 0; n = len(text)
        while i < n:
            j = text.find('{', i)
            if j < 0: break
            head = text[i:j].strip()
            depth = 1; k = j + 1
            while k < n and depth:
                if text[k] == '{': depth += 1
                elif text[k] == '}': depth -= 1
                k += 1
            body = text[j+1:k-1]
            if head.startswith('@media') or head.startswith('@container') or head.startswith('@supports'):
                block(body, ctx + [head])
            elif head.startswith('@'):
                pass  # keyframes, font-face, etc.
            elif head:
                out.append((tuple(ctx), head, body))
            i = k
    block(strip_comments(css), [])
    return out

SIZE = re.compile(r'(?:^|;)\s*font-size\s*:\s*([\d.]+)px\s*(!important)?\s*(?=;|$)')
SHORT = re.compile(r'(?:^|;)\s*font\s*:\s*(?:[a-z-]+\s+)*?([\d.]+)px(?:/[\d.a-z%]+)?\s+[^;]*?(!important)?\s*(?=;|$)')
def sizes(body):
    found = []
    for m in SIZE.finditer(body): found.append((float(m.group(1)), bool(m.group(2))))
    for m in SHORT.finditer(body): found.append((float(m.group(1)), 'important' in m.group(0)))
    return found

def generate():
    lines = [MARK]
    count = 0
    rules = []
    for f in FILES:
        rules += parse((ROOT / 'src' / f).read_text())
    buf = []; ctx_prev = None
    def flush():
        if not buf: return
        text = '\n'.join(buf)
        for head in reversed(ctx_prev or ()): text = head + '{\n' + text + '\n}'
        lines.append(text)
    for ctx, sel, body in rules:
        found = sizes(body)
        if not found: continue
        n, imp = found[-1]
        if ctx != ctx_prev:
            flush(); buf.clear(); ctx_prev = ctx
        sel = ' '.join(sel.split())
        buf.append(f'{sel}{{font-size:max({MIN}px,{n:g}px){"!important" if imp else ""}}}')
        count += 1
    flush()
    return '\n'.join(lines) + '\n', count

if __name__ == '__main__':
    text, count = generate()
    themes = ROOT / 'src/themes.css'
    base = themes.read_text()
    if MARK in base: base = base[:base.index(MARK)].rstrip('\n') + '\n'
    if '--apply' in sys.argv:
        themes.write_text(base + text)
    print('rules emitted:', count, 'bytes:', len(text))
