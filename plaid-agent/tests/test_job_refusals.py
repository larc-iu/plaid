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
from plaid_agent.core.prompt import JOB_LEAVE_IT, JOB_TEXT_THEN_FILL
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
    # The rest of the refusals that carry advice (REV-DF3-7), each pinned in
    # the chat as at 358c37f7a.
    'merge words then split a merged word': [('merge_words', {'refs': ['s1.w2', 's1.w3']}),
                                             ('split_word', {'ref': 's1.w3', 'at': 2})],
    'split sentence then merge across it': [('split_sentence', {'ref': 's1', 'before_word': 3}),
                                            ('merge_words', {'refs': ['s1.w2', 's1.w3']})],
    'merge words then split the sentence between them': [('merge_words', {'refs': ['s1.w2', 's1.w3']}),
                                                         ('split_sentence', {'ref': 's1', 'before_word': 3})],
    'retype then delete the sentence': [RT, ('delete_sentence', {'refs': ['s1']})],
    'respell then delete the sentence': [('respell', {'ref': 's1.w3', 'new_text': 'akunaa'}),
                                         ('delete_sentence', {'refs': ['s1']})],
    'respell then retype before it': [('respell', {'ref': 's2.w1', 'new_text': 'Gam-arr'}), RT],
    'retype then comment on a word': [RT, ('add_comment', {'ref': 's1.w3', 'body': 'Check this.'})],
    'comment then retype': [('add_comment', {'ref': 's1.w3', 'body': 'Check this.'}), RT],
    'morpheme gloss then retype': [('set_field', {'refs': ['s1.w1.m1'], 'field': 'Morph Gloss', 'value': 'person'}),
                                   RT],
    'word gloss then retype taking the word': [('set_field', {'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'see'}),
                                               ('retype_sentence', {'ref': 's1', 'text': 'Ali-di gam.'})],
    'unnumbered retype then a value': [('retype_sentence', {'ref': 's1', 'text': 'A li-di ga m akuna.'}),
                                       ('set_field', {'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'see'})],
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
    at 358c37f7a, before DF3 moved the lexicon's, REV-DF-D-5; the scenarios
    REV-DF3-7 added made from 358c37f7a's source too)."""
    import json
    import os
    with open(os.path.join(os.path.dirname(__file__), 'job_refusals_chat.json'), encoding='utf-8') as f:
        before = json.load(f)
    _, said = _said(SCENARIOS[scenario], job=False)
    assert said == before[scenario]


def test_the_retype_whose_words_cannot_be_numbered_gives_a_job_its_own_next_step():
    """REV-DF4-5: the retype's own answer (a success, not a refusal) told a
    job to "plan values on them once the retype is applied", a chat step. A
    job reads its own, through the one place a next step is worded by who
    reads it (core.tools.next_step), the chat its own as before."""
    steps = SCENARIOS['unnumbered retype then a value'][:1]
    _, (job,) = _said(steps)
    assert job.endswith('Its words cannot be numbered before it is applied: no value can be planned on them in '
                        'this piece: they are offered for filling straight after.'), job
    _, (chat,) = _said(steps, job=False)
    assert chat.endswith('Its words cannot be numbered before it is applied: plan values on them once the retype '
                         'is applied.'), chat


def test_the_chat_reads_the_same_refusals_as_before():
    """The chat's wording keeps its step, as it was."""
    _, said = _said(SCENARIOS['retype then analyse'], job=False)
    assert any('Plan this once the retype is applied. Only word field values can be planned on its words in this '
               'plan (set_field, by the numbers the retype listed).' in x for x in said), said
    _, said = _said(SCENARIOS['split then retype'], job=False)
    assert any('Retype it once the split is applied.' in x for x in said), said


def test_a_job_asked_to_insert_a_zero_element_and_gloss_it_glosses_it_after_the_text_edit(monkeypatch):
    """The whole job: the piece retypes s1 with "∅" and glosses it by form,
    refused (its morphemes do not exist until the retype is written) with
    the true next step. The retype is written, then s1 is taken once more as
    the edit left it, by a piece offered no text tool, which glosses "∅"
    (RPF3-B, RP2-2: before, the gloss was left, listed as refused). Nothing
    is listed as refused."""
    from plaid_agent.igt import job as igt_job
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    job = start(client, 'Insert a zero element before ta in s1 and gloss it 3SG.', id='JRF', plan='document')
    after = []

    def answer(asked, n, kwargs):
        if igt_job.AFTER_TEXT_LINE in asked:
            if n == 1:
                after.append({t['function']['name'] for t in kwargs.get('tools') or []})
                return reply(calls=[call(4, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "∅"', 'morphemes': [
                    {'form': '∅', 'fields': {'Morph Gloss': '3SG'}}]})])
            return reply('Glossed the zero element.')
        if n > 1:
            return reply('Inserted the zero element.')
        return reply(calls=[
            call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka ∅ ta.'}),
            call(2, 'set_field', {'document': 'Story', 'refs': ['s1.w2 "∅"'], 'field': 'Gloss', 'value': 'he'}),
            call(3, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "∅"', 'morphemes': [
                {'form': '∅', 'fields': {'Morph Gloss': '3SG'}}]})])
    model = use(monkeypatch, Model(answer))
    sent = []

    def execute(c, ops, **kw):
        # The fake has no text server: the retype is taken as written.
        sent.append([o['kind'] for o in ops])
        client._holder('d1')['documents']['d1'] = document('d1', 'Story', [{'words': ['ka', '∅', 'ta']}],
                                                           version=len(sent) + 1)
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    answers = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    refused = [a for a in answers if a.startswith('Error')]
    assert refused and JOB_TEXT_THEN_FILL in refused[0] and JOB_LEAVE_IT not in refused[0], answers
    assert len(after) == 1 and 'retype_sentence' not in after[0], 'once, with no text tool'
    assert any('set_analysis' in kinds for kinds in sent[1:]), sent
    (doc,) = finished['report']['documents']
    assert not doc.get('refused'), doc


@pytest.mark.parametrize('job', [True, False], ids=['job', 'chat'])
def test_a_reference_to_an_entry_this_plan_creates_is_taken_by_its_entry_id(job):
    """A reference field may name an entry the same plan creates, by the
    entry_id create_entry answered, in a chat and in a job alike (SVB B2;
    it was refused, REV-DF-D-5). Approval writes the id it is made under
    (test_planned_entry_refs.py). No lexicon of the fixture declares a
    reference field, so lexicon.py's helper is asked directly."""
    from types import SimpleNamespace
    from plaid_agent.igt import lexicon
    c = FakeClient(documents={'d1': machine_raw()})
    project = load_project(c, 'p1')
    w = JobWorkspace(c, project) if job else Workspace(c, project)
    w.new_entries['new:v1:zork#1'] = {'form': 'zork', 'vocab_id': 'v1'}
    w.view = lambda vocab: SimpleNamespace(tree=SimpleNamespace(by_id={}))
    assert lexicon._resolve_ref(w, {'id': 'v1'}, {'name': 'See'}, 'new:v1:zork#1', None) == 'new:v1:zork#1'


CODES = {
         # A change on a word of a sentence its own plan retypes (RPF3-B):
         # listed, as none of them fills only what the piece after the text
         # edit is shown as empty (REV-RPF3-1).
         'retype then analyse': 'retyped', 'retype then rule': 'retyped',
         'unnumbered retype then a value': 'retyped','new entry then rename': 'entry-new', 'deleted entry then rename': 'entry-gone',
         'merge then delete what it keeps': 'entry-gone', 'entry numbers moved': 'entry-gone',
         'phrase then link a word in it': 'expression', 'analysis then retype': 'shape',
         'rule then retype': 'shape', 'comment then retype': 'shape', 'morpheme gloss then retype': 'shape',
         'word gloss then retype taking the word': 'shape'}


@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_what_a_refusal_left_says_what_kind_of_refusal_it_was(scenario):
    """REV-DF-S-4: each refusal a job cannot follow carries a code of a closed
    set, which the job page labels: never its text."""
    from plaid_agent.igt.job import LEFT_CODES
    w, _ = _said(SCENARIOS[scenario])
    assert w.left_by_refusal and {e['code'] for e in w.left_by_refusal} == {CODES.get(scenario, 'text')}, \
        w.left_by_refusal
    assert set(LEFT_CODES) == {'text', 'shape', 'entry-new', 'entry-gone', 'expression', 'not-added', 'retyped', 'outside'}


def test_leave_it_keeps_its_docstring_and_takes_any_code():
    """REV-DF3-8: the assert sat above the docstring, so the docstring was a
    bare string, and an unknown code raised inside a tool call. The page
    labels an unknown code "Refused"."""
    from plaid_agent.igt.job import JobWorkspace
    assert 'A refusal whose chat advice a job cannot follow' in (JobWorkspace.leave_it.__doc__ or '')
