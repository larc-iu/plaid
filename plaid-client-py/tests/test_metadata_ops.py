"""metadata_ops turns a top-level fragment into the ops a metadata PATCH
takes, and apply_metadata_ops mirrors the server on a local copy. The
server's rules are in plaid.sql.metadata/patch-metadata!, and these cases
follow its tests."""

import pytest

from plaid_client import apply_metadata_ops, contribute_on_edit, merge_metadata, metadata_ops


def test_metadata_ops_sets_each_key_and_deletes_a_none_one():
    assert metadata_ops({'a': 1, 'b': None, 'c': {'d': 2}}) == [
        {'op': 'set', 'path': ['a'], 'value': 1},
        {'op': 'delete', 'path': ['b']},
        {'op': 'set', 'path': ['c'], 'value': {'d': 2}},
    ]
    assert metadata_ops(None) == []


def test_apply_edits_nested_keys_and_leaves_the_rest():
    m = {'corefud': {'counts': {'c': 9}, 'entities': {'c8': 'animal', 'c9': 'fish'}}, 'other': 1}
    out = apply_metadata_ops(m, [
        {'op': 'set', 'path': ['corefud', 'entities', 'c10'], 'value': 'bird'},
        {'op': 'set', 'path': ['corefud', 'counts', 'c'], 'value': 10},
        {'op': 'delete', 'path': ['corefud', 'entities', 'c8']},
    ])
    assert out == {'corefud': {'counts': {'c': 10}, 'entities': {'c9': 'fish', 'c10': 'bird'}},
                   'other': 1}
    assert m['corefud']['entities'] == {'c8': 'animal', 'c9': 'fish'}, 'input untouched'


def test_set_creates_missing_objects_stores_none_and_one_key_replaces_whole():
    assert apply_metadata_ops({}, [{'op': 'set', 'path': ['a', 'b'], 'value': None}]) == {'a': {'b': None}}
    assert apply_metadata_ops({'a': {'x': 1}}, [{'op': 'set', 'path': ['a'], 'value': {'y': 2}}]) == {'a': {'y': 2}}


def test_delete_of_an_absent_key_or_under_an_absent_object_is_a_noop():
    m = {'a': 1}
    assert apply_metadata_ops(m, [{'op': 'delete', 'path': ['b']},
                                  {'op': 'delete', 'path': ['b', 'c']}]) == m


@pytest.mark.parametrize('m, op', [
    ({'s': 'x'}, {'op': 'set', 'path': ['s', 't'], 'value': 1}),
    ({'l': [1]}, {'op': 'delete', 'path': ['l', '0']}),
    ({}, {'op': 'set', 'path': [], 'value': 1}),
    ({}, {'op': 'set', 'path': ['a']}),
    ({}, {'op': 'merge', 'path': ['a'], 'value': 1}),
])
def test_what_the_server_refuses_raises(m, op):
    with pytest.raises(ValueError):
        apply_metadata_ops(m, [op])


def test_merge_metadata_is_apply_over_metadata_ops():
    m = {'prov': 'inferred', 'provConfirmed': True, 'keep': 1}
    fragment = contribute_on_edit(m, 'u@example.org')
    assert merge_metadata(m, fragment) == apply_metadata_ops(m, metadata_ops(fragment))
