"""The protected-content rule, clause by clause (SPEC 6.5): at staging, and
again under the lock against the document as it is then (SPEC 5.4)."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch
from plaid_agent.igt.project import load_project, parse_document

TASKS = ['translate', 'gloss', 'link']


def _story():
    return [
        {'words': ['ctx'], 'translation': ('Context.', 'human')},
        {'words': ['blank', ('done', [('do', 'DO'), ('ne', 'NE')], 'human'), ('mach', [('mach', 'M')], 'machine')],
         'translation': ('A person wrote this.', 'human')},
        {'words': [{'form': 'valued', 'gloss': ('w', 'machine')}, 'free'], 'translation': ('Draft.', 'machine')},
    ]


def _ws(sentences=None, tasks=TASKS):
    client = JobClient({'d1': document('d1', 'Story', sentences or _story())})
    project = load_project(client, 'p1')
    ws = JobWorkspace(client, project, tasks)
    doc = ws.doc('d1')
    ws.stretch = Stretch(doc, project, doc.sentences[1:], tasks, 'J1')
    return ws


def _run(ws, name, args):
    return toolkit.job_call_tool(ws, name, {'document': 'Story', **args}, ws.tasks)


@pytest.mark.parametrize('name,args,said', [
    ('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'ctx'}]}, 's1 is not one of the target sentences'),
    ('set_analysis', {'ref': 's2.w2', 'morphemes': [{'form': 'done'}]}, 'is not a target'),
    ('set_analysis', {'ref': 's2.w3', 'morphemes': [{'form': 'mach'}]}, 'is not a target'),
    ('set_analysis', {'ref': 's3.w1', 'morphemes': [{'form': 'valued'}]}, 'is not a target'),
    ('set_field', {'refs': ['s2'], 'field': 'Translation', 'value': 'Mine.'}, 'is not a target'),
    ('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'Mine.'}, 'not one of the target sentences'),
    ('set_field', {'refs': ['s3.w1'], 'field': 'Gloss', 'value': 'x'}, 'is not a target'),
    ('set_field', {'refs': ['s2.w2.m1'], 'field': 'Morph Gloss', 'value': 'x'}, 'is not a target'),
    ('link_entry', {'refs': ['s2.w1'], 'entry_form': 'gam#1'}, 'Link the morphemes'),
    ('link_entry', {'refs': ['s2.w2.m1'], 'entry_form': 'gam#1'}, 'is not a target'),
])
def test_a_change_to_anything_but_a_target_is_refused_at_staging(name, args, said):
    ws = _ws()
    out = _run(ws, name, args)
    assert said in str(out) and not ws.ops, out


def test_the_targets_themselves_are_staged():
    ws = _ws()
    assert 'staged' in _run(ws, 'set_analysis', {'analyses': [
        {'ref': 's2.w1', 'morphemes': [{'form': 'bla', 'type': 'stem'}, {'form': 'nk', 'type': 'suffix'}]},
        {'ref': 's3.w2', 'morphemes': [{'form': 'free'}]}]}).lower()
    assert 'staged' in _run(ws, 'set_field', {'refs': ['s3'], 'field': 'Translation', 'value': 'Free.'}).lower()
    assert 'staged' in _run(ws, 'link_entry', {'refs': ['s2.w1.m1'], 'entry_form': 'gam#1'}).lower()
    assert {o['kind'] for o in ws.ops} == {'set_analysis', 'set_span', 'link'}


def test_a_task_not_asked_is_refused():
    ws = _ws(tasks=['gloss'])
    out = toolkit.job_call_tool(ws, 'set_field', {'document': 'Story', 'refs': ['s3'], 'field': 'Translation',
                                                  'value': 'x'}, ws.tasks)
    assert 'not a target' in out and not ws.ops


def _job_doc(sentences):
    return document('d1', 'Story', sentences)


def test_an_op_whose_sentence_changed_before_the_lock_is_dropped_and_its_sentence_taken_again(monkeypatch):
    before = [{'words': ['blank', 'other']}]
    after = [{'words': ['blank', {'form': 'other', 'gloss': ('typed', 'human')}]}]
    client = JobClient({'d1': _job_doc(before)})
    job = start(client, ['gloss'])
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


def test_a_target_no_longer_a_target_under_the_lock_is_dropped_as_protected():
    client = JobClient({'d1': _job_doc([{'words': ['blank']}])})
    job = start(client, ['gloss'])
    r = runner(job)
    project = load_project(client, 'p1')
    ws = JobWorkspace(client, project, ['gloss'])
    doc = ws.doc('d1')
    st = Stretch(doc, project, doc.sentences, ['gloss'], job.id)
    ws.stretch = st
    toolkit.job_call_tool(ws, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [{'form': 'b'}]},
                          ['gloss'])
    fresh = parse_document(_job_doc([{'words': [('blank', [('blank', 'B')], 'human')]}]), project)
    prints = {s.id: ws.sentence_print(fresh, s) for s in fresh.sentences}
    kept, counts, changed = r.recheck(ws, project, fresh, st, prints, list(ws.ops))
    assert kept == [] and counts['protected'] == 1 and not changed


def test_an_off_list_value_is_staged_as_a_machine_value():
    """A closed or mixed tagset does not refuse an unverified machine value
    (SPEC 6.4): the job stores it and it shows as off-tagset."""
    ws = _ws()
    out = _run(ws, 'set_analysis', {'ref': 's2.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'NOTLISTED'}}]})
    assert 'staged' in out.lower() and ws.ops, out
