"""A refusal a job cannot follow (REV-DAY-SURFACE point 2): the chat is told
to plan once the plan is applied, in a later turn, or to discard_plan, none
of which a job has. In a job, every such refusal says what was refused and
the job's closing line, worded in one place (``core.tools.advised``), and
what it left is kept for the report. The chat's wording is unchanged.

The scenarios are the reviewer's probe (scripts/REV-DAY/probe_refusals.py),
on a JobWorkspace whose plan edits the text."""

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use
from test_retype_word_refs import machine_raw

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_LEAVE_IT
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace

AS = 'analyze_sentence'
RT = ('retype_sentence', {'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
CHAT_ONLY = ('discard_plan', 'approve the plan', 'once the plan is applied', 'once the retype is applied', 'once the split is applied',
             'separate turns', 'later turn')

SCENARIOS = {
    'retype then analyse': [RT, (AS, {'sentences': [{'ref': 's1', 'words': [
        'Ali-di Ali-ERG', '∅ 3SG', 'gam fish', 'akuna see']}]}),
        ('set_analysis', {'ref': 's1.w2 "∅"', 'morphemes': [{'form': '∅', 'fields': {'Morph Gloss': '3SG'}}]}),
        ('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph Gloss', 'value': '3SG'})],
    'analysis then retype': [(AS, {'sentences': [{'ref': 's1', 'words': ['Ali-di Ali-ERG', 'gam fish',
                                                                         'akuna see']}]}), RT],
    'split then retype': [('split_sentence', {'ref': 's1', 'before_word': 2}), RT],
    'retype then split': [RT, ('split_sentence', {'ref': 's1', 'before_word': 2})],
    'delete_word then bare numbers': [
        ('delete_word', {'refs': ['s1.w2']}),
        ('set_field', {'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'see'}),
        (AS, {'sentences': [{'ref': 's1.w3', 'words': ['akuna see']}]}),
        ('split_sentence', {'ref': 's1', 'before_word': 3})],
    'rule then retype': [('set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'fish'}), RT],
    'retype then rule': [RT, ('set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'fish'})],
    'split_word then analyse': [('split_word', {'ref': 's1.w2', 'at': 1}),
                                ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'g'}]})],
    # The lexicon's, reachable in a document or selection piece without text
    # edits (REV-DF-D-5).
    'new entry then rename': [('create_entry', {'form': 'zork', 'fields': {'gloss': 'thing'}}),
                              ('rename_entry', {'entry_form': 'zork', 'new_form': 'zorka'})],
    'deleted entry then rename': [('delete_entry', {'entry_id': 'vi-gam2'}),
                                  ('rename_entry', {'entry_id': 'vi-gam2', 'new_form': 'gama'})],
    'merge then delete what it keeps': [('merge_entries', {'keep_id': 'vi-gam', 'remove_id': 'vi-gam2'}),
                                        ('delete_entry', {'entry_id': 'vi-gam'})],
    'entry numbers moved': [('delete_entry', {'entry_id': 'vi-gam'}),
                            ('rename_entry', {'entry_form': 'gam#2', 'new_form': 'gama'})],
    'phrase then link a word in it': [('link_phrase', {'refs': ['s1.w2', 's1.w3'], 'entry_id': 'vi-gam'}),
                                      ('link_entry', {'refs': ['s1.w2'], 'entry_id': 'vi-gam2'})],
}
#: Tools that take no document.
NO_DOCUMENT = ('create_entry', 'rename_entry', 'delete_entry', 'merge_entries')


def _said(steps, job=True):
    c = FakeClient(documents={'d1': machine_raw()})
    project = load_project(c, 'p1')
    w = JobWorkspace(c, project) if job else Workspace(c, project)
    w.edits_text = True
    call = toolkit.job_piece_call if job else toolkit.call_tool
    return w, [str(call(w, tool, args if tool in NO_DOCUMENT else {'document': 'd1', **args})) for tool, args in steps]


@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_no_refusal_a_job_reads_advises_a_step_it_cannot_take(scenario):
    w, said = _said(SCENARIOS[scenario])
    refused = [x for x in said if x.startswith('Error')]
    assert refused, said
    for x in said:
        assert not any(c in x for c in CHAT_ONLY), x
    closing = [x for x in refused if JOB_LEAVE_IT in x]
    assert closing, refused
    assert len(w.left_by_refusal) == len({(e['sentence_id'], e['what']) for e in w.left_by_refusal}) >= 1


@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_the_chat_reads_every_refusal_byte_for_byte_as_before(scenario):
    """REV-DF-D-22: every answer the chat gets in every scenario, the
    refusals that carry advice among them, is the one it got before the
    refusals were split into a fact and advice (job_refusals_chat.json, made
    at 358c37f7a, before DF3 moved the lexicon's, REV-DF-D-5)."""
    import json
    import os
    with open(os.path.join(os.path.dirname(__file__), 'job_refusals_chat.json'), encoding='utf-8') as f:
        before = json.load(f)
    _, said = _said(SCENARIOS[scenario], job=False)
    assert said == before[scenario]


def test_the_chat_reads_the_same_refusals_as_before():
    """The chat's wording keeps its step, as it was."""
    _, said = _said(SCENARIOS['retype then analyse'], job=False)
    assert any('Plan this once the retype is applied. Only word field values can be planned on its words in this '
               'plan (set_field, by the numbers the retype listed).' in x for x in said), said
    _, said = _said(SCENARIOS['split then retype'], job=False)
    assert any('Retype it once the split is applied.' in x for x in said), said


def test_a_job_asked_to_insert_a_zero_element_and_gloss_it_lists_what_the_refusal_left(monkeypatch):
    """The whole job: the piece retypes s1 with "∅", glosses it by form
    (refused: its morphemes do not exist until the retype is written),
    and ends. The retype and the word value are written, the report lists
    s1 under what a refusal left, with what was refused."""
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    job = start(client, 'Insert a zero element before ta in s1 and gloss it 3SG.', id='JRF', plan='document')

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Inserted the zero element. Its gloss was refused.')
        return reply(calls=[
            call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka ∅ ta.'}),
            call(2, 'set_field', {'document': 'Story', 'refs': ['s1.w2 "∅"'], 'field': 'Gloss', 'value': 'he'}),
            call(3, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "∅"', 'morphemes': [
                {'form': '∅', 'fields': {'Morph Gloss': '3SG'}}]})])
    model = use(monkeypatch, Model(answer))
    from plaid_agent.igt import job as igt_job

    def execute(c, ops, **kw):
        # The fake has no text server: the retype is taken as written.
        client.after_write['d1'] = document('d1', 'Story', [{'words': ['ka', '∅', 'ta']}], version=2)
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    answers = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    refused = [a for a in answers if a.startswith('Error')]
    assert refused and JOB_LEAVE_IT in refused[-1] and 'once the retype is applied' not in refused[-1], answers
    (doc,) = finished['report']['documents']
    assert [(r['sentence'], r['sentence_id']) for r in doc['refused']] == [('s1', 'd1-s1')], doc
    assert 's1 is retyped in this plan' in doc['refused'][0]['what'] and doc['refused'][0]['code'] == 'text'


@pytest.mark.parametrize('job', [True, False], ids=['job', 'chat'])
def test_a_reference_to_an_entry_this_plan_creates_is_worded_by_who_reads_it(job):
    """REV-DF-D-5, lexicon.py's reference refusal (no lexicon of the fixture
    declares a reference field, so its helper is asked directly): the chat is
    told to approve first, a job reads the fact and its closing line."""
    from types import SimpleNamespace
    from plaid_agent.core.tools import run_tool
    from plaid_agent.igt import lexicon
    c = FakeClient(documents={'d1': machine_raw()})
    project = load_project(c, 'p1')
    w = JobWorkspace(c, project) if job else Workspace(c, project)
    w.new_entries['new:v1:zork#1'] = {'form': 'zork'}
    w.view = lambda vocab: SimpleNamespace(tree=SimpleNamespace(by_id={}))
    out = run_tool(w, 'set_entry_field', lambda ws: lexicon._resolve_ref(ws, {}, {'name': 'See'}, 'new:v1:zork#1',
                                                                          None), {})
    fact = '"See" must name an entry that already exists. "new:v1:zork#1" is created by this same plan and has no ' \
           'id until it is approved'
    assert out == (f'Error: {fact}. {JOB_LEAVE_IT}' if job else f'Error: {fact}: approve the plan, then set the '
                   'reference.'), out


CODES = {'new entry then rename': 'lexicon', 'deleted entry then rename': 'lexicon',
         'merge then delete what it keeps': 'lexicon', 'entry numbers moved': 'lexicon',
         'phrase then link a word in it': 'expression'}


@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_what_a_refusal_left_says_what_kind_of_refusal_it_was(scenario):
    """REV-DF-S-4: each refusal a job cannot follow carries a code of a closed
    set, which the job page labels: never its text."""
    from plaid_agent.core.tools import LEFT_CODES
    w, _ = _said(SCENARIOS[scenario])
    assert w.left_by_refusal and {e['code'] for e in w.left_by_refusal} == {CODES.get(scenario, 'text')}, \
        w.left_by_refusal
    assert set(LEFT_CODES) == {'text', 'lexicon', 'expression'}
