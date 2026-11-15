"""A job edits the text only when its plan says so (the owner's ruling,
2026-11-15). A real model told only to segment, gloss and link retyped six
sentences and changed the words of two. The planner opts in: plan_work's
``edits_text``, set when the job's instructions ask for the text itself to
change. Without it a piece (sentences, document or selection) is not offered
the tools that change the text or its words and sentences, a call of one
anyway is refused as any tool not offered, and an op of such a kind is never
staged by the job's workspace, whatever path stages it, nor applied by the
job's rule (reported as a proposed change instead). With it, everything is
offered as before. Chat is unchanged."""

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core import opkind
from plaid_agent.core.job import run_job
from plaid_agent.core.tools import ToolError
from plaid_agent.igt import jobapply, jobread, toolkit
from plaid_agent.igt import plan as igt_plan
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.prompt import JOB_PLAN_RULES, build_job_prompt

J = 'JTX'
TEXT_TOOLS = {'append_text', 'retype_sentence', 'split_sentence', 'merge_sentences', 'delete_sentence',
              'split_word', 'merge_words', 'delete_word', 'respell', 'respell_all', 'restore_document'}
REFUSED = "that tool is not one of this job's"


# --- the lists ----------------------------------------------------------------------------------


def test_the_text_tools_are_the_tools_that_change_the_text_and_none_else():
    assert set(toolkit.TEXT_TOOLS) == TEXT_TOOLS
    names = {t['function']['name'] for t in toolkit.TOOLS}
    assert set(toolkit.TEXT_TOOLS) <= names
    # Morpheme segmentation is no text edit.
    assert not {'set_analysis', 'analyze_sentence', 'set_morpheme', 'discard_analysis'} & set(toolkit.TEXT_TOOLS)


def test_the_text_kinds_are_read_off_the_plan_registry():
    """Every kind that moves a word or sentence boundary or rewrites the
    text, and a restore."""
    shaped = set(opkind.shaped(igt_plan.KIND, igt_plan.WORD_SHAPE, igt_plan.SENTENCE_SHAPE, igt_plan.TEXT_SHAPE))
    assert set(jobapply.TEXT_KINDS) == shaped | {'restore_document'}
    assert 'restore_document' not in shaped
    assert jobapply.edits_text({'kind': 'bulk_scope', 'tool': 'respell_all'})
    assert not jobapply.edits_text({'kind': 'bulk_scope', 'tool': 'set_field_for_form'})
    assert not jobapply.edits_text({'kind': 'set_analysis'})


# --- plan_work -----------------------------------------------------------------------------------


