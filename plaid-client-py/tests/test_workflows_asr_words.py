"""The ASR transcription's text stands apart from the text beside it, and gets the words of igt's "Tokenize new text",
read off the word layer it is handed, as typed text gets them: in the batch
that writes the text, none when the layer has the setting off, none in a
script written without spaces. The rule is checked against the app's in
plaid-agent/tests/test_igt_tokens_mirror.py."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.http import PlaidAPIError  # noqa: E402
from plaid_client.workflows.asr import Alignment, AlignmentProcessor  # noqa: E402
from test_workflows_asr import (ALIGN_LAYER, SENTENCE_LAYER, TEXT_LAYER, _Batch,  # noqa: E402
                                _document, _FakeClient, _Helper)

WORD_LAYER = 'word-layer'


def _with_words(doc, words=(), tokenize=None):
    config = {'plaid': {'role': 'word'},
              'igt': {'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}}
    if tokenize is not None:
        config['igt']['tokenizeNewText'] = tokenize
    doc['text_layers'][0]['token_layers'].append(
        {'id': WORD_LAYER, 'name': 'Words', 'config': config,
         'tokens': [{'id': f'w{i}', 'begin': b, 'end': e} for i, (b, e) in enumerate(words)]})
    return doc


def _run(client, alignments, word_layer=WORD_LAYER):
    return AlignmentProcessor().process_alignments(
        client, 'd1', alignments, TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, _Helper(),
        prov_source='service:asr:test', word_token_layer_id=word_layer)


def _word_rows(client):
    return [op for c in client.calls if c[0] == 'bulk_create' for op in c[1]
            if op['token_layer_id'] == WORD_LAYER]


def _body_after(client, before):
    body = before
    for c in client.calls:
        if c[0] == 'text_update':
            for op in c[1]:
                body = body[:op['index']] + op['value'] + body[op['index']:]
    return body


def test_the_transcribed_text_gets_its_words_in_the_batch_that_writes_it():
    client = _FakeClient([_with_words(_document(''))])
    _run(client, [Alignment(text='hello there,', start=0.0, end=1.0),
                  Alignment(text='我今天去北京 ok', start=1.0, end=2.0)])
    body = _body_after(client, '')
    assert [body[r['begin']:r['end']] for r in _word_rows(client)] == ['hello', 'there', 'ok']
    assert all(r['text'] == 'text-1' for r in _word_rows(client))
    # Last in the one batch, after the sentences it lies in.
    assert client.calls[-2][0] == 'bulk_create' and client.calls[-2][1][0]['token_layer_id'] == WORD_LAYER


def test_words_already_there_are_kept_and_text_against_them_is_left_to_them():
    client = _FakeClient([_with_words(_document('one', sentences=[(0, 3)], align=[(0, 3, 0.0, 1.0)]),
                                      words=[(0, 3)])])
    _run(client, [Alignment(text='two three', start=1.0, end=2.0)])
    body = _body_after(client, 'one')
    assert body == 'one two three'
    assert [body[r['begin']:r['end']] for r in _word_rows(client)] == ['two', 'three']


def _segments(client):
    return [op for c in client.calls if c[0] == 'bulk_create' for op in c[1]
            if op['token_layer_id'] == ALIGN_LAYER]


def test_a_segments_text_never_runs_into_the_text_beside_it():
    # Before the first segment, between two, and after the last: a space on
    # each side that touches text, none where there is whitespace already.
    doc = _document('one\nthree', sentences=[(0, 9)], align=[(0, 3, 1.0, 2.0), (4, 9, 5.0, 6.0)])
    client = _FakeClient([doc])
    AlignmentProcessor().process_alignments(
        client, 'd1', [Alignment(text='zero', start=0.0, end=0.5),
                       Alignment(text='two', start=3.0, end=4.0),
                       Alignment(text='two more', start=4.0, end=4.5),
                       Alignment(text='four', start=7.0, end=8.0)],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, _Helper(), prov_source='service:asr:test')
    body = _body_after(client, 'one\nthree')
    assert body == 'zero one two two more\nthree four'
    # Each segment covers its own text and no space.
    assert [body[t['begin']:t['end']] for t in _segments(client)] == ['zero', 'two', 'two more', 'four']


def test_the_first_text_of_an_empty_document_gets_no_space():
    client = _FakeClient([_document('')])
    AlignmentProcessor().process_alignments(
        client, 'd1', [Alignment(text='a b', start=0.0, end=1.0), Alignment(text='c', start=1.0, end=2.0)],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, _Helper(), prov_source='service:asr:test')
    assert _body_after(client, '') == 'a b c'


def test_no_words_when_the_project_has_the_setting_off():
    client = _FakeClient([_with_words(_document(''), tokenize=False)])
    _run(client, [Alignment(text='hello there', start=0.0, end=1.0)])
    assert _word_rows(client) == []


def test_no_words_without_a_word_layer():
    client = _FakeClient([_with_words(_document(''))])
    _run(client, [Alignment(text='hello there', start=0.0, end=1.0)], word_layer=None)
    assert _word_rows(client) == []


def test_a_batch_refused_for_a_word_over_one_the_server_placed_goes_again_without_them():
    client = _FakeClient([_with_words(_document(''))])
    refused = []
    submit = _Batch.submit

    def once(self):
        if not refused and any(c[0] == 'bulk_create' and c[1] and c[1][0]['token_layer_id'] == WORD_LAYER
                               for c in self.queued):
            refused.append(self.queued)
            self.queued = []
            raise PlaidAPIError('HTTP 409', status=409,
                                response_data={'error': 'Bulk-created token overlaps an existing token.'})
        return submit(self)
    _Batch.submit = once
    try:
        assert _run(client, [Alignment(text='hello there', start=0.0, end=1.0)]) == 1
    finally:
        _Batch.submit = submit
    assert refused
    assert _word_rows(client) == []
    assert [c[0] for c in client.calls].count('text_update') == 1


def test_another_refusal_is_not_taken_for_one():
    client = _FakeClient([_with_words(_document(''))])
    submit = _Batch.submit

    def refuse(self):
        self.queued = []
        raise PlaidAPIError('HTTP 409', status=409, response_data={'error': 'Document version mismatch.'})
    _Batch.submit = refuse
    try:
        with pytest.raises(PlaidAPIError):
            _run(client, [Alignment(text='hello there', start=0.0, end=1.0)])
    finally:
        _Batch.submit = submit


# --- what the core does with the run's writes ----------------------------------

def _replay(doc, calls):
    """The document after ``calls``, as the core takes them: an insert at a
    sentence boundary goes to the sentence before, one at a word's edge stays
    outside it, a split keeps the left half's id, and a sentence deleted takes
    every token of the layers nested in it (the words) and every span on
    those with it, as the core cascades a delete."""
    import copy
    doc = copy.deepcopy(doc)
    tl = doc['text_layers'][0]
    layers = {layer['id']: layer for layer in tl['token_layers']}
    body = tl['text']['body']
    for call in calls:
        kind = call[0]
        if kind == 'text_update':
            for op in call[1]:
                i, n = op['index'], len(op['value'])
                body = body[:i] + op['value'] + body[i:]
                for lid, layer in layers.items():
                    for t in layer['tokens']:
                        if lid == SENTENCE_LAYER:
                            if t['begin'] >= i and t['begin'] > 0:
                                t['begin'] += n
                            if t['end'] >= i:
                                t['end'] += n
                        else:
                            if t['begin'] >= i:
                                t['begin'] += n
                            if t['end'] > i:
                                t['end'] += n
        elif kind == 'bulk_create':
            for op in call[1]:
                layers[op['token_layer_id']]['tokens'].append(
                    {'id': op.get('id') or f"made-{len(layers[op['token_layer_id']]['tokens'])}",
                     'begin': op['begin'], 'end': op['end']})
        elif kind == 'bulk_delete':
            gone = set(call[1])
            dead = [t for t in layers[SENTENCE_LAYER]['tokens'] if t['id'] in gone]
            for lid, layer in layers.items():
                if lid in (SENTENCE_LAYER, ALIGN_LAYER):
                    continue
                for t in layer['tokens']:
                    if any(d['begin'] <= t['begin'] and t['end'] <= d['end'] for d in dead):
                        gone.add(t['id'])
            for layer in layers.values():
                layer['tokens'] = [t for t in layer['tokens'] if t['id'] not in gone]
                for sl in layer.get('span_layers', []):
                    sl['spans'] = [sp for sp in sl['spans'] if not set(sp['tokens']) & gone]
        elif kind == 'split':
            _, tid, pos, new_id = call
            [t] = [t for t in layers[SENTENCE_LAYER]['tokens'] if t['id'] == tid]
            assert t['begin'] < pos < t['end'], (t, pos)
            layers[SENTENCE_LAYER]['tokens'].append({'id': new_id, 'begin': pos, 'end': t['end']})
            t['end'] = pos
    tl['text']['body'] = body
    return doc


def _glossed():
    """`one two`, one sentence, the words `one` and `two` glossed by a person,
    one segment over the text at 0 to 2 s."""
    doc = _with_words(_document('one two', sentences=[(0, 7)], align=[(0, 7, 0.0, 2.0)]),
                      words=[(0, 3), (4, 7)])
    words = doc['text_layers'][0]['token_layers'][2]
    words['span_layers'] = [{'id': 'gloss', 'name': 'Gloss', 'spans': [
        {'id': 'g0', 'tokens': ['w0'], 'value': 'ONE', 'metadata': {}},
        {'id': 'g1', 'tokens': ['w1'], 'value': 'TWO', 'metadata': {}}]}]
    return doc


def test_a_transcription_keeps_every_word_and_gloss_already_there():
    # REV-R4-TOK F1: the full sentence reset deleted every word and gloss.
    for word_layer in (WORD_LAYER, None):
        doc = _glossed()
        client = _FakeClient([doc])
        _run(client, [Alignment(text='three', start=3.0, end=4.0)], word_layer=word_layer)
        after = _replay(doc, client.calls)
        tl = after['text_layers'][0]
        body = tl['text']['body']
        layers = {layer['id']: layer for layer in tl['token_layers']}
        words = sorted(layers[WORD_LAYER]['tokens'], key=lambda t: t['begin'])
        assert body == 'one two three'
        assert [body[t['begin']:t['end']] for t in words] == (
            ['one', 'two', 'three'] if word_layer else ['one', 'two'])
        assert [w['id'] for w in words][:2] == ['w0', 'w1']
        assert [sp['value'] for sp in layers[WORD_LAYER]['span_layers'][0]['spans']] == ['ONE', 'TWO']
        # The new segment has a sentence of its own, split from the old one.
        sentences = sorted(layers[SENTENCE_LAYER]['tokens'], key=lambda t: t['begin'])
        assert [(t['id'] == 's0', body[t['begin']:t['end']]) for t in sentences] == [
            (True, 'one two'), (False, ' three')]
        assert not any(c[0] == 'bulk_delete' for c in client.calls)


def test_a_segment_put_between_two_gets_a_sentence_of_its_own():
    doc = _with_words(_document('one\nthree', sentences=[(0, 4), (4, 9)],
                                align=[(0, 3, 0.0, 1.0), (4, 9, 4.0, 5.0)]), words=[(0, 3), (4, 9)])
    client = _FakeClient([doc])
    _run(client, [Alignment(text='two', start=2.0, end=3.0)])
    after = _replay(doc, client.calls)
    tl = after['text_layers'][0]
    body = tl['text']['body']
    layers = {layer['id']: layer for layer in tl['token_layers']}
    sentences = sorted(layers[SENTENCE_LAYER]['tokens'], key=lambda t: t['begin'])
    assert body == 'one two\nthree'
    assert [body[t['begin']:t['end']] for t in sentences] == ['one', ' two\n', 'three']
    assert [body[t['begin']:t['end']] for t in sorted(layers[WORD_LAYER]['tokens'], key=lambda t: t['begin'])] == [
        'one', 'two', 'three']

