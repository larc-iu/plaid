"""Tests for the ASR workflow's document rewrite.

The 700 lines that every transcribe service runs had no test of their own. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import testing  # noqa: E402
from plaid_client.service import locked_for_writes  # noqa: E402
from plaid_client.workflows.asr import Alignment, AlignmentProcessor  # noqa: E402

TEXT_LAYER = 'text-layer'
ALIGN_LAYER = 'align-layer'
SENTENCE_LAYER = 'sentence-layer'


class _FakeClient(testing.FakeClient):
    """plaid_client.testing's FakeClient, with its log read back as these
    tests ask it: ``('bulk_create', ops)``, ``('bulk_delete', ids)``,
    ``('split', token_id, position, id, keep)``, ``('text_update', ops)``,
    ``('text_create', body)``, the lock and its release, and the word layer
    each text update named for "Tokenize new text"."""

    @property
    def calls_made(self):
        return _logged(self.calls)

    @property
    def tokenize_layers(self):
        return [_call(payload)[1].get('tokenize_layer')
                for kind, payload in self.calls if kind == 'texts.update']


def _call(payload):
    """A recorded call's positional and keyword arguments."""
    if isinstance(payload, dict) and set(payload) == {'args', 'kwargs'}:
        return tuple(payload['args']), payload['kwargs']
    return (payload if isinstance(payload, tuple) else (payload,)), {}


def _logged(entries):
    out = []
    for kind, payload in entries:
        args, kwargs = _call(payload)
        if kind in ('lock', 'unlock'):
            out.append((kind, payload))
        elif kind in ('tokens.bulk_create', 'tokens.bulk_delete'):
            out.append((kind.removeprefix('tokens.'), list(payload)))
        elif kind == 'tokens.split':
            out.append(('split', args[0], args[1], kwargs.get('id'), kwargs.get('keep')))
        elif kind == 'texts.update':
            out.append(('text_update', list(args[1])))
        elif kind == 'texts.create':
            out.append(('text_create', args[2]))
    return out


