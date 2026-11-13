"""The jobs resource (CONTRACT 9 of the jobs round): what each method sends
and what it answers. The whole request of every method is also in
tests/fixtures/wire.json. Here: a 204 answers None, a keyword given as None
is sent as null (clear) and one left out is not sent (leave), the worker's
calls carry no Idempotency-Key and go over the wire from a batch, a person's
calls never join an open operation, and the answers are recased.
plaid-client-js's test/jobs.test.js is the twin. After them, the fake's jobs
(``FakeClient.jobs``) are held to core's state rules, a test for each rule."""

import inspect
import json
from urllib.parse import parse_qsl, urlsplit

import pytest

from plaid_client.client import JobsResource, PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.testing import FakeClient, Response, _FakeJobs, recording_session

WIRE_JOB = {
    'job/id': 'j1',
    'job/project': 'p1',
    'job/app': 'igt',
    'job/instructions': 'Gloss -ka as PST.',
    'job/started-by': 'a@b.com',
    'job/started-by-name': 'A',
    'job/state': 'running',
    'job/waiting-for': None,
    'job/current-document': 'd1',
    'job/lease-s': 120,
    'job/lapsed': False,
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
        {'entries': [{**WIRE_JOB, 'job/document-count': 1}], 'next-cursor': None},
        WIRE_JOB,
        WIRE_JOB,
        Response(204),
        WIRE_JOB,
        {'seen-at': None, 'model': None, 'instructions-max-chars': 2000, 'documents-max': 500},
    ])
    made = client.jobs.create('p1', 'igt', 'Gloss -ka as PST.', id='j1')
    assert made['instructions'] == 'Gloss -ka as PST.'
    assert made['started_by'] == 'a@b.com'
    assert made['documents'][0]['document_id'] == 'd1'
    assert made['documents'][0]['last_sentence'] == 's1'
    assert made['documents'][0]['skipped'][0] == {'sentence': 's2', 'sentence_id': 't2',
                                                  'reason': 'failed', 'kind': 'budget'}
    assert made['lease_s'] == 120
    assert made['lapsed'] is False
    listed = client.jobs.list('p1')
    assert listed[0]['id'] == 'j1'
    assert listed[0]['document_count'] == 1, 'a list entry counts its documents'
    assert client.jobs.get('j1')['current_document'] == 'd1'
    assert client.jobs.active('p1')['state'] == 'running'
    assert client.jobs.active('p1') is None, '204: no active job'
    assert client.jobs.cancel('j1')['id'] == 'j1'
    assert client.jobs.worker() == {'seen_at': None, 'model': None, 'instructions_max_chars': 2000,
                                     'documents_max': 500}
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
    assert sent[0]['body'] == {'id': 'j1', 'app': 'igt', 'instructions': 'Gloss -ka as PST.'}
    assert sent[0]['key'], 'a create is keyed, so a lost answer is sent again safely'


def test_a_create_with_its_documents_sends_them_in_order_and_the_list_pages():
    client = _client([Response(201, WIRE_JOB), {'entries': [WIRE_JOB], 'next-cursor': 'c2'}])
    client.jobs.create('p1', 'igt', 'Translate.', ['d2', 'd1'])
    page = client.jobs.list_page('p1', limit=1, cursor='c1')
    assert page['next_cursor'] == 'c2'
    sent = _sent(client)
    assert sent[0]['body'] == {'app': 'igt', 'documents': ['d2', 'd1'], 'instructions': 'Translate.'}
    assert sent[1]['query'] == {'limit': '1', 'cursor': 'c1'}


