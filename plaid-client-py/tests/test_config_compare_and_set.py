"""A config write that names the value it read is a compare-and-set:
``?if-unchanged=true`` with the body ``{expected, value}``. The server's side
is plaid-core's config-compare-and-set-test, the JS side
``plaid-client-js/test/configCompareAndSet.test.js``. Network-free: a batch
queues the op exactly as it would go out."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient

BUNDLES = ['projects', 'text_layers', 'token_layers', 'span_layers', 'relation_layers', 'vocab_layers']


def _queued(fn):
    client = PlaidClient('http://localhost:0', 'dummy-token')
    b = client.batch()
    fn(b)
    ops = [dict(op) for op in b.operations]
    b.abort()
    return ops


@pytest.mark.parametrize('bundle', BUNDLES)
def test_set_config_without_expected_sends_the_value(bundle):
    [op] = _queued(lambda b: getattr(b, bundle).set_config('L1', 'igt', 'tagsets', {'a-b': 1}))
    assert op['method'] == 'PUT'
    assert 'if-unchanged' not in op['path']
    assert op['body'] == {'a-b': 1}


@pytest.mark.parametrize('bundle', BUNDLES)
def test_set_config_with_expected_sends_the_envelope(bundle):
    [op] = _queued(lambda b: getattr(b, bundle).set_config(
        'L1', 'igt', 'tagsets', {'new-key': 2}, expected={'old-key': 1}))
    assert 'if-unchanged=true' in op['path']
    assert op['body'] == {'expected': {'old-key': 1}, 'value': {'new-key': 2}}


@pytest.mark.parametrize('bundle', BUNDLES)
def test_delete_config_with_expected_sends_it(bundle):
    [op] = _queued(lambda b: getattr(b, bundle).delete_config(
        'L1', 'ud', 'language', 'Clear it', expected='en'))
    assert op['method'] == 'DELETE'
    assert 'if-unchanged=true' in op['path']
    assert 'audit-message=Clear' in op['path']
    assert op['body'] == {'expected': 'en'}


def test_expected_none_means_the_key_was_absent():
    [op] = _queued(lambda b: b.projects.set_config('P1', 'igt', 'languages', {'object': 'Lezgian'}, expected=None))
    assert 'if-unchanged=true' in op['path']
    assert op['body'] == {'expected': None, 'value': {'object': 'Lezgian'}}


def test_delete_config_without_expected_sends_no_body():
    [op] = _queued(lambda b: b.projects.delete_config('P1', 'ud', 'language'))
    assert 'if-unchanged' not in op['path']
    assert 'body' not in op or op['body'] is None
