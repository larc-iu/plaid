"""STRESS S2-1: a whole-selection piece deletes a lexicon entry (a change of
no document, written with the first document's write) and sets a value in
a second document whose sentence holds a link to that entry. The entry's
links go with it there, by the job's own write: the second document's
value is still written, nothing counts as changed during the job, and no
second piece asks for the document again."""

import copy

import pytest

from job_fixtures import both_ways  # noqa: F401 (the pytestmark below)
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job

J = 'JSL'
SELECTION = 'Your piece: the whole selection'

# Each test also runs with documents kept between reads as on a real core
# (SCL7-6, REV-CU-2): the reads that must be fresh are fresh there too.
pytestmark = pytest.mark.usefixtures('both_ways')


def _docs():
    d1 = document('d1', 'Story 1', [{'words': [('Ali', [('Ali', 'Ali', 'vi-ali')], 'human'), 'ta']}])
    d2 = document('d2', 'Story 2', [{'words': [('Ali', [('Ali', 'Ali', 'vi-ali')], 'human'),
                                               ('ka', [('ka', None)], 'human')]}])
    return d1, d2


def _unlinked(raw):
    raw = copy.deepcopy(raw)
    for tl in raw['text_layers'][0]['token_layers']:
        for v in tl.get('vocabs') or []:
            v['vocab_links'] = []
    raw['version'] = raw['version'] + 1
    return raw


@pytest.mark.parametrize('fills', [None, ()])
def test_a_selections_own_entry_delete_is_not_a_change_during_the_job(monkeypatch, fills):
    d1, d2 = _docs()
    client = JobClient({'d1': d1, 'd2': d2})
    # The job's own delete takes the entry's links in Story 2 with it.
    client.after_write['d2'] = _unlinked(d2)
    kw = {} if fills is None else {'fills': fills}
    job = start(client, 'Tidy the lexicon.', id=J, plan='selection', **kw)
    asked_of = []

    def answer(asked, n, kwargs):
        asked_of.append(asked)
        if SELECTION not in asked:
            return reply('Nothing more to do here.')
        if n == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'})])
        if n == 2:
            return reply(calls=[call(2, 'delete_entry', {'entry_id': 'vi-ali'}),
                                call(3, 'set_field', {'document': 'Story 2', 'refs': ['s1.w2.m1'],
                                                      'field': 'Morph Gloss', 'value': 'X-sel'})])
        return reply('Tidied.')
    use(monkeypatch, Model(answer))
    # The starter may delete entries (a maintainer).
    from plaid_agent.igt import job as igt_job
    monkeypatch.setattr(igt_job.IgtRunner, 'starter_maintains', lambda self, ws, project: True)
    finished = run_job(job, runner(job))
    assert 'X-sel' in str(client.calls), 'the value staged in Story 2 is written'
    d2_row = finished['report']['documents'][1]
    assert not d2_row['counts'].get('changed'), d2_row['counts']
    assert all(SELECTION in a for a in asked_of), 'no second piece for Story 2'
