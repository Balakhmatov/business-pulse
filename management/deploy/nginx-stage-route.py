#!/usr/bin/env python3
"""Insert an isolated route into the existing stage HTTPS vhost only."""
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

START = '# BEGIN BUSINESS PULSE STAGE'
END = '# END BUSINESS PULSE STAGE'

def closing_brace(source, opening):
    depth, quote, escaped, comment = 0, None, False, False
    for i in range(opening, len(source)):
        c = source[i]
        if comment:
            if c == '\n': comment = False
            continue
        if escaped:
            escaped = False
            continue
        if c == '\\':
            escaped = True
            continue
        if quote:
            if c == quote: quote = None
            continue
        if c in ('"', "'"):
            quote = c
            continue
        if c == '#':
            comment = True
            continue
        if c == '{': depth += 1
        if c == '}':
            depth -= 1
            if depth == 0: return i
    raise ValueError('Unbalanced Nginx server block; no changes made')

def add_stage_route(source, snippet):
    matches = []
    for match in re.finditer(r'(?m)^\s*server\s*\{', source):
        opening = source.index('{', match.start(), match.end())
        closing = closing_brace(source, opening)
        block = source[opening:closing]
        clean = re.sub(r'(?m)#.*$', '', block)
        names = [name for values in re.findall(r'\bserver_name\s+([^;]+);', clean) for name in values.split()]
        if 'stage.cityai.site' in names and re.search(r'\blisten\s+[^;]*\b443\b[^;]*\bssl\b', clean):
            matches.append((opening, closing))
    if len(matches) != 1:
        raise ValueError('Expected one HTTPS stage.cityai.site server; no changes made')
    opening, closing = matches[0]
    block = source[opening:closing]
    addition = '\n' + '\n'.join('    '+line if line else '' for line in (START+'\n'+snippet.rstrip()+'\n'+END).splitlines())+'\n'
    if START in source or END in source:
        if source.count(START) == 1 and source.count(END) == 1 and addition in block:
            return source
        raise ValueError('Managed stage route differs; inspect it instead of overwriting')
    if re.search(r'\blocation\s+[^\n{]*?/businesspulse(?:/|\s|\{)', block):
        raise ValueError('A /businesspulse route already exists on stage; no changes made')
    return source[:closing]+addition+source[closing:]

def main():
    config, snippet = map(Path, sys.argv[1:])
    old = config.read_text()
    new = add_stage_route(old, snippet.read_text())
    if old == new:
        print('Stage route already installed')
        return
    fd, temp = tempfile.mkstemp(prefix='.bp-stage-', dir=config.parent)
    try:
        with os.fdopen(fd, 'w') as stream: stream.write(new)
        shutil.copystat(config, temp)
        os.chown(temp, config.stat().st_uid, config.stat().st_gid)
        os.replace(temp, config)
    finally:
        if os.path.exists(temp): os.unlink(temp)
    print('Stage route added; other vhosts unchanged')

if __name__ == '__main__':
    try: main()
    except ValueError as error: raise SystemExit(str(error))
