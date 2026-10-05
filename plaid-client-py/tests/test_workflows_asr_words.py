"""The ASR transcription's text gets the words of igt's "Tokenize new text",
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
    # Inserted at the segment's end with no space, as the run always has.
    assert body == 'onetwo three'
    assert [body[r['begin']:r['end']] for r in _word_rows(client)] == ['three']


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
