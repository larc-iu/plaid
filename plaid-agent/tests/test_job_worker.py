"""The worker: claim, the heartbeat and its token, a stop between calls and
during a write, a job lost to another worker or to its starter's access, the
wait for a model that does not answer, and the command line (SPEC 3, 1.3,
CONTRACT 11)."""

import argparse
import json

import litellm
import pytest
from plaid_client import PlaidAPIError

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent import jobworker
from plaid_agent.core.job import Worker, run_job
from plaid_agent.core.limits import JOB_MODEL_RETRY_S
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import runner_factory


def _client(n=2):
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in range(1, n + 1)})


def _analyse(asked, n, kwargs):
    if n == 1:
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


def _written(client):
    return [c for c in client.calls if c[0].startswith(('tokens', 'spans'))]


def test_the_worker_claims_a_job_runs_it_and_finishes_and_says_nothing_waits(monkeypatch):
    client = _client()
    client.jobs.create('p1', 'igt', ['gloss'])
    use(monkeypatch, Model(_analyse))
    from job_fixtures import ModelConfig
    worker = Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                                   count=lambda v: 1)},
                    'fake/m', client_for=lambda token: client, sleep=lambda s: None)
    claimed = worker.once()
    assert claimed is not None
    job = client.jobs.rows[claimed['job']['id']]
    assert job['state'] == 'done' and job['report']['totals']['documents_done'] == 2
    assert len(_written(client)) >= 2
    assert worker.once() is None, 'nothing waits'


def test_each_heartbeat_swaps_the_token_the_job_writes_with():
    client = _client(1)
    tokens = []
    job = start(client)
    job.client_for = lambda token: tokens.append(token) or client
    first = job.token
    job.client()
    job.beat()
    job.client()
    assert tokens[0] == first and tokens[1] != first and tokens[1].startswith('job-token-')


def test_a_stop_seen_between_model_calls_drops_the_stretch_and_finishes_cancelled(monkeypatch):
    client = _client(1)
    job = start(client)

    def answer(asked, n, kwargs):
        if n == 1:
            client.jobs.cancel(job.id)
            job.beat()
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled' and finished['reason'] == 'cancelled'
    assert not _written(client), 'the stretch in flight was dropped'
    assert len(model.calls) == 1
    assert client.jobs.rows[job.id]['report']['harmonize'] == {'changed': [], 'left': [], 'changed_more': 0,
                                                                'left_more': 0}


def test_a_stop_during_a_write_lets_the_write_finish(monkeypatch):
    client = _client(2)
    job = start(client)
    use(monkeypatch, Model(_analyse))
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        client.jobs.cancel(job.id)
        job.beat()
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled'
    assert "'blank'" in str(_written(client)), 'the write that had begun was finished'
    rows = {r['document_id']: r for r in client.jobs.rows[job.id]['documents']}
    assert rows['d2']['state'] == 'not-reached', 'nothing after the stop'


def test_a_job_taken_by_another_worker_is_dropped_with_nothing_more_written(monkeypatch):
    client = _client(1)
    job = start(client)

    def answer(asked, n, kwargs):
        client.jobs.rows[job.id]['worker_id'] = 'worker-2'
        job.beat()
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                     'morphemes': [{'form': 'blank'}]})])
    use(monkeypatch, Model(answer))
    assert run_job(job, runner(job)) is None
    assert not _written(client)
    assert not [c for c in client.jobs.calls if c[0] == 'finish']


def _token_refused(method='POST', path='/api/v1/batch'):
    # What core answers a job token whose job ended or moved to another worker.
    return PlaidAPIError('HTTP 401', status=401, url=path, method=method,
                         response_data={'error': 'This job has ended, or another worker holds it.',
                                        'code': 'job-ended'})


def test_a_refused_token_drops_a_job_another_worker_took_with_nothing_more_written(monkeypatch):
    # The worker slept past its lease mid-stretch and another worker took the
    # job: its heartbeat has not said so yet, and core refuses the write.
    client = _client(2)
    job = start(client)
    model = use(monkeypatch, Model(_analyse))

    calls_then = []

    def execute(c, ops, **kw):
        client.jobs.rows[job.id]['worker_id'] = 'worker-2'
        calls_then.append(len(client.jobs.calls))
        raise _token_refused()
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert run_job(job, runner(job)) is None
    assert job.lost == 'taken', 'the heartbeat said why'
    assert len(model.calls) == 2, 'one stretch (a call and its answer), not halved and asked again'
    assert not [c for c in client.jobs.calls if c[0] == 'finish']
    later = [c[0] for c in client.jobs.calls[calls_then[0]:]]
    assert later == ['heartbeat'], 'after the refusal only the heartbeat that learns why'


def test_a_refused_token_of_a_starter_who_lost_access_fails_the_job_with_its_report(monkeypatch):
    client = _client(1)
    job = start(client)
    use(monkeypatch, Model(_analyse))

    def execute(c, ops, **kw):
        client.jobs.can_write = lambda user, project: False
        raise _token_refused()
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'
    assert client.jobs.rows[job.id]['report']['state'] == 'failed'


def test_a_starter_who_can_no_longer_write_fails_the_job_with_its_report(monkeypatch):
    client = _client(1)
    job = start(client)

    def answer(asked, n, kwargs):
        client.jobs.can_write = lambda user, project: False
        job.beat()
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'
    assert client.jobs.rows[job.id]['report']['state'] == 'failed'


