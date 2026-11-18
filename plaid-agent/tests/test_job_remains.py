"""RW round 3 (REV-RW-R2-1): what remains after a big piece is what the
ordinary walk would take for the plan, among the sentences the piece staged
nothing in. Reads are scripted with calls that need no core."""

import json

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP

J = 'JRM'
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


def test_a_revising_whole_document_that_ran_out_has_every_unstaged_sentence_worked_in_stretches(monkeypatch):
    """REV-RW-R2-1, the reviewer's P7: every sentence analysed, a job that
    revises glosses by documents (every sentence is walked). The whole piece
    changes s1's gloss and runs out. s2 to s6 are then worked in stretches,
    as a stretch under the same plan would have counted them."""
    client = JobClient({'d1': document('d1', 'Story', _analysed(6))})
    job = start(client, 'Check every gloss and correct the wrong ones.', id=J, plan='document')

    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if WHOLE in asked:
            return reply(calls=_stage('Story', [1], gloss='walk')) if n == 1 else _reads(n)
        return reply('Checked.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert _firsts(model) == ['WHOLE', [2, 3, 4, 5, 6]]
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'ran-out'}]
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['skipped'] == []
