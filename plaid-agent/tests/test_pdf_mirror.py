"""The service's PDF reading (``core/pdftext.py``, and the cutting of a file
into stored parts in ``core/files.py``) against the composer's
(``plaid-ui/src/components/assistant/pdfText.js`` and ``attachments.js``).

A PDF reaches the assistant two ways: read_url fetches one and the service
extracts it, or the user attaches one and the browser extracts it. Either way
read_file finds its pages and sections by the markers the extraction wrote, so
two extractions that laid a page out differently, cleaned it differently or
marked it differently would make the same PDF read differently depending on how
it arrived. Everything after the library (laying a page out from positioned
text, cleaning it, writing the markers, deciding it is a scan, cutting it into
stored parts) is run here on both sides over the same input. The fixtures are
then read whole, with PDFium on one side and pdf.js on the other, and must
agree on every marker and every word.

It skips where it cannot run (no node); it does not skip when they disagree.
"""

import json
import os
import random
import subprocess
import tempfile

import pytest

from node_exe import node_or_skip

from plaid_agent.core import pdftext
from plaid_agent.core.files import chunk, stored_bytes

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'pdf_mirror.mjs')
FIXTURES = os.path.join(HERE, 'pdf')
PDFJS = os.path.join(HERE, '..', '..', 'plaid-igt', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
CASES = 900

WORDS = ['kasuk', 'sa', 'a-mtonan', 'ŋa-mriri', '3', 'sg', 'poss', '.', '-stand', 'ɛ́', 'é',
         'ﬁrst', 'ﻟﻐﺔ', 'لغة', 'العربية', '2024', '(1)', 'Tone', 'kʰa', '´a', '=== page 3 ===', '𝄞']


def _items(rng):
    """A page's worth of positioned pieces: lines of words, some in columns,
    some in a smaller size, some right to left, some with drawn spaces, and
    pairs of lines whose words start at nearly the same places, as an
    interlinear example's do."""
    items = []
    y = 700.0
    for _ in range(rng.randrange(1, 7)):
        size = rng.choice([9.0, 10.0, 11.0, 12.0])
        starts = []
        x = rng.choice([50.0, 56.6, 72.0])
        for _ in range(rng.randrange(1, 8)):
            word = rng.choice(WORDS)
            s = size * rng.choice([1.0, 1.0, 1.0, 0.7])
            width = len(word) * s * rng.uniform(0.4, 0.6)
            text = word + (' ' if rng.random() < 0.4 else '')
            items.append({'text': text, 'x0': x, 'x1': x + width, 'y': y + rng.choice([0, 0, 0, 0.3, 3.5]),
                          'size': s})
            starts.append(x)
            if rng.random() < 0.2:
                items.append({'text': ' ', 'x0': x + width, 'x1': x + width + s * 0.3, 'y': y, 'size': s})
            x += width + size * rng.choice([0.0, 0.1, rng.uniform(0, 1.2), rng.uniform(0, 1.2), 3.0])
        if rng.random() < 0.3:
            # A right-to-left word drawn a letter at a time, left to right.
            for letter in reversed('\u0627\u0644\u0644\u063a\u0629'):
                width = size * 0.4
                items.append({'text': letter, 'x0': x, 'x1': x + width, 'y': y, 'size': size})
                x += width + size * rng.uniform(0, 0.4)
        y -= size * rng.choice([1.2, 1.4, 2.5])
        if rng.random() < 0.5:
            # A gloss line under it, each word near the start of one above.
            prev = 0.0
            for start in starts:
                word = rng.choice(WORDS)
                x0 = max(prev, start + size * rng.uniform(-0.25, 0.25))
                width = len(word) * size * rng.uniform(0.3, 0.5)
                items.append({'text': word, 'x0': x0, 'x1': x0 + width, 'y': y, 'size': size})
                prev = x0 + width
            y -= size * 1.3
    return items


def _case(rng, i):
    kind = ['clean', 'layout', 'layout', 'assemble', 'scan', 'chunk'][i % 6]
    if kind == 'clean':
        return {'kind': kind, 'text': ' '.join(rng.choice(WORDS + ['\n', '\n\n\n', ' ́', 'ﬃ'])
                                               for _ in range(rng.randrange(0, 20)))}
    if kind == 'layout':
        return {'kind': kind, 'items': _items(rng)}
    if kind == 'assemble':
        pages = [rng.choice(['', 'text', 'a\n=== # fake ===\nb', ' '.join(WORDS)]) for _ in range(rng.randrange(0, 6))]
        labels = [rng.choice(['', str(n + 1), 'xii', ' 7 ', 'A-3']) for n in range(len(pages))]
        sections = [(rng.randrange(1, 9), rng.choice(['1 Intro', '  9   Complex  predicates', '', 'a === b',
                                                      'ﬁnal']), rng.randrange(-1, len(pages) + 1))
                    for _ in range(rng.randrange(0, 6))]
        return {'kind': kind, 'pages': pages, 'labels': labels, 'sections': sections}
    if kind == 'scan':
        return {'kind': kind, 'pages': [rng.choice(['', ' x ', 'y' * 19, 'z' * 20, ' '.join(WORDS)])
                                        for _ in range(rng.randrange(0, 6))]}
    text = ''.join(rng.choice(['a', '/', '"', '\\', '\n', '\t', '\x01', 'é', 'ŋ', '𝄞', 'لغة'])
                   for _ in range(rng.randrange(0, 200)))
    return {'kind': kind, 'text': text, 'budget': rng.randrange(14, 120)}


def _python(c):
    if c['kind'] == 'clean':
        return pdftext.clean(c['text'])
    if c['kind'] == 'layout':
        return pdftext.layout(pdftext.runs_from_items(c['items']))
    if c['kind'] == 'assemble':
        return pdftext.assemble(c['pages'], c['labels'], [tuple(s) for s in c['sections']])
    if c['kind'] == 'scan':
        return [pdftext.is_scan(c['pages']), pdftext.empty_pages(c['pages'])]
    return [chunk(c['text'], c['budget']), stored_bytes(c['text'])]


def _run_js(cases):
    node = node_or_skip('the PDF mirror runs plaid-ui\'s pdfText.js in node')
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(cases, f, ensure_ascii=False)
        path = f.name
    try:
        out = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout)


def test_both_sides_lay_out_clean_and_mark_alike():
    rng = random.Random(20261005)
    cases = [_case(rng, i) for i in range(CASES)]
    js = _run_js(cases)
    for c, theirs in zip(cases, js):
        assert _python(c) == theirs, c


def test_a_fixture_reads_the_same_with_pdfium_and_with_pdfjs():
    if not os.path.exists(PDFJS):
        pytest.skip('pdfjs-dist is not installed in plaid-igt')
    names = ['sample.pdf', 'scan.pdf', 'smallcaps.pdf', 'smaller.pdf']
    js = _run_js([{'kind': 'file', 'path': os.path.join(FIXTURES, n)} for n in names])
    for name, theirs in zip(names, js):
        with open(os.path.join(FIXTURES, name), 'rb') as f:
            ours = pdftext.extract(f.read())
        assert (ours.pages, ours.empty, ours.scan) == (theirs['pages'], theirs['empty'], theirs['scan'])
        # The two libraries measure a glyph's width a little differently, so
        # a column can land one place over. Every marker and every word on
        # every line must be the same.
        mine = [' '.join(line.split()) for line in ours.text.split('\n')]
        other = [' '.join(line.split()) for line in theirs['text'].split('\n')]
        assert mine == other, name