def test_a_jobs_create_and_cancel_never_join_an_open_operation():
    client = _client([Response(201, WIRE_JOB)])
    with client.operation('Edit'):
        client.jobs.create('p1', 'igt', 'Gloss.')
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
    beat = client.jobs.heartbeat('j1', 'w1', phase='working', waiting_for=None, current_document='d1')
    assert beat == {'state': 'running', 'token': 'jwt2', 'lease_s': 120}
    client.jobs.heartbeat('j1', 'w1')
    sent = _sent(client)
    assert sent[0]['body'] == {'worker-id': 'w1', 'phase': 'working', 'waiting-for': None,
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


def test_landed_asks_by_seed_and_answers_the_keys():
    client = _client([{'keys': ['s1.0', 's1.1']}])
    assert client.jobs.landed('j1', ['s1', 's2']) == ['s1.0', 's1.1']
    (sent,) = _sent(client)
    assert f"{sent['method']} {sent['path']}" == 'POST /api/v1/jobs/j1/landed'
    assert sent['body'] == {'refs': ['s1', 's2']}
    assert sent['key'] is None, 'a signal, never keyed'


def test_fake_landed_answers_the_keys_of_writes_that_landed():
    client, _ = _fake()
    job = client.jobs.create('p1', 'igt', 'Gloss.')
    client.jobs.claim('w1', 'm', ['igt'])
    seed, other = client.key_seed(), client.key_seed()
    with client.operation('Job', keys=seed):
        client.tokens.create('l1', 't1', 0, 1)
        with client.batched() as b:
            b.tokens.create('l1', 't1', 1, 2)
            b.tokens.create('l1', 't1', 2, 3)
        with client.batched():
            pass
    with client.operation('Unkeyed'):
        client.tokens.create('l1', 't1', 3, 4)
    s = seed['seed']
    assert client.jobs.landed(job['id'], [s, other['seed']]) == [f'{s}.0', f'{s}.1'], \
        'one key a write, a batch one write, an empty batch none'
    _refused(lambda: client.jobs.landed(job['id'], []), 400, 'refs: give at least one.')
    _refused(lambda: client.jobs.landed('nope', [s]), 404)


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


# --- FakeClient.jobs: core's state rules in memory (CONTRACT 3) -----------------------


def _fake():
    client = FakeClient({'d1': {'id': 'd1', 'name': 'Second'}, 'd2': {'id': 'd2', 'name': 'First'}},
                        project={'id': 'p1'},
                        projects={'p2': {'project': {'id': 'p2'},
                                         'documents': {'d3': {'id': 'd3', 'name': 'Third'}}}})
    clock = {'t': 1_000_000.0}
    client.jobs.now = lambda: clock['t']
    client._clock = clock
    client.jobs.user = 'w@x.org'
    return client, clock


def _fake_clock(client):
    return client._clock


def _refused(call, status, error=None, **fields):
    with pytest.raises(PlaidAPIError) as e:
        call()
    assert e.value.status == status
    if error is not None:
        assert e.value.response_data['error'] == error
    for k, v in fields.items():
        assert e.value.response_data[k] == v
    return e.value


def test_fake_create_waits_with_its_rows_in_order_and_refuses_as_core_does():
    client, _ = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'n')
    assert (job['state'], job['instructions'], job['started_by'], job['report']) == \
        ('waiting', 'n', 'w@x.org', None)
    assert 'tasks' not in job, 'a job has no task types'
    assert [(r['document_id'], r['name'], r['position'], r['state']) for r in job['documents']] == \
        [('d2', 'First', 0, 'waiting'), ('d1', 'Second', 1, 'waiting')], 'every document, by name'
    assert jobs.active('p1')['id'] == job['id'] and jobs.active('p2') is None
    _refused(lambda: jobs.create('p1', 'igt', 'Gloss.'), 409, 'This project already has a job.',
             code='job-active', job=job['id'])
    _refused(lambda: jobs.create('p2', 'ud', 'Gloss.'), 400, 'Unknown app: ud.')
    _refused(lambda: jobs.create('p2', 'igt', ''), 400, 'instructions: say what the job is to do.')
    _refused(lambda: jobs.create('p2', 'igt', ' \n'), 400, 'instructions: say what the job is to do.')
    _refused(lambda: jobs.create('p2', 'igt', 'Gloss.', ['d1', 'd3']), 400,
             'documents: 1 is not a document of this project.')
    _refused(lambda: jobs.create('p2', 'igt', 'Gloss.', ['d1', 'd2', 'd3']), 400,
             'documents: 2 are not documents of this project.')
    _refused(lambda: jobs.create('p2', 'igt', 'Gloss.', []), 400,
             'documents: give at least one document, or leave them out for all.')
    _refused(lambda: jobs.create('p2', 'igt', 'x' * 2412), 400,
             "The instructions are 2,412 characters. A job's instructions are at most 2,000.")
    _refused(lambda: jobs.create('p2', 'igt', 'Gloss.', ['d3'], id=job['id']), 409, 'id-taken')
    second = jobs.create('p2', 'igt', 'Gloss.', ['d3', 'd3'])
    assert [r['document_id'] for r in second['documents']] == ['d3'], 'a document named twice is taken once'
    assert second['ahead'] == 1, 'the job of p1 was started before it'
    assert [j['id'] for j in jobs.list('p2')] == [second['id']]
    assert 'documents' not in jobs.list('p1')[0] and 'report' not in jobs.list('p1')[0]
    assert jobs.list('p2')[0]['document_count'] == 1, 'a list entry counts its documents, as core\'s does'


