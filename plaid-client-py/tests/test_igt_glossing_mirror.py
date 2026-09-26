"""``plaid_client.workflows.igt.glossing`` against plaid-igt's own rules.

Which part of a gloss is a word, which morph type is bound and what the zero
morph is are plaid-igt's rules (``tagsets.js``, ``affixMarkers.js``,
``zeroMorph.js``). The UMR skeleton reads glosses by the Python copy, and a
copy drifts silently: the skeleton once read a caseless-script gloss as an
abbreviation that igt set as a word. This runs the app's modules over one case
table and compares every answer.

It skips where it cannot run (no node, or plaid-igt not beside the client); it
does not skip when the two disagree.
"""

import json
import os
import shutil
import subprocess

import pytest

from plaid_client.workflows.igt import glossing

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'igt_glossing_mirror.mjs')
TAGSETS_JS = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-igt', 'src', 'domain',
                                          'tagsets.js'))

VALUES = [
    '', ' ', '-', '..', 'dog', 'dog-PL', 'Dog', 'I', 'A', '3', '3sg', '3SG', '1pl.POSS',
    'go.3sg.pfv',
    'sbj:3.pfv', 'lay-sbj:3.pfv', 'pass.PST', 'top.PL', 'art.PL', 'all.PL', 'go.pass.3',
    '3SG-pfv', 'lay.pfv', 'a.3SG', 'hit;PST', 'sing\\PST', 'come.out', 'walk about.PST',
    '水', '水.DEM', 'go.水', 'पानी', 'ماء.PL', 'ĸ.PL', 'IDEO:INT.rhythmic', 'house-PL-1SG.POSS',
    '1-see-PL', 'go=3SG', 'go~go.PL', 'b<in>ili.PST', 'NOM_x', "don't.PST", '42.pfv.go',
    '?.pfv.go', 'go..pfv', 'İSTANBUL.LOC', 'sbj:3sg.pfv', 'x.y.z', 'ǅ.PL', 'pos.3', 'ipfv.PL',
    'go-a.3SG', 'q.PL-go',
]
UNITS = [
    [['go'], ['sbj', '3', 'pfv']],
    [['pass', 'PST'], ['3']],
    [['sbj', '3', 'pfv'], ['obj', '3']],
    [],
    [[]],
]
PARTS = ['dog', 'PL', '1SG', 'I', '', 'Dog', 'walk about', '3sg', '犬', 'कुत्ता', '42', 'ǅ', 'pfv']
MORPH_TYPES = [None, '', 'stem', 'root', 'prefix', 'suffix', 'infix', 'circumfix', 'Suffix',
               'clitic', 'enclitic', 'proclitic', 'particle', 'bound root', 'suprafix', 'fix',
               'prefixing interfix', 3]
FORMS = ['∅', '0', 'Ø', 'ø', '', ' ∅', 'a', None]


@pytest.fixture(scope='module')
def js(tmp_path_factory):
    exe = shutil.which('node')
    if not exe or not os.path.isfile(TAGSETS_JS):
        pytest.skip('node or plaid-igt is not here')
    cases = tmp_path_factory.mktemp('mirror') / 'cases.json'
    cases.write_text(json.dumps({
        'values': VALUES, 'scanned': [v for v in VALUES if not any(c.isspace() for c in v)],
        'units': UNITS, 'parts': PARTS, 'morphTypes': MORPH_TYPES, 'forms': FORMS,
    }), encoding='utf-8')
    out = subprocess.run([exe, SCRIPT, str(cases)], capture_output=True, text=True, timeout=60,
                         check=True).stdout
    return json.loads(out)


def test_the_abbreviations_are_the_apps(js):
    assert sorted(glossing.GLOSS_ABBREVIATIONS) == js['abbreviations']


def test_a_gloss_is_cut_as_the_app_cuts_it(js):
    assert [glossing.gloss_morphemes(v) for v in VALUES] == js['morphemes']


def test_every_part_of_a_gloss_is_read_as_the_app_reads_it(js):
    assert [glossing.lexical_flags(glossing.gloss_morphemes(v)) for v in VALUES] == js['flags']
    assert [glossing.lexical_flags(u) for u in UNITS] == js['units']
    assert [glossing.is_lexical_part(p) for p in PARTS] == js['parts']


def test_a_tagset_check_reads_a_value_as_the_skeleton_does(js):
    """The app scans a cell by the tagset's delimiters and groups the parts by
    what separates them. Over every separator, that is the skeleton's cut."""
    spaceless = [v for v in VALUES if not any(c.isspace() for c in v)]
    assert [[f for m in glossing.lexical_flags(glossing.gloss_morphemes(v)) for f in m]
            for v in spaceless] == js['scanned']


def test_bound_types_and_the_zero_morph_are_the_apps(js):
    assert [glossing.is_bound_type(t) for t in MORPH_TYPES] == js['bound']
    assert [glossing.is_zero_morph(f) for f in FORMS] == js['zero']