def test_a_model_that_does_not_answer_is_waited_for_and_asked_again(monkeypatch):
    from plaid_client.workflows import llm
    monkeypatch.setattr(llm, 'RETRY_BASE_S', 0)
    client = _client(1)
    job = start(client)
    tries = {'n': 0}

    def answer(asked, n, kwargs):
        tries['n'] += 1
        if tries['n'] <= 1 + llm.RETRIES:
            raise litellm.APIConnectionError(message='down', llm_provider='openai', model='m')
        return _analyse(asked, n, kwargs)
    use(monkeypatch, Model(answer))
    before = job.now()
    r = runner(job)
    assert r.document('d1') == 'done'
    assert job.now() - before >= JOB_MODEL_RETRY_S
    beats = [c[1] for c in client.jobs.calls if c[0] == 'heartbeat']
    assert any(b.get('waiting_for') == 'model' and b['message'] == 'The model is not answering. Trying again in '
               '5 minutes.' for b in beats), 'no clock time: the worker\'s is not the reader\'s'
    assert beats[-1].get('waiting_for') is None
    assert job.paused['model'] >= JOB_MODEL_RETRY_S
    assert not job.rows['d1'].get('skipped'), 'not the stretch\'s fault'


# --- the command line -------------------------------------------------------------

def test_the_scripted_model_answers_in_order_and_repeats_its_last_reply(tmp_path):
    path = tmp_path / 'model.json'
    path.write_text(json.dumps([{'calls': [{'name': 'search', 'arguments': {'pattern': 'ka'}}]},
                                {'content': 'Done.'}]))
    m = jobworker.ScriptedModel.load(str(path))
    first = m(messages=[])
    assert first.choices[0].message.tool_calls[0].function.name == 'search'
    assert json.loads(first.choices[0].message.tool_calls[0].function.arguments) == {'pattern': 'ka'}
    assert m().choices[0].message.content == 'Done.' and m().choices[0].message.content == 'Done.'


def test_a_scripted_model_is_refused_beside_an_api_base(tmp_path, capsys):
    path = tmp_path / 'model.json'
    path.write_text('[{"content": "Done."}]')
    assert jobworker.main(['--url', 'http://localhost:1', '--model', 'm', '--api-base', 'http://x',
                           '--scripted-model', str(path)]) == 2
    assert 'does not go with --api-base' in capsys.readouterr().out


def test_the_flags_are_the_contracts():
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm', '--api-base', 'b', '--context-window',
                                          '196608', '--model-pool', 'reallms', '--timeout', '200',
                                          '--max-output-tokens', '9000', '--trace-dir', 'd', '--apps', 'igt'])
    assert (args.model_pool, args.trace_dir, args.apps, args.context_window, args.max_tokens) == \
        ('reallms', 'd', ['igt'], 196608, 9000)


def test_the_assistants_take_model_pool_into_their_extras(monkeypatch):
    from plaid_agent.core import service_cli
    from test_service_flow import _service
    monkeypatch.setattr(service_cli, 'ping_model', lambda cfg: None)
    for pool, expected in (('reallms', 'reallms'), (None, None)):
        service = _service()
        p = argparse.ArgumentParser()
        p.add_argument('--url', default='http://localhost:1')
        service.add_arguments(p)
        args = p.parse_args(['--model', 'm'] + (['--model-pool', pool] if pool else []))
        service.setup(args)
        assert service.extras.get('model_pool') == expected


def test_the_trace_folder_keeps_every_model_call_of_a_stretch_on_disk(monkeypatch, tmp_path):
    client = _client(1)
    job = start(client)
    use(monkeypatch, Model(_analyse))
    runner(job, trace_dir=str(tmp_path)).document('d1')
    files = sorted(tmp_path.rglob('round-*.json'))
    assert len(files) == 1 and files[0].parent.parent.name == 'd1', 'the call that staged; the reply had no reasoning'
    first = json.loads(files[0].read_text())
    assert 'unattended' in first['system'] and first['tools'] and first['calls'][0]['name'] == 'set_analysis'
    assert not [k for k, _ in client.calls if k.startswith('user_data')], 'to disk only'


def test_the_trace_folder_is_the_operators_alone_and_a_resumed_run_gets_its_own(monkeypatch, tmp_path):
    import os
    import stat
    client = _client(1)
    job = start(client)
    use(monkeypatch, Model(_analyse))
    old = os.umask(0o022)
    try:
        runner(job, trace_dir=str(tmp_path)).document('d1')
        # A second worker process takes the job again: it numbers its
        # stretches from 1 as well.
        job.update_row('d1', state='working')
        r = runner(job, trace_dir=str(tmp_path))
        r.recorded['d1'] = {}
        r.model_work(r.project(), 'd1', ['d1-s1'])
    finally:
        os.umask(old)
    files = sorted(tmp_path.rglob('round-*.json'))
    assert len(files) == 2
    for path in [*files, *[p for p in tmp_path.rglob('*') if p.is_dir()]]:
        mode = stat.S_IMODE(path.stat().st_mode)
        assert mode & 0o077 == 0, (path, oct(mode))
    assert files[0].parent != files[1].parent, 'each run\'s stretch in a folder of its own'


def test_a_scripted_worker_starts_without_the_providers_banner(tmp_path, capsys, monkeypatch):
    import litellm as _litellm
    monkeypatch.setattr(_litellm, 'suppress_debug_info', _litellm.suppress_debug_info)
    path = tmp_path / 'model.json'
    path.write_text('[{"content": "Done."}]')

    def no_core(url):
        raise SystemExit(0)
    monkeypatch.setattr(jobworker.BaseService, 'get_client', staticmethod(no_core))
    with pytest.raises(SystemExit):
        jobworker.main(['--url', 'http://localhost:1', '--model', 'fake/m', '--scripted-model', str(path), '--once'])
    assert 'Provider List' not in capsys.readouterr().out
