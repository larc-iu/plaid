"""RW round 3 (REV-RW-R2-3): a restarted worker never asks a selection again
once core holds its rows."""

import json

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP

J = 'JSR'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _closing(kwargs):
    return any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages'])


def _stage(name, ns, gloss='go'):
    return [call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': gloss}}]}) for n in ns]


def _reads(n):
    return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])


def _analysed(n):
    return [{'words': [{'form': f'ka{i}', 'morphs': [(f'ka{i}', 'go')]}, {'form': 'ta', 'morphs': [('ta', 'x')]}]}
            for i in range(1, n + 1)]


def _firsts(model):
    out = []
    for c in model.calls:
        if c['n'] == 1:
            a = c['asked']
            out.append('WHOLE' if WHOLE in a else 'SELECTION' if SELECTION in a else targets_named(a))
    return out


TWO = {'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(3))}


def test_a_restarted_worker_never_asks_a_selection_again_once_core_holds_its_rows(monkeypatch):
    """REV-RW-R2-3, the reviewer's P11: a selection stages Story s1 and runs
    out, both documents go to stretches, and the worker dies in the second
    stretch. The resumed worker goes on with the stretches: the selection is
    never asked again, and no change already written becomes a proposal."""
    client = JobClient(dict(TWO))
    job = start(client, id=J, plan='selection')
    state = {'stretches': 0}

    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if SELECTION in asked:
            return reply(calls=_stage('Story', [1])) if n == 1 else _reads(n)
        if n == 1:
            state['stretches'] += 1
            if state['stretches'] == 2:
                raise KeyboardInterrupt('the worker dies in a stretch')
            return reply(calls=_stage(asked.split('"')[1], targets_named(asked)))
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    with pytest.raises(KeyboardInterrupt):
        run_job(job, runner(job))
    finished = run_job(job, runner(job))
    assert _firsts(model).count('SELECTION') == 1, _firsts(model)
    assert finished['report']['proposed'] == []
    assert [d['counts']['words'] for d in finished['report']['documents']] == [3, 3]
