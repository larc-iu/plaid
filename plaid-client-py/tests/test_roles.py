"""Tests for the shared layer-role vocabulary (the Python peer of roles.js).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import (
    ROLES,
    PLAID_NAMESPACE,
    ROLE_KEY,
    read_role,
    find_by_role,
    is_ud_project,
)


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


def _project(role, span_config, camel=False):
    """The shape ``client.projects.get`` hands back: snake_case structural
    keys. ``camel`` builds the wire's own spelling instead, which a caller
    that decoded a response body itself would have."""
    k = (('textLayers', 'tokenLayers', 'spanLayers') if camel
         else ('text_layers', 'token_layers', 'span_layers'))
    return {
        k[0]: [
            {
                k[1]: [
                    {
                        'config': {'plaid': {'role': role}},
                        k[2]: [{'config': span_config}],
                    }
                ]
            }
        ]
    }


def test_is_ud_project_reads_the_structure_ud_alone_writes():
    # The ROLE alone does not answer it: plaid-igt tags a morpheme layer and
    # can carry syntactic-word too. The `ud` namespace on the span layers does.
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, {'ud': {'upos': True}})) is True
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, {'igt': {'gloss': True}})) is False
    # Right namespace, wrong layer: annotations hang off syntactic-word in UD.
    assert is_ud_project(_project(ROLES.MORPHEME, {'ud': {'upos': True}})) is False
    # A `ud` key that is not a namespace object says nothing.
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, {'ud': 'yes'})) is False
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, {})) is False
    assert is_ud_project({'text_layers': []}) is False
    assert is_ud_project({}) is False
    assert is_ud_project(None) is False


def test_is_ud_project_reads_both_spellings_of_the_structural_keys():
    """The client recases structural keys, so a project read through it says
    `text_layers` where the wire says `textLayers`. Reading only the wire's
    spelling made this answer False for every real project."""
    ud = {'ud': {'upos': True}}
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, ud)) is True
    assert is_ud_project(_project(ROLES.SYNTACTIC_WORD, ud, camel=True)) is True


if __name__ == '__main__':
    test_role_values_match_the_interop_contract()
    test_read_role()
    test_find_by_role_returns_first_match_else_none()
    test_is_ud_project_reads_the_structure_ud_alone_writes()
    print('roles tests passed')
