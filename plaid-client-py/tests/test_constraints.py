"""Layer constraint writes: paths, bodies and kebab keys on the wire, the
compare-and-set's ``expected``, ``violations_of``, and the fake's methods.
The server's side is plaid-core's layer-constraints-test, the JS side
``plaid-client-js/test/constraints.test.js``. Network-free: a batch queues
the op exactly as it would go out."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import CONSTRAINT_TYPES, PlaidAPIError, PlaidClient, violations_of
from plaid_client.testing import FakeClient

BUNDLES = {'token_layers': 'token-layers', 'span_layers': 'span-layers', 'relation_layers': 'relation-layers'}


def _queued(fn):
    client = PlaidClient('http://localhost:0', 'dummy-token')
    b = client.batch()
    fn(b)
    ops = [dict(op) for op in b.operations]
    b.abort()
    return ops


@pytest.mark.parametrize('bundle,kind', BUNDLES.items())
def test_set_constraints_sends_the_list_with_kebab_keys(bundle, kind):
    [op] = _queued(lambda b: getattr(b, bundle).set_constraints(
        'L1', 'igt', [{'type': 'single-span', 'join_with': '+'}], 'Set up'))
    assert op['method'] == 'PUT'
    assert op['path'].startswith(f'/api/v1/{kind}/L1/constraints/igt')
    assert 'audit-message=Set' in op['path']
    assert op['body'] == {'constraints': [{'type': 'single-span', 'join-with': '+'}]}


@pytest.mark.parametrize('bundle', BUNDLES)
def test_expected_none_versus_absent(bundle):
    [cas] = _queued(lambda b: getattr(b, bundle).set_constraints('L1', 'ud', [], expected=None))
    assert cas['body'] == {'constraints': [], 'expected': None}
    [plain] = _queued(lambda b: getattr(b, bundle).set_constraints('L1', 'ud', []))
    assert plain['body'] == {'constraints': []}


@pytest.mark.parametrize('bundle', BUNDLES)
def test_delete_constraints_sends_expected_only_when_given(bundle):
    [plain] = _queued(lambda b: getattr(b, bundle).delete_constraints('L1', 'ud'))
    assert plain['method'] == 'DELETE'
    assert not plain.get('body')
    [cas] = _queued(lambda b: getattr(b, bundle).delete_constraints(
        'L1', 'ud', expected=[{'type': 'coextensive'}]))
    assert cas['body'] == {'expected': [{'type': 'coextensive'}]}


@pytest.mark.parametrize('bundle,kind', BUNDLES.items())
def test_check_and_repair_post_the_list(bundle, kind):
    check, repair = _queued(lambda b: (
        getattr(b, bundle).check_constraints('L1', [{'type': 'value-set', 'values': ['N', 'V']}]),
        getattr(b, bundle).repair_constraints('L1', [{'type': 'same-ancestor', 'token_layer': 'S'}])))
    assert check['path'].startswith(f'/api/v1/{kind}/L1/constraints/check')
    assert check['body'] == {'constraints': [{'type': 'value-set', 'values': ['N', 'V']}]}
    assert repair['path'].startswith(f'/api/v1/{kind}/L1/constraints/repair')
    assert repair['body']['constraints'][0]['token-layer'] == 'S'


def test_values_are_never_recased():
    [op] = _queued(lambda b: b.span_layers.set_constraints(
        'L1', 'igt', [{'type': 'value-set', 'values': ['snake_case', '1SG']}]))
    assert op['body']['constraints'][0]['values'] == ['snake_case', '1SG']


def test_violations_of_reads_a_422():
    err = PlaidAPIError('HTTP 422', status=422, response_data={
        'error': 'A token is in 2 spans',
        'violations': [{'constraint': 'single-span', 'layer-name': 'Gloss', 'ids': ['a', 'b']}],
        'violation-count': 1})
    assert violations_of(err) == [{'constraint': 'single-span', 'layer_name': 'Gloss', 'ids': ['a', 'b']}]
    assert violations_of(PlaidAPIError('x', status=422, response_data={'error': 'idempotency-key-reused'})) is None
    assert violations_of(PlaidAPIError('x', status=409, response_data={'violations': []})) is None
    assert violations_of(ValueError('x')) is None


def test_constraint_types():
    assert len(CONSTRAINT_TYPES) == 7
    assert 'same-ancestor' in CONSTRAINT_TYPES


def test_the_fake_records_the_four_methods():
    fake = FakeClient([{'id': 'd1'}])
    fake.span_layers.set_constraints('L1', 'igt', [{'type': 'single-span'}])
    assert fake.span_layers.check_constraints('L1', [{'type': 'single-span'}]) == {
        'violations': [], 'violation_count': 0}
    fake.token_layers.repair_constraints('L2', [{'type': 'coextensive'}])
    fake.relation_layers.delete_constraints('L3', 'ud')
    kinds = [k for k, _ in fake.calls]
    assert kinds == ['span_layers.set_constraints', 'span_layers.check_constraints',
                     'token_layers.repair_constraints', 'relation_layers.delete_constraints']
