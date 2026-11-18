"""STRESS S5-4: a maintainer changes the ignored-token rule while a piece
works, so a word the piece was shown is now ignored (hidden from the grid).
Nothing is written on it: the write reads the document by the rule as it is
now, the word's sentence reads as changed, and the walk takes it again."""

import pytest

from job_fixtures import both_ways  # noqa: F401 (the pytestmark below)
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from fixtures import MGLOSS, WORD_LAYER
from plaid_agent.core.job import run_job

J = 'JIG'

# Each test also runs with documents kept between reads as on a real core
# (SCL7-6, REV-CU-2): the reads that must be fresh are fresh there too.
pytestmark = pytest.mark.usefixtures('both_ways')


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


def test_the_rule_is_read_with_one_light_request_per_turn_and_per_write(monkeypatch):
    """REV-SJ2-5: what reading the rule again costs, counted on a 20-document
    job of one stretch each: the project's guidelines are read as before
    (once per document, as the walk loads the project), and the rule adds
    one ``projects.get`` per turn of the walk and one per write."""
    client = JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['lo']}])
                        for i in range(1, 21)})
    job = start(client, 'Gloss every word.', id=J, plan='sentences', fills=(MGLOSS,))
    counted = {'projects.get': 0, 'guidelines.list': 0}
    for name in counted:
        resource, method = name.split('.')
        real = getattr(getattr(client, resource), method)

        def counting(*a, _real=real, _name=name, **kw):
            counted[_name] += 1
            return _real(*a, **kw)
        monkeypatch.setattr(getattr(client, resource), method, counting)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_field', {'document': doc, 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                                  'value': 'go'})])
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    per_doc = {k: v / 20 for k, v in counted.items()}
    # At the base 1.25 and 1.25 (the walk's load per document, and the
    # checks', planning's and report's). Reloading the whole project per turn
    # and per write made it 4.25 and 4.25. Now the guidelines stay at 1.25.
    assert per_doc['guidelines.list'] <= 1.25, per_doc
    assert per_doc['projects.get'] <= 3.25, per_doc


def test_a_field_renamed_while_the_piece_worked_does_not_drop_its_write(monkeypatch):
    """REV-SJ2-5: only the ignored-token rule is read again, so renaming the
    field the piece fills changes nothing of the write."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'lo']}, {'words': ['nima']}])})
    job = start(client, 'Gloss every word.', id=J, plan='sentences', fills=(MGLOSS,))
    renamed = {}

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if not renamed:
            for tl in client.project['text_layers'][0]['token_layers']:
                for sl in tl.get('span_layers') or []:
                    if sl['id'] == MGLOSS:
                        sl['name'] = 'Morpheme gloss'
            renamed['yes'] = True
        refs = [r for r in ('s1.w1.m1', 's1.w2.m1', 's2.w1.m1') if f'[{r[:2]}]' in asked]
        return reply(calls=[call(i, 'set_field', {'document': 'Story', 'refs': [r], 'field': 'Morph Gloss',
                                                  'value': f'J{i}'}) for i, r in enumerate(refs, 1)])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    body = client.documents.get('d1', include_body=True)['text_layers'][0]['text']['body']
    made = {p['kwargs']['id']: body[p['args'][2]:p['args'][3]] for p in client.payloads('tokens.create')}
    glossed = sorted(made.get(p['args'][1][0], p['args'][1][0]) for p in client.payloads('spans.create'))
    assert glossed == ['ka', 'lo', 'nima'], glossed
    assert not finished['report']['documents'][0]['counts'].get('changed'), finished['report']['documents'][0]
