"""Regression tests for request key-recasing vs query field paths / bindings.

The query language addresses fields with dotted string *values* (``?s.metadata.caseKey``)
and carries ``bindings`` keyed by ``?name`` placeholders. The client recases object
*keys* (camel/snake <-> kebab) but must NEVER touch string *values*, and must pass the
``bindings`` subtree through verbatim (it is in ``OPAQUE_KEYS``). Otherwise a
case-sensitive metadata/config key inside a path would be silently mangled in transit.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q

or with no dependencies::

    python tests/test_transforms.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.transforms import transform_request


def test_field_path_value_is_not_recased():
    # a dotted field path is a string VALUE, so it is never recased (the camelCase
    # metadata key inside it survives); real top-level KEYS still recase.
    out = transform_request({
        'find': ['?s'],
        'where': [['span', '?s', {'layer': 'pos'}],
                  ['>=', '?s.metadata.caseKey', 5]],
        'strict_layers': True,
    })
    assert out['where'][1] == ['>=', '?s.metadata.caseKey', 5]   # path value verbatim
    assert 'strict-layers' in out and 'strict_layers' not in out  # a key DID recase


def test_bindings_keys_and_values_pass_through_verbatim():
    out = transform_request({
        'find': ['?s'],
        'where': [['span', '?s', {'layer': '?lyr'}]],
        'bindings': {'?lyr': '0194-uuid', '?tags': ['NOUN', 'PROPN']},
    })
    assert out['bindings'] == {'?lyr': '0194-uuid', '?tags': ['NOUN', 'PROPN']}


def test_layer_structural_slot_keys_recase():
    # the layer structural slots (text-layer, parent-token-layer, token-layer,
    # span-layer) are object KEYS inside a clause's constraint map, so they recase
    # snake <-> kebab like any key; the layer-reference VALUE is a string and is
    # left verbatim. Clause heads are literal strings (write them kebab).
    out = transform_request({
        'find': ['?s'],
        'where': [['span', '?s', {'layer': '?sl'}],
                  ['span-layer', '?sl', {'token_layer': '?tl'}],
                  ['token-layer', '?tl', {'text_layer': 'Transcription',
                                          'parent_token_layer': '?p'}]],
    })
    assert out['where'][1][2] == {'token-layer': '?tl'}
    assert out['where'][2][2] == {'text-layer': 'Transcription',
                                  'parent-token-layer': '?p'}


if __name__ == '__main__':
    test_field_path_value_is_not_recased()
    test_bindings_keys_and_values_pass_through_verbatim()
    test_layer_structural_slot_keys_recase()
    print('ok')
