"""A job that fills only the words it adds (RPF-A7, the owner's R3).

RP-6: asked to insert ∅ where a clause has no subject and give each ∅ a Word
class, a job also filled Word class on 154 existing words, because its card
could not say "only on the words it inserts". The card can now say so
(propose_job's ``only_new``, the setup's ``onlynew``), the planner is told
in its setup line, and the job's workspace refuses, whatever path stages
it, a value of a setup target on a word, a morpheme of it or a sentence the
job did not add: listed as refused with the code ``not-added``. A word the
job added is decided by its own text edits and the token ids they made,
never by form."""

import json

import pytest

from fixtures import FakeClient, GLOSS, MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job, jobcard, targets as tg, toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project

J = 'JON'


def _setup(only=True, text=True, fills=((GLOSS, 'Gloss'),)):
    return {'fills': [{'id': i, 'name': n} for i, n in fills], 'text': text, 'conversation': 'c1',
            **({'onlynew': True} if only else {})}


# --- the card and the setup --------------------------------------------------------------------

def _drafting():
    from plaid_agent.igt.workspace import Workspace
    client = FakeClient()
    client.jobs.active = lambda project_id: None
    return Workspace(client, load_project(client, 'p1'))


def _draft(ws, **kw):
    return toolkit.call_tool(ws, 'propose_job', {'action': 'draft', 'documents': ['all'], 'fills': ['Gloss'],
                                                 'brief': 'Insert ∅ before each verb with no subject.', **kw})


def test_the_card_fills_only_the_words_the_job_adds_only_when_it_may_edit_the_text():
    ws = _drafting()
    out = _draft(ws, only_new=True)
    assert jobcard.ONLY_NEW_REFUSAL in str(out), out
    assert ws.job_card is None
    _draft(ws, only_new=True, edits_text=True)
    assert ws.job_card['only_new'] is True and ws.job_card['edits_text'] is True
    _draft(ws, edits_text=True)
    assert ws.job_card['only_new'] is False, 'always said on a new card'


def test_the_setup_reads_onlynew_and_the_planner_is_told():
    project = load_project(FakeClient(), 'p1')
    setup = tg.setup_of(project, _setup())
    assert setup.only_new is True
    assert setup.line == 'This job was set up to fill only "Gloss", only on the words it adds. It may edit the text.'
    assert tg.said_setup(_setup()) == setup.line
    assert tg.setup_of(project, _setup(only=False)).only_new is False
    assert tg.setup_of(project, {**_setup(), 'onlynew': 'yes'}).unread, 'onlynew is a boolean or absent'


def test_a_setup_with_no_onlynew_is_read_with_no_limit_as_the_page_reads_it():
    """Every setup made before R3, and every card without the row, has no
    ``onlynew``: readable, with no limit, as the job page's ``readableSetup``
    reads it. ``onlynew`` present and null is unreadable on both sides."""
    project = load_project(FakeClient(), 'p1')
    for setup in (_setup(only=False), {**_setup(only=False), 'onlynew': False}):
        read = tg.setup_of(project, setup)
        assert not read.unread and read.only_new is False and tg.readable(setup)
        assert read.line == 'This job was set up to fill only "Gloss". It may edit the text.'
    assert tg.setup_of(project, {**_setup(), 'onlynew': None}).unread


# --- the guard ------------------------------------------------------------------------------------

def _piece(added=(set(), set())):
    client = FakeClient()
    ws = JobWorkspace(client, load_project(client, 'p1'))
    ws.edits_text = True
    ws.only_new = (set(added[0]), set(added[1]))
    ws.only_targets = {GLOSS}
    return ws


def test_a_value_on_a_word_the_job_did_not_add_is_refused_as_not_added():
    ws = _piece()
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert 'this job fills only the words it adds' in str(out), out
    assert ws.ops == []
    assert [e['code'] for e in ws.left_by_refusal] == ['not-added']


def test_a_value_on_a_word_the_job_added_is_staged():
    ws = _piece()
    doc = ws.doc('Text 1')
    w = doc.sentences[0].words[0]
    ws.only_new = ({w.id}, set())
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert [o['kind'] for o in ws.ops] == ['set_span']


def test_a_value_outside_the_setups_targets_is_not_its_business():
    ws = _piece()
    ws.only_targets = {MGLOSS}
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert [o['kind'] for o in ws.ops] == ['set_span']


