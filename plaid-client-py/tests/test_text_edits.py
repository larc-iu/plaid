"""compose_text_edits, gaps_to_ops and apply_text_ops. The cases are the JS
client's test/fixtures/text-edits.json, shared with the core, so the three
composers agree."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.text_edits import apply_text_ops, compose_text_edits, gaps_to_ops

FIXTURE = os.path.join(os.path.dirname(__file__), '..', '..', 'plaid-client-js', 'test',
                       'fixtures', 'text-edits.json')

with open(FIXTURE, encoding='utf-8') as f:
    CASES = json.load(f)


@pytest.mark.parametrize('case', CASES, ids=[c['name'] for c in CASES])
def test_fixture(case):
    assert compose_text_edits(case['body'], case['ops']) == case['gaps']
    assert apply_text_ops(case['body'], case['ops']) == case['result']
    assert apply_text_ops(case['body'], gaps_to_ops(case['gaps'])) == case['result']


def test_gaps_to_ops_gives_insert_delete_or_replace_in_running_coordinates():
    assert gaps_to_ops([
        {'start': 0, 'end': 0, 'value': 'ab'},
        {'start': 2, 'end': 4, 'value': ''},
        {'start': 6, 'end': 7, 'value': 'xyz'},
    ]) == [
        {'type': 'insert', 'index': 0, 'value': 'ab'},
        {'type': 'delete', 'index': 4, 'value': 2},
        {'type': 'replace', 'index': 6, 'length': 1, 'value': 'xyz'},
    ]


@pytest.mark.parametrize('op', [
    None,
    {'type': 'insert', 'index': 0},
    {'type': 'insert', 'index': 0.5, 'value': 'a'},
    {'type': 'insert', 'index': True, 'value': 'a'},
    {'type': 'delete', 'index': 0, 'value': 'a'},
    {'type': 'replace', 'index': 0, 'value': 'a'},
    {'type': 'move', 'index': 0, 'value': 1},
])
def test_a_malformed_op_raises(op):
    with pytest.raises(ValueError, match='Malformed text edit operation'):
        compose_text_edits('abc', [op])
    with pytest.raises(ValueError, match='Malformed text edit operation'):
        apply_text_ops('abc', [op])


@pytest.mark.parametrize('op', [
    {'type': 'insert', 'index': 3, 'value': 'a'},
    {'type': 'insert', 'index': -1, 'value': 'a'},
    {'type': 'delete', 'index': 1, 'value': 2},
    {'type': 'delete', 'index': 0, 'value': -1},
    {'type': 'replace', 'index': 2, 'length': 1, 'value': 'a'},
])
def test_an_op_out_of_bounds_raises_counting_code_points(op):
    with pytest.raises(ValueError, match='out of bounds.*2 code points'):
        compose_text_edits('\U00010330\U00010331', [op])


def test_an_op_is_checked_against_the_body_the_ops_before_it_left():
    with pytest.raises(ValueError, match='out of bounds'):
        compose_text_edits('ab', [{'type': 'delete', 'index': 0, 'value': 1},
                                  {'type': 'delete', 'index': 1, 'value': 1}])


def _rng(seed):
    """splitmix32, as the JS test uses: full period over 2**32 seeds."""
    state = [seed & 0xFFFFFFFF]

    def draw():
        state[0] = (state[0] + 0x9E3779B9) & 0xFFFFFFFF
        z = state[0]
        z = ((z ^ (z >> 16)) * 0x85EBCA6B) & 0xFFFFFFFF
        z = ((z ^ (z >> 13)) * 0xC2B2AE35) & 0xFFFFFFFF
        return ((z ^ (z >> 16)) & 0xFFFFFFFF) / 4294967296
    return draw


ALPHABET = ['a', 'b', 'c', ' ', '\U00010330', '\U0001F600', 'e', '\u0301', '\n']


def _text(r, most):
    return ''.join(ALPHABET[int(r() * len(ALPHABET))] for _ in range(int(r() * most)))


def _ops(r, body):
    ops = []
    length = len(body)
    for _ in range(int(r() * 12)):
        kind = r()
        index = int(r() * (length + 1))
        if kind < 0.45:
            value = _text(r, 4)
            ops.append({'type': 'insert', 'index': index, 'value': value})
            length += len(value)
        elif kind < 0.8:
            value = int(r() * (length - index + 1))
            ops.append({'type': 'delete', 'index': index, 'value': value})
            length -= value
        else:
            size = int(r() * (length - index + 1))
            value = _text(r, 4)
            ops.append({'type': 'replace', 'index': index, 'length': size, 'value': value})
            length += len(value) - size
    return ops


def test_property_composed_ops_make_the_same_body_and_composing_again_is_stable():
    r = _rng(20260930)
    for _ in range(3000):
        body = _text(r, 10)
        ops = _ops(r, body)
        gaps = compose_text_edits(body, ops)
        composed = gaps_to_ops(gaps)
        assert apply_text_ops(body, composed) == apply_text_ops(body, ops), (body, ops)
        for i, g in enumerate(gaps):
            assert g['start'] <= g['end'] <= len(body), (body, ops, gaps)
            assert g['value'] != body[g['start']:g['end']]
            if i:
                assert gaps[i - 1]['end'] < g['start'], (body, ops, gaps)
        assert compose_text_edits(body, composed) == gaps, (body, ops)