def test_fake_claim_takes_the_oldest_and_holds_the_one_slot_until_the_lease_lapses():
    client, clock = _fake()
    jobs = client.jobs
    assert jobs.claim('w1', 'm', ['igt']) is None
    assert jobs.worker() == {'seen_at': '1970-01-12T13:46:40.000Z', 'model': 'm', 'instructions_max_chars': 2000,
                            'documents_max': 500}
    first = jobs.create('p2', 'igt', 'Gloss.')
    second = jobs.create('p1', 'igt', 'Gloss.')
    claimed = jobs.claim('w1', 'm', ['igt'])
    assert claimed['job']['id'] == first['id'] and claimed['heartbeat_s'] == 30
    assert (claimed['job']['state'], claimed['job']['model']) == ('running', 'm')
    assert jobs.claim('w2', 'm', ['igt']) is None, 'one job at a time on the server'
    clock['t'] += 121
    taken = jobs.claim('w2', 'm', ['igt'])
    assert taken['job']['id'] == first['id'], 'a lapsed lease is taken over before a waiting job'
    _refused(lambda: jobs.heartbeat(first['id'], 'w1'), 409, 'Another worker holds this job.', code='job-taken')
    _refused(lambda: jobs.update_document(first['id'], 'd3', 'w1', done=1), 409, code='job-taken')
    assert jobs.get(second['id'])['state'] == 'waiting'


def test_fake_heartbeat_sets_what_is_given_clears_none_and_leaves_the_rest():
    client, _ = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    one = jobs.heartbeat(job['id'], 'w1', phase='working', message='Sentences 1 to 5 of 40.',
                         waiting_for='people', current_document='d2')
    clock_before = jobs.worker()['seen_at']
    _fake_clock(client)['t'] += 5
    two = jobs.heartbeat(job['id'], 'w1', waiting_for=None)
    assert jobs.worker()['seen_at'] > clock_before, 'a heartbeat counts as the worker seen'
    _refused(lambda: jobs.heartbeat(job['id'], 'w1', message='x' * 301), 400)
    _refused(lambda: jobs.heartbeat(job['id'], 'w1', phase='napping'), 400)
    assert one['state'] == 'running' and one['lease_s'] == 120 and one['token'] != two['token']
    now = jobs.get(job['id'])
    assert (now['phase'], now['message'], now['waiting_for'], now['current_document']) == \
        ('working', 'Sentences 1 to 5 of 40.', None, 'd2')
    _refused(lambda: jobs.heartbeat('nope', 'w1'), 404, 'Job not found')
    jobs.hidden_projects.add('p1')
    _refused(lambda: jobs.heartbeat(job['id'], 'w1'), 404, 'Job not found')


def test_fake_every_read_says_whether_the_lease_has_lapsed_and_settles_nothing():
    client, clock = _fake()
    jobs = client.jobs

    def reads(job_id):
        return [jobs.get(job_id)['lapsed'], jobs.active('p1')['lapsed'], jobs.list('p1')[0]['lapsed']]

    job = jobs.create('p1', 'igt', 'Gloss.')
    assert reads(job['id']) == [False, False, False], 'waiting'
    jobs.claim('w1', 'm', ['igt'])
    assert reads(job['id']) == [False, False, False], 'running, the lease live'
    clock['t'] += 121
    assert reads(job['id']) == [True, True, True], 'running, the lease lapsed'
    assert jobs.get(job['id'])['state'] == 'running', 'a read settles nothing'
    jobs.heartbeat(job['id'], 'w1')
    assert jobs.cancel(job['id'])['state'] == 'stopping'
    assert reads(job['id']) == [False, False, False], 'stopping, the lease live'
    clock['t'] += 121
    assert reads(job['id']) == [True, True, True], 'stopping, the lease lapsed'
    ended = jobs.cancel(job['id'])
    assert (ended['state'], ended['lapsed']) == ('cancelled', False), 'a second Stop settles it at once'


