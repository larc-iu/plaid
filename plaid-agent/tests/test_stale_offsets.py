"""Typing in an earlier sentence never stales a plan, and what the plan creates
lands where its sentence is now (A3-UMR-1, FIX9).

A sentence's fingerprint held its absolute offsets, so one letter typed into
sentence 2 moved every later sentence's fingerprint and refused every plan
waiting on them. Now the fingerprint counts offsets from the sentence's own
start. A planned change that holds a place in the text either names the token
it was read from, and takes that token's extent when the plan is applied, or
pins its whole document.
"""

import pytest

import fixtures as igt_fx  # noqa: F401 - the fixture modules the specs load
from test_stale_by_sentence import APPS, _approve, _edit, _layer, _plan

from plaid_agent.core import fingerprint as fp


def _refused(helper):
    return bool(helper.errors) and 'changed since the plan was made' in helper.errors[0]


def _insert(at: int, text: str):
    """An edit that types ``text`` at ``at`` and moves every later offset, as
    core does for a text edit."""
    n = len(text)

    def edit(raw):
        body = raw['text_layers'][0]['text']
        body['body'] = body['body'][:at] + text + body['body'][at:]
        for layer in raw['text_layers'][0]['token_layers']:
            for t in layer.get('tokens') or []:
                if t['begin'] >= at:
                    t['begin'] += n
                if t['end'] > at:
                    t['end'] += n
    return edit


def _created(client):
    """(begin, end) of every token the apply created, in order."""
    out = []
    for kind, payload in client.calls:
        if kind == 'tokens.create':
            args = list(payload['args'])
            out.append((args[2], args[3]))
        elif kind == 'tokens.bulk_create':
            out.extend((t['begin'], t['end']) for t in payload)
    return out


# --- an edit in an earlier sentence -------------------------------------------------

def test_igt_a_letter_typed_in_an_earlier_sentence_does_not_stale_and_morphemes_follow_the_word():
    spec = APPS['igt']()
    client = spec['client']()
    # s2.w1 "Gam-ar" is 18-24.
    plan, _ = _plan(spec, client, tool=('set_analysis', {
        'document': 'd1', 'ref': 's2.w1',
        'morphemes': [{'form': 'Ga', 'type': 'stem'}, {'form': 'm', 'type': 'suffix'},
                      {'form': 'ar', 'type': 'enclitic'}]}))
    _edit(client, spec, _insert(7, 'big '))   # "Ali-di big gam akuna."
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    made = _created(client)
    assert made and set(made) == {(22, 28)}, made


def test_igt_a_morpheme_made_for_an_unsegmented_word_follows_the_word():
    spec = APPS['igt']()
    client = spec['client']()
    # s1.w3 "akuna" (11-16) has no morphemes: a gloss on its morpheme makes one.
    plan, _ = _plan(spec, client, tool=('set_field', {'document': 'd1', 'refs': ['s1.w3.m1'],
                                                      'field': 'Morph Gloss', 'value': 'fish'}))
    _edit(client, spec, _insert(0, 'Oh. '))
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert _created(client) == [(15, 20)]


def test_ud_a_letter_typed_in_an_earlier_sentence_does_not_stale_and_new_words_follow_the_token():
    spec = APPS['ud']()
    client = spec['client']()
    # s2.w1 "Corre" is 14-19.
    plan, _ = _plan(spec, client, tool=('set_words', {'document': 'Viaje', 'ref': 's2.w1',
                                                      'forms': ['Cor', 're']}))
    _edit(client, spec, _insert(2, 'x'))   # "Vaxmos al mar."
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert set(_created(client)) == {(15, 20)}, _created(client)


