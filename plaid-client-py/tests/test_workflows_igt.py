"""Tests for plaid_client.workflows.igt (the model-independent half of an
interlinear analysis service).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import contextlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.igt import (
    field_layer_id,
    ParsedWord, parse_interleaved, align_words, analysis_for, clitic_types,
    derive, word_state, select_targets, is_token_ignored, chunk_plans, write_analyses, virtual_morpheme,
    normalize_tagset, read_tagsets, tagset_for, vocab_tagset_for, governed_fields, mode_rule, value_lines,
)


# --- interleaved format ---------------------------------------------------------

def test_parsed_word_reads_glosses_segments_and_joiners():
    w = ParsedWord('house(ev)-PL(ler)=1PL(imiz)')
    assert w.glosses == ['house', 'PL', '1PL']
    assert w.segments == ['ev', 'ler', 'imiz']
    assert w.joiners == ['-', '=']
    assert w.surface == 'evlerimiz'
    assert not w.malformed


def test_malformed_words_degrade_to_one_morpheme_with_the_joined_gloss():
    w = ParsedWord('house-PL')
    assert w.malformed
    a = analysis_for('evler', w)
    assert a == {'segments': ['evler'], 'glosses': ['house-PL'], 'types': [None], 'joiners': [],
                 'degraded': True, 'surface_mismatch': False}


def test_analysis_for_flags_surface_mismatch_and_types_clitics():
    a = analysis_for('evlerdir', ParsedWord('house(ev)-PL(ler)=COP(dir)'))
    assert a['segments'] == ['ev', 'ler', 'dir']
    assert a['types'] == [None, None, 'enclitic']
    assert a['joiners'] == ['-', '=']
    assert not a['surface_mismatch'] and not a['degraded']
    assert analysis_for('evlerdi', ParsedWord('house(ev)-PL(ler)=COP(dir)'))['surface_mismatch']


def test_clitic_types_edge_rule_then_gloss_case():
    assert clitic_types(['='], ['DET', 'house']) == ['proclitic', None]  # two pieces: positional tie, caps left
    assert clitic_types(['='], ['house', 'DET']) == [None, 'enclitic']
    assert clitic_types(['=', '-'], ['x', 'y', 'z']) == ['proclitic', None, None]  # first boundary: left is first
    assert clitic_types(['-', '='], ['x', 'y', 'z']) == [None, None, 'enclitic']


# --- alignment --------------------------------------------------------------------

def test_align_words_fast_path_and_merge_and_drop():
    outs = parse_interleaved('house(ev) come(gel)-PROG(iyor)')
    assert align_words(['ev', 'geliyor'], outs) == outs
    # the model split one input word in two: merged back with a '-' boundary
    merged = align_words(['evler'], parse_interleaved('house(ev) PL(ler)'))
    assert merged[0] is not None and merged[0].segments == ['ev', 'ler']
    # a hallucinated punctuation word is dropped; unrelated output leaves None
    mapping = align_words(['ev', 'gel'], parse_interleaved('house(ev) .(.) come(gel)'))
    assert [o.surface for o in mapping] == ['ev', 'gel']
    assert align_words(['kalem'], parse_interleaved('house(ev)')) == [None]


# --- derive + write contract ---------------------------------------------------------

MACHINE = {'prov': 'inferred', 'provSource': 'service:x'}
VERIFIED = {**MACHINE, 'provConfirmed': True}
CONTRIBUTED = {'prov': 'contributed', 'provSource': 'user:ann@x.com'}


def raw_doc(*, word_meta=None, gloss_meta=None, morph2=None):
    body = 'ev geliyor .'
    words = [
        {'id': 'w1', 'text': 't', 'begin': 0, 'end': 2, 'metadata': word_meta or {'orthog:Latin': 'EV'}},
        {'id': 'w2', 'text': 't', 'begin': 3, 'end': 10, 'metadata': {}},
        {'id': 'w3', 'text': 't', 'begin': 11, 'end': 12, 'metadata': {}},
    ]
    morphs = [
        {'id': 'm1', 'text': 't', 'begin': 0, 'end': 2, 'precedence': 1, 'metadata': {}},
        {'id': 'm2', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 1, 'metadata': {'form': 'gel'}},
    ]
    if morph2:
        morphs.append({'id': 'm3', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 2, 'metadata': morph2})
    gloss_spans = []
    if gloss_meta is not None:
        gloss_spans.append({'id': 'g1', 'tokens': ['m2'], 'value': 'come', 'metadata': gloss_meta})
    return {'text_layers': [{
        'text': {'id': 't', 'body': body},
        'token_layers': [
            {'id': 'sentL', 'tokens': [{'id': 's1', 'begin': 0, 'end': 12}],
             'span_layers': [{'id': 'trL', 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}},
                              'spans': [{'id': 'tr1', 'tokens': ['s1'], 'value': 'the house is coming'}]}]},
            {'id': 'wordL', 'config': {'igt': {'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}},
             'tokens': words, 'span_layers': [], 'vocabs': []},
            {'id': 'morphL', 'tokens': morphs,
             'span_layers': [{'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme'}},
                              'spans': gloss_spans}],
             'vocabs': []},
        ],
    }]}


def test_derive_walks_sentences_words_morphemes_ignoring_punctuation():
    sentences, gloss_id = derive(raw_doc(), 'wordL', 'morphL', 'sentL',
                                 gloss_field='Gloss', translation_field='Translation', orthography='Latin')
    assert gloss_id == 'glossL'
    [s] = sentences
    assert s['translation'] == 'the house is coming'
    assert [w['surface'] for w in s['words']] == ['ev', 'geliyor']  # '.' ignored
    assert [w['text'] for w in s['words']] == ['EV', 'geliyor']  # orthography, surface fallback
    assert [m['id'] for m in s['words'][1]['morphs']] == ['m2']


def test_derive_rejects_a_missing_gloss_field_with_a_helpful_message():
    try:
        derive(raw_doc(), 'wordL', 'morphL', 'sentL', gloss_field='Nope')
    except ValueError as e:
        assert 'Gloss' in str(e)
    else:
        raise AssertionError('expected ValueError')


def test_field_layer_id_finds_a_field_or_says_none():
    doc = raw_doc()
    assert field_layer_id(doc, 'sentL', 'Translation') == 'trL'
    assert field_layer_id(doc, 'morphL', 'Gloss', 'Morpheme') == 'glossL'
    assert field_layer_id(doc, 'sentL', 'Translation (en)') is None
    assert field_layer_id(doc, 'sentL', '') is None
    assert field_layer_id(doc, 'nope', 'Translation') is None


def test_is_token_ignored():
    cfg = {'type': 'unicodePunctuation', 'whitelist': ['$']}
    assert is_token_ignored('.', cfg) and not is_token_ignored('$', cfg)
    assert not is_token_ignored('😀', cfg) and not is_token_ignored('ev', cfg)
    assert is_token_ignored('x', {'type': 'blacklist', 'blacklist': ['x']})
    assert not is_token_ignored('.', None)


def words_of(doc):
    sentences, _ = derive(doc, 'wordL', 'morphL', 'sentL', gloss_field='Gloss')
    return sentences


def test_word_state_votes_by_provenance():
    s = words_of(raw_doc())
    assert word_state(s[0]['words'][0]) == 'unanalyzed'  # bare default morpheme, nothing attached
    assert word_state(s[0]['words'][1]) == 'protected'  # form 'gel' != surface, human-made
    s = words_of(raw_doc(gloss_meta=MACHINE, morph2=MACHINE))
    # the first morpheme's human-looking form still votes: mixed -> protected
    assert word_state(s[0]['words'][1]) == 'protected'
    doc = raw_doc(gloss_meta=MACHINE, morph2=MACHINE)
    doc['text_layers'][0]['token_layers'][2]['tokens'][1]['metadata'] = {'form': 'gel', **MACHINE}
    assert word_state(words_of(doc)[0]['words'][1]) == 'machine'
    doc['text_layers'][0]['token_layers'][2]['tokens'][1]['metadata'] = {'form': 'gel', **VERIFIED}
    assert word_state(words_of(doc)[0]['words'][1]) == 'protected'
    # A word nobody has segmented has no morpheme token. It reads as the app
    # reads it, with its virtual morpheme, and is there to analyze (R1-DEBT-CORE-1).
    doc['text_layers'][0]['token_layers'][2]['tokens'] = []
    [w0, w1] = words_of(doc)[0]['words']
    assert w0['morphs'] == [{'id': 'virtual:w1', 'virtual': True, 'text': 't', 'begin': 0, 'end': 2,
                             'precedence': 1, 'metadata': {}}]
    assert word_state(w0) == word_state(w1) == 'unanalyzed'
    targets, skipped = select_targets(words_of(doc))
    assert [idxs for _, idxs in targets] == [[0, 1]] and skipped == {'protected': 0, 'precedent': 0}


def test_select_targets_applies_the_write_contract():
    s = words_of(raw_doc())
    targets, skipped = select_targets(s, overwrite=False)
    assert [(sent['id'], idxs) for sent, idxs in targets] == [('s1', [0])]
    assert skipped == {'protected': 1, 'precedent': 0}
    assert s[0]['words'][1]['state'] == 'protected'
    targets, skipped = select_targets(s, overwrite=True)
    assert [idxs for _, idxs in targets] == [[0, 1]]
    assert skipped == {'protected': 0, 'precedent': 0}


def test_chunk_plans_respects_the_op_budget():
    s = words_of(raw_doc())
    w = s[0]['words'][0]
    plan = {'word': w, 'analysis': analysis_for('ev', ParsedWord('house(ev)'))}  # 3 ops
    assert chunk_plans([plan] * 5, budget=6) == [[plan, plan], [plan, plan], [plan]]
    assert chunk_plans([plan], budget=1) == [[plan]]  # never an empty chunk


# --- cases carried over from the PolyGloss service's own tests ------------------------

def test_align_dropped_hallucinated_and_shifted_words():
    # the model dropped the second word: 'bbb' stays None, the rest align
    m = align_words(['aaa', 'bbb', 'ccc'], parse_interleaved('A(aaa) C(ccc)'))
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'
    # a hallucinated word in the output is skipped
    m = align_words(['aaa', 'bbb'], parse_interleaved('A(aaa) X(xxx) B(bbb)'))
    assert m[0].raw == 'A(aaa)' and m[1].raw == 'B(bbb)'
    # same count but shifted (dropped + junk appended): the fast path must not fire
    m = align_words(['aaa', 'bbb', 'ccc'], parse_interleaved('A(aaa) C(ccc) Z(zzz)'))
    assert m[0].raw == 'A(aaa)' and m[1] is None and m[2].raw == 'C(ccc)'
    # non-Latin fast path
    out = parse_interleaved('1pl.gen(чи) teacher(муаллим) friend(юлдаш)-PL(ар)-ERG(и)')
    assert align_words(['Чи', 'муаллим', 'юлдашари'], out) == out


def test_clitic_defaults_and_undecidable_interior_boundary():
    assert clitic_types(['='], ['a', 'b']) == [None, 'enclitic']  # two-piece default
    assert clitic_types(['-', '=', '-'], ['a', 'b', 'c', 'd']) == [None, None, None, None]
    assert clitic_types(['-', '='], ['house', 'PL', 'TOP']) == [None, None, 'enclitic']


def test_analysis_for_surface_mismatch_in_cyrillic():
    a = analysis_for('rixoqiil', ParsedWord('E3S(r)-esposa(ixoqiil)'))
    assert not a['degraded'] and a['segments'] == ['r', 'ixoqiil'] and not a['surface_mismatch']
    assert analysis_for('тухузвай', ParsedWord('bring(тухун)-IMPF(зва)-PTP(й)'))['surface_mismatch']


def _word(surface, morphs, spans=(), links=(), morph_spans=None, morph_links=None):
    return {
        'surface': surface, 'text': surface, 'token': {'id': 'w'},
        'morphs': morphs, 'spans': list(spans), 'links': list(links),
        'morph_spans': morph_spans or {}, 'morph_links': morph_links or {},
    }


def test_word_state_on_hand_built_words():
    assert word_state(_word('abc', [virtual_morpheme({'id': 'w', 'begin': 0, 'end': 3})])) == 'unanalyzed'
    m0 = {'id': 'm0', 'metadata': {}}
    assert word_state(_word('abc', [m0])) == 'unanalyzed'
    assert word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'abc'}}])) == 'unanalyzed'
    # human segmentation (no prov on the morpheme tokens) -> protected
    assert word_state(_word('abc', [{'id': 'm0', 'metadata': {'form': 'ab'}},
                                     {'id': 'm1', 'metadata': {'form': 'c'}}])) == 'protected'
    ms = [{'id': 'm0', 'metadata': {'form': 'ab', **MACHINE}}, {'id': 'm1', 'metadata': {'form': 'c', **MACHINE}}]
    assert word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': MACHINE})]})) == 'machine'
    assert word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': VERIFIED})]})) == 'protected'
    # a contributor's work is a person's work: protected from machine writers
    assert word_state(_word('abc', ms, morph_spans={'m0': [('g', {'metadata': CONTRIBUTED})]})) == 'protected'
    # a human morpheme link protects even a default morpheme
    assert word_state(_word('abc', [m0], morph_links={'m0': [{'metadata': {}}]})) == 'protected'
    # word-scope spans and links are never written over, so they protect nothing
    human_word = dict(spans=[('wgloss', {'metadata': None})], links=[{'metadata': {}}])
    assert word_state(_word('abc', [m0], **human_word)) == 'unanalyzed'
    assert word_state(_word('abc', ms, **human_word)) == 'machine'


# --- tagsets ---------------------------------------------------------------------------

def raw_project():
    return {
        'id': 'p', 'config': {'igt': {
            'tagsets': {'Leipzig': {'delimiters': ' . : ', 'mode': 'mixed',
                                    'values': [{'value': ' PL ', 'description': 'plural'}, {'value': 'PL'},
                                               {'value': ''}, {'value': '1SG'}, 'junk']},
                        ' POS ': {'mode': 'closed', 'values': [{'value': 'n'}]},
                        'Odd': {'mode': 'strict', 'delimiters': 7}},
            'documentMetadata': [{'name': 'Genre', 'tagset': 'POS'}, {'name': 'Date'}, {'name': 'X', 'tagset': 'Gone'}],
        }},
        'text_layers': [{'token_layers': [
            {'id': 'morphL', 'span_layers': [
                {'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme', 'tagset': 'Leipzig'}}},
                {'id': 'noteL', 'name': 'Note', 'config': {'igt': {'scope': 'Morpheme'}}},
                {'id': 'oldL', 'name': 'Old', 'config': {'igt': {'scope': 'Morpheme', 'tagset': 'Gone'}}}]}]}],
        'vocabs': [{'id': 'v', 'name': 'Lex', 'config': {'igt': {
            'fields': {'pos': {'inline': True, 'tagset': 'POS'}, 'gloss': {'inline': True}},
            'tagsets': {'POS': {'mode': 'closed', 'values': [{'value': 'adj'}]}}}}}],
    }


def test_tagsets_are_read_the_way_the_editor_reads_them():
    ts = read_tagsets(raw_project()['config'])
    assert set(ts) == {'Leipzig', 'POS', 'Odd'}  # names trimmed
    leipzig = ts['Leipzig']
    assert leipzig['delimiters'] == '.:' and leipzig['mode'] == 'mixed'
    assert [v['value'] for v in leipzig['values']] == ['PL', '1SG']  # trimmed, deduped, empties and junk dropped
    assert leipzig['values'][0]['description'] == 'plural'
    assert ts['Odd'] == {'name': 'Odd', 'delimiters': '', 'mode': 'suggest', 'values': []}
    assert normalize_tagset(None)['mode'] == 'suggest'


def test_tagset_for_and_governed_fields_resolve_by_name_and_ignore_dangling_references():
    p = raw_project()
    assert tagset_for(p, 'glossL')['name'] == 'Leipzig'
    assert tagset_for(p, 'noteL') is None and tagset_for(p, 'oldL') is None and tagset_for(p, 'nope') is None
    g = governed_fields(p)
    assert [(f['kind'], f['name'], f['scope'], f['layer_id'], f['tagset']['name']) for f in g] == [
        ('span', 'Gloss', 'Morpheme', 'glossL', 'Leipzig'), ('metadata', 'Genre', 'document', None, 'POS')]
    # a vocabulary's field resolves against the vocabulary's own tagsets, never the project's
    assert [v['value'] for v in vocab_tagset_for(p['vocabs'][0], 'pos')['values']] == ['adj']
    assert vocab_tagset_for(p['vocabs'][0], 'gloss') is None


def test_tagset_rules_and_value_lines_for_a_prompt():
    leipzig = read_tagsets(raw_project()['config'])['Leipzig']
    assert mode_rule(leipzig) == ('A grammatical tag, written in capitals or digits, must be a listed '
                                  'value, and so must a known abbreviation written in lowercase beside '
                                  'a tag in the same morpheme (the pfv of sbj:3.pfv). '
                                  'A lexical gloss, an ordinary word in lowercase or in a script without capitals, '
                                  "may be anything. A composite value joins its parts with '.' or ':'.")
    assert mode_rule({'mode': 'closed', 'delimiters': ''}) == 'Only the listed values are accepted.'
    assert mode_rule({'mode': 'suggest', 'delimiters': '.:>'}).endswith("joins its parts with '.', ':' or '>'.")
    assert value_lines(leipzig) == ['PL: plural', '1SG']
    assert value_lines(leipzig, max_values=1) == ['PL: plural', '... and 1 more']


def test_write_analyses_says_where_it_is_between_batches():
    """A document of several thousand words is a dozen batches and a minute of
    writing. The requester heard nothing between "Writing analyses" and "Done",
    which is exactly how a working run looks like a wedged one."""
    seen = []

    class _Resource:
        def __init__(self, log, name):
            self._log, self._name = log, name

        def __getattr__(self, method):
            def call(*a, **k):
                self._log.append((self._name, method))
            return call

    class _Batch:
        """A write made on the batch queues; its results land when it submits."""

        def __init__(self):
            self.queued = []
            self.results = []
            self.tokens = _Resource(self.queued, 'tokens')
            self.spans = _Resource(self.queued, 'spans')

        def submit(self):
            self.results = [{'body': {'id': f'new-{i}'}} for i in range(len(self.queued))]
            return self.results

    class _Client:
        """A write made on the client goes out at once, whatever batches are
        open, so anything written here rather than on the batch never reached
        the transaction."""

        def __init__(self):
            self.direct = []
            self.batches = []
            self.tokens = _Resource(self.direct, 'tokens')
            self.spans = _Resource(self.direct, 'spans')

        @contextlib.contextmanager
        def batched(self):
            batch = _Batch()
            self.batches.append(batch)
            yield batch
            batch.submit()

    plans = [_plan(f'w{i}') for i in range(5)]
    client = _Client()
    write_analyses(client, plans, 'gloss-layer', 'morph-layer', 'service:x', {},
                   on_progress=lambda done, total: seen.append((done, total)))
    assert seen and seen[0][0] == 0 and seen[-1] == (seen[-1][1], seen[-1][1])
    assert all(0 <= done <= total for done, total in seen)
    assert client.direct == []  # every write went on the batch
    # One batch makes the morphemes and their glosses together.
    assert len(client.batches) == 1
    # Each word's one stored morpheme is the word itself: patched in place.
    assert client.batches[0].queued.count(('tokens', 'delete')) == 0
    assert client.batches[0].queued.count(('tokens', 'patch_metadata')) == 5
    assert client.batches[0].queued.count(('tokens', 'create')) == 5
    assert client.batches[0].queued.count(('spans', 'create')) == 10


def _plan(word_id):
    morph = {'id': f'{word_id}-m0', 'metadata': {}}
    return {
        'word': {'text_id': 't1', 'morphs': [morph], 'morph_spans': {morph['id']: []},
                 'morph_links': {}, 'surface': 'abc', 'token': {'begin': 0, 'end': 3}},
        'analysis': {'segments': ['ab', 'c'], 'glosses': ['A', 'C'], 'types': [None, None],
                     'joiners': ['-'], 'surface_mismatch': False, 'degraded': False},
        'sentence_id': 's1',
    }


def test_write_analyses_makes_the_first_morpheme_of_a_word_nobody_segmented():
    """Its morpheme is virtual, so there is nothing to patch: the first slot
    is created under a minted id, and its gloss names that id in the same
    batch. Patching the virtual id reached the server as a token that does
    not exist."""
    class _Batch:
        def __init__(self, log):
            self.log = log
            self.results = []
            self.tokens = _Rec(log, 'tokens')
            self.spans = _Rec(log, 'spans')

    class _Rec:
        def __init__(self, log, name):
            self._log, self._name = log, name

        def __getattr__(self, method):
            return lambda *a, **k: self._log.append((self._name, method, a, k))

    class _Client:
        def __init__(self):
            self.batches = []

        @contextlib.contextmanager
        def batched(self):
            b = _Batch([])
            self.batches.append(b)
            yield b
            b.results = [{'body': {'id': f'new-{i}'}} for i in range(len(b.log))]

    m0 = virtual_morpheme({'id': 'w1', 'begin': 0, 'end': 3})
    plan = {'word': {'text_id': 't1', 'morphs': [m0], 'morph_spans': {m0['id']: []},
                     'token': {'id': 'w1', 'begin': 0, 'end': 3}},
            'analysis': {'segments': ['ab', 'c'], 'glosses': ['A', 'C'], 'types': ['stem', None],
                         'joiners': ['-'], 'surface_mismatch': False, 'degraded': False}}
    client = _Client()
    write_analyses(client, [plan], 'gloss-layer', 'morph-layer', 'service:x', {})
    first = client.batches[0].log
    creates = [c for c in first if c[:2] == ('tokens', 'create')]
    assert len(creates) == 2 and not [c for c in first if c[1] == 'patch_metadata']
    made = creates[0][3]['id']
    assert made and not made.startswith('virtual:')
    assert creates[0][2] == ('morph-layer', 't1', 0, 3)
    assert creates[0][3]['precedence'] == 1 and creates[0][3]['metadata']['form'] == 'ab'
    assert creates[0][3]['metadata']['morphType'] == 'stem'
    glosses = [c for c in first if c[:2] == ('spans', 'create')]
    assert [g[2][:3] for g in glosses] == [('gloss-layer', [made], 'A'),
                                           ('gloss-layer', [creates[1][3]['id']], 'C')]
    assert not [c for c in first if c[:2] == ('tokens', 'delete')]  # nothing stored to delete
    assert all('virtual:' not in repr(c) for b in client.batches for c in b.log)


# --- re-analysis replaces the whole analysis (H26-SERVICES-1, -2, -3) -------------------

PRECEDENT = {'prov': 'inferred', 'provSource': 'rule:analysis-precedent'}


class _RecBatch:
    def __init__(self, log):
        self.log = log
        self.results = []
        self.tokens = _RecResource(log, 'tokens')
        self.spans = _RecResource(log, 'spans')


class _RecResource:
    def __init__(self, log, name):
        self._log, self._name = log, name

    def __getattr__(self, method):
        return lambda *a, **k: self._log.append((self._name, method, a, k))


class _RecClient:
    def __init__(self):
        self.batches = []

    @contextlib.contextmanager
    def batched(self):
        b = _RecBatch([])
        self.batches.append(b)
        yield b
        b.results = [{'body': {'id': f'new-{i}'}} for i in range(len(b.log))]


def _analyzed_word(m0_meta, m1_meta, gloss_meta, link_meta, pos_meta):
    """`dogs` analyzed as dog-s: its first morpheme linked to an entry and
    carrying a POS value beside its gloss."""
    m0 = {'id': 'm0', 'metadata': {'form': 'dog', **m0_meta}}
    m1 = {'id': 'm1', 'metadata': {'form': 's', **m1_meta}}
    return _word('dogs', [m0, m1],
                 morph_spans={'m0': [('glossL', {'id': 'g0', 'metadata': gloss_meta}),
                                     ('posL', {'id': 'p0', 'metadata': pos_meta})],
                              'm1': [('glossL', {'id': 'g1', 'metadata': gloss_meta})]},
                 morph_links={'m0': [{'id': 'l0', 'metadata': link_meta}]})


def test_a_word_copied_from_precedent_is_left_to_its_precedent():
    """Auto-analyze copies precedent first so the model only sees what
    precedent cannot answer. The copy is machine-made, so the model step read
    it as fair game and replaced the project's own analysis with its guess,
    and the toast counted the word twice."""
    w = _analyzed_word(PRECEDENT, PRECEDENT, PRECEDENT, PRECEDENT, PRECEDENT)
    assert word_state(w) == 'precedent'
    # a later auto-link adds its own machine link: still the precedent's word
    w['morph_links']['m1'] = [{'id': 'l1', 'metadata': {'prov': 'inferred',
                                                        'provSource': 'rule:precedent-or-unique'}}]
    assert word_state(w) == 'precedent'
    s = [{'id': 's1', 'words': [w, _word('bark', [virtual_morpheme({'id': 'w2', 'begin': 5, 'end': 9})])]}]
    targets, skipped = select_targets(s, overwrite=False)
    assert [idxs for _, idxs in targets] == [[1]]
    assert skipped == {'protected': 0, 'precedent': 1}
    # Overwrite replaces it like everything else
    targets, skipped = select_targets(s, overwrite=True)
    assert [idxs for _, idxs in targets] == [[0, 1]]
    # a person's edit of one piece makes it a person's word
    w['morph_spans']['m0'][0] = ('glossL', {'id': 'g0', 'metadata': {}})
    assert word_state(w) == 'protected'
    # and a model's own analysis stays the model's to redo
    assert word_state(_analyzed_word(MACHINE, MACHINE, MACHINE, MACHINE, MACHINE)) == 'machine'


def _rewrite(word, reply):
    from plaid_client.workflows.igt import ParsedWord as _P
    word = {**word, 'text_id': 't1', 'token': {'id': 'w1', 'begin': 0, 'end': 4}}
    client = _RecClient()
    write_analyses(client, [{'word': word, 'analysis': analysis_for('dogs', _P(reply))}],
                   'glossL', 'morphL', 'service:x', {})
    return client


def _deleted(client):
    return {c[2][0] for b in client.batches for c in b.log if c[:2] == ('tokens', 'delete')}


def test_a_rewrite_discards_the_old_first_morpheme_with_its_link_and_fields():
    """The first morpheme was patched in place: its form became the model's,
    and its lexicon link and its other fields (a POS, a note) stayed, naming
    an entry of the old form and describing a different morpheme. A rewrite
    now deletes every old morpheme, which takes their spans and links with
    them, and makes every slot afresh."""
    for word in (_analyzed_word(MACHINE, MACHINE, MACHINE, MACHINE, MACHINE),  # a re-run
                 _analyzed_word({}, {}, {}, {}, {})):  # Overwrite over a person's work
        client = _rewrite(word, 'dogs(dogs)')
        assert _deleted(client) == {'m0', 'm1'}
        log = [c for b in client.batches for c in b.log]
        assert not [c for c in log if c[1] == 'patch_metadata']
        [made] = [c for c in log if c[:2] == ('tokens', 'create')]
        assert made[3]['id'] not in ('m0', 'm1')
        assert made[3]['metadata']['form'] == 'dogs'
        [gloss] = [c for c in log if c[:2] == ('spans', 'create')]
        assert gloss[2][1] == [made[3]['id']]


def test_overwrite_leaves_nothing_verified_on_what_it_rewrites():
    """Overwrite over a confirmed analysis kept provConfirmed on the first
    morpheme while giving it the model's form, so the model's segment read as
    verified, and a later machine run treated the word as protected."""
    word = _analyzed_word(VERIFIED, VERIFIED, VERIFIED, VERIFIED, VERIFIED)
    client = _rewrite(word, 'dog(dog)-PL(s)')
    log = [c for b in client.batches for c in b.log]
    made = [c[3]['metadata'] for c in log if c[:2] == ('tokens', 'create')]
    glosses = [c[2][3] for c in log if c[:2] == ('spans', 'create')]
    assert len(made) == 2 and len(glosses) == 2
    for meta in made + glosses:
        assert 'provConfirmed' not in meta and meta['prov'] == 'inferred'
    # Every gloss goes in the batch that makes its morpheme.
    assert len(client.batches) == 1


def test_an_unanalyzed_words_stored_morpheme_is_patched_in_place_with_what_else_it_carries():
    """REV-SVC-1. A word whose one stored morpheme is the word itself (no type,
    no span, no link) is unanalyzed, so a run writes it without Overwrite.
    Deleting and remaking that morpheme dropped every other key on it (an
    import's record, on 3,585 Biloxi morphemes) and left any comment on it
    Outdated. It is patched in place, and slots 2..n are created beside it."""
    from plaid_client.metadata_ops import apply_metadata_ops
    record = {'record': 'r-17', 'source_kind': 'default full-word morpheme'}
    m0 = {'id': 'm0', 'metadata': {'form': 'dogs', 'biloxi': record, 'provConfirmed': True}}
    word = _word('dogs', [m0])  # a comment anchored on m0 lives as long as m0 does
    assert word_state(word) == 'unanalyzed'
    client = _rewrite(word, 'dog(dog)-PL(s)')
    log = [c for b in client.batches for c in b.log]
    assert len(client.batches) == 1
    assert not [c for c in log if c[:2] == ('tokens', 'delete')]
    [patch] = [c for c in log if c[:2] == ('tokens', 'patch_metadata')]
    assert patch[2][0] == 'm0'
    after = apply_metadata_ops(m0['metadata'], patch[2][1])
    assert after['biloxi'] == record
    assert after['form'] == 'dog' and after['prov'] == 'inferred'
    assert 'provConfirmed' not in after
    [made] = [c for c in log if c[:2] == ('tokens', 'create')]
    assert made[3]['metadata']['form'] == 's' and made[3]['precedence'] == 2
    glosses = [(c[2][1], c[2][2]) for c in log if c[:2] == ('spans', 'create')]
    assert glosses == [(['m0'], 'dog'), ([made[3]['id']], 'PL')]


def test_words_the_caller_names_are_left_alone_whatever_overwrite_says():
    """REV-SVC-3. Auto-analyze names the words its copy step wrote in this
    run, and the model step never re-analyzes them, Overwrite or not."""
    copied = _analyzed_word(PRECEDENT, PRECEDENT, PRECEDENT, PRECEDENT, PRECEDENT)
    copied['token'] = {'id': 'w1'}
    bare = _word('bark', [virtual_morpheme({'id': 'w2', 'begin': 5, 'end': 9})])
    bare['token'] = {'id': 'w2'}
    s = [{'id': 's1', 'words': [copied, bare]}]
    for overwrite in (False, True):
        targets, skipped = select_targets(s, overwrite=overwrite, skip_word_ids={'w1'})
        assert [idxs for _, idxs in targets] == [[1]], overwrite
        assert skipped['precedent'] == 1
