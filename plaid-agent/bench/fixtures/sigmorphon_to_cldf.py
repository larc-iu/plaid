"""Convert a SIGMORPHON 2023 glossing shared-task file (track 2, uncovered:
\\t text, \\m segmentation, \\g gloss, \\l translation) into a zipped CLDF
TextCorpus that plaid-igt's own CLDF importer reads.

    python sigmorphon_to_cldf.py SRC OUT.zip --glottocode lezg1247 --name Lezgi \\
        [--per-text 20] [--max 60]

Kept: lines whose \\t, \\m and \\g have the same number of space-separated
words, and whose every word has as many morphemes as glosses. Dropped lines
are counted on stderr. Consecutive kept lines are grouped into texts of
--per-text sentences (a Text_ID column), so each text becomes one document.

The dataset carries Plaid_ID and Surface_Word columns, which make the importer
place each word at its surface form in the \\t line (the \\m form is often an
underlying form that is not in the text). A punctuation word gets an empty
gloss, since igt skips punctuation and would otherwise store "," as a gloss.
"""

import argparse
import json
import re
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path

from pycldf import TextCorpus

PUNCT = re.compile(r'^[\W_]+$', re.UNICODE)


def blocks(text):
    cur = {}
    for line in text.splitlines():
        line = line.rstrip('\n')
        if not line.strip():
            if cur:
                yield cur
                cur = {}
            continue
        m = re.match(r'^\\([tmgl])\s?(.*)$', line)
        if m:
            cur[m.group(1)] = m.group(2).strip()
    if cur:
        yield cur


def pieces(word):
    return [p for p in re.split(r'[-=]', word) if p != '']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--glottocode', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--per-text', type=int, default=20)
    ap.add_argument('--max', type=int, default=0, help='keep at most this many sentences (0: all)')
    ap.add_argument('--lexicon', action='store_true',
                    help='also write an EntryTable and SenseTable: one entry per distinct morpheme form '
                         '(lowercased), one sense per distinct gloss it has in the kept lines. The importer '
                         'makes these the project\'s lexicon, with no morpheme linked to any entry')
    a = ap.parse_args()

    rows, dropped = [], 0
    for b in blocks(Path(a.src).read_text(encoding='utf-8')):
        t, m, g = b.get('t', ''), b.get('m', ''), b.get('g', '')
        tw, mw, gw = t.split(), m.split(), g.split()
        if not tw or not (len(tw) == len(mw) == len(gw)):
            dropped += 1
            continue
        ok = True
        glosses = []
        for mword, gword, sword in zip(mw, gw, tw):
            if PUNCT.match(sword) and PUNCT.match(mword):
                glosses.append('')
                continue
            if len(pieces(mword)) != len(pieces(gword)) or re.split(r'[^-=]+', mword) != re.split(r'[^-=]+', gword):
                ok = False
                break
            glosses.append(gword)
        if not ok:
            dropped += 1
            continue
        rows.append({'t': unicodedata.normalize('NFC', t), 'tw': tw, 'mw': mw, 'gw': glosses,
                     'l': b.get('l', '').strip().strip('"')})
        if a.max and len(rows) >= a.max:
            break
    print(f'{a.name}: kept {len(rows)} sentences, dropped {dropped}', file=sys.stderr)

    with tempfile.TemporaryDirectory() as d:
        ds = TextCorpus.in_dir(d)
        ds.add_component('LanguageTable')
        ds.add_columns('ExampleTable', 'Text_ID', 'Plaid_ID',
                       {'name': 'Surface_Word', 'separator': '\t'})
        tables = {}
        if a.lexicon:
            senses = {}
            for r in rows:
                for mword, gword in zip(r['mw'], r['gw']):
                    if not gword:
                        continue
                    for form, gl in zip(pieces(mword), pieces(gword)):
                        senses.setdefault(form.lower(), [])
                        if gl not in senses[form.lower()]:
                            senses[form.lower()].append(gl)
            ds.add_component('EntryTable')
            ds.add_component('SenseTable')
            forms = sorted(senses)
            tables['EntryTable'] = [{'ID': f'e{i + 1}', 'Language_ID': a.glottocode, 'Headword': f}
                                    for i, f in enumerate(forms)]
            tables['SenseTable'] = [{'ID': f'e{i + 1}-{k + 1}', 'Entry_ID': f'e{i + 1}', 'Description': g}
                                    for i, f in enumerate(forms) for k, g in enumerate(senses[f])]
            print(f'{a.name}: lexicon of {len(forms)} entries, '
                  f'{sum(len(v) for v in senses.values())} senses', file=sys.stderr)
        ds.write(
            **tables,
            LanguageTable=[{'ID': a.glottocode, 'Name': a.name, 'Glottocode': a.glottocode}],
            ExampleTable=[{
                'ID': f'{a.glottocode}-{i + 1}',
                'Language_ID': a.glottocode,
                'Primary_Text': r['t'],
                'Analyzed_Word': r['mw'],
                'Gloss': r['gw'],
                'Translated_Text': r['l'],
                'Text_ID': f'{a.name} text {i // a.per_text + 1}',
                'Plaid_ID': f'{a.glottocode}-{i + 1}',
                'Surface_Word': r['tw'],
            } for i, r in enumerate(rows)],
        )
        ds.validate()
        with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as z:
            for p in Path(d).iterdir():
                z.write(p, p.name)
    print(json.dumps({'kept': len(rows), 'dropped': dropped}))


if __name__ == '__main__':
    main()
