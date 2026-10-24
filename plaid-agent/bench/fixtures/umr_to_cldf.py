"""The interlinear lines of a UMR 2.0 file (Words, Morphemes, Morpheme
Gloss(English), Translation(English)) as a zipped CLDF TextCorpus, one text,
so plaid-igt's CLDF importer builds the igt document the .umr graphs are then
attached to (umr_import.mjs).

    python umr_to_cldf.py FILE.umr OUT.zip --glottocode kuka1246 --name Kukama --text "Kukama text 2"

The words are the Words line exactly (Surface_Word), since the UMR attach
compares them sentence by sentence. Morphemes and glosses are grouped into
words by their joints ("t-" joins the next piece, "-r" the one before, a lone
"-" the one before). A word whose morphemes and glosses do not group the same
way, or a sentence whose morpheme words do not count out to its Words, is
left unanalyzed (the surface word as its one morpheme, no gloss), which is
counted on stderr. Trailing punctuation stays on the word as the Words line
has it.
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


def line(block, header):
    for ln in block:
        m = re.match(r'^' + re.escape(header) + r':\s*\t?(.*)$', ln)
        if m:
            return m.group(1).split()
    return None


def group(tokens):
    """Pieces into words by their joints."""
    words, cur, joined = [], [], False
    for t in tokens:
        if t in ('-', '='):
            joined = True
            continue
        if cur and (joined or t[0] in '-=' or cur[-1][-1] in '-='):
            cur.append(t)
        else:
            if cur:
                words.append(cur)
            cur = [t]
        joined = False
    if cur:
        words.append(cur)
    return words


def shape(pieces):
    return [(p[0] in '-=', p[-1] in '-=') for p in pieces]


def joined(pieces):
    """'t-', 'ɨmɨntsara', '-r' -> 't-ɨmɨntsara-r'"""
    out = pieces[0].strip('-=')
    for prev, p in zip(pieces, pieces[1:]):
        joint = prev[-1] if prev[-1] in '-=' else p[0] if p[0] in '-=' else '-'
        out += joint + p.strip('-=')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--glottocode', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--text', required=True)
    a = ap.parse_args()
    raw = Path(a.src).read_text(encoding='utf-8')
    blocks = [b.splitlines() for b in re.split(r'\n#{20,}\n', raw) if ':: snt' in b]
    rows, unanalyzed_words, unanalyzed_sentences = [], 0, 0
    for i, b in enumerate(blocks):
        words = [unicodedata.normalize('NFC', w) for w in (line(b, 'Words') or [])]
        morphs = group(line(b, 'Morphemes') or [])
        glosses = group(line(b, 'Morpheme Gloss(English)') or [])
        tl = next((ln.split(':', 1)[1].strip() for ln in b if ln.startswith('Translation(English)')), '')
        analyzed, gl = [], []
        clean = len(morphs) == len(words) == len(glosses)
        if not clean:
            unanalyzed_sentences += 1
        for k, w in enumerate(words):
            bare = re.sub(r'[\W_]+$', '', w) or w
            if clean and shape(morphs[k]) == shape(glosses[k]) and len(morphs[k]) == len(glosses[k]):
                analyzed.append(joined(morphs[k]))
                gl.append(joined(glosses[k]))
            else:
                if clean:
                    unanalyzed_words += 1
                analyzed.append(bare)
                gl.append('')
        rows.append({'words': words, 'analyzed': analyzed, 'glosses': gl, 'tl': tl})
    print(f'{a.name}: {len(rows)} sentences, {unanalyzed_sentences} left unanalyzed, '
          f'{unanalyzed_words} more words unanalyzed', file=sys.stderr)
    with tempfile.TemporaryDirectory() as d:
        ds = TextCorpus.in_dir(d)
        ds.add_component('LanguageTable')
        ds.add_columns('ExampleTable', 'Text_ID', 'Plaid_ID', {'name': 'Surface_Word', 'separator': '\t'})
        ds.write(
            LanguageTable=[{'ID': a.glottocode, 'Name': a.name, 'Glottocode': a.glottocode}],
            ExampleTable=[{
                'ID': f'{a.glottocode}-{i + 1}', 'Language_ID': a.glottocode,
                'Primary_Text': ' '.join(r['words']), 'Analyzed_Word': r['analyzed'], 'Gloss': r['glosses'],
                'Translated_Text': r['tl'], 'Text_ID': a.text, 'Plaid_ID': f'{a.glottocode}-{i + 1}',
                'Surface_Word': r['words'],
            } for i, r in enumerate(rows)])
        ds.validate()
        with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as z:
            for p in Path(d).iterdir():
                z.write(p, p.name)
    print(json.dumps({'sentences': len(rows), 'unanalyzed_sentences': unanalyzed_sentences,
                      'unanalyzed_words': unanalyzed_words}))


if __name__ == '__main__':
    main()
