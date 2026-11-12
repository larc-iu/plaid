"""What a vocabulary delete, a project delete or an unlink would take is a GET
on a route of its own (``vocab_layers.deletion``, ``projects.deletion``,
``projects.vocab_unlinking``), never the destructive request with a flag. The
destructive methods take no ``dry_run`` any more, so one passed (a caller from
before) is a TypeError before anything is sent. The same as plaid-client-js's
test/destructiveReads.test.js."""

import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.testing import Response, recording_session


def _client(status, body):
    c = PlaidClient('http://plaid.test', 'tok', retry_delays=[])
    c.session = recording_session(lambda request: Response(status, body))
    return c


READS = [
    (lambda c: c.vocab_layers.deletion('v1'), '/api/v1/vocab-layers/v1/deletion', {'links': 4}),
    (lambda c: c.projects.deletion('p1'), '/api/v1/projects/p1/deletion',
     {'vocabularies': [{'id': 'v1', 'name': 'Lex'}]}),
    (lambda c: c.projects.vocab_unlinking('p2', 'v1'), '/api/v1/projects/p2/vocabs/v1/unlinking', {'links': 3}),
]


@pytest.mark.parametrize('fn,path,answer', READS)
def test_each_read_is_a_get_on_its_own_route_with_no_query(fn, path, answer):
    c = _client(200, answer)
    assert fn(c) == answer
    assert len(c.session.sent) == 1
    sent = c.session.sent[0]
    assert sent['method'] == 'GET'
    assert urlparse(sent['url']).path == path
    assert urlparse(sent['url']).query == ''


def test_a_read_refused_keeps_cores_count_of_the_projects_in_the_way():
    c = _client(409, {'error': '2 other projects use this vocabulary.', 'other-projects': 2})
    with pytest.raises(PlaidAPIError) as e:
        c.vocab_layers.deletion('v1')
    assert e.value.status == 409
    assert e.value.response_data['other-projects'] == 2


@pytest.mark.parametrize('fn', [
    lambda c: c.vocab_layers.delete('v1', dry_run=True),
    lambda c: c.projects.delete('p1', dry_run=True),
    lambda c: c.projects.unlink_vocab('p2', 'v1', dry_run=True),
])
def test_a_leftover_dry_run_is_a_type_error_and_sends_nothing(fn):
    c = _client(204, None)
    with pytest.raises(TypeError):
        fn(c)
    assert c.session.sent == []


def test_the_destructive_methods_still_send_the_plain_request():
    for fn, path in [(lambda c: c.vocab_layers.delete('v1'), '/api/v1/vocab-layers/v1'),
                     (lambda c: c.projects.delete('p1'), '/api/v1/projects/p1'),
                     (lambda c: c.projects.unlink_vocab('p2', 'v1'), '/api/v1/projects/p2/vocabs/v1')]:
        c = _client(204, None)
        fn(c)
        sent = c.session.sent[0]
        assert sent['method'] == 'DELETE'
        assert urlparse(sent['url']).path == path
        assert 'dry-run' not in urlparse(sent['url']).query
