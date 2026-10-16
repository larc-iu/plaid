"""Write, or check, the case folding table core and plaid-ui compare document
names by: every code point whose Python `str.casefold` differs from itself,
with what it folds to. Names are one name when NFC(casefold(NFC(name))) agree,
as the assistant compares them (Luke, 2026-10-16, ruling 5).

    python scripts/casefold_table.py          # rewrite both tables
    python scripts/casefold_table.py --check  # exit 1 if either differs

Run from plaid-core with the assistant's Python, whose Unicode version the
tables then follow.
"""
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORE = HERE.parent / 'resources' / 'casefold.txt'
UI = HERE.parent.parent / 'plaid-ui' / 'src' / 'lib' / 'caseFoldTable.js'


def lines():
    out = []
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        c = chr(cp)
        f = c.casefold()
        if f != c:
            out.append(f'{cp:X} ' + ' '.join(f'{ord(x):X}' for x in f))
    return out


def core_text():
    head = (f'# Python str.casefold, Unicode {unicodedata.unidata_version}: a code point, then what it folds to.\n'
            '# Written by scripts/casefold_table.py, do not edit.\n')
    return head + '\n'.join(lines()) + '\n'


def ui_text():
    return ('// Python str.casefold, Unicode ' + unicodedata.unidata_version + ', as core folds document names\n'
            '// (plaid-core/resources/casefold.txt): each line a code point, then what it\n'
            '// folds to, in hex. Written by plaid-core/scripts/casefold_table.py, do not edit.\n'
            'export const CASE_FOLD_TABLE = `\n' + '\n'.join(lines()) + '\n`;\n')


def main():
    want = {CORE: core_text(), UI: ui_text()}
    if '--check' in sys.argv:
        bad = [str(p) for p, t in want.items() if not p.exists() or p.read_text(encoding='utf-8') != t]
        if bad:
            print('out of date:', *bad)
            sys.exit(1)
        print('both tables match str.casefold')
        return
    for p, t in want.items():
        p.write_text(t, encoding='utf-8')
        print('wrote', p)


if __name__ == '__main__':
    main()
