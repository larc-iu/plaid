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
NAMERS = [[t, f] for t in [None, 'stem', 'suffix', 'enclitic', 'bound root'] for f in FORMS]
#: One word's gloss line, each morpheme (gloss, morph type, form). The first
#: three are the probes the skeleton and the app once read apart: a stem's
#: pass.PST beside a clitic glossed with a word, beside a suffix glossed with
#: lower-case abbreviations, and that suffix's cell alone.
LINES = [
    [['pass.PST', 'stem', 'pa'], ['and', 'enclitic', 'ka']],
    [['pass.PST', 'stem', 'pa'], ['sbj:3.pfv', 'suffix', 'ti']],
    [['sbj:3.pfv', 'suffix', 'ti']],
    [['pass.PST', None, 'pa']],
    [['sbj:3.pfv', 'stem', 'ti']],
    [['pass.PST', 'stem', 'pa'], ['go', 'root', 'go'], ['PL', 'suffix', 's']],
    [['pass.PST', 'stem', 'pa'], ['top.PL', 'stem', 'ki']],
    [['top.PL', 'stem', 'x'], ['pfv.3', None, '∅']],
    [['sbj:3.pfv', 'stem', '']],
    [['1SG', 'prefix', 'ni'], ['lay.pfv', 'stem', 'la'], ['3sg.pfv', 'suffix', 'a']],
    [['pass.PST', 'bound root', 'pa'], ['pass.PST', 'suffix', 'u']],
    [['art.PL', 'proclitic', 'l'], ['dog', 'stem', 'kalb']],
    [['go.3SG.pfv', 'stem', 'ik'], ['ipfv.PL', 'enclitic', 'ma']],
]


@pytest.fixture(scope='module')
def js(tmp_path_factory):
    exe = shutil.which('node')
    if not exe or not os.path.isfile(TAGSETS_JS):
        pytest.skip('node or plaid-igt is not here')
    cases = tmp_path_factory.mktemp('mirror') / 'cases.json'
    cases.write_text(json.dumps({
        'values': VALUES, 'scanned': [v for v in VALUES if not any(c.isspace() for c in v)],
        'units': UNITS, 'parts': PARTS, 'morphTypes': MORPH_TYPES, 'forms': FORMS,
        'namers': NAMERS, 'lines': LINES,
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


def test_the_lenient_reading_is_the_rule_less_its_fall_back():
    """``lenient_flags`` is ``lexical_flags`` wherever the fall-back does not
    fire, and never falls back itself (``sbj:3.pfv`` stays grammatical)."""
    for unit in [glossing.gloss_morphemes(v) for v in VALUES] + UNITS:
        lenient = glossing.lenient_flags(unit)
        if any(any(f) for f in lenient) or not any(any(f) for f in glossing.lexical_flags(unit)):
            assert lenient == glossing.lexical_flags(unit)
    assert glossing.lenient_flags(glossing.gloss_morphemes('sbj:3.pfv')) == [[False] * 3]
    assert glossing.lexical_flags(glossing.gloss_morphemes('sbj:3.pfv')) == [[True, False, True]]


def test_a_morpheme_names_its_word_as_the_app_says(js):
    assert [glossing.can_name_word(t, f) for t, f in NAMERS] == js['names']


def _skeleton_line(line):
    """The skeleton's reading of one word's gloss line (``line_flags`` with
    the morphemes that could name the word, as ``plan_sentence`` passes it)."""
    return glossing.line_flags([g for g, _, _ in line],
                               [glossing.can_name_word(t, f) for _, t, f in line])


def test_a_word_line_is_read_in_latex_as_the_skeleton_reads_it(js):
    """The gb4e gloss line of one word, joined from its morphemes' glosses,
    sets in small caps exactly the parts the skeleton reads as grammatical."""
    def lettered(line):
        return [f for gloss, flags in zip([g for g, _, _ in line], _skeleton_line(line))
                for parts, fs in zip(glossing.gloss_morphemes(gloss), flags)
                for p, f in zip(parts, fs) if any(c.isalpha() for c in p)]
    assert [lettered(line) for line in LINES] == [r['tex'] for r in js['lines']]


def test_a_morpheme_cell_is_checked_as_the_skeleton_reads_it(js):
    """Each morpheme's cell under a mixed tagset lets through as a word
    exactly the parts the skeleton reads as lexical."""
    assert [[[f for fs in flags for f in fs] for flags in _skeleton_line(line)]
            for line in LINES] == [r['cells'] for r in js['lines']]


def test_the_probes_read_as_the_rule_says():
    """pass.PST keeps pass beside a clitic and a suffix, and a suffix glossed
    sbj:3.pfv is all abbreviations whatever stands beside it."""
    assert _skeleton_line(LINES[0]) == [[[True, False]], [[True]]]
    assert _skeleton_line(LINES[1]) == [[[True, False]], [[False, False, False]]]
    assert _skeleton_line(LINES[2]) == [[[False, False, False]]]
