"""Write, or check, the Unicode tables core and plaid-ui read, by one Unicode
version (core's Java and the assistant's Python, 15.0):

- core's case folding table document names are compared by: every code
  point whose Python `str.casefold` differs from itself, with what it folds
  to. Names are one name when NFC(casefold(NFC(name))) agree, as the
  assistant compares them (Luke, 2026-10-16, ruling 5).
- the names of the combining marks, which plaid-ui's `namesMark` reads a
  `\\N{...}` escape by, as core reads it with Java's names (REV8-CORE-6).

    python scripts/casefold_table.py          # rewrite the tables
    python scripts/casefold_table.py --check  # exit 1 if any differs

Run from plaid-core with the assistant's Python, whose Unicode version the
tables then follow.
"""
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORE = HERE.parent / 'resources' / 'casefold.txt'
MARKS = HERE.parent.parent / 'plaid-ui' / 'src' / 'domain' / 'markNames.js'


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


def mark_names():
    return [unicodedata.name(chr(cp)) for cp in range(0x110000)
            if unicodedata.category(chr(cp)) in ('Mn', 'Mc', 'Me')]


def core_text():
    head = (f'# Python str.casefold, Unicode {unicodedata.unidata_version}: a code point, then what it folds to.\n'
            '# Written by scripts/casefold_table.py, do not edit.\n')
    return head + '\n'.join(lines()) + '\n'


def marks_text():
    return ('// The names of the combining marks (Mn, Mc, Me) in Unicode ' + unicodedata.unidata_version + ', one a line, as\n'
            '// core\'s Java names them in a pattern\'s \\N{...}. Written by\n'
            '// plaid-core/scripts/casefold_table.py, do not edit.\n'
            'export const MARK_NAMES = `\n' + '\n'.join(mark_names()) + '\n`;\n')


def main():
    want = {CORE: core_text(), MARKS: marks_text()}
    if '--check' in sys.argv:
        bad = [str(p) for p, t in want.items() if not p.exists() or p.read_text(encoding='utf-8') != t]
        if bad:
            print('out of date:', *bad)
            sys.exit(1)
        print('every table matches this Python')
        return
    for p, t in want.items():
        p.write_text(t, encoding='utf-8')
        print('wrote', p)


if __name__ == '__main__':
    main()
