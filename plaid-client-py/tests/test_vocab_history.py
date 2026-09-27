"""A vocabulary's history: the whole vocabulary at a time, one entry at a
time (also after it was deleted), its audit log, and putting one entry back.
The restore bumps every document linking the entry when it sets the form
back, so its X-Document-Versions (or the omitted marker) is taken up like any
write's."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient

T = '2026-06-01T12:00:00Z'


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body, headers=None):
        self._body = body
        self.headers = {'content-type': 'application/json', **(headers or {})}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _stub(client, answer):
    sent = []

    class _Session:
        def request(self, **kw):
            url = urlparse(kw['url'])
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            sent.append((kw['method'], url.path, query))
            return answer(url.path, query)

        def close(self):
            pass

    client.session = _Session()
    return sent


def test_the_vocabulary_read_takes_a_time_with_or_without_its_entries():
    c = PlaidClient('http://x', 'tok')
    sent = _stub(c, lambda path, q: _Resp({
        'vocab/id': 'v1', 'vocab/name': 'Lex',
        'vocab/items': [{'vocab-item/id': 'i1', 'vocab-item/form': 'kai'}]}))
    at = c.vocab_layers.get('v1', include_items=True, as_of=T)
    assert at['name'] == 'Lex' and at['items'] == [{'id': 'i1', 'form': 'kai'}]
    c.vocab_layers.get('v1')
    assert sent[0][1] == '/api/v1/vocab-layers/v1'
    assert sent[0][2] == {'as-of': T, 'include-items': 'true'}
    assert sent[1][2] == {}


def test_one_entry_at_a_time_is_read_under_its_vocabulary():
    c = PlaidClient('http://x', 'tok')
    sent = _stub(c, lambda path, q: _Resp({'vocab-item/id': 'i1', 'vocab-item/form': 'kai'}))
    assert c.vocab_layers.get_item_at('v1', 'i1', T) == {'id': 'i1', 'form': 'kai'}
    assert sent == [('GET', '/api/v1/vocab-layers/v1/items/i1', {'as-of': T})]


def test_the_vocabulary_log_pages_as_the_document_log_does():
    c = PlaidClient('http://x', 'tok')

    def answer(path, q):
        if q.get('cursor'):
            return _Resp({'entries': [{'audit/id': 'a2'}], 'next-cursor': None})
        return _Resp({'entries': [{'audit/id': 'a1'}], 'next-cursor': 'k'})

    sent = _stub(c, answer)
    all_entries = c.vocab_layers.audit('v1', start_time='S', end_time='E',
                                       op_types=['vocab-item/delete', 'vocab-item/restore'])
    assert [e['id'] for e in all_entries] == ['a1', 'a2']
    method, path, q = sent[0]
    assert path == '/api/v1/vocab-layers/v1/audit'
    assert q['start-time'] == 'S' and q['end-time'] == 'E'
    assert q['op-types'] == 'vocab-item/delete,vocab-item/restore'
    assert sent[1][2]['cursor'] == 'k'
    page = c.vocab_layers.audit_page('v1', order='desc', limit=1, op_types='vocab-item/delete')
    assert page == {'entries': [{'id': 'a1'}], 'next_cursor': 'k'}
    q = sent[2][2]
    assert q['order'] == 'desc' and q['limit'] == '1' and q['op-types'] == 'vocab-item/delete'


def test_an_entry_restore_posts_the_time_a_dry_run_says_so_and_the_message_rides_along():
    c = PlaidClient('http://localhost:0', 'tok')
    b = c.batch()
    b.vocab_layers.restore_item('v1', 'i1', T)
    b.vocab_layers.restore_item('v1', 'i1', T, dry_run=True, audit_message='Put kai back')
    plain, dry = list(b.operations)
    b.abort()
    assert plain['method'] == 'POST'
    assert plain['path'].startswith('/api/v1/vocab-layers/v1/items/i1/restore?')
    assert 'as-of=2026-06-01T12%3A00%3A00Z' in plain['path']
    assert 'dry-run' not in plain['path']
    assert 'dry-run=true' in dry['path']
    assert 'audit-message=Put%20kai%20back' in dry['path']


def test_an_entry_restore_takes_up_the_linking_documents_new_versions():
    c = PlaidClient('http://x', 'tok')
    c.document_versions.update({'d1': 3, 'd9': 1})
    _stub(c, lambda path, q: _Resp({'inserted': False, 'form': True, 'metadata': False, 'total': 1},
                                   {'X-Document-Versions': json.dumps({'d1': 4, 'd2': 8})}))
    summary = c.vocab_layers.restore_item('v1', 'i1', T)
    assert summary == {'inserted': False, 'form': True, 'metadata': False, 'total': 1}
    assert c.document_versions == {'d1': 4, 'd2': 8, 'd9': 1}


def test_past_fifty_linking_documents_the_restores_marker_forgets_every_version_held():
    c = PlaidClient('http://x', 'tok')
    c.document_versions.update({'d1': 3})
    _stub(c, lambda path, q: _Resp({'inserted': False, 'form': True, 'metadata': False, 'total': 1},
                                   {'X-Document-Versions-Omitted': '73'}))
    c.vocab_layers.restore_item('v1', 'i1', T)
    assert c.document_versions == {}
    assert c.document_versions_omitted is True
