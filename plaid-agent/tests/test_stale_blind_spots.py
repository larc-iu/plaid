"""What a sentence's fingerprint has to see for a plan to apply after someone
else edited its document (ruling umr-assist-stale-plan, the review of 61389370).

A plan approved after an edit elsewhere in the document now applies. That is
safe only when every change that could make the plan wrong lands in a sentence
the plan pinned, or pins the whole document. Each case here is one way a
document can change under a pending plan without the planned sentence's own
annotations changing, in each app where it exists: an edge or document-level
relation written from another sentence, an
alignment, the vocabulary a planned link names, the glosses the UMR model read.
A text edit before the planned sentence moves its offsets and nothing else, so
it does not refuse the plan (test_stale_offsets.py).
"""

import copy

import pytest

import fixtures as igt_fx
import ud_fixtures as ud_fx
import umr_fixtures as umr_fx
from test_stale_by_sentence import APPS, _approve, _edit, _layer, _plan, _span


def _refused(helper):
    return bool(helper.errors) and 'changed since the plan was made' in helper.errors[0]


# --- UMR ---------------------------------------------------------------------------

UMR = APPS['umr']


def _umr_sentence_2_plan():
    # A change to s2r, a node of sentence 2 (ms-2).
    return ('set_attributes', {'document': 'Story', 'sentence': 2, 'var': 's2r',
                               'line': ':aspect state'})


def test_umr_a_document_level_relation_another_sentence_writes_into_the_planned_one_refuses():
    """A triple written in sentence 1's block, ending on the planned node."""
    spec = UMR()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=_umr_sentence_2_plan())
    _edit(client, spec, lambda raw: _layer(raw, umr_fx.DOC_LAYER)['relations'].append(
        {'id': 'md-2', 'source': 'mc-b', 'target': 'mc-r', 'value': ':before',
         'metadata': {'umr': {'group': 'temporal'}}}))
    assert _refused(_approve(spec, client, plan))


def test_umr_an_alignment_change_in_the_planned_sentence_refuses():
    spec = UMR()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=_umr_sentence_2_plan())

    def realign(raw):
        for t in _layer(raw, umr_fx.NODE_LAYER)['tokens']:
            if t['id'] == 'mn-3':
                t.update(begin=24, end=28)   # ran -> away
    _edit(client, spec, realign)
    assert _refused(_approve(spec, client, plan))


def test_umr_a_text_edit_before_the_planned_sentence_does_not_refuse():
    """Four characters typed into sentence 1 move every offset of sentence 2,
    which its fingerprint counts from its own start (A3-UMR-1)."""
    spec = UMR()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=_umr_sentence_2_plan())

    def insert(raw):
        text = raw['text_layers'][0]['text']
        text['body'] = 'The big dog barked .\n' + text['body'][17:]
        for layer in raw['text_layers'][0]['token_layers']:
            for t in layer.get('tokens') or []:
                if t['begin'] >= 4:
                    t['begin'] += 4
                if t['end'] > 4 or t['id'] == 'ms-1':
                    t['end'] += 4
    _edit(client, spec, insert)
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors


def test_umr_a_gloss_the_model_read_changing_in_the_planned_sentence_refuses():
    """The gloss lines of a sentence are what the model drafts its graph from,
    and they are a part of the sentence another app writes: IGT's gloss on
    "ran" changing under a plan about "ran" is a change to that sentence."""
    spec = UMR()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=_umr_sentence_2_plan())
    _edit(client, spec, lambda raw: _span(raw, 'mg-6').update(value='flee.PST'))
    assert _refused(_approve(spec, client, plan))


def test_umr_a_gloss_changing_in_another_sentence_does_not_refuse():
    spec = UMR()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=_umr_sentence_2_plan())
    _edit(client, spec, lambda raw: _span(raw, 'mg-3').update(value='woof.PST'))
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors


# --- IGT ---------------------------------------------------------------------------

IGT = APPS['igt']


def test_igt_a_text_edit_before_the_planned_sentence_does_not_refuse():
    spec = IGT()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('set_field', {'document': 'd1', 'refs': ['s2.w1'],
                                                      'field': 'Gloss', 'value': 'fish.PL'}))

    def insert(raw):
        text = raw['text_layers'][0]['text']
        text['body'] = 'Ali-di gam akuna! ' + text['body'][18:]
        text['body'] = text['body'][:7] + 'big ' + text['body'][7:]
        for layer in raw['text_layers'][0]['token_layers']:
            for t in layer.get('tokens') or []:
                if t['begin'] >= 7:
                    t['begin'] += 4
                if t['end'] > 7:
                    t['end'] += 4
    _edit(client, spec, insert)
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors


def _links(raw):
    """Every vocabulary link list in a document read."""
    return [v['vocab_links'] for layer in raw['text_layers'][0]['token_layers']
            for v in layer.get('vocabs') or []]


def test_igt_a_link_to_an_entry_deleted_since_refuses():
    """The entry a planned link names is deleted, which takes its links in
    another sentence of the same document and bumps the document. The planned
    word's own sentence is untouched, and the link would be written to an
    entry that is gone."""
    spec = IGT()
    client = spec['client']()
    # Link s2.w1 "Gam-ar" to -di, the entry s1.w1.m2 is linked to.
    plan, _ = _plan(spec, client, tool=('link_entry', {'document': 'd1', 'refs': ['s2.w1'],
                                                       'entry_id': 'vi-erg'}))

    def delete_entry(raw):
        for links in _links(raw):
            links[:] = [l for l in links if l['vocab_item']['id'] != 'vi-erg']
    _edit(client, spec, delete_entry)
    assert _refused(_approve(spec, client, plan))


def test_igt_a_link_to_an_entry_merged_away_since_refuses():
    spec = IGT()
    client = spec['client']()
    plan, _ = _plan(spec, client, tool=('link_entry', {'document': 'd1', 'refs': ['s2.w1'],
                                                       'entry_id': 'vi-erg'}))

    def merge(raw):
        for links in _links(raw):
            for l in links:
                if l['vocab_item']['id'] == 'vi-erg':
                    l['vocab_item'] = {'id': 'vi-ali', 'form': 'Ali'}
    _edit(client, spec, merge)
    assert _refused(_approve(spec, client, plan))


def test_igt_a_planned_link_pins_one_sentence_already_linking_its_entry():
    """One is enough to see the entry go, and an entry nothing in the
    document links pins nothing more than the word's own sentence."""
    spec = IGT()
    plan, _ = _plan(spec, spec['client'](), tool=('link_entry', {'document': 'd1', 'refs': ['s2.w1'],
                                                                  'entry_id': 'vi-erg'}))
    assert [s['id'] for s in plan['documents'][0]['sentences']] == ['s-1', 's-2']
    plan, _ = _plan(spec, spec['client'](), tool=('link_entry', {'document': 'd1', 'refs': ['s2.w1'],
                                                                  'entry_id': 'vi-gam'}))
    assert [s['id'] for s in plan['documents'][0]['sentences']] == ['s-2']


# --- UD ----------------------------------------------------------------------------

UD = APPS['ud']


def test_ud_a_text_edit_before_the_planned_sentence_does_not_refuse():
    spec = UD()
    client = spec['client']()
    plan, _ = _plan(spec, client)   # a lemma in sentence 2

    def shift(raw):
        raw['text_layers'][0]['text']['body'] = 'xx' + raw['text_layers'][0]['text']['body']
        for layer in raw['text_layers'][0]['token_layers']:
            for t in layer.get('tokens') or []:
                t['begin'] += 2
                t['end'] += 2
    _edit(client, spec, shift)
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
