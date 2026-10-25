"""A vocabulary's history: the whole vocabulary at a time, one entry at a
time (also after it was deleted), its audit log, and putting one entry back.
The restore bumps every document linking the entry when it sets the form
back, so its X-Document-Versions (or the omitted marker) is taken up like any
write's. What each read sends is in the shared request table
(``test_requests.py``). Here: what the answers become."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.testing import Response, recording_session

T = '2026-06-01T12:00:00Z'


def _query(request):
    return {k: v[0] for k, v in parse_qs(urlparse(request['url']).query).items()}


def _stub(client, answer):
    """Each request answered by ``answer(path, query)``. Returns the requests
    sent."""
    client.session = recording_session(lambda request: answer(urlparse(request['url']).path, _query(request)))
    return client.session.sent


def test_the_vocabulary_read_and_one_entrys_read_are_recased():
    c = PlaidClient('http://x', 'tok')
    _stub(c, lambda path, q: Response(200, 
        {'vocab-item/id': 'i1', 'vocab-item/form': 'kai'} if '/items/' in path else
        {'vocab/id': 'v1', 'vocab/name': 'Lex',
         'vocab/items': [{'vocab-item/id': 'i1', 'vocab-item/form': 'kai'}]}))
    at = c.vocab_layers.get('v1', include_items=True, as_of=T)
    assert at['name'] == 'Lex' and at['items'] == [{'id': 'i1', 'form': 'kai'}]
    assert c.vocab_layers.get_item_at('v1', 'i1', T) == {'id': 'i1', 'form': 'kai'}


def test_the_vocabulary_log_pages_as_the_document_log_does():
    c = PlaidClient('http://x', 'tok')

    def answer(path, q):
        if q.get('cursor'):
            return Response(200, {'entries': [{'audit/id': 'a2'}], 'next-cursor': None})
        return Response(200, {'entries': [{'audit/id': 'a1'}], 'next-cursor': 'k'})

    sent = _stub(c, answer)
    assert [e['id'] for e in c.vocab_layers.audit('v1')] == ['a1', 'a2']
    assert _query(sent[1])['cursor'] == 'k'
    page = c.vocab_layers.audit_page('v1', limit=1)
    assert page == {'entries': [{'id': 'a1'}], 'next_cursor': 'k'}


def test_an_entry_restore_takes_up_the_linking_documents_new_versions():
    c = PlaidClient('http://x', 'tok')
    c.document_versions.update({'d1': 3, 'd9': 1})
    _stub(c, lambda path, q: Response(200, {'inserted': False, 'form': True, 'metadata': False, 'total': 1},
                                   {'X-Document-Versions': json.dumps({'d1': 4, 'd2': 8})}))
    summary = c.vocab_layers.restore_item('v1', 'i1', T)
    assert summary == {'inserted': False, 'form': True, 'metadata': False, 'total': 1}
    assert c.document_versions == {'d1': 4, 'd2': 8, 'd9': 1}


def test_past_fifty_linking_documents_the_restores_marker_forgets_every_version_held():
    c = PlaidClient('http://x', 'tok')
    c.document_versions.update({'d1': 3})
    _stub(c, lambda path, q: Response(200, {'inserted': False, 'form': True, 'metadata': False, 'total': 1},
                                   {'X-Document-Versions-Omitted': '73'}))
    c.vocab_layers.restore_item('v1', 'i1', T)
    assert c.document_versions == {}
    assert c.document_versions_omitted is True
