"""STRESS S5-4: a maintainer changes the ignored-token rule while a piece
works, so a word the piece was shown is now ignored (hidden from the grid).
Nothing is written on it: the write reads the document by the rule as it is
now, the word's sentence reads as changed, and the walk takes it again."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from fixtures import MGLOSS, WORD_LAYER
from plaid_agent.core.job import run_job

J = 'JIG'


def test_a_word_ignored_while_the_piece_worked_gets_no_value(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'lo']}, {'words': ['nima']}])})
    job = start(client, 'Gloss every word.', id=J, plan='sentences', fills=(MGLOSS,))
    hidden = {}

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if not hidden:
            word = next(t for t in client.project['text_layers'][0]['token_layers'] if t['id'] == WORD_LAYER)
            word['config']['plaid']['ignoredTokens'] = {'type': 'blacklist', 'blacklist': ['lo']}
            hidden['yes'] = True
        refs = [r for r in ('s1.w1.m1', 's1.w2.m1', 's2.w1.m1') if f'[{r[:2]}]' in asked]
        return reply(calls=[call(i, 'set_field', {'document': 'Story', 'refs': [r], 'field': 'Morph Gloss',
                                                  'value': f'J{i}'}) for i, r in enumerate(refs, 1)])
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    body = client.documents.get('d1', include_body=True)['text_layers'][0]['text']['body']
    made = {p['kwargs']['id']: body[p['args'][2]:p['args'][3]] for p in client.payloads('tokens.create')}
    glossed = sorted(made.get(p['args'][1][0], p['args'][1][0]) for p in client.payloads('spans.create'))
    assert glossed == ['ka', 'nima'], glossed