def test_fake_cancel_follows_each_path():
    client, clock = _fake()
    jobs = client.jobs
    waiting = jobs.create('p1', 'igt', 'Gloss.')
    done = jobs.cancel(waiting['id'])
    assert (done['state'], done['reason'], done['cancelled_by'], done['report']) == \
        ('cancelled', 'cancelled', 'w@x.org', None)
    assert done['finished_at']
    _refused(lambda: jobs.cancel(waiting['id']), 409, 'This job has ended.', code='job-finished')

    live = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    assert jobs.cancel(live['id'])['state'] == 'stopping'
    assert jobs.cancel(live['id'])['state'] == 'stopping', 'stopping with a live lease: no change'
    assert jobs.heartbeat(live['id'], 'w1')['state'] == 'stopping'
    _refused(lambda: jobs.finish(live['id'], 'w1', 'done', {}), 409, 'This job cannot end as done now.',
             code='job-state')
    ended = jobs.finish(live['id'], 'w1', 'cancelled', {'stopped': None})
    assert (ended['state'], ended['reason']) == ('cancelled', 'cancelled')

    lapsed = jobs.create('p2', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.update_document(lapsed['id'], 'd3', 'w1', state='done', done=2,
                         counts={'words': 4, 'changes': 6, 'deletions': 1, 'repeated': 2},
                         skipped=[{'sentence': 's2', 'sentence_id': 't2', 'reason': 'failed', 'kind': 'budget'},
                                  {'sentence': 's3', 'sentence_id': 't3', 'reason': 'interrupted', 'kind': None}])
    clock['t'] += 121
    gone = jobs.cancel(lapsed['id'])
    assert gone['state'] == 'cancelled'
    report = gone['report']
    assert report['stopped'] == 'without-worker'
    assert report['totals']['documents_done'] == 1 and report['totals']['words'] == 4
    assert report['totals']['skipped_failed'] == 1 and report['totals']['sentences'] == 2
    assert [report['totals'][k] for k in ('changes', 'deletions', 'repeated', 'skipped_interrupted')] == [6, 1, 2, 1]
    assert 'deleted' not in report['entries'], 'a job lists no deleted entries'
    assert [r['state'] for r in gone['documents']] == ['done'], 'a done row stays done'
    assert report['harmonize'] == {'changed': [], 'left': [], 'changed_more': 0, 'left_more': 0}
    assert report['entries']['created'] == []
    assert report['entries']['lexicons'] == []


def test_fake_a_running_job_may_end_cancelled_and_core_settles_unreached_rows():
    client, clock = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.update_document(job['id'], 'd2', 'w1', state='working')
    clock['t'] += 121
    gone = jobs.cancel(job['id'])
    assert [r['state'] for r in gone['documents']] == ['not-reached', 'not-reached']
    assert gone['report']['totals']['documents_not_reached'] == 2
    other = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    assert jobs.finish(other['id'], 'w1', 'cancelled', {})['state'] == 'cancelled'


def test_fake_a_stopping_job_claimed_after_a_crash_stays_stopping_and_ends_cancelled():
    client, clock = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.cancel(job['id'])
    clock['t'] += 121
    again = jobs.claim('w2', 'm', ['igt'])
    assert again['job']['state'] == 'stopping'
    assert jobs.finish(job['id'], 'w2', 'cancelled', {})['state'] == 'cancelled'


def test_fake_a_starter_who_no_longer_writes_fails_the_job():
    client, _ = _fake()
    jobs = client.jobs
    lost = jobs.create('p1', 'igt', 'Gloss.')
    kept = jobs.create('p2', 'igt', 'Gloss.')
    jobs.can_write = lambda user, project: project != 'p1'
    claimed = jobs.claim('w1', 'm', ['igt'])
    assert claimed['job']['id'] == kept['id'], 'the next job is taken'
    failed = jobs.get(lost['id'])
    assert (failed['state'], failed['reason']) == ('failed', 'starter-access')
    assert failed['report']['state'] == 'failed' and failed['report']['stopped'] is None

    jobs.can_write = lambda user, project: False
    _refused(lambda: jobs.heartbeat(kept['id'], 'w1'), 409, code='job-failed', reason='starter-access')
    assert jobs.get(kept['id'])['state'] == 'failed'
    assert [r['state'] for r in jobs.get(kept['id'])['documents']] == ['not-reached']
    # Until its report is in, a worker that lost the first answer hears it again.
    _refused(lambda: jobs.heartbeat(kept['id'], 'w1'), 409, code='job-failed')
    ended = jobs.finish(kept['id'], 'w1', 'failed', {'state': 'failed'})
    assert ended['report'] == {'state': 'failed'} and ended['reason'] == 'starter-access'
    _refused(lambda: jobs.finish(kept['id'], 'w1', 'failed', {}), 409, code='job-state')
    _refused(lambda: jobs.heartbeat(kept['id'], 'w1'), 409, code='job-finished')


def test_fake_document_rows_and_finish():
    client, _ = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    row = jobs.update_document(job['id'], 'd1', 'w1', state='working', last_sentence='s4', gloss_group='g1')
    assert (row['state'], row['last_sentence'], row['gloss_group'], row['harmonize_group']) == \
        ('working', 's4', 'g1', None)
    assert jobs.update_document(job['id'], 'd1', 'w1', targets=8)['last_sentence'] == 's4', 'left as it was'
    _refused(lambda: jobs.update_document(job['id'], 'd3', 'w1', done=1), 404, 'Document not in job')
    _refused(lambda: jobs.update_document(job['id'], 'd1', 'w1', skipped=[{}] * 501), 400)
    del client._documents['d1']
    assert jobs.get(job['id'])['documents'][1]['name'] is None, 'a deleted document keeps its row'
    ended = jobs.finish(job['id'], 'w1', 'done', {'paused_for_people_s': 3, 'totals': {'documents_done': 1}})
    assert (ended['state'], ended['current_document'], ended['waiting_for']) == ('done', None, None)
    assert ended['report'] == {'paused_for_people_s': 3, 'totals': {'documents_done': 1}}
    _refused(lambda: jobs.finish(job['id'], 'w1', 'done', {}), 409, code='job-state')
    _refused(lambda: jobs.finish('nope', 'w1', 'done', {}), 404)
    assert jobs.active('p1') is None


def test_fake_decisions_add_up_and_read_back_in_order():
    client, _ = _fake()
    jobs = client.jobs
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.add_decisions(job['id'], 'w1', [
        {'form': 'ka', 'key': 'k2', 'analysis': '{"a":2}', 'count': 1, 'document_id': 'd1', 'sentence_id': 't1'},
        {'form': 'ka', 'key': 'k1', 'analysis': '{"a":1}', 'count': 1, 'document_id': 'd1', 'sentence_id': 't2'},
        {'form': 'ba', 'key': 'k3', 'analysis': '{"b":1}', 'count': 1, 'document_id': 'd1', 'sentence_id': 't2'}])
    jobs.add_decisions(job['id'], 'w1', [
        {'form': 'ka', 'key': 'k2', 'analysis': '{"a":2}', 'count': 2, 'document_id': 'd2', 'sentence_id': 't9'}])
    found = jobs.lookup_decisions(job['id'], ['ka'])
    assert [(r['key'], r['count'], r['first_document'], r['first_sentence']) for r in found] == \
        [('k2', 3, 'd1', 't1'), ('k1', 1, 'd1', 't2')]
    assert [(r['form'], r['key']) for r in jobs.decisions(job['id'])] == [('ba', 'k3'), ('ka', 'k1'), ('ka', 'k2')]
    _refused(lambda: jobs.lookup_decisions(job['id'], []), 400, 'forms: give at least one form.')
    _refused(lambda: jobs.add_decisions(job['id'], 'w1', [
        {'form': 'x', 'key': 'k', 'analysis': 'x' * 4001, 'count': 1, 'document_id': 'd1',
         'sentence_id': 't1'}]), 400)
    _refused(lambda: jobs.add_decisions(job['id'], 'w2', []), 409, code='job-taken')


def test_fake_an_ended_job_takes_no_row_or_decision():
    client, _ = _fake()
    jobs = client.jobs
    decision = [{'form': 'ka', 'key': 'k', 'analysis': '{}', 'count': 1}]
    job = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.finish(job['id'], 'w1', 'done', {})
    _refused(lambda: jobs.update_document(job['id'], 'd1', 'w1', state='working'), 409, 'This job has ended.',
             code='job-finished')
    _refused(lambda: jobs.add_decisions(job['id'], 'w1', decision), 409, 'This job has ended.',
             code='job-finished')
    # A job core failed takes them until the worker's finish stores its report.
    failed = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.can_write = lambda user, project: False
    _refused(lambda: jobs.heartbeat(failed['id'], 'w1'), 409, code='job-failed')
    assert jobs.update_document(failed['id'], 'd1', 'w1', done=1)['done'] == 1
    jobs.add_decisions(failed['id'], 'w1', decision)
    jobs.finish(failed['id'], 'w1', 'failed', {})
    _refused(lambda: jobs.update_document(failed['id'], 'd1', 'w1', done=2), 409, code='job-finished')
    _refused(lambda: jobs.add_decisions(failed['id'], 'w1', decision), 409, code='job-finished')


def test_fake_an_end_core_decides_clears_the_workers_line():
    client, clock = _fake()
    jobs = client.jobs
    line = 'Sentences 1 to 5 of 40.'
    lapsed = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.heartbeat(lapsed['id'], 'w1', message=line)
    clock['t'] += 121
    assert jobs.cancel(lapsed['id'])['message'] is None, 'a lapsed lease cancelled by core'

    at_beat = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.heartbeat(at_beat['id'], 'w1', message=line)
    jobs.can_write = lambda user, project: False
    _refused(lambda: jobs.heartbeat(at_beat['id'], 'w1'), 409, code='job-failed')
    assert jobs.get(at_beat['id'])['message'] is None, 'starter-access at the heartbeat'
    failed_at = jobs.get(at_beat['id'])['finished_at']
    clock['t'] += 5
    assert jobs.finish(at_beat['id'], 'w1', 'failed', {})['finished_at'] == failed_at, \
        'the worker\'s report keeps the time core failed it, as core does'

    jobs.can_write = lambda user, project: True
    at_claim = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.heartbeat(at_claim['id'], 'w1', message=line)
    clock['t'] += 121
    jobs.can_write = lambda user, project: False
    assert jobs.claim('w2', 'm', ['igt']) is None
    assert jobs.get(at_claim['id'])['message'] is None, 'starter-access at the claim'

    jobs.can_write = lambda user, project: True
    by_worker = jobs.create('p1', 'igt', 'Gloss.')
    jobs.claim('w1', 'm', ['igt'])
    jobs.heartbeat(by_worker['id'], 'w1', message=line)
    assert jobs.finish(by_worker['id'], 'w1', 'done', {})['message'] == line, 'an end the worker sends keeps it'


def test_fake_every_end_settles_the_rows_it_did_not_finish():
    client, _ = _fake()
    jobs = client.jobs
    waiting = jobs.create('p1', 'igt', 'Gloss.')
    assert [r['state'] for r in jobs.cancel(waiting['id'])['documents']] == ['not-reached', 'not-reached']
    for to in ('done', 'cancelled', 'failed'):
        job = jobs.create('p1', 'igt', 'Gloss.')
        jobs.claim('w1', 'm', ['igt'])
        jobs.update_document(job['id'], 'd2', 'w1', state='done')
        jobs.update_document(job['id'], 'd1', 'w1', state='working')
        ended = jobs.finish(job['id'], 'w1', to, {})
        assert [r['state'] for r in ended['documents']] == ['done', 'not-reached'], to


def test_fake_model_busy_answers_the_load_a_test_sets():
    client, _ = _fake()
    assert client.jobs.model_busy('glm') == {'in_flight': 0, 'last_finished_at': None}
    client.jobs.model_load['glm'] = {'in_flight': 2, 'last_finished_at': '2026-11-12T10:00:00.000Z'}
    assert client.jobs.model_busy('glm') == {'in_flight': 2, 'last_finished_at': '2026-11-12T10:00:00.000Z'}
    _refused(lambda: client.jobs.model_busy(''), 400)


def test_the_fake_jobs_take_what_the_real_ones_take():
    """Each fake method has the real method's parameters, so a worker tested
    on the fake calls the real client the same way."""
    real = {n for n in dir(JobsResource) if not n.startswith('_')}
    assert real <= {n for n in dir(_FakeJobs) if not n.startswith('_')}
    for name in real:
        want = list(inspect.signature(getattr(JobsResource, name)).parameters)
        assert list(inspect.signature(getattr(_FakeJobs, name)).parameters) == want, name
