"""A two-document job end to end under a real core, with the scripted model:
a writer starts it, the worker runs it as an administrator and writes with
the token core mints for the writer, and the History, the stamps, the entries
and the report say what it did. A job's token is scoped: a maintainer's
route refuses it (plaid_agent_package: a new write path is tried under a
delegated token).

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names.
"""

import json
import uuid

import pytest

from job_fixtures import Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Worker
from plaid_agent.igt.job import runner_factory
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-000000000002'


@pytest.fixture(scope='module')
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-writer-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-writer-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-writer-pass-1')
    docs = {'d1': document('d1', 'One', [{'words': ['ka', 'ka']}, {'words': ['ta']}]),
            'd2': document('d2', 'Two', [{'words': ['ka']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job live {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, email, s
    s.delete()


def _model(asked, n, kwargs):
    """Analyses "ka" as 'go' in One and as 'come' in Two, links each morpheme
    to an entry it creates, and ends."""
    doc = asked.split('"')[1]
    if n > 1:
        return reply('Done.')
    calls = []
    gloss = 'go' if doc == 'One' else 'come'
    for line in asked.splitlines():
        if not line.startswith('Targets in s'):
            continue
        s = line.split()[2].rstrip(':')
        for w in line.split('words ')[1].split(' and ')[0].split(', '):
            ref, form = w.split(' ')[0], w.split('"')[1]
            calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f'{s}.{ref}', 'morphemes': [
                {'form': form, 'type': 'stem', 'fields': {'Morph Gloss': gloss if form == 'ka' else 'x'}}]}))
    return reply(calls=calls)


def test_a_two_document_job_end_to_end(world, monkeypatch):
    admin, writer, email, s = world
    use(monkeypatch, Model(_model))
    made = writer.jobs.create(s.project_id, 'igt', ['gloss'])
    assert made['state'] == 'waiting'
    from plaid_client import PlaidClient
    worker = Worker(admin, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                                  count=count_chars)},
                    'fake/m', client_for=lambda token: PlaidClient(core_url(), token))
    assert worker.once()
    job = writer.jobs.get(made['id'])
    assert job['state'] == 'done', job
    report = job['report']
    assert report['totals']['documents_done'] == 2 and report['totals']['words'] == 4
    assert report['harmonize']['changed'] == [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority', 'from': [
        {'analysis': 'ka ‘come’', 'count': 1, 'documents': [s.ids['d2']]}]}]
    d2 = s.ids['d2']
    entries = admin.documents.audit(d2, kinds=['job'])
    refs = sorted(e.get('ref') for e in entries)
    assert refs == [f'job:{job["id"]}/doc:{d2}/pass:gloss', f'job:{job["id"]}/doc:{d2}/pass:harmonize']
    assert {(e.get('user') or {}).get('id') for e in entries} == {email}, 'written as the starter'
    raw = admin.documents.get(d2, include_body=True)
    spans = [sp for tl in raw['text_layers'] for tk in tl['token_layers'] for sl in tk.get('span_layers') or []
             for sp in sl.get('spans') or []]
    stamped = [sp['metadata'] for sp in spans if (sp.get('metadata') or {}).get('prov')]
    assert stamped and all(md['prov'] == 'inferred' and md['provDetail']['job'] == job['id']
                           and 'provConfirmed' not in md for md in stamped)
    assert any(sp['value'] == 'go' for sp in spans), 'harmonized to the majority'


def test_a_jobs_token_is_refused_on_a_maintainers_route(world):
    admin, writer, email, s = world
    from plaid_client import PlaidAPIError, PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', ['gloss'])
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id'] and claimed['token']
    token = PlaidClient(core_url(), claimed['token'])
    try:
        assert token.documents.get(s.ids['d1'])['id'] == s.ids['d1'], 'it reads the project'
        with pytest.raises(PlaidAPIError) as e:
            token.projects.set_config(s.project_id, 'igt', 'jobLiveProbe', {'x': 1})
        assert e.value.status == 403
    finally:
        admin.jobs.finish(made['id'], WORKER, 'done', {'state': 'done'})
