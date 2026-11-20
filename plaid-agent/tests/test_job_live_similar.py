"""The similar sentences of a piece in sentences, on a real core (BRIEF-SS):
the pool is read from what core holds (a sentence people analysed in
another document, its translation, its glosses), and the piece's message
shows it as analyze_sentence takes it.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import uuid

from job_fixtures import Model, document, job_project, reply, use
from live import core_url, seed
from test_job_live_delete_sentence import _admin, _job, _runner

from plaid_client import PlaidClient
from plaid_agent.core.job import run_job
from plaid_agent.igt import similar
from plaid_agent.igt.prompt import JOB_STAGE_SIMILAR


def test_a_piece_is_handed_the_sentences_people_analysed_most_like_its_own(monkeypatch):
    admin = _admin()
    email = f'job-similar-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-similar-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-similar-pass-1')
    s = seed(admin, job_project(),
             {'dA': document('dA', 'Alpha', [{'words': ['gamda', 'zo']}]),
              'dP': document('dP', 'People', [
                  {'words': [('gamdi', [('gam', 'fish'), ('di', 'ERG')], 'human'), ('ka', [('ka', 'eat')], 'human')],
                   'translation': ('The fish ate.', 'human')},
                  {'words': [('lili', [('lili', 'sing')], 'human'), 'mumu']}])},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}},
             name=f'job similar {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    try:
        model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
        job = _job(admin, writer, s, 'Segment and gloss.', 'sentences')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        first = next(c for c in model.calls if 'Document "Alpha"' in c['asked'])
        asked = first['asked']
        # "lili mumu." is not people's whole sentence: mumu is unanalysed.
        assert '\n'.join([similar.HEAD, '', 'gamdi ka.', 'Translation: The fish ate.',
                          'Words: ["gam-di fish-ERG", "ka eat"]', '', 'Instructions from']) in asked, asked
        assert JOB_STAGE_SIMILAR in first['kwargs']['messages'][0]['content']
    finally:
        s.delete()