def test_umr_a_letter_typed_in_an_earlier_sentence_does_not_stale_and_a_new_node_covers_its_sentence():
    spec = APPS['umr']()
    client = spec['client']()
    # Sentence 2 is 17-31.
    plan, _ = _plan(spec, client, tool=('apply_penman', {
        'document': 'Story', 'sentence': 2,
        'text': '(s2r / run-01 :ARG0 (s2t / thing) :direction (s2a / away))'}))
    _edit(client, spec, _insert(4, 'big '))
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert _created(client) == [(21, 35)]


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_the_same_plan_without_an_edit_writes_where_it_was_planned(app):
    """The read again finds every token where the plan read it."""
    spec = APPS[app]()
    client = spec['client']()
    tool = {'igt': ('set_analysis', {'document': 'd1', 'ref': 's2.w1',
                                     'morphemes': [{'form': 'Ga'}, {'form': 'm'}, {'form': 'ar'}]}),
            'ud': ('set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['Cor', 're']}),
            'umr': ('apply_penman', {'document': 'Story', 'sentence': 2,
                                     'text': '(s2r / run-01 :ARG0 (s2t / thing) :direction (s2a / away))'})}[app]
    plan, _ = _plan(spec, client, tool=tool)
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert set(_created(client)) == {{'igt': (18, 24), 'ud': (14, 19), 'umr': (17, 31)}[app]}


def test_an_edit_inside_the_planned_sentence_still_refuses():
    spec = APPS['igt']()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('set_field', {'document': 'd1', 'refs': ['s2.w1'],
                                                      'field': 'Gloss', 'value': 'fish.PL'}))
    _edit(client, spec, _insert(20, 'x'))   # inside "Gam-ar"
    assert _refused(_approve(spec, client, plan))


def _cuts(client):
    """(token id, position) of every split the apply sent, in order."""
    out = []
    for kind, payload in client.calls:
        if kind == 'tokens.split':
            args = list(payload['args']) if isinstance(payload, dict) and 'args' in payload else list(payload)
            out.append((args[0], args[1]))
    return out


@pytest.mark.parametrize('app, tool, at, cut', [
    # s2.w1 "Gam-ar" is 18-24: cut after "Gam".
    ('igt', ('split_word', {'document': 'd1', 'ref': 's2.w1', 'at': 'Gam'}), 7, ('w-4', 25)),
    # Text typed before sentence 1: a new sentence from its third word.
    ('igt', ('split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 3}), 0, None),
    ('ud', ('split_sentence', {'document': 'Viaje', 'ref': 's2.w2'}), 2, None),
])
def test_a_cut_follows_its_token_after_an_edit_in_an_earlier_sentence(app, tool, at, cut):
    """A split is pinned to its sentence and its cut moves with the token it
    falls in, as a create does: a letter typed before the sentence neither
    stales it nor cuts at the wrong place."""
    spec = APPS[app]()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=tool)
    assert plan['documents'][0].get('sentences'), plan['documents']
    planned = [o for o in plan['ops'] if o['kind'].startswith('split')][0]
    key = 'position' if 'position' in planned else 'char_pos'
    assert at <= planned['token_at']['begin'], 'the edit falls before the cut sentence'
    _edit(client, spec, _insert(at, 'xyz '))
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    [(_, position)] = _cuts(client)
    assert position == planned[key] + 4
    if cut:
        assert (planned[key] + 4) == cut[1]


def test_a_cut_without_an_edit_lands_where_it_was_planned():
    spec = APPS['igt']()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('split_word', {'document': 'd1', 'ref': 's2.w1', 'at': 'Gam'}))
    assert not _approve(spec, client, plan).errors
    assert [p for _, p in _cuts(client)] == [21]


def test_an_edit_inside_the_cut_sentence_still_refuses():
    spec = APPS['igt']()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('split_word', {'document': 'd1', 'ref': 's2.w1', 'at': 'Gam'}))
    _edit(client, spec, _insert(19, 'x'))   # inside "Gam-ar"
    assert _refused(_approve(spec, client, plan))
    assert not _cuts(client)


# --- the rules on their own ------------------------------------------------------------

