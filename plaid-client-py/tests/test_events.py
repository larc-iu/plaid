"""The events resource: research telemetry reads, and the raw write a script
uses (the browser's buffered recorder is JavaScript only)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    headers = {'content-type': 'application/json'}

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def _client(bodies):
    client = PlaidClient('http://x', 'tok')
    sent = []
    bodies = iter(bodies)

    class _Session:
        def request(self, **kw):
            sent.append(kw)
            return _Resp(next(bodies))

    client.session = _Session()
    return client, sent


def test_list_pages_through_a_projects_events_with_its_filters():
    client, sent = _client([
        {'entries': [{'client-event/id': 1, 'client-event/type': 'suggestion.shown',
                      'client-event/target-id': 't1',
                      'client-event/data': {'value': 'dog', 'source': 'precedent'}}],
         'next-cursor': 'k'},
        {'entries': [{'client-event/id': 2, 'client-event/type': 'suggestion.adopted'}],
         'next-cursor': None},
    ])
    got = client.events.list('p1', types=['suggestion.shown', 'suggestion.adopted'],
                             start_time='2026-09-29T00:00:00Z')
    assert [e['id'] for e in got] == [1, 2]
    assert got[0]['target_id'] == 't1'
    assert got[0]['data'] == {'value': 'dog', 'source': 'precedent'}
    url = sent[0]['url']
    assert url.startswith('http://x/api/v1/projects/p1/events?')
    assert 'types=suggestion.shown%2Csuggestion.adopted' in url
    assert 'start-time=2026-09-29T00%3A00%3A00Z' in url
    assert 'cursor=k' in sent[1]['url']


def test_list_page_and_iter_pages_take_the_same_filters():
    client, sent = _client([{'entries': [], 'next-cursor': None}] * 2)
    page = client.events.list_page('p1', types='plan.opened', limit=5)
    assert page['entries'] == [] and page['next_cursor'] is None
    assert 'types=plan.opened' in sent[0]['url'] and 'limit=5' in sent[0]['url']
    assert list(client.events.iter_pages('p1', end_time='2026-09-30T00:00:00Z', page_size=7)) == []
    assert 'end-time=' in sent[1]['url'] and 'limit=7' in sent[1]['url']


def test_create_posts_an_array_in_the_wire_spelling():
    client, sent = _client([{'count': 1}])
    assert client.events.create('p1', [{'type': 'suggestion.adopted', 'document_id': 'd1',
                                        'target_id': 't1', 'data': {'value': 'dog'}}]) == {'count': 1}
    assert sent[0]['method'] == 'POST'
    assert sent[0]['url'] == 'http://x/api/v1/projects/p1/events'
    body = sent[0].get('json')
    if body is None:
        body = json.loads(sent[0]['data'])
    assert body == [{'type': 'suggestion.adopted', 'document-id': 'd1', 'target-id': 't1',
                     'data': {'value': 'dog'}}]


def test_create_is_not_part_of_an_open_operation():
    client, sent = _client([{'count': 0}])
    client.begin_operation('Glossing')
    client.events.create('p1', [])
    assert 'group-id' not in sent[0]['url']