def _planning():
    ws = JobWorkspace(FakeClient(), load_project(FakeClient(), 'p1'), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    return ws


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
@pytest.mark.parametrize('given', [None, False, True])
def test_plan_work_keeps_edits_text_only_when_true(pieces, given):
    ws = _planning()
    args = {'pieces': pieces, **({} if given is None else {'edits_text': given})}
    assert toolkit.job_plan_call(ws, 'plan_work', args) == 'The plan is kept. End now with a one-line reply.'
    assert ws.plan_work.get('edits_text') is (True if given else None)


def test_the_planner_is_told_of_edits_text_in_one_sentence_and_one_short_line():
    prop = toolkit.PLAN_WORK['function']['parameters']['properties']['edits_text']
    assert prop == {'type': 'boolean'}
    desc = toolkit.PLAN_WORK['function']['description']
    said = desc[desc.index('edits_text:'):]
    said = said[:said.index('. ') + 1]
    assert said == ('edits_text: true when the instructions ask for the text itself to change: words or sentences '
                    'retyped, respelled, split, merged, inserted or deleted.'), said
    lines = [line for line in JOB_PLAN_RULES.splitlines() if 'edits_text' in line]
    assert len(lines) == 1 and len(lines[0].split()) <= 20, lines


# --- what a piece is offered -------------------------------------------------------------------


def _job(monkeypatch, pieces, edits_text, answer, sentences=None):
    client = JobClient({'d1': document('d1', 'Story', sentences or [{'words': ['ka', 'ta']}])})
    job = start(client, 'Do as asked.', id=J, plan=pieces, edits_text=edits_text)
    model = use(monkeypatch, Model(answer))
    return client, job, model


def _done(asked, n, kwargs):
    return reply('Done.')


def _offered(model):
    return [[t['function']['name'] for t in c['kwargs']['tools']] for c in model.calls
            if 'Instructions from' in c['asked'] or 'whole selection' in c['asked']]


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
def test_a_piece_of_a_plan_that_does_not_edit_the_text_is_not_offered_the_text_tools(monkeypatch, pieces):
    client, job, model = _job(monkeypatch, pieces, False, _done)
    run_job(job, runner(job))
    offered = _offered(model)
    assert offered, [c['asked'][:80] for c in model.calls]
    for names in offered:
        assert not set(names) & TEXT_TOOLS, names
        assert 'set_analysis' in names and 'analyze_sentence' in names
    if pieces == 'sentences':
        assert len(offered[0]) == 7, offered[0]


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
def test_a_piece_of_a_plan_that_edits_the_text_is_offered_everything_as_before(monkeypatch, pieces):
    client, job, model = _job(monkeypatch, pieces, True, _done)
    run_job(job, runner(job))
    offered = _offered(model)
    assert offered
    for names in offered:
        if pieces == 'sentences':
            assert set(names) == set(toolkit.SENTENCES_ALWAYS + toolkit.SENTENCES_SEGMENTATION
                                     + toolkit.SENTENCES_LEXICON + toolkit.SENTENCES_TEXT), names
        else:
            assert TEXT_TOOLS <= set(names), names


def test_a_default_plan_does_not_edit_the_text(monkeypatch):
    """Planning ended with no plan: the default works in sentences and
    offers no text tool."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    job = start(client, 'Do as asked.', id=J, plan=None)
    model = use(monkeypatch, Model(_done))
    r = runner(job)
    run_job(job, r)
    assert r.plan_made['by'] == 'default' and 'edits_text' not in r.plan_made
    offered = _offered(model)
    assert offered and not set(offered[0]) & TEXT_TOOLS


def _retyping(asked, n, kwargs):
    if 'Instructions from' not in asked:
        return reply('Done.')
    if n == 1:
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka tax.'})])
    return reply('Retyped s1.')


def _edits(monkeypatch, client):
    monkeypatch.setattr(igt_plan, '_composed_as', lambda body, stored: (body, lambda p: p))
    edits = []

    def edit(*a, **kw):
        edits.append((a, kw))
        return client.record('texts.edit', {'args': a, 'kwargs': kw})
    client.texts.edit = edit
    return edits


def test_a_text_tool_called_anyway_is_refused_as_any_tool_not_offered(monkeypatch):
    client, job, model = _job(monkeypatch, 'document', False, _retyping)
    edits = _edits(monkeypatch, client)
    r = runner(job)
    run_job(job, r)
    second = next(c for c in model.calls if 'Instructions from' in c['asked'] and c['n'] == 2)
    (answer,) = [m['content'] for m in second['kwargs']['messages'] if m['role'] == 'tool']
    assert REFUSED in answer, answer
    assert edits == []
    assert r.report_parts(job)['proposed'] == []


def test_an_opted_in_job_still_retypes(monkeypatch):
    client, job, model = _job(monkeypatch, 'document', True, _retyping)
    edits = _edits(monkeypatch, client)
    run_job(job, runner(job))
    assert len(edits) == 1, edits


def test_a_text_op_that_reaches_the_write_of_a_job_that_does_not_edit_the_text_is_reported_not_written(monkeypatch):
    """Should a path stage one past the workspace's guard, the job's rule
    lists it as a proposed change and writes nothing of it."""
    monkeypatch.setattr(JobWorkspace, 'guard_op', lambda self, op, replacing=None: None)
    monkeypatch.setattr(toolkit, 'TEXT_TOOLS', ())
    client, job, model = _job(monkeypatch, 'document', False, _retyping)
    edits = _edits(monkeypatch, client)
    r = runner(job)
    run_job(job, r)
    assert edits == []
    assert [c['kind'] for c in r.report_parts(job)['proposed']] == ['edit_text']


# --- every staging path ------------------------------------------------------------------------


def _piece(edits_text):
    client = FakeClient()
    ws = JobWorkspace(client, load_project(client, 'p1'))
    ws.edits_text = edits_text
    return ws


@pytest.mark.parametrize('tool,args', [
    ('retype_sentence', {'ref': 's1', 'text': 'Ali-di gam akunaa.'}),
    ('delete_word', {'refs': ['s1.w3']}),
    ('split_word', {'ref': 's1.w3', 'at': 2}),
    ('merge_words', {'refs': ['s1.w2', 's1.w3']}),
    ('split_sentence', {'ref': 's1', 'before_word': 2}),
    ('merge_sentences', {'ref': 's2'}),
    ('delete_sentence', {'refs': ['s2']}),
    ('respell', {'ref': 's1.w3', 'new_text': 'akunaa'}),
    ('append_text', {'text': 'Ka ta.'}),
])
def test_no_text_op_is_staged_by_any_path_unless_the_plan_edits_the_text(tool, args):
    """call_tool is what code's plan(tool, ...) and every tool reach: the
    workspace refuses the op itself, whatever staged it."""
    ws = _piece(False)
    out = toolkit.call_tool(ws, tool, {'document': 'd1', **args})
    assert out.startswith('Error: This job does not edit the text'), out
    assert ws.ops == []
    ws = _piece(True)
    out = toolkit.call_tool(ws, tool, {'document': 'd1', **args})
    assert not out.startswith('Error'), out
    assert ws.ops


@pytest.mark.parametrize('op', [
    {'kind': 'delete_word', 'document_id': 'd1', 'word_id': 'w-3'},
    {'kind': 'bulk_scope', 'tool': 'respell_all', 'args': {'pattern': 'a', 'replacement': 'b'}},
], ids=['delete_word', 'respell_all'])
def test_an_op_added_by_hand_is_refused_too(op):
    """add_op is what every stager reaches, a rule (respell_all's) too."""
    ws = _piece(False)
    with pytest.raises(ToolError) as e:
        ws.add_op(op)
    assert str(e.value).startswith('This job does not edit the text')
    assert ws.ops == []


def test_the_rule_proposes_a_text_op_of_a_job_that_does_not_edit_the_text():
    client = FakeClient()
    project = load_project(client, 'p1')
    ws = JobWorkspace(client, project)
    doc = ws.doc('d1')
    op = {'kind': 'delete_word', 'document_id': 'd1', 'word_id': 'w-3'}
    assert jobapply.Rule(doc, project).alone(op) == jobapply.PROPOSE
    assert jobapply.Rule(doc, project, edits_text=True).alone(op) == jobapply.APPLY
    gloss = {'kind': 'set_span', 'document_id': 'd1', 'token_id': 'w-3', 'layer_id': 'x', 'value': 'see'}
    assert jobapply.Rule(doc, project).alone(gloss) == jobapply.APPLY


def test_chat_is_unchanged():
    from fixtures import fake_ws
    ws = fake_ws(FakeClient())
    out = toolkit.call_tool(ws, 'delete_word', {'document': 'd1', 'refs': ['s1.w3']})
    assert out.startswith('Planned'), out


# --- what the piece, the page's line and read_job say ------------------------------------------


@pytest.mark.parametrize('sentences', [False, True])
def test_a_piece_not_offered_the_text_tools_is_told_of_none(sentences):
    project = load_project(FakeClient(), 'p1')
    without = build_job_prompt(project, sentences=sentences)
    with_ = build_job_prompt(project, sentences=sentences, edits_text=True)
    for name in TEXT_TOOLS:
        assert name not in without, name
    assert 'text edits' not in without and 'document restores' not in without
    # A piece in sentences is told of no project-wide tool at all (REV-DAY-P-8).
    assert ('respell_all' in with_) is not sentences and 'deletions and text edits included' in with_


def test_read_job_says_the_job_may_edit_the_text():
    plan = {'pieces': 'sentences', 'by': 'model', 'fallback': []}
    assert jobread.plan_line({'plan': plan}) == 'Worked in stretches of sentences.'
    assert jobread.plan_line({'plan': {**plan, 'edits_text': True}}) == \
        'Worked in stretches of sentences. Text edits allowed.'