def test_offsets_follow_only_where_every_place_names_its_token():
    reg = {'k': type('K', (), {'extra': {'anchors': lambda op: [(None, op.get('word_id'))]}})(),
           'bare': type('K', (), {'extra': {}})()}
    assert fp.offsets_follow(reg, {'kind': 'k', 'word_id': 'w', 'begin': 1, 'end': 2})
    assert fp.offsets_follow(reg, {'kind': 'bare', 'value': 'x'})
    assert not fp.offsets_follow(reg, {'kind': 'bare', 'begin': 1, 'end': 2})
    assert not fp.offsets_follow(reg, {'kind': 'k', 'word_id': 'w', 'begin': 1, 'end': 2,
                                       'at': {'begin': 1, 'end': 2}})
    assert not fp.offsets_follow(reg, {'kind': 'k', 'word_id': 'w', 'position': 4})
    assert not fp.offsets_follow(reg, {'kind': 'k', 'word_id': 'w', 'rows': [{'begin': 1}]})


def test_a_position_follows_only_with_the_extent_of_the_token_it_cuts():
    cut = type('K', (), {'extra': {'anchors': lambda op: [('position', op.get('word_id')),
                                                          ('token_at', op.get('word_id'))]}})()
    loose = type('K', (), {'extra': {'anchors': lambda op: [('position', op.get('word_id')),
                                                            ('token_at', 'other')]}})()
    reg = {'cut': cut, 'loose': loose}
    assert fp.offsets_follow(reg, {'kind': 'cut', 'word_id': 'w', 'position': 4,
                                   'token_at': {'begin': 2, 'end': 6}})
    assert not fp.offsets_follow(reg, {'kind': 'cut', 'word_id': 'w', 'position': 4})
    assert not fp.offsets_follow(reg, {'kind': 'loose', 'word_id': 'w', 'position': 4,
                                       'token_at': {'begin': 2, 'end': 6}})


class _Tokens:
    def __init__(self, extents):
        self.extents = extents

    def get(self, token_id):
        if token_id not in self.extents:
            gone = LookupError(token_id)
            gone.status = 404
            raise gone
        begin, end = self.extents[token_id]
        return {'id': token_id, 'begin': begin, 'end': end}


class _Client:
    def __init__(self, extents):
        self.tokens = _Tokens(extents)


_REG = {'make': type('K', (), {'extra': {'anchors': lambda op: [(None, op['word_id'])]}})(),
        'cut': type('K', (), {'extra': {'anchors': lambda op: [('position', op['word_id']),
                                                               ('token_at', op['word_id'])]}})()}


def test_a_rebase_moves_creates_and_cuts_by_as_much_as_their_token():
    ops = [{'kind': 'make', 'word_id': 'w', 'begin': 10, 'end': 14},
           {'kind': 'cut', 'word_id': 'w', 'position': 12, 'token_at': {'begin': 10, 'end': 14}}]
    made, cut = fp.rebase_offsets(_Client({'w': (13, 17)}), _REG, ops)
    assert (made['begin'], made['end']) == (13, 17)
    assert cut['position'] == 15 and cut['token_at'] == {'begin': 13, 'end': 17}


@pytest.mark.parametrize('extents', [{}, {'w': (13, 18)}, {'w': (13, 16)}])
def test_a_rebase_refuses_a_token_gone_or_of_another_length(extents):
    """Whatever let the plan through, a change planned over a token that is
    gone or no longer as long never lands on other text."""
    from plaid_agent.core.plan import PlanOutOfDate
    for op in ({'kind': 'make', 'word_id': 'w', 'begin': 10, 'end': 14},
               {'kind': 'cut', 'word_id': 'w', 'position': 12, 'token_at': {'begin': 10, 'end': 14}}):
        with pytest.raises(PlanOutOfDate):
            fp.rebase_offsets(_Client(extents), _REG, [op])


def test_a_sentence_print_counts_offsets_from_the_sentence():
    a = {'begin': 10, 'end': 14, 'words': [{'begin': 10, 'end': 12, 'timeBegin': 3}]}
    b = {'begin': 13, 'end': 17, 'words': [{'begin': 13, 'end': 15, 'timeBegin': 3}]}
    c = {'begin': 13, 'end': 17, 'words': [{'begin': 13, 'end': 16, 'timeBegin': 3}]}
    assert fp.fingerprint(a, origin=10) == fp.fingerprint(b, origin=13)
    assert fp.fingerprint(a, origin=10) != fp.fingerprint(c, origin=13)
    assert fp.fingerprint(a) != fp.fingerprint(b)
