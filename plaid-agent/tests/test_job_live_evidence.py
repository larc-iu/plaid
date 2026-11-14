"""A piece of a job planned in sentences stages its sentence on its first
model call from the evidence block alone, on a real core (EV): the block is
read from what core holds (people's analysis in another document, the
lexicon), the scripted model writes analyze_sentence's items from it, and
core holds the analysis and the link.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import uuid

from fixtures import MORPH_LAYER
from job_fixtures import Model, call, document, job_project, reply, use
from live import core_url, seed
from test_job_evidence import from_block
from test_job_live_delete_sentence import _admin, _job, _runner

from plaid_client import PlaidClient
from plaid_agent.core.job import run_job


def test_a_piece_stages_on_its_first_call_from_the_block_alone(monkeypatch):
    admin = _admin()
    email = f'job-evidence-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-evidence-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-evidence-pass-1')
    s = seed(admin, job_project(),
             {'dA': document('dA', 'Alpha', [{'words': ['gam', 'ka,', 'zo']}]),
              'dP': document('dP', 'People', [{'words': [('ka', [('ka', 'eat')], 'human')]}])},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1',
                     'items': [{'id': 'e-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
                               {'id': 'e-gam2', 'form': 'gam', 'metadata': {'gloss': 'net'}}]}},
             name=f'job evidence {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    try:
        seen = {}

        def answer(asked, n, kwargs):
            if 'Document "Alpha"' not in asked or n > 1:
                return reply('Glossed s1.')
            seen['asked'] = asked
            seen['items'] = from_block(asked)
            return reply(calls=[call(1, 'analyze_sentence', {'document': 'Alpha', 'sentences': [
                {'ref': 's1', 'words': seen['items']}]})])
        model = use(monkeypatch, Model(answer))
        job = _job(admin, writer, s, 'Segment, gloss and link.', 'sentences')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert '- "ka": people: ka ‘eat’ (1)' in seen['asked'] and 'gam#1 ‘fish’' in seen['asked'], seen['asked']
        assert seen['items'] == ['gam fish', 'ka eat', '_']
        piece = [c for c in model.calls if 'Document "Alpha"' in c['asked']]
        assert len(piece) == 2, 'one call staged, one ended the piece'
        raw = admin.documents.get(s.ids['dA'], include_body=True)
        layers = {tk['id']: tk for tk in raw['text_layers'][0]['token_layers']}
        morphs = layers[s.ids[MORPH_LAYER]]
        assert sorted(t['metadata']['form'] for t in morphs['tokens']) == ['gam', 'ka']
        linked = [link['vocab_item']['id'] for v in morphs.get('vocabs') or [] for link in v.get('vocab_links') or []]
        assert linked == [s.ids['e-gam']], linked
    finally:
        s.delete()
