"""The fake client's model of what a delete takes with it.

The fake records a write and does not apply it, so a test that read the log
for what was deleted saw only what the code named. Core deletes more: the
tokens nested under a deleted one, the spans and links left with none of
their tokens, and the relations on those spans. Transcribe once wiped every
word of a document behind a test whose fake did not cascade (REV-R4-TOK F1).
``cascaded`` and ``cascaded_work`` say what core would take, read from the
fixture as given.
"""

import copy

from plaid_client import testing

SENT, WORD, MORPH, NODES = 'k-sent', 'k-word', 'k-morph', 'k-nodes'


def _doc():
    return {
        'id': 'd1', 'name': 'D', 'version': 1,
        'text_layers': [{'id': 'tl', 'text': {'id': 't1', 'body': 'ab cd'}, 'token_layers': [
            {'id': SENT, 'parent_token_layer': None, 'overlap_mode': 'partitioning',
             'tokens': [{'id': 's1', 'begin': 0, 'end': 5}],
             'span_layers': [{'id': 'sl-tr', 'spans': [{'id': 'tr', 'value': 'T', 'tokens': ['s1']}]}]},
            {'id': WORD, 'parent_token_layer': SENT,
             'tokens': [{'id': 'w1', 'begin': 0, 'end': 2}, {'id': 'w2', 'begin': 3, 'end': 5}],
             'span_layers': [{'id': 'sl-g', 'spans': [
                 {'id': 'g1', 'value': 'G1', 'tokens': ['w1']},
                 {'id': 'g12', 'value': 'both', 'tokens': ['w1', 'w2']}],
                 'relation_layers': [{'id': 'rl', 'relations': [
                     {'id': 'r1', 'source': 'g1', 'target': 'g12', 'value': 'x'}]}]}],
             'vocabs': [{'id': 'v', 'vocab_links': [
                 {'id': 'l1', 'vocab_item': {'id': 'vi1'}, 'tokens': ['w1']},
                 {'id': 'l12', 'vocab_item': {'id': 'vi2'}, 'tokens': ['w1', 'w2'],
                  'metadata': {'prov': 'inferred', 'provSource': 'service:x'}}]}]},
            {'id': MORPH, 'parent_token_layer': WORD,
             'tokens': [{'id': 'm1', 'begin': 0, 'end': 2, 'metadata': {'form': 'a'}},
                        {'id': 'm2', 'begin': 3, 'end': 5}],
             'span_layers': [{'id': 'sl-mg', 'spans': [{'id': 'mg1', 'value': 'M', 'tokens': ['m1']}]}]},
            {'id': NODES, 'parent_token_layer': None,
             'tokens': [{'id': 'n1', 'begin': 0, 'end': 2}],
             'span_layers': [{'id': 'sl-c', 'spans': [{'id': 'c1', 'value': 'C', 'tokens': ['n1']}]}]},
        ]}],
    }


def _taken(client):
    return sorted(e['id'] for e in client.cascaded)


def test_a_token_takes_what_is_nested_in_it_and_what_is_on_that():
    c = testing.FakeClient({'d1': _doc()})
    c.tokens.delete('w1')
    # m1 under it, g1 and mg1 left with no token, r1 on g1, l1. g12 and l12
    # keep w2 and are only cut down. The node over the same letters is on a
    # root layer and stays.
    assert _taken(c) == ['g1', 'l1', 'm1', 'mg1', 'r1']


def test_a_partition_reset_takes_everything_under_it():
    c = testing.FakeClient({'d1': _doc()})
    c.tokens.bulk_delete(['s1'])
    assert _taken(c) == ['g1', 'g12', 'l1', 'l12', 'm1', 'm2', 'mg1', 'r1', 'tr', 'w1', 'w2']


def test_a_span_takes_its_relations_and_an_entry_its_links():
    c = testing.FakeClient({'d1': _doc()})
    c.spans.delete('g12')
    c.vocab_items.delete('vi2')
    assert _taken(c) == ['l12', 'r1']


def test_the_work_lost_leaves_out_what_was_named_bare_tokens_and_nothing_else():
    c = testing.FakeClient({'d1': _doc()})
    c.tokens.bulk_delete(['s1'])
    c.spans.delete('tr')  # named too
    work = sorted(e['id'] for e in c.cascaded_work())
    # w1 and w2 are bare substrate, m2 too. m1 has a segmentation of its own.
    # The machine-made link counts: whether to protect it is the caller's.
    assert work == ['g1', 'g12', 'l1', 'l12', 'm1', 'mg1', 'r1']


def test_a_batch_cascades_when_it_submits_and_not_when_it_aborts():
    c = testing.FakeClient({'d1': _doc()})
    try:
        with c.batched() as b:
            b.tokens.delete('w1')
            assert c.cascaded == []
            raise RuntimeError('stop')
    except RuntimeError:
        pass
    assert c.cascaded == []
    with c.batched() as b:
        b.tokens.delete('w1')
    assert _taken(c) == ['g1', 'l1', 'm1', 'mg1', 'r1']
    assert {e['by'] for e in c.cascaded} == {'tokens.delete'}


def test_a_fixture_that_does_not_name_parents_nests_by_role():
    doc = _doc()
    project = {'id': 'p', 'text_layers': [{'id': 'tl', 'token_layers': [
        {'id': SENT, 'config': {'plaid': {'role': 'sentence'}}},
        {'id': WORD, 'config': {'plaid': {'role': 'word'}}},
        {'id': MORPH, 'config': {'plaid': {'role': 'morpheme'}}}]}]}
    for layer in doc['text_layers'][0]['token_layers']:
        layer.pop('parent_token_layer')
    c = testing.FakeClient({'d1': copy.deepcopy(doc)}, project=project)
    c.tokens.delete('w1')
    assert _taken(c) == ['g1', 'l1', 'm1', 'mg1', 'r1']
