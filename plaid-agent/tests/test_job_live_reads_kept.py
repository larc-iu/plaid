"""A job's kept document bodies on a real core (SCL7-6, REV-CU-2). The job
reads a document whole once while core says it is unchanged, and whole again
after a change to what a whole read answers: here a person's value, and the
job's own lexicon change (S2-1), an entry renamed and one deleted, which core
answers by moving every document that links it. The fake client cannot
show this: it stamps a document by what it holds, so its stamp moves with the
content by construction. Here core's own version and time decide.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import uuid
from types import SimpleNamespace

from job_fixtures import document, job_project
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidClient
from plaid_agent.core.agent import ModelConfig
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.igt.project import load_project
from plaid_agent.jobworker import count_chars

FIELD = 'Morph Gloss'


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _world(admin):
    email = f'job-kept-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-kept-pass-1', False)
    starter = PlaidClient.login(core_url(), email, 'job-kept-pass-1')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        {'id': 'e-kai', 'form': 'kai', 'metadata': {}}, {'id': 'e-lo', 'form': 'lo', 'metadata': {}}]}
    s = seed(admin, job_project(), {
        'dA': document('dA', 'Story A', [{'words': [('kai', [('kai', 'go', 'e-kai')], 'human'),
                                                    ('lo', [('lo', 'here', 'e-lo')], 'human')]}])},
        {'v1': lexicon}, name=f'job kept {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    return starter, s


def _counting(client):
    whole = []
    get = client.documents.get

    def counting(document_id, **kw):
        if kw.get('include_body'):
            whole.append(document_id)
        return get(document_id, **kw)
    client.documents.get = counting
    return whole


def _morphemes(doc):
    return [(m.form, m.fields[FIELD].value if FIELD in m.fields else None, m.link.form if m.link else None)
            for s in doc.sentences for w in s.words for m in w.morphemes]


def test_a_kept_body_gives_way_to_every_change_core_makes_to_the_document(fresh_document_cache):
    admin = _admin()
    starter, s = _world(admin)
    igt_job._BODIES.clear()
    try:
        assert not getattr(starter, 'no_doc_cache', False) and starter.base_url
        run = IgtRunner(SimpleNamespace(id=f'job-{uuid.uuid4().hex[:8]}', client=lambda: starter),
                        ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                        write_summary=False)
        project = load_project(starter, s.project_id)
        doc_id = s.ids['dA']
        whole = _counting(starter)

        first = run.read(project, doc_id, starter)
        assert _morphemes(first) == [('kai', 'go', 'kai'), ('lo', 'here', 'lo')]
        assert _morphemes(run.read(project, doc_id, starter)) == _morphemes(first)
        assert whole == [doc_id], 'an unchanged document is read whole once'

        # A person's value.
        span = first.sentences[0].words[0].morphemes[0].fields[FIELD]
        admin.spans.update(span.id, 'went')
        assert _morphemes(run.read(project, doc_id, starter))[0] == ('kai', 'went', 'kai')

        # The job's own lexicon change (S2-1): a rename, then a delete.
        admin.vocab_items.update(s.ids['e-kai'], 'kay')
        assert _morphemes(run.read(project, doc_id, starter))[0] == ('kai', 'went', 'kay')
        admin.vocab_items.delete(s.ids['e-lo'])
        assert _morphemes(run.read(project, doc_id, starter))[1] == ('lo', 'here', None)

        assert whole == [doc_id] * 4, whole
        # Unchanged since: kept again.
        run.read(project, doc_id, starter)
        assert whole == [doc_id] * 4, whole
    finally:
        igt_job._BODIES.clear()
        s.delete()
