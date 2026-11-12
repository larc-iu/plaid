"""The tasks a job was started with bound every write it makes, in every
pass (REV-J-B S3-2): each task alone and in every pair a job may be started
with, against a model that stages everything it can, and a harmonize whose
people's analysis carries a link. The report counts what was written: a
person's translation is not a target the model left blank."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job

J = 'JT'
COMBOS = [('translate',), ('gloss',), ('gloss', 'link'), ('translate', 'gloss'), ('translate', 'gloss', 'link')]


def _greedy(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    return reply(calls=[
        call(1, 'set_field', {'document': doc, 'refs': ['s1'], 'field': 'Translation', 'value': 'T.'}),
        call(2, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                 'morphemes': [{'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}),
        call(3, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'go'}),
        call(4, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}}),
        call(5, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:ka#1'}),
    ])


def _harmonize_doc():
    # The job's own ka 'go' twice and ka 'come' once, and a person's ka 'go'
    # linked to an entry: harmonize rewrites the 'come' to the person's.
    w = lambda g: ('ka', [('ka', g)], J)  # noqa: E731
    return document('h', 'Harm', [{'words': [w('go'), w('go'), w('come'), ('ka', [('ka', 'go', 'vi-gam')], 'human')]}])


def _layers_written(client):
    out = set()
    for kind, payload in client.calls:
        text = str(payload)
        if kind.startswith('vocab_links'):
            out.add('link')
        elif kind.startswith('vocab_items'):
            out.add('entry')
        elif kind.startswith('tokens'):
            out.add('morpheme')
        for layer, name in (('sl-trans', 'translation'), ('sl-mgloss', 'morpheme'), ('sl-gloss', 'word field')):
            if f"'{layer}'" in text:
                out.add(name)
    return out


ALLOWED = {'translate': {'translation'}, 'gloss': {'morpheme', 'word field'}, 'link': {'link', 'entry'}}


@pytest.mark.parametrize('tasks', COMBOS, ids=['+'.join(c) for c in COMBOS])
def test_the_tasks_asked_bound_every_write_of_every_pass(monkeypatch, tasks):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}]), 'h': _harmonize_doc()})
    job = start(client, list(tasks), id=J)
    use(monkeypatch, Model(_greedy))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    allowed = set().union(*(ALLOWED[t] for t in tasks))
    assert _layers_written(client) <= allowed, (tasks, _layers_written(client))


def test_a_persons_translation_written_meanwhile_is_not_counted_left(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    client.after_write['d1'] = document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], J)],
                                                         'translation': ('Mine.', 'human')}], version=2)
    job = start(client, ['translate', 'gloss'], id=J)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                     'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
    use(monkeypatch, Model(answer))
    assert runner(job).document('d1') == 'done'
    assert job.rows['d1']['counts']['left'] == 0
