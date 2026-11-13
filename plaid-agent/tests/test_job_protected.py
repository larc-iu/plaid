"""What is checked under the lock (SPEC 5.4): an op whose sentence changed
since the piece read it is dropped and its sentence taken again, and what is
left goes to the apply rule (test_job_apply.py), which writes only what fills
something empty or revises the job's own work. Nothing is refused at staging
for what it would change (the owner's ruling 13)."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch
from plaid_agent.igt.project import load_project, parse_document



def _story():
    return [
        {'words': ['ctx'], 'translation': ('Context.', 'human')},
        {'words': ['blank', ('done', [('do', 'DO'), ('ne', 'NE')], 'human'), ('mach', [('mach', 'M')], 'machine')],
         'translation': ('A person wrote this.', 'human')},
        {'words': [{'form': 'valued', 'gloss': ('w', 'machine')}, 'free'], 'translation': ('Draft.', 'machine')},
    ]


def _ws(sentences=None):
    client = JobClient({'d1': document('d1', 'Story', sentences or _story())})
    project = load_project(client, 'p1')
    ws = JobWorkspace(client, project)
    doc = ws.doc('d1')
    ws.stretch = Stretch(doc, project, doc.sentences[1:], 'J1')
    return ws


def _run(ws, name, args):
    return toolkit.job_piece_call(ws, name, {'document': 'Story', **args})


def _job_doc(sentences):
    return document('d1', 'Story', sentences)


def test_an_op_whose_sentence_changed_before_the_lock_is_dropped_and_its_sentence_taken_again(monkeypatch):
    before = [{'words': ['blank', 'other']}]
    after = [{'words': ['blank', {'form': 'other', 'gloss': ('typed', 'human')}]}]
    client = JobClient({'d1': _job_doc(before)})
    job = start(client)
    client.on_lock['d1'] = _job_doc(after)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    runner(job).document('d1')
    row = job.rows['d1']
    assert row['counts']['changed'] == 1, 'the first stretch read s1 before the person typed in it'
    stretches = [c for c in model.calls if c['n'] == 1]
    assert len(stretches) == 2, 's1 was taken again'
    assert "'blank'" in str(client.calls), 'and written the second time'
    assert not row.get('skipped')


def test_a_word_a_person_analysed_since_is_a_proposed_change_under_the_lock():
    client = JobClient({'d1': _job_doc([{'words': ['blank']}])})
    job = start(client)
    r = runner(job)
    project = load_project(client, 'p1')
    ws = JobWorkspace(client, project)
    doc = ws.doc('d1')
    st = Stretch(doc, project, doc.sentences, job.id)
    ws.stretch = st
    toolkit.job_piece_call(ws, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [{'form': 'b'}]})
    fresh = parse_document(_job_doc([{'words': [('blank', [('blank', 'B')], 'human')]}]), project)
    # The sentence as the piece read it is the sentence now (no change since):
    # the rule alone decides.
    prints = {s.id: ws.sentence_print(fresh, s) for s in fresh.sentences}
    kept, counts, changed, proposed = r.recheck(ws, project, fresh, st, prints, list(ws.ops))
    assert kept == [] and counts['proposed'] == 1 and [c['from'] for c in proposed] == ['blank ‘B’']


def test_an_off_list_value_is_staged_as_a_machine_value():
    """A closed or mixed tagset does not refuse an unverified machine value
    (SPEC 6.4): the job stores it and it shows as off-tagset."""
    ws = _ws()
    out = _run(ws, 'set_analysis', {'ref': 's2.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'NOTLISTED'}}]})
    assert 'staged' in out.lower() and ws.ops, out
