"""A job that fills a field on texts already analysed, on a real core (BRIEF
EW): a guideline says how to fill the word field Thematic role, the job is
planned in sentences (every sentence, as no only_empty is set), and the
scripted piece sets the field on every word of three fully analysed
sentences with set_field. The write lands, the report counts the field's
values, Left blank lists nothing, and Undo job (core's route) takes it back.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from job_fixtures import Model, plan_row, use
from live import _skip_or_fail, core_url, login, seed
from test_job_fields import GUIDELINE, INSTRUCTIONS, ROLE, ROLE_NAME, VALUES, WORDS, _fill, _piece_words, \
    role_document, role_of, role_project
from test_job_live_entries import WORKER, _runner

from plaid_agent.core.job import Job, run_job


@pytest.fixture
def world():
    """A writer who maintains a project of the Thematic role field."""
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-fields-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-fields-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-fields-pass-1')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, role_project(), {'d1': role_document()}, {'v1': lexicon},
             name=f'job fields {uuid.uuid4().hex[:6]}')
    admin.projects.add_maintainer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _job(admin, writer, s, pieces):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', INSTRUCTIONS)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces, ids=s.ids, fills=(ROLE,))])
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _roles(admin, s):
    """Word fixture id -> its Thematic role value, as core holds them."""
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    back = {real: fixture for fixture, real in s.ids.items()}
    return {back[sp['tokens'][0]]: sp['value'] for tl in raw['text_layers'] for tk in tl['token_layers']
            for sl in tk.get('span_layers') or [] if sl['id'] == s.ids[ROLE] for sp in sl.get('spans') or []}


def test_a_job_fills_a_field_on_every_word_and_undo_job_takes_it_back(world, monkeypatch):
    admin, writer, s = world
    writer.guidelines.create(s.project_id, 'Thematic role', body=GUIDELINE)
    model = use(monkeypatch, Model(_fill(_piece_words)))
    job = _job(admin, writer, s, 'sentences')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    pieces = [c['asked'] for c in model.calls if c['n'] == 1 and 'Instructions from' in c['asked']]
    assert [p.splitlines()[-1] for p in pieces] == ['Your piece: s1, s2, s3.']
    assert 'Empty in s1: Thematic role in w1 ' in pieces[0], pieces[0]
    expected = {f'd1-s{si}w{wi}': role_of(si, wi) for si, ws in enumerate(WORDS, start=1)
                for wi in range(1, len(ws) + 1)}
    assert _roles(admin, s) == expected, 'the write landed'
    report = finished['report']
    (doc,) = report['documents']
    assert doc['counts']['fields'] == [{'field': ROLE_NAME, 'id': s.ids[ROLE], 'values': VALUES}], doc['counts']
    assert report['totals']['fields'] == [{'field': ROLE_NAME, 'id': s.ids[ROLE], 'values': VALUES}]
    assert report['totals']['changes'] == VALUES and report['totals']['words'] == 0
    assert doc['left'] == [] and doc['left_more'] == 0 and not doc['counts'].get('left')
    assert doc['done'] == doc['targets'] == len(WORDS)
    # As core keeps the job: its row and its report, keys as the wire has them.
    read = admin.jobs.get(job.id)
    assert read['documents'][0]['counts']['fields'] == [{'field': ROLE_NAME, 'id': s.ids[ROLE], 'values': VALUES}]
    assert read['report']['totals']['fields'] == [{'field': ROLE_NAME, 'id': s.ids[ROLE], 'values': VALUES}]
    undone = writer.jobs.undo(job.id)
    assert undone, undone
    assert _roles(admin, s) == {}, 'Undo job took every value back'
    assert admin.jobs.get(job.id).get('undone'), 'the job reads undone'
