"""A stretch whose write spans requests, refused on a later one, under a
real core (REV-J-B3 B3-8): the write is cut into tries of one request each,
the starter types in the document between two of them, and core refuses the
next for the moved version. The job writes nothing again under the keys it
already used (core would refuse a different request under a key it stored,
422 ``idempotency-key-reused``), puts the document off, and finishes it later.
And a write whose answer was lost, after which the starter deleted what the
job wrote in a sentence, is not written again (REV-FIX3-1).

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS
from job_fixtures import plan_row, empty_translations, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core import plan
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000b8'


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-batches-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-batches-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-batches-pass-1')
    human = ('ka', [('ka', 'go')], 'human')
    docs = {'d1': document('d1', 'Story', [{'words': ['sani', 'sani']}, {'words': ['sani', 'sani']},
                                           {'words': [human]}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job batches {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _model(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': ref, 'morphemes': [
        {'form': 'sa', 'fields': {'Morph Gloss': 'go'}}, {'form': 'ni', 'fields': {'Morph Gloss': 'now'}}]})
        for i, ref in enumerate(['s1.w1', 's1.w2', 's2.w1', 's2.w2'], start=1)])


def test_a_write_refused_on_a_later_batch_sends_nothing_again_under_its_keys(world, monkeypatch):
    admin, writer, s = world
    from plaid_client import PlaidClient
    from plaid_client.batch import PlaidBatch
    use(monkeypatch, Model(_model))
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the words.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    if claimed:
        admin.jobs.add_decisions(claimed['job']['id'], WORKER, [plan_row()])
    assert claimed and claimed['job']['id'] == made['id']
    offset = {'s': 0.0}

    def sleep(seconds):
        offset['s'] += seconds
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=sleep, now=lambda: time.time() + offset['s'])
    # One analysis a request (five writes each): s1's two land, then the
    # starter types in s3, and s2's first is refused for the moved version.
    monkeypatch.setattr(plan, 'MAX_BATCH_OPS', 6)
    real, sent, refused = PlaidBatch.submit, {'n': 0}, []
    d1 = s.ids['d1']

    def submit(self):
        sent['n'] += 1
        if sent['n'] == 3:
            writer.spans.create(s.ids[GLOSS], [s.ids['d1-s3w1']], 'typed')
        try:
            return real(self)
        except Exception as e:
            refused.append((getattr(e, 'status', None), (getattr(e, 'response_data', None) or {}).get('code')))
            raise
    monkeypatch.setattr(PlaidBatch, 'submit', submit)
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                       write_summary=False)
    finished = run_job(job, runner)
    assert refused and refused[0][0] == 409, f'the starter\'s edit moved the version: {refused}'
    assert not any(status == 422 for status, _ in refused), f'a key used again for another request: {refused}'
    assert finished['state'] == 'done', (finished.get('reason'), writer.jobs.get(made['id']).get('message'))
    row = writer.jobs.get(made['id'])['documents'][0]
    # s1 landed. Nothing of s2 landed, as core says: it is a target again,
    # and a later piece writes it.
    assert row['state'] == 'done' and row['counts']['words'] == 4, row
    assert not row['skipped'], row
    raw = admin.documents.get(d1, include_body=True)
    glosses = [sp['value'] for tl in raw['text_layers'] for tk in tl['token_layers']
               for sl in tk.get('span_layers') or [] for sp in sl.get('spans') or []]
    # The piece run next is s3's, with s1 and s2 as its context, and this
    # model stages there whatever its piece: a later piece's change is
    # written (REV-JH-1), so s2's words are glossed by it.
    assert glosses.count('now') == 4 and 'typed' in glosses


@pytest.fixture
def story():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-writing-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-writing-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-writing-pass-1')
    docs = {'d1': document('d1', 'Story', [{'words': ['sani']}, {'words': ['gam', 'sani']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job writing {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _translate(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    named = [f's{n}' for n in empty_translations(asked)]
    return reply(calls=[call(i, 'set_field', {'document': 'Story', 'refs': [sid], 'field': 'Translation',
                                              'value': f'{sid} by the job.'}) for i, sid in enumerate(named, 1)])


def _translations(admin, s):
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    return [(sp['id'], sp['value']) for tl in raw['text_layers'] for tk in tl['token_layers']
            for sl in tk.get('span_layers') or [] for sp in sl.get('spans') or [] if sp.get('value')]


def test_a_translation_the_starter_deleted_after_a_lost_answer_is_not_written_again(story, monkeypatch):
    """REV-FIX3-1 (its L5): the job's write lands, its answer is lost, and
    in the wait the starter deletes the job's translation of s1. Core says
    the write landed: s1 is not written again, nothing is listed, and both
    translations the job wrote are counted."""
    admin, writer, s = story
    from plaid_client import PlaidAPIError, PlaidClient
    from plaid_client.batch import PlaidBatch
    model = use(monkeypatch, Model(_translate))
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the words.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    if claimed:
        admin.jobs.add_decisions(claimed['job']['id'], WORKER, [plan_row()])
    assert claimed and claimed['job']['id'] == made['id']
    offset, deleted = {'s': 0.0}, []

    def sleep(seconds):
        for sid, value in _translations(admin, s):
            if value == 's1 by the job.' and not deleted:
                writer.spans.delete(sid)
                deleted.append(sid)
        offset['s'] += seconds
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=sleep, now=lambda: time.time() + offset['s'])
    real, sent = PlaidBatch.submit, {'n': 0}

    def submit(self):
        sent['n'] += 1
        out = real(self)
        if sent['n'] == 1:
            raise PlaidAPIError('HTTP 502 lost after landing', status=502, method='POST', url='/batch')
        return out
    monkeypatch.setattr(PlaidBatch, 'submit', submit)
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                       write_summary=False)
    finished = run_job(job, runner)
    assert deleted, 'the starter deleted the job\'s translation in the wait'
    assert finished['state'] == 'done', (finished.get('reason'), writer.jobs.get(made['id']).get('message'))
    assert [v for _, v in _translations(admin, s)] == ['s2 by the job.'], 'the deletion stands'
    assert sum(1 for c in model.calls if c['n'] == 1) == 1, 'the model was not asked again'
    report = writer.jobs.get(made['id'])['report']
    assert report['documents'][0]['skipped'] == []
    assert report['totals']['translations'] == 2 and report['totals']['skipped_interrupted'] == 0
