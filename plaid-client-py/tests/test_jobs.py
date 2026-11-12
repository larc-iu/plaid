"""The jobs resource (CONTRACT 9 of the jobs round): what each method sends
and what it answers. The whole request of every method is also in
tests/fixtures/wire.json. Here: a 204 answers None, a keyword given as None
is sent as null (clear) and one left out is not sent (leave), the worker's
calls carry no Idempotency-Key and go over the wire from a batch, a person's
calls never join an open operation, and the answers are recased.
plaid-client-js's test/jobs.test.js is the twin."""

import json
from urllib.parse import parse_qsl, urlsplit

from plaid_client.client import PlaidClient
from plaid_client.testing import Response, recording_session

WIRE_JOB = {
    'job/id': 'j1',
    'job/project': 'p1',
    'job/app': 'igt',
    'job/tasks': ['gloss', 'link'],
    'job/started-by': 'a@b.com',
    'job/started-by-name': 'A',
    'job/state': 'running',
    'job/waiting-for': None,
    'job/current-document': 'd1',
    'job/lease-s': 120,
    'job/documents': [{
        'document-id': 'd1', 'name': 'One', 'position': 0, 'state': 'working', 'targets': 4,
        'done': 1, 'last-sentence': 's1', 'counts': {'words': 3, 'links': 2},
        'skipped': [{'sentence': 's2', 'sentence-id': 't2', 'reason': 'failed', 'kind': 'budget'}],
        'gloss-group': 'g1'}],
    'job/report': None,
}


def _client(answers):
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session(answers)
    return client


def _sent(client):
    out = []
    for r in client.session.sent:
        u = urlsplit(r['url'])
        query = dict(parse_qsl(u.query))
        query.update({k: str(v) for k, v in (r['params'] or {}).items() if v is not None})
        out.append({'method': r['method'], 'path': u.path, 'query': query,
                    'body': r['json'] if r['json'] is not None else (json.loads(r['data']) if r['data'] else None),
                    'key': (r['headers'] or {}).get('Idempotency-Key')})
    return out


def test_a_persons_calls_create_list_get_active_cancel_worker():
    client = _client([
        Response(201, WIRE_JOB),
        {'entries': [WIRE_JOB], 'next-cursor': None},
        WIRE_JOB,
        WIRE_JOB,
        Response(204),
        WIRE_JOB,
        {'seen-at': None, 'model': None, 'note-max-chars': 2000},
    ])
    made = client.jobs.create('p1', 'igt', ['gloss', 'link'], note='Gloss -ka as PST.', id='j1')
    assert made['started_by'] == 'a@b.com'
    assert made['documents'][0]['document_id'] == 'd1'
    assert made['documents'][0]['last_sentence'] == 's1'
    assert made['documents'][0]['skipped'][0] == {'sentence': 's2', 'sentence_id': 't2',
                                                  'reason': 'failed', 'kind': 'budget'}
    assert made['lease_s'] == 120
    assert client.jobs.list('p1')[0]['id'] == 'j1'
    assert client.jobs.get('j1')['current_document'] == 'd1'
    assert client.jobs.active('p1')['state'] == 'running'
    assert client.jobs.active('p1') is None, '204: no active job'
    assert client.jobs.cancel('j1')['id'] == 'j1'
    assert client.jobs.worker() == {'seen_at': None, 'model': None, 'note_max_chars': 2000}
    sent = _sent(client)
    assert [f"{s['method']} {s['path']}" for s in sent] == [
        'POST /api/v1/projects/p1/jobs',
        'GET /api/v1/projects/p1/jobs',
        'GET /api/v1/jobs/j1',
        'GET /api/v1/projects/p1/jobs/active',
        'GET /api/v1/projects/p1/jobs/active',
        'POST /api/v1/jobs/j1/cancel',
        'GET /api/v1/jobs/worker',
    ]
    assert sent[0]['body'] == {'id': 'j1', 'app': 'igt', 'tasks': ['gloss', 'link'],
                               'note': 'Gloss -ka as PST.'}
    assert sent[0]['key'], 'a create is keyed, so a lost answer is sent again safely'


def test_a_create_with_its_documents_sends_them_in_order_and_the_list_pages():
    client = _client([Response(201, WIRE_JOB), {'entries': [WIRE_JOB], 'next-cursor': 'c2'}])
    client.jobs.create('p1', 'igt', ['translate'], ['d2', 'd1'])
    page = client.jobs.list_page('p1', limit=1, cursor='c1')
    assert page['next_cursor'] == 'c2'
    sent = _sent(client)
    assert sent[0]['body'] == {'app': 'igt', 'tasks': ['translate'], 'documents': ['d2', 'd1']}
    assert sent[1]['query'] == {'limit': '1', 'cursor': 'c1'}


def test_a_jobs_create_and_cancel_never_join_an_open_operation():
    client = _client([Response(201, WIRE_JOB)])
    with client.operation('Edit'):
        client.jobs.create('p1', 'igt', ['gloss'])
        client.jobs.cancel('j1')
    for s in _sent(client):
        assert 'group-id' not in s['query'], s['path']


def test_claim_answers_the_job_and_its_token_and_none_on_204():
    client = _client([{'job': WIRE_JOB, 'token': 'jwt', 'heartbeat-s': 30}, Response(204)])
    claimed = client.jobs.claim('w1', 'm', ['igt'])
    assert (claimed['token'], claimed['heartbeat_s'], claimed['job']['state']) == ('jwt', 30, 'running')
    assert client.jobs.claim('w1', 'm', ['igt']) is None
    assert _sent(client)[0]['body'] == {'worker-id': 'w1', 'model': 'm', 'apps': ['igt']}