def test_a_value_on_the_new_word_of_a_retype_in_the_same_piece_is_staged_and_an_old_ones_refused():
    ws = _piece()
    toolkit.call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'zz Gam-ar.'})
    retyped = [o for o in ws.ops if o['kind'] == 'edit_text']
    assert retyped, ws.ops
    new = [i for i, p in enumerate(retyped[0]['planned_words'], start=1) if p['word_id'] is None]
    old = [i for i, p in enumerate(retyped[0]['planned_words'], start=1) if p['word_id'] is not None]
    assert new and old, retyped[0]['planned_words']
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': [f's2.w{new[0]} "zz"'],
                                        'values': {'Gloss': 'he'}})
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': [f's2.w{old[0]} "Gam-ar"'],
                                             'values': {'Gloss': 'x'}})
    assert 'this job fills only the words it adds' in str(out), out
    assert [o['value'] for o in ws.ops if o['kind'] == 'set_span'] == ['he']


def test_the_text_edits_themselves_pass():
    ws = _piece()
    toolkit.call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'zz Gam-ar.'})
    assert [o['kind'] for o in ws.ops] == ['edit_text'] and not ws.left_by_refusal


# --- a job --------------------------------------------------------------------------------------

def test_a_job_refuses_a_value_on_an_existing_word_and_lists_it(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'Insert ∅ before each verb with no subject and give it the Gloss "he".', id=J,
                plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())

    def answer(asked, n, kwargs):
        if 'Your piece' not in asked or n > 1:
            return reply('Refused on tqmc.')
        assert igt_job.ONLY_NEW_LINE in asked
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w2'], 'values': {'Gloss': 'x'}})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert not [c for c in client.calls if c[0].startswith('spans')], 'nothing written on an existing word'
    refused = finished['report']['documents'][0]['refused']
    assert [r['code'] for r in refused] == ['not-added'] and refused[0]['sentence'] == 's1'


def test_the_apply_rule_refuses_a_value_on_an_existing_word_that_staging_let_through(monkeypatch):
    """The staging guard is one line of defence. Where a job's ops are
    applied, under the document's lock, the same rule holds: a value of a
    setup target on a word the job did not add is listed as refused
    (``not-added``) and never written, whatever path staged it (RPF-INT 4)."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'Insert ∅ before each verb with no subject and give it the Gloss "he".', id=J,
                plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    monkeypatch.setattr(JobWorkspace, 'refuse_not_added', lambda self, op: None)

    def answer(asked, n, kwargs):
        if 'Your piece' not in asked or n > 1:
            return reply('Glossed tqmc.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w2'], 'values': {'Gloss': 'x'}})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert not [c for c in client.calls if c[0].startswith('spans')], 'nothing written on an existing word'
    refused = finished['report']['documents'][0]['refused']
    assert [(r['code'], r['sentence']) for r in refused] == [('not-added', 's1')], refused
    assert finished['report']['totals']['changes'] == 0


def test_the_words_a_write_added_are_kept_and_a_later_piece_may_fill_them(monkeypatch):
    """What one write added (by id, under the lock) is kept among the job's
    rows, so a later worker reads it back."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'x', id=J, plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    r = runner(job)
    before = r.read(r.project(), 'd1')
    after_raw = document('d1', 'Story', [{'words': ['sc', 'zz', 'tqmc']}])
    tokens = after_raw['text_layers'][0]['token_layers'][1]['tokens']
    tokens[1]['id'], tokens[2]['id'] = 'new-zz', 'd1-s1w2'
    client._holder('d1')['documents']['d1'] = after_raw
    r.record_added('d1', before, r.read(r.project(), 'd1'))
    rows = [json.loads(x['analysis']) for (f, _k), x in client.jobs.decision_rows[J].items()
            if f == igt_job.ADDED_FORM + 'd1']
    assert rows == [{'document': 'd1', 'words': ['new-zz'], 'sentences': []}]
    assert runner(job).added() == ({'new-zz'}, set()), 'read back by the next worker'


def test_left_blank_of_such_a_job_lists_only_the_words_it_added(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'x', id=J, plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Nothing to add.')))
    finished = run_job(job, runner(job))
    doc = finished['report']['documents'][0]
    assert doc.get('left', []) == [] and doc['counts']['blank'][0]['untouched'] == 0
