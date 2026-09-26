"""metadata_ops turns a top-level fragment into the ops a metadata PATCH
takes, and apply_metadata_ops mirrors the server on a local copy. The
server's rules are in plaid.sql.metadata/patch-metadata!, and the cases are
the shared table in plaid-core/src/test/plaid/sql/metadata_op_cases.json."""

import json
import re
from pathlib import Path

import pytest

from plaid_client import (
    apply_metadata_ops,
    contribute_on_edit,
    is_reserved_metadata_key,
    merge_metadata,
    metadata_ops,
)


def test_metadata_ops_sets_each_key_and_deletes_a_none_one():
    assert metadata_ops({'a': 1, 'b': None, 'c': {'d': 2}}) == [
        {'op': 'set', 'path': ['a'], 'value': 1},
        {'op': 'delete', 'path': ['b']},
        {'op': 'set', 'path': ['c'], 'value': {'d': 2}},
    ]
    assert metadata_ops(None) == []


def test_apply_leaves_its_input_alone():
    m = {'corefud': {'entities': {'c8': 'animal', 'c9': 'fish'}}}
    apply_metadata_ops(m, [
        {'op': 'set', 'path': ['corefud', 'entities', 'c10'], 'value': 'bird'},
        {'op': 'delete', 'path': ['corefud', 'entities', 'c8']},
    ])
    assert m == {'corefud': {'entities': {'c8': 'animal', 'c9': 'fish'}}}


# The case table plaid-core and plaid-client-js run too.
CASES = json.loads(
    (Path(__file__).resolve().parents[2] / 'plaid-core' / 'src' / 'test' / 'plaid' / 'sql'
     / 'metadata_op_cases.json').read_text(encoding='utf-8'))['cases']


def test_the_shared_case_table_is_there():
    assert len(CASES) > 40


@pytest.mark.parametrize('case', CASES, ids=[c['name'] for c in CASES])
def test_shared_case(case):
    if 'error' in case:
        with pytest.raises(ValueError, match=re.escape(case['error'])):
            apply_metadata_ops(case['metadata'], case['ops'])
    else:
        assert apply_metadata_ops(case['metadata'], case['ops']) == case['result']


@pytest.mark.parametrize('key', ['plaid', 'prov', 'provSource', 'provConfirmed', 'provProb', 'provDetail'])
def test_the_plaid_namespace_and_the_provenance_keys_are_reserved(key):
    assert is_reserved_metadata_key(key)


@pytest.mark.parametrize('key', ['Plaid', 'plaid.x', 'author', 'review', 'provenance', ''])
def test_any_other_key_is_not_reserved(key):
    assert not is_reserved_metadata_key(key)


def test_merge_metadata_is_apply_metadata_ops_over_metadata_ops():
    m = {'prov': 'inferred', 'provConfirmed': True, 'keep': 1}
    fragment = contribute_on_edit(m, 'u@example.org')
    assert merge_metadata(m, fragment) == apply_metadata_ops(m, metadata_ops(fragment))
    assert merge_metadata(None, None) == {}


@pytest.mark.parametrize('key', ['', '   ', 'a' * 201, 'a\x01b'])
def test_merge_metadata_refuses_a_key_the_server_refuses(key):
    with pytest.raises(ValueError, match='Invalid metadata key'):
        merge_metadata({}, {key: 1})
