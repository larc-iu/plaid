"""Tests for the shared layer-role vocabulary (the Python peer of roles.js).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import ROLES, PLAID_NAMESPACE, ROLE_KEY, read_role, find_by_role


def test_role_values_match_the_interop_contract():
    # These literal strings ARE the cross-app contract (must match roles.js).
    assert (PLAID_NAMESPACE, ROLE_KEY) == ('plaid', 'role')
    assert ROLES.BASELINE == 'baseline'
    assert ROLES.SENTENCE == 'sentence'
    assert ROLES.WORD == 'word'
    assert ROLES.SYNTACTIC_WORD == 'syntactic-word'
    assert ROLES.MORPHEME == 'morpheme'
    assert ROLES.TIME_ALIGNMENT == 'time-alignment'


def test_read_role():
    assert read_role({'plaid': {'role': 'baseline'}}) == 'baseline'
    assert read_role({'plaid': {}}) is None      # namespace present, no role
    assert read_role({'other': {'role': 'x'}}) is None  # wrong namespace
    assert read_role({}) is None
    assert read_role(None) is None


def test_find_by_role_returns_first_match_else_none():
    layers = [
        {'id': 'a', 'config': {'plaid': {'role': 'sentence'}}},
        {'id': 'b', 'config': {'plaid': {'role': 'word'}}},
        {'id': 'c', 'config': {'plaid': {'role': 'word'}}},  # dup: first wins
        {'id': 'd'},  # no config at all — tolerated
    ]
    assert find_by_role(layers, ROLES.SENTENCE)['id'] == 'a'
    assert find_by_role(layers, ROLES.WORD)['id'] == 'b'
    # No silent positional fallback: a missing role yields None, not layers[0].
    assert find_by_role(layers, ROLES.BASELINE) is None
    assert find_by_role([], ROLES.WORD) is None
    assert find_by_role(None, ROLES.WORD) is None


if __name__ == '__main__':
    test_role_values_match_the_interop_contract()
    test_read_role()
    test_find_by_role_returns_first_match_else_none()
    print('roles tests passed')