def _document(body, *, sentences=(), align=(), sentence_spans=()):
    return {
        'id': 'd1',
        'text_layers': [{
            'id': TEXT_LAYER,
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                {'id': ALIGN_LAYER, 'name': 'Alignment',
                 'tokens': [{'id': f'a{i}', 'begin': b, 'end': e,
                             'metadata': {'timeBegin': tb, 'timeEnd': te}}
                            for i, (b, e, tb, te) in enumerate(align)]},
                {'id': SENTENCE_LAYER, 'name': 'Sentences',
                 'tokens': [{'id': f's{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(sentences)],
                 'span_layers': [{'id': 'note', 'name': 'Note', 'spans': list(sentence_spans)}],
                 'vocabs': []},
            ],
        }],
    }


def test_the_processor_refuses_to_write_a_document_nobody_holds():
    client = _FakeClient([_document('')])
    with pytest.raises(RuntimeError):
        AlignmentProcessor().process_alignments(
            client, 'd1', [Alignment(text='hello', start=0.0, end=1.0)],
            TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, testing.Helper())
    assert [c for c in client.calls_made if c[0] in ('text_update', 'bulk_create')] == []


def _held_alignments(client, document_id, *args, **kwargs):
    """The processor as a service calls it: inside the lock the service took
    for the whole run (R15)."""
    with locked_for_writes(client, document_id):
        return AlignmentProcessor().process_alignments(client, document_id, *args, **kwargs)


def _run(client, helper=None):
    return _held_alignments(
        client, 'd1', [Alignment(text='hello there', start=0.0, end=1.5)],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, helper or testing.Helper(),
        prov_source='service:asr:test')


def test_a_transcription_is_stamped_machine_made_and_lands_in_one_batch():
    client = _FakeClient([_document('')])
    created = _run(client)
    assert created == 1
    writes = [c for c in client.calls_made if c[0] in ('text_update', 'bulk_create', 'bulk_delete')]
    kinds = [c[0] for c in writes]
    assert kinds[0] == 'text_update'
    token_ops = next(c[1] for c in writes if c[0] == 'bulk_create'
                     and c[1][0]['token_layer_id'] == ALIGN_LAYER)
    assert token_ops[0]['metadata']['prov'] == 'inferred'
    assert token_ops[0]['metadata']['provSource'] == 'service:asr:test'
    assert token_ops[0]['metadata']['timeBegin'] == 0.0


def test_a_persons_sentence_work_stays_and_the_new_segment_is_split_out():
    # REV-R4-TOK F1: the run used to delete every sentence and make a new
    # partition, and the core took the nested words and their glosses with
    # them. Now no sentence is deleted: the new segment's sentence is split
    # out of the one its text went into, which keeps its id and its spans.
    human = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    client = _FakeClient([_document('already here', sentences=[(0, 12)],
                                    align=[(0, 12, 5.0, 6.0)], sentence_spans=[human])])
    assert _run(client) == 1
    assert not any(c[0] == 'bulk_delete' for c in client.calls_made)
    [split] = [c for c in client.calls_made if c[0] == 'split']
    assert split[1:3] == ('s0', 11)  # "hello there" put before "already here"


def test_the_run_never_reads_the_document_back():
    # Core refuses an incomplete or overlapping partition on its own, inside
    # the write, so a read-back to look for one only cost a read
    # (R1-DEBT-CORE-10).
    client = _FakeClient([_document('')])
    _run(client)
    # Once for the version once the lock is held, once by the run.
    assert len(client.reads) == 2


def test_a_segment_that_cannot_be_put_in_time_order_is_refused_before_the_write():
    # The document's segments are out of order in the text (the one at 5 s
    # comes first), so a segment at 3 s has no place that keeps time order.
    # The run refuses before writing, where it wrote and printed a warning.
    client = _FakeClient([_document('aaaaa bbbbb', sentences=[(0, 11)],
                                    align=[(0, 5, 5.0, 6.0), (6, 11, 1.0, 2.0)])])
    with pytest.raises(ValueError) as caught:
        _held_alignments(
            client, 'd1', [Alignment(text='new', start=3.0, end=4.0)],
            TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, testing.Helper(), prov_source='service:asr:test')
    assert 'time order' in str(caught.value)
    assert [c for c in client.calls_made if c[0] in ('text_update', 'bulk_create', 'bulk_delete')] == []


def test_a_segment_in_time_order_is_written():
    client = _FakeClient([_document('aaaaa bbbbb', sentences=[(0, 11)],
                                    align=[(0, 5, 1.0, 2.0), (6, 11, 5.0, 6.0)])])
    assert _held_alignments(
        client, 'd1', [Alignment(text='new', start=3.0, end=4.0)],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, testing.Helper(), prov_source='service:asr:test') == 1


def test_segments_the_model_gives_out_of_order_are_written_in_time_order():
    # REV-DEBT-R1 F2: the model's segments are not always sorted by start.
    # They were placed in the order given, then refused as out of time order
    # on a document with no segments at all.
    client = _FakeClient([_document('')])
    starts = [1.5, 1, 20, 5, 0.25]
    n = _held_alignments(
        client, 'd1', [Alignment(text=f'w{s}', start=s, end=s + 0.1) for s in starts],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, testing.Helper(), prov_source='service:asr:test')
    assert n == 5
    made = next(c[1] for c in client.calls_made if c[0] == 'bulk_create' and c[1][0]['token_layer_id'] == ALIGN_LAYER)
    by_pos = sorted(made, key=lambda t: t['begin'])
    assert [t['metadata']['timeBegin'] for t in by_pos] == sorted(starts)


def test_the_time_order_refusal_names_the_document_segment_in_the_way():
    client = _FakeClient([_document('aaaaa bbbbb', sentences=[(0, 11)],
                                    align=[(0, 5, 5.0, 6.0), (6, 11, 1.0, 2.0)])])
    with pytest.raises(ValueError) as caught:
        _held_alignments(
            client, 'd1', [Alignment(text='new', start=3.0, end=4.0)],
            TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, testing.Helper(), prov_source='service:asr:test')
    assert str(caught.value) == ('The new segment at 3 s has no place in time order: the document\'s segment '
                                 'at 1 s stands after it in the text. Put the document\'s segments in time '
                                 'order first. Nothing was written.')
