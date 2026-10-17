"""Write, or check, the Unicode tables core and plaid-ui share, so both read
one Unicode version (core's Java and the assistant's Python, 15.0):

- the case folding table document names are compared by: every code point
  whose Python `str.casefold` differs from itself, with what it folds to.
  Names are one name when NFC(casefold(NFC(name))) agree, as the assistant
  compares them (Luke, 2026-10-16, ruling 5). plaid-ui also gets the code
  points this Unicode version leaves unassigned, which its fold leaves as
  they are, as core's NFC does, where the browser's own NFC may know them
  (REV8-CORE-5).
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
UI = HERE.parent.parent / 'plaid-ui' / 'src' / 'lib' / 'caseFoldTable.js'
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


def unassigned():
    """Ranges `lo-hi` (hex) of the code points this Unicode version leaves
    unassigned, surrogates aside."""
    out = []
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF or unicodedata.category(chr(cp)) != 'Cn':
            continue
        if out and out[-1][1] == cp - 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return [f'{lo:X}-{hi:X}' for lo, hi in out]


def mark_names():
    return [unicodedata.name(chr(cp)) for cp in range(0x110000)
            if unicodedata.category(chr(cp)) in ('Mn', 'Mc', 'Me')]


def core_text():
    head = (f'# Python str.casefold, Unicode {unicodedata.unidata_version}: a code point, then what it folds to.\n'
            '# Written by scripts/casefold_table.py, do not edit.\n')
    return head + '\n'.join(lines()) + '\n'


def ui_text():
    return ('// Python str.casefold, Unicode ' + unicodedata.unidata_version + ', as core folds document names\n'
            '// (plaid-core/resources/casefold.txt): each line a code point, then what it\n'
            '// folds to, in hex. Written by plaid-core/scripts/casefold_table.py, do not edit.\n'
            'export const CASE_FOLD_TABLE = `\n' + '\n'.join(lines()) + '\n`;\n'
            '\n'
            '// The code points Unicode ' + unicodedata.unidata_version + ' leaves unassigned, as ranges in hex: core\'s\n'
            '// NFC leaves each as it is, whatever a newer Unicode makes of it.\n'
            'export const UNASSIGNED_TABLE = `\n' + '\n'.join(unassigned()) + '\n`;\n')


def marks_text():
    return ('// The names of the combining marks (Mn, Mc, Me) in Unicode ' + unicodedata.unidata_version + ', one a line, as\n'
            '// core\'s Java names them in a pattern\'s \\N{...}. Written by\n'
            '// plaid-core/scripts/casefold_table.py, do not edit.\n'
            'export const MARK_NAMES = `\n' + '\n'.join(mark_names()) + '\n`;\n')


def main():
    want = {CORE: core_text(), UI: ui_text(), MARKS: marks_text()}
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
