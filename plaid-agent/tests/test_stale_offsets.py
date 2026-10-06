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


def test_a_cut_at_a_position_pins_the_whole_document():
    """A split names a place inside a word, which is not read again: an edit
    anywhere before it refuses the plan rather than cut at the wrong place."""
    spec = APPS['igt']()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('split_word', {'document': 'd1', 'ref': 's2.w1', 'at': 'Gam'}))
    assert not plan['documents'][0].get('sentences')
    _edit(client, spec, _insert(7, 'big '))
    assert _refused(_approve(spec, client, plan))


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


def test_a_sentence_print_counts_offsets_from_the_sentence():
    a = {'begin': 10, 'end': 14, 'words': [{'begin': 10, 'end': 12, 'timeBegin': 3}]}
    b = {'begin': 13, 'end': 17, 'words': [{'begin': 13, 'end': 15, 'timeBegin': 3}]}
    c = {'begin': 13, 'end': 17, 'words': [{'begin': 13, 'end': 16, 'timeBegin': 3}]}
    assert fp.fingerprint(a, origin=10) == fp.fingerprint(b, origin=13)
    assert fp.fingerprint(a, origin=10) != fp.fingerprint(c, origin=13)
    assert fp.fingerprint(a) != fp.fingerprint(b)