def test_heartbeat_sends_none_to_clear_a_field_and_leaves_out_a_field_it_leaves():
    client = _client([{'state': 'running', 'token': 'jwt2', 'lease-s': 120}])
    beat = client.jobs.heartbeat('j1', 'w1', phase='glossing', waiting_for=None, current_document='d1')
    assert beat == {'state': 'running', 'token': 'jwt2', 'lease_s': 120}
    client.jobs.heartbeat('j1', 'w1')
    sent = _sent(client)
    assert sent[0]['body'] == {'worker-id': 'w1', 'phase': 'glossing', 'waiting-for': None,
                               'current-document': 'd1'}
    assert sent[1]['body'] == {'worker-id': 'w1'}
    assert sent[0]['path'] == '/api/v1/jobs/j1/heartbeat'


def test_update_document_finish_and_the_decisions_send_the_contracts_bodies():
    client = _client([
        WIRE_JOB['job/documents'][0],
        {**WIRE_JOB, 'job/state': 'done'},
        Response(204),
        [{'form': 'ka', 'key': 'k1', 'analysis': '{}', 'count': 2, 'first-document': 'd1',
          'first-sentence': 't1'}],
        {'entries': [{'form': 'ka', 'key': 'k1', 'analysis': '{}', 'count': 2}], 'next-cursor': None},
        {'in-flight': 1, 'last-finished-at': None},
    ])
    row = client.jobs.update_document(
        'j1', 'd1', 'w1', state='working', last_sentence='s1', counts={'words': 3},
        skipped=[{'sentence': 's2', 'sentence_id': 't2', 'reason': 'too-long', 'kind': None}],
        gloss_group='g1', harmonize_group=None)
    assert row['gloss_group'] == 'g1'
    ended = client.jobs.finish('j1', 'w1', 'done',
                               {'paused_for_people_s': 0, 'totals': {'documents_done': 1}})
    assert ended['state'] == 'done'
    assert client.jobs.add_decisions('j1', 'w1', [
        {'form': 'ka', 'key': 'k1', 'analysis': '{"morphemes":[]}', 'count': 2, 'document_id': 'd1',
         'sentence_id': 't1'}]) is None
    assert client.jobs.lookup_decisions('j1', ['ka'])[0]['first_document'] == 'd1'
    assert client.jobs.decisions('j1')[0]['count'] == 2
    assert client.jobs.model_busy('glm') == {'in_flight': 1, 'last_finished_at': None}

    put, fin, dec, look, all_, busy = _sent(client)
    assert f"{put['method']} {put['path']}" == 'PUT /api/v1/jobs/j1/documents/d1'
    assert put['body'] == {
        'worker-id': 'w1', 'state': 'working', 'last-sentence': 's1', 'counts': {'words': 3},
        'skipped': [{'sentence': 's2', 'sentence-id': 't2', 'reason': 'too-long', 'kind': None}],
        'gloss-group': 'g1', 'harmonize-group': None}
    assert fin['body'] == {'worker-id': 'w1', 'state': 'done',
                           'report': {'paused-for-people-s': 0, 'totals': {'documents-done': 1}}}
    assert dec['body'] == {'worker-id': 'w1', 'decisions': [
        {'form': 'ka', 'key': 'k1', 'analysis': '{"morphemes":[]}', 'count': 2, 'document-id': 'd1',
         'sentence-id': 't1'}]}
    assert f"{look['method']} {look['path']}" == 'POST /api/v1/jobs/j1/decisions/lookup'
    assert look['body'] == {'forms': ['ka']}
    assert f"{all_['method']} {all_['path']}" == 'GET /api/v1/jobs/j1/decisions'
    assert f"{busy['method']} {busy['path']}" == 'GET /api/v1/jobs/model-busy'
    assert busy['query'] == {'pool': 'glm'}


def test_finish_sends_a_reason_only_when_given():
    client = _client([WIRE_JOB])
    client.jobs.finish('j1', 'w1', 'failed', {}, reason='no-lexicon')
    client.jobs.finish('j1', 'w1', 'cancelled', {})
    sent = _sent(client)
    assert sent[0]['body'] == {'worker-id': 'w1', 'state': 'failed', 'reason': 'no-lexicon', 'report': {}}
    assert sent[1]['body'] == {'worker-id': 'w1', 'state': 'cancelled', 'report': {}}


def test_the_workers_calls_are_signals_unkeyed_outside_any_operation_sent_from_a_batch():
    client = _client([{'state': 'running', 'token': 't', 'lease-s': 120}])
    client.enter_strict_mode('d1')
    client.document_versions['d1'] = 7
    batch = client.batch()
    with client.operation('Edit'):
        batch.jobs.heartbeat('j1', 'w1', message='Sentences 1 to 5 of 40.')
        batch.jobs.claim('w1', 'm', ['igt'])
        batch.jobs.update_document('j1', 'd1', 'w1', done=3)
        batch.jobs.finish('j1', 'w1', 'failed', {}, reason='no-lexicon')
        batch.jobs.add_decisions('j1', 'w1', [])
        batch.jobs.lookup_decisions('j1', ['ka'])
    assert batch.operations == [], 'nothing queued'
    sent = _sent(client)
    assert len(sent) == 6
    for s in sent:
        assert s['key'] is None, f"{s['path']} carries no Idempotency-Key"
        assert 'group-id' not in s['query'], f"{s['path']} joins no operation"
        assert 'document-version' not in s['query'], f"{s['path']} claims no version"
