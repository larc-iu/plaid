"""Unit tests for the pure parts of the PolyGloss service (no model, no server).
Run: pytest plaid-igt/services/tests
(Lives under tests/ because bb/pipeline.clj bundles every services/*.py into the jar.)"""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    'igt_analyze_polygloss', pathlib.Path(__file__).parent.parent / 'igt_analyze_polygloss.py')
pg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pg)


def parsed(text):
    return [pg.ParsedWord(w) for w in text.split()]


def test_parse_interleaved_word():
    w = pg.ParsedWord('COM(x)-buscar(tok)')
    assert w.glosses == ['COM', 'buscar'] and w.segments == ['x', 'tok'] and w.joiners == ['-']
    assert not w.malformed and w.surface == 'xtok'
    w = pg.ParsedWord('DET(a)=house(b)')
    assert w.joiners == ['=']
    bad = pg.ParsedWord('FOO')
    assert bad.malformed and bad.glosses == ['FOO'] and bad.segments == ['']


def test_align_fast_path():
    out = parsed('1pl.gen(чи) teacher(муаллим) friend(юлдаш)-PL(ар)-ERG(и)')
    m = pg.align_words(['Чи', 'муаллим', 'юлдашари'], out)
    assert [o.raw for o in m] == [o.raw for o in out]


def test_align_dropped_output_word_leaves_input_untouched():
    # model dropped the second word: 'b' must stay None, 'a' and 'c' align
    out = parsed('A(aaa) C(ccc)')
    m = pg.align_words(['aaa', 'bbb', 'ccc'], out)
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'


def test_align_hallucinated_output_word_is_skipped():
    out = parsed('A(aaa) X(xxx) B(bbb)')
    m = pg.align_words(['aaa', 'bbb'], out)
    assert m[0].raw == 'A(aaa)' and m[1].raw == 'B(bbb)'


def test_align_merges_a_word_the_model_split():
    out = parsed('A(aa) B(bb) C(cccc)')
    m = pg.align_words(['aabb', 'cccc'], out)
    assert m[0].segments == ['aa', 'bb'] and m[0].joiners == ['-'] and m[1].raw == 'C(cccc)'


def test_align_count_match_but_shifted_falls_to_dp():
    # same count, but word 2 was dropped and a junk word appended
    out = parsed('A(aaa) C(ccc) Z(zzz)')
    m = pg.align_words(['aaa', 'bbb', 'ccc'], out)
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'


def test_clitic_types_positional_and_case():
    assert pg.clitic_types(['=', '-'], ['DET', 'house', 'PL']) == ['proclitic', None, None]
    assert pg.clitic_types(['-', '='], ['house', 'PL', 'TOP']) == [None, None, 'enclitic']
    assert pg.clitic_types(['='], ['house', 'DET']) == [None, 'enclitic']
    assert pg.clitic_types(['='], ['DET', 'house']) == ['proclitic', None]
    assert pg.clitic_types(['='], ['a', 'b']) == [None, 'enclitic']  # default
    assert pg.clitic_types(['-', '=', '-'], ['a', 'b', 'c', 'd']) == [None, None, None, None]


def test_analysis_for_degrades_malformed_word():
    a = pg.analysis_for('xtok', pg.ParsedWord('COM-buscar'))
    assert a['degraded'] and a['segments'] == ['xtok'] and a['glosses'] == ['COM-buscar']
    a = pg.analysis_for('rixoqiil', pg.ParsedWord('E3S(r)-esposa(ixoqiil)'))
    assert not a['degraded'] and a['segments'] == ['r', 'ixoqiil'] and not a['surface_mismatch']
    a = pg.analysis_for('тухузвай', pg.ParsedWord('bring(тухун)-IMPF(зва)-PTP(й)'))
    assert a['surface_mismatch']


def _word(surface, morphs, spans=(), links=(), morph_spans=None, morph_links=None):
    return {
        'surface': surface, 'text': surface, 'token': {'id': 'w'},
        'morphs': morphs, 'spans': list(spans), 'links': list(links),
        'morph_spans': morph_spans or {}, 'morph_links': morph_links or {},
    }


MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {**MACHINE, 'provConfirmed': True}


def test_word_state():
    assert pg.word_state(_word('abc', [])) == 'nomorph'
    m0 = {'id': 'm0', 'metadata': {}}
    assert pg.word_state(_word('abc', [m0])) == 'unanalyzed'
    assert pg.word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'abc'}}])) == 'unanalyzed'
    # human segmentation (no prov on the morpheme tokens) → protected
    assert pg.word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'ab'}},
                                        {'id': 'm1', 'metadata': {'form': 'c'}}])) == 'protected'
    # machine segmentation + machine gloss → replaceable
    ms = [{'id': 'm0', 'metadata': {'form': 'ab', **MACHINE}}, {'id': 'm1', 'metadata': {'form': 'c', **MACHINE}}]
    assert pg.word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': MACHINE})]})) == 'machine'
    # one verified piece protects the word
    assert pg.word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': VERIFIED})]})) == 'protected'
    # a human word-level span protects even a default morpheme
    assert pg.word_state(_word('abc', [m0], spans=[('pos', {'metadata': None})])) == 'protected'
    # a human link on the morpheme protects
    assert pg.word_state(_word('abc', [m0], morph_links={'m0': [{'metadata': {}}]})) == 'protected'


def test_ignored_tokens():
    cfg = {'type': 'unicodePunctuation', 'whitelist': ['?']}
    assert pg.is_token_ignored('.', cfg) and not pg.is_token_ignored('?', cfg)
    assert not pg.is_token_ignored('derechos.', cfg)
    assert pg.is_token_ignored('x', {'type': 'blacklist', 'blacklist': ['x']})
