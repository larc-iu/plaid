"""A job set up in a conversation (BRIEF-SU, 2026-11-15): the card the person
started is the job's ``setup`` (``{fills: [{id, name}], text, conversation}``),
and it binds the planning. The planning context is shown only the setup's
targets the project still has, with one fixed line; plan_work refuses, by id,
a target outside the setup and a text edit the setup does not allow; a setup
whose targets are all gone ends the job with no plan; a job with no setup is
as before. read_job and the final context say what the job was set up to
fill.

The fake keeps a setup as core does (``plaid_client.testing``)."""

import json

import pytest

from fixtures import FakeClient, MGLOSS, TRANS
from job_fixtures import Model, call, reply, runner, start, use
from test_job_fields import ROLE, ROLE_NAME, _fill, _piece_words, role_project

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job, targets as tg, toolkit
from plaid_agent.igt.job import JobWorkspace, summary_message
from plaid_agent.igt.project import load_project

J = 'JEW'
PLANNING = 'Plan the job and end with plan_work.'
#: A setup to fill Thematic role only, the text kept.
ROLE_ONLY = {'fills': [{'id': ROLE, 'name': ROLE_NAME}], 'text': False, 'conversation': 'c1'}
#: The line the planning context, read_job and the final context are told of it.
ROLE_LINE = 'This job was set up to fill only "Thematic role". It may not edit the text.'


def _planned(client, setup, plans, monkeypatch):
    """A job of the Thematic role project with ``setup``, unplanned, and the
    model: the planning calls plan_work with each of ``plans`` in turn
    (None answers text instead), and each piece fills Thematic role."""
    from test_job_fields import GUIDELINE, INSTRUCTIONS
    client.guidelines.create('p1', 'Thematic role', body=GUIDELINE)
    job = start(client, INSTRUCTIONS, id=J, plan=None, setup=setup)
    piece = _fill(_piece_words)

    def answer(asked, n, kwargs):
        if asked.rstrip().endswith(PLANNING):
            plan = plans[n - 1] if n - 1 < len(plans) else None
            return reply(calls=[call(90 + n, 'plan_work', plan)]) if plan is not None else reply('Planned.')
        return piece(asked, n, kwargs)
    return job, use(monkeypatch, Model(answer))


def _client():
    from job_fixtures import JobClient
    from test_job_fields import role_document
    return JobClient({'d1': role_document()}, project=role_project())


def _written(client):
    """What the job wrote: every write but the test's own guideline."""
    return [w for w in client.writes if w[0] != 'guidelines.create']


def _plan_ws(setup):
    client = _client()
    ws = JobWorkspace(client, load_project(client, 'p1'), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Story'}]
    ws.job_setup = tg.setup_of(ws.project, setup)
    return ws


def _plan_work(ws, **args):
    return toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', **args})


def _planning_asked(model):
    return [c for c in model.calls if c['asked'].rstrip().endswith(PLANNING)]


# --- what the planning context is shown --------------------------------------------------

def test_the_planner_is_shown_only_the_setups_targets_the_project_still_has_and_the_line():
    client = _client()
    project = load_project(client, 'p1')
    gone = {'id': 'sl-gone', 'name': 'Animacy'}
    job = start(client, id=J, plan=None, setup={**ROLE_ONLY, 'fills': [gone, *ROLE_ONLY['fills']]})
    r = runner(job)
    facts = r.document_facts(project, job)
    text = r.plan_message(facts, project)
    assert ("What a job can fill (name them in plan_work's fills):\n"
            f'- "{ROLE_NAME}" (word level)\n{ROLE_LINE}\n\n') in text, text
    assert 'Animacy' not in text and 'segmentation' not in text and 'Morph Gloss' not in text
    # The document's line counts only what the job may fill.
    assert '- "Story": 3 sentences, 9 words, ' in text and f'Empty: {ROLE_NAME} 9.' in text, text


def test_a_setup_that_may_edit_the_text_and_fills_nothing_is_said_so():
    client = _client()
    project = load_project(client, 'p1')
    job = start(client, id=J, plan=None, setup={'fills': [], 'text': True})
    r = runner(job)
    text = r.plan_message(r.document_facts(project, job), project)
    assert ("What a job can fill (name them in plan_work's fills):\n"
            'This job was set up to fill nothing. It may edit the text.\n') in text, text


def test_a_job_with_no_setup_is_shown_everything_and_no_line():
    client = _client()
    project = load_project(client, 'p1')
    job = start(client, id=J, plan=None)
    assert job.setup is None
    r = runner(job)
    text = r.plan_message(r.document_facts(project, job), project)
    assert 'set up' not in text
    assert all(f'- {t.label}' in text for t in tg.fillable(project))


# --- plan_work keeps to the setup --------------------------------------------------------

def test_plan_work_refuses_a_target_outside_the_setup_by_id():
    ws = _plan_ws(ROLE_ONLY)
    out = _plan_work(ws, fills=[ROLE_NAME, 'Morph Gloss', 'Translation'])
    assert out == ('Error: fills: this job was set up to fill only "Thematic role". Leave out "Morph Gloss" and '
                   '"Translation".'), out
    assert ws.plan_work is None
    assert _plan_work(ws, fills=[ROLE_NAME]).startswith('The plan is kept.')
    assert ws.plan_work['fills'] == [ROLE]


def test_plan_work_compares_ids_not_names():
    """The card's name is what the person saw. A field renamed since is the
    same target, by its id."""
    ws = _plan_ws({'fills': [{'id': ROLE, 'name': 'An old name'}], 'text': False})
    assert _plan_work(ws, fills=[ROLE_NAME]).startswith('The plan is kept.')


def test_plan_work_refuses_a_text_edit_the_setup_does_not_allow():
    ws = _plan_ws(ROLE_ONLY)
    out = _plan_work(ws, fills=[ROLE_NAME], edits_text=True)
    assert out == 'Error: edits_text: this job was set up not to edit the text. Give false.', out
    both = _plan_work(ws, fills=['Translation'], edits_text=True)
    assert both == ('Error: fills: this job was set up to fill only "Thematic role". Leave out "Translation". '
                    'edits_text: this job was set up not to edit the text. Give false.'), both
    ws = _plan_ws({**ROLE_ONLY, 'text': True})
    assert _plan_work(ws, fills=[ROLE_NAME], edits_text=True).startswith('The plan is kept.')
    assert ws.plan_work['edits_text'] is True


def test_a_setup_that_fills_nothing_refuses_every_target_and_keeps_a_check():
    ws = _plan_ws({'fills': [], 'text': False})
    out = _plan_work(ws, fills=[ROLE_NAME])
    assert out == 'Error: fills: this job was set up to fill nothing. Leave out "Thematic role".', out
    assert _plan_work(ws, fills=[]).startswith('The plan is kept.')


def test_a_plan_may_fill_a_subset_of_the_setup():
    ws = _plan_ws({'fills': [{'id': ROLE, 'name': ROLE_NAME}, {'id': TRANS, 'name': 'Translation'}], 'text': False})
    assert _plan_work(ws, fills=['Translation']).startswith('The plan is kept.')
    assert ws.plan_work['fills'] == [TRANS]


def test_with_no_setup_plan_work_is_as_before():
    ws = _plan_ws(None)
    assert ws.job_setup is None
    assert _plan_work(ws, fills=[ROLE_NAME, 'Morph Gloss'], edits_text=True).startswith('The plan is kept.')
    assert ws.plan_work['fills'] == [ROLE, MGLOSS]


# --- the job, each way -------------------------------------------------------------------

INSIDE = {'pieces': 'sentences', 'fills': [ROLE_NAME]}
OUTSIDE = {'pieces': 'sentences', 'fills': [ROLE_NAME, 'Morph Gloss']}


def test_a_job_planned_inside_its_setup_is_worked(monkeypatch):
    client = _client()
    job, model = _planned(client, ROLE_ONLY, [INSIDE], monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), finished['report'].get('plan'))
    (planning,) = [c for c in _planning_asked(model) if c['n'] == 1]
    assert ROLE_LINE in planning['asked']
    assert finished['report']['plan']['fills_names'] == [ROLE_NAME]
    pieces = [c for c in model.calls if c['n'] == 1 and not c['asked'].rstrip().endswith(PLANNING)]
    assert pieces and all('Empty in s1: Thematic role in w1 ' in p['asked'] for p in pieces[:1])


def test_a_plan_refused_for_its_setup_and_corrected_is_worked(monkeypatch):
    client = _client()
    job, model = _planned(client, ROLE_ONLY, [OUTSIDE, INSIDE], monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), finished['report'].get('plan'))
    said = [m.get('content') for c in _planning_asked(model) for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert any(t.startswith('Error: fills: this job was set up to fill only "Thematic role". Leave out "Morph '
                            'Gloss".\n') for t in said), said
    assert finished['report']['plan']['fills_names'] == [ROLE_NAME]


def test_a_plan_refused_for_its_setup_to_the_end_ends_with_no_plan(monkeypatch):
    client = _client()
    job, model = _planned(client, ROLE_ONLY, [OUTSIDE], monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'no-plan', finished
    assert finished['report']['plan']['by'] == 'none'
    assert not _written(client), 'nothing written'
    assert all(c['asked'].rstrip().endswith(PLANNING) for c in model.calls), 'no piece'


def test_a_setup_whose_targets_are_all_gone_ends_saying_so_and_with_no_model_call(monkeypatch):
    """REV-SU-B-3, REV-SU-F-2: a reason and a plan row of its own, which
    keep the card's names of what is gone, never a no-plan read as any
    other."""
    client = _client()
    gone = {'fills': [{'id': 'sl-gone', 'name': 'Animacy'}, {'id': 'sl-gone2', 'name': 'Part of Speech'}],
            'text': False}
    job, model = _planned(client, gone, [INSIDE], monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'setup-gone', finished
    assert finished['report']['plan'] == {'by': 'none', 'why': 'setup-gone', 'gone': gone['fills'],
                                          'piece_instructions': '', 'fallback': [], 'left_out': []}
    assert model.calls == [], 'never planned freely'
    assert not _written(client)
    from plaid_agent.igt import jobread
    said = jobread.summary({'id': J, 'state': 'failed', 'reason': 'setup-gone', 'instructions': 'x',
                            'documents': [], 'setup': gone, 'report': finished['report']})
    assert 'This job was set up to fill only "Animacy" (deleted) and "Part of Speech" (deleted). It may not edit ' \
           'the text.' in said, said
    assert 'The fields this job was set up to fill are gone: Animacy, Part of Speech. Nothing was written.' in said


def test_a_setup_some_of_whose_targets_are_gone_keeps_their_names_and_says_them_deleted(monkeypatch):
    client = _client()
    some = {**ROLE_ONLY, 'fills': [{'id': 'sl-gone', 'name': 'Animacy'}, *ROLE_ONLY['fills']]}
    job, model = _planned(client, some, [INSIDE], monkeypatch)
    seen = {}
    real = igt_job.summary_message

    def spy(report, setup=None):
        seen['setup'] = setup
        return real(report, setup)
    monkeypatch.setattr(igt_job, 'summary_message', spy)
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done', finished.get('reason')
    plan = finished['report']['plan']
    assert plan['by'] == 'model' and plan['gone'] == [{'id': 'sl-gone', 'name': 'Animacy'}], plan
    line = 'This job was set up to fill only "Animacy" (deleted) and "Thematic role". It may not edit the text.'
    assert seen['setup'] == line
    from plaid_agent.igt import jobread
    said = jobread.summary({'id': J, 'state': 'done', 'instructions': 'x', 'documents': [], 'setup': some,
                            'report': finished['report']})
    assert line in said, said
    # Before any plan, nothing is known to be gone: the card's names as they are.
    assert jobread.summary({'id': J, 'state': 'waiting', 'instructions': 'x', 'documents': [], 'setup': some})[4] \
        == 'This job was set up to fill only "Animacy" and "Thematic role". It may not edit the text.'


def test_a_setup_that_fills_nothing_is_planned(monkeypatch):
    """A setup of no targets (a check) never named any: it is not gone."""
    client = _client()
    job, model = _planned(client, {'fills': [], 'text': False}, [{'pieces': 'document', 'fills': []}],
                          monkeypatch)
    run_job(job, runner(job))
    assert _planning_asked(model), 'planned'
    assert json.loads(next(r['analysis'] for (f, _k), r in client.jobs.decision_rows[J].items()
                                   if f == igt_job.PLAN_FORM))['by'] == 'model'


# --- what read_job and the final context say ---------------------------------------------

def test_read_job_says_what_the_job_was_set_up_to_fill_by_the_cards_names():
    from fixtures import fake_ws
    from plaid_agent.igt.toolkit import call_tool
    ws = fake_ws(FakeClient())
    made = ws.client.jobs.create('p1', 'igt', 'Fill Case.', ['d1'],
                                 setup={'fills': [{'id': 'L1', 'name': 'Case'}, {'id': 'L2', 'name': 'Word class'}],
                                        'text': True, 'conversation': 'c9'})
    out = call_tool(ws, 'read_job', {'job': made['id']})
    assert 'Instructions as sent: "Fill Case."\nThis job was set up to fill only "Case" and "Word class". It may ' \
           'edit the text.\n' in out, out


def test_read_job_says_nothing_of_a_setup_a_job_does_not_have():
    from plaid_agent.igt import jobread
    job = {'id': 'j', 'state': 'waiting', 'instructions': 'x', 'documents': []}
    assert not any('set up' in line for line in jobread.summary(job))
    assert jobread.summary({**job, 'setup': ROLE_ONLY})[4] == ROLE_LINE


def test_the_final_context_is_told_what_the_job_was_set_up_to_fill():
    report = {'instructions': 'Fill it.', 'totals': {}, 'documents': []}
    text = summary_message(report, tg.said_setup(ROLE_ONLY))
    assert "The job's instructions:\nFill it.\n" + ROLE_LINE + '\n' in text, text
    assert 'set up' not in summary_message(report)


def test_a_finished_job_passes_its_setup_to_the_final_context(monkeypatch):
    client = _client()
    job, model = _planned(client, ROLE_ONLY, [INSIDE], monkeypatch)
    seen = {}
    real = igt_job.summary_message

    def spy(report, setup=None):
        seen['setup'] = setup
        return real(report, setup)
    monkeypatch.setattr(igt_job, 'summary_message', spy)
    run_job(job, runner(job, write_summary=True))
    assert seen.get('setup') == ROLE_LINE


@pytest.mark.parametrize('setup', [None, 'a string', ['a list'], {'fills': 'Case'}])
def test_a_setup_that_is_no_map_of_fills_has_no_targets(setup):
    project = load_project(_client(), 'p1')
    got = tg.setup_of(project, setup)
    assert got is None if not isinstance(setup, dict) else (got.targets == () and not got.gone)


# --- two targets sharing a name (REV-SU-B-2) ---------------------------------------------

def _ipa_raw(raw):
    """``raw`` with a word field "IPA" (sl-ipafield) beside its orthography "IPA"."""
    from fixtures import WORD_LAYER
    words = next(tk for tk in raw['text_layers'][0]['token_layers'] if tk['id'] == WORD_LAYER)
    words['span_layers'].append({'id': 'sl-ipafield', 'name': 'IPA', 'config': {'igt': {'scope': 'Word'}}})
    return raw


def _ipa_ws(setup):
    from job_fixtures import JobClient
    from test_job_fields import role_document
    client = JobClient({'d1': role_document()}, project=_ipa_raw(role_project()))
    ws = JobWorkspace(client, load_project(client, 'p1'), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Story'}]
    ws.job_setup = tg.setup_of(ws.project, setup)
    return ws


def test_targets_sharing_a_name_are_shown_by_the_label_that_tells_them_apart():
    ws = _ipa_ws(None)
    both = [t for t in tg.fillable(ws.project) if t.name == 'IPA']
    assert tg.shown_names(ws.project, both) == ['IPA (word level)', 'IPA (orthography, word level)']
    assert tg.shown_names(ws.project, [t for t in tg.fillable(ws.project) if t.id == ROLE]) == [ROLE_NAME]
    # The one rule: a refusal lists them as the card, the line and the page name them.
    assert tg.listed_names(ws.project) == tg.shown_names(ws.project, tg.fillable(ws.project))
    for shown, target in zip(tg.shown_names(ws.project, both), both):
        assert tg.named(ws.project, [shown])[0] == [target], shown


@pytest.mark.parametrize('setup_id, other, line_name, other_name', [
    ('sl-ipafield', 'IPA (orthography)', 'IPA (word level)', 'IPA (orthography, word level)'),
    ('orthography:IPA', 'IPA (word level)', 'IPA (orthography, word level)', 'IPA (word level)'),
])
def test_the_setup_line_and_the_refusal_tell_a_shared_name_apart(setup_id, other, line_name, other_name):
    ws = _ipa_ws({'fills': [{'id': setup_id, 'name': line_name}], 'text': False})
    assert ws.job_setup.line == f'This job was set up to fill only "{line_name}". It may not edit the text.'
    out = _plan_work(ws, fills=[other])
    assert out == (f'Error: fills: this job was set up to fill only "{line_name}". Leave out "{other_name}".'), out
    assert _plan_work(ws, fills=[line_name]).startswith('The plan is kept.')


@pytest.mark.parametrize('fills, name', [(['IPA (word level)'], 'IPA (word level)'),
                                         (['IPA (orthography)'], 'IPA (orthography, word level)'),
                                         (['Gloss'], 'Gloss')])
def test_the_card_keeps_the_label_that_tells_a_shared_name_apart(fills, name):
    from fixtures import fake_ws, project_raw
    from plaid_agent.igt.toolkit import call_tool
    ws = fake_ws(FakeClient(project=_ipa_raw(project_raw())))
    out = call_tool(ws, 'propose_job', {'action': 'draft', 'documents': ['Text 1'], 'fills': fills, 'brief': 'Do it.'})
    assert out.startswith('Drafted'), out
    assert [f['name'] for f in ws.job_card['fills']] == [name]


# --- a setup that is not the card's shape (REV-SU-B-6) -----------------------------------

UNREADABLE = [{}, {'fills': 'Thematic role'}, {'fills': [{'name': ROLE_NAME}], 'text': False},
              {'fills': [ROLE], 'text': False}, {'fills': [{'id': ROLE, 'name': ROLE_NAME}], 'text': 'true'},
              {'fills': [{'id': ROLE, 'name': ROLE_NAME}]}, {'fills': [{'id': ROLE, 'name': {'a': 1}}], 'text': False},
              {'fills': [None, 3], 'text': False}, {'fills': {'id': ROLE, 'name': ROLE_NAME}, 'text': False}]


@pytest.mark.parametrize('setup', UNREADABLE)
def test_a_setup_that_cannot_be_read_ends_the_job_saying_so_and_read_job_agrees(monkeypatch, setup):
    """Only an API caller can send one (the page builds the card's shape).
    It is never read as a limit it does not state: the job ends before
    planning, with a reason and a plan row of its own, and read_job says the
    same."""
    from plaid_agent.igt import jobread
    assert tg.setup_of(load_project(_client(), 'p1'), setup).unread
    client = _client()
    job, model = _planned(client, setup, [INSIDE], monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'setup-unreadable', finished
    assert finished['report']['plan'] == {'by': 'none', 'why': 'setup-unreadable', 'piece_instructions': '',
                                          'fallback': [], 'left_out': []}
    assert model.calls == [] and not _written(client)
    said = jobread.summary({'id': J, 'state': 'failed', 'reason': 'setup-unreadable', 'instructions': 'x',
                            'documents': [], 'setup': setup, 'report': finished['report']})
    assert said[4] == "This job's setup could not be read. The job writes nothing.", said
    assert "This job's setup could not be read. Nothing was written." in said
    assert not any('set up to fill' in line for line in said)


def test_the_cards_own_shape_is_read():
    project = load_project(_client(), 'p1')
    for setup in (ROLE_ONLY, {'fills': [], 'text': True}, {**ROLE_ONLY, 'conversation': None}):
        assert not tg.setup_of(project, setup).unread, setup


# --- plan_work's lists under a setup (REV-SU-B-5) ----------------------------------------

def test_under_a_setup_plan_works_unknown_name_refusal_lists_only_the_setups_targets():
    ws = _plan_ws({'fills': [{'id': ROLE, 'name': ROLE_NAME}, {'id': TRANS, 'name': 'Translation'}], 'text': False})
    out = _plan_work(ws, fills=['Thematc role'])
    assert out == ('Error: fills: not something a job on this project can fill: "Thematc role". Name each as listed '
                   'under What a job can fill: Thematic role, Translation.'), out
    assert _plan_work(ws) == ('Error: fills: say what the job fills, each named as listed under What a job can '
                              'fill: Thematic role, Translation. Give [] when it fills nothing, such as a check or '
                              'a summary.')
    nothing = _plan_ws({'fills': [], 'text': False})
    assert _plan_work(nothing, fills=['Thematc role']) == (
        'Error: fills: not something a job on this project can fill: "Thematc role". This job was set up to fill '
        'nothing: give [].')
    # With no setup, every target of the project.
    free = _plan_ws(None)
    assert 'Morph Gloss' in _plan_work(free, fills=['Thematc role'])


# --- what a job wrote outside its setup (REV-SU-B-4, the lead's addition) ----------------

def _wrote_outside(monkeypatch, client, setup, field, ref):
    """A job of ``setup`` planned in sentences to fill Thematic role, whose
    first piece also writes ``field`` at ``ref`` with set_field (offered to
    every piece in sentences), then fills Thematic role."""
    from test_job_fields import GUIDELINE, INSTRUCTIONS
    client.guidelines.create('p1', 'Thematic role', body=GUIDELINE)
    job = start(client, INSTRUCTIONS, id=J, plan=None, setup=setup)
    base = _fill(_piece_words)

    def answer(asked, n, kwargs):
        if asked.rstrip().endswith(PLANNING):
            return reply(calls=[call(90 + n, 'plan_work', INSIDE)]) if n == 1 else reply('Planned.')
        if 'Instructions from' in asked and n == 1 and 'Your piece: s1' in asked:
            return reply(calls=[call(500, 'set_field', {'document': 'Story', 'refs': [ref], 'field': field,
                                                        'value': 'NOBODY ASKED'})])
        if 'Instructions from' in asked and n == 2 and 'Your piece: s1' in asked:
            return base(asked, 1, kwargs)
        return base(asked, n, kwargs)
    use(monkeypatch, Model(answer))
    return run_job(job, runner(job))


@pytest.mark.parametrize('field, ref, layer, fields', [
    ('Gloss', 's1.w1', 'sl-gloss', [{'field': 'Gloss', 'id': 'sl-gloss', 'values': 1, 'outside': True},
                                    {'field': ROLE_NAME, 'id': ROLE, 'values': 9}]),
    ('Translation', 's1', TRANS, [{'field': ROLE_NAME, 'id': ROLE, 'values': 9}]),
])
def test_a_value_written_outside_the_setup_is_marked_by_id_in_the_report(monkeypatch, field, ref, layer, fields):
    """Nothing is refused (the limit is the plan's): the report marks each
    field row the job wrote that its setup does not name, decided by the
    written layer's id, and counts what it wrote outside its setup."""
    from plaid_agent.igt import jobread
    client = _client()
    finished = _wrote_outside(monkeypatch, client, ROLE_ONLY, field, ref)
    assert finished['state'] == 'done', finished.get('reason')
    totals = finished['report']['totals']
    assert totals['fields'] == fields, totals
    assert totals['outside'] == [{'field': field, 'id': layer, 'values': 1}], totals
    (doc,) = finished['report']['documents']
    assert doc['counts']['outside'] == [{'field': field, 'id': layer, 'values': 1}], doc['counts']
    said = jobread.summary({'id': J, 'state': 'done', 'instructions': 'x', 'documents': [], 'setup': ROLE_ONLY,
                            'report': finished['report']})
    assert f'written outside its setup: {field} 1 values' in said[-2], said[-2]
    # A field the setup names is never marked, renamed or not: by id.
    client = _client()
    named = {**ROLE_ONLY, 'fills': [*ROLE_ONLY['fills'], {'id': 'sl-gloss' if field == 'Gloss' else TRANS,
                                                          'name': 'An old name'}]}
    finished = _wrote_outside(monkeypatch, client, named, field, ref)
    assert 'outside' not in finished['report']['totals']
    assert not any(f.get('outside') for f in finished['report']['totals']['fields'])


def test_a_job_with_no_setup_marks_nothing_outside(monkeypatch):
    client = _client()
    finished = _wrote_outside(monkeypatch, client, None, 'Gloss', 's1.w1')
    totals = finished['report']['totals']
    assert 'outside' not in totals and not any('outside' in f for f in totals['fields']), totals
    assert all('outside' not in (d.get('counts') or {}) for d in finished['report']['documents'])


def _piece_also(monkeypatch, client, setup, plan, calls):
    """A job of ``setup`` planned as ``plan``, whose first piece first makes
    ``calls`` (``(tool, args)``), then fills Thematic role."""
    from test_job_fields import GUIDELINE, INSTRUCTIONS
    client.guidelines.create('p1', 'Thematic role', body=GUIDELINE)
    job = start(client, INSTRUCTIONS, id=J, plan=None, setup=setup)
    base = _fill(_piece_words)
    st = {}

    def answer(asked, n, kwargs):
        if asked.rstrip().endswith(PLANNING):
            return reply(calls=[call(90 + n, 'plan_work', plan)]) if n == 1 else reply('Planned.')
        if 'Instructions from' in asked and n == 1 and not st.get('also'):
            st['also'] = True
            return reply(calls=[call(500 + i, name, args) for i, (name, args) in enumerate(calls)])
        if 'Instructions from' in asked and n == 2 and not st.get('base'):
            st['base'] = True
            return base(asked, 1, kwargs)
        return base(asked, n, kwargs)
    use(monkeypatch, Model(answer))
    return run_job(job, runner(job))


@pytest.mark.parametrize('setup_id, setup_name, fields, outside', [
    ('sl-ipafield', 'IPA (word level)',
     [{'field': 'IPA (word level)', 'id': 'sl-ipafield', 'values': 1}, {'field': ROLE_NAME, 'id': ROLE, 'values': 9}],
     [{'field': 'IPA (orthography, word level)', 'id': 'orthography:IPA', 'values': 1}]),
    ('orthography:IPA', 'IPA (orthography, word level)',
     [{'field': 'IPA (word level)', 'id': 'sl-ipafield', 'values': 1, 'outside': True},
      {'field': ROLE_NAME, 'id': ROLE, 'values': 9}],
     [{'field': 'IPA (word level)', 'id': 'sl-ipafield', 'values': 1}]),
])
def test_a_field_and_an_orthography_sharing_a_name_are_counted_and_marked_apart(monkeypatch, setup_id, setup_name,
                                                                                  fields, outside):
    """REV-SUFIX-2: each row of ``fields`` and ``outside`` carries the
    target's id and is summed and marked by it, its ``field`` the name the
    setup line shows (``targets.shown_names``): a word field "IPA" and the
    orthography "IPA" are two rows, and only the one outside the setup is
    marked."""
    from job_fixtures import JobClient
    from test_job_fields import role_document
    client = JobClient({'d1': role_document()}, project=_ipa_raw(role_project()))
    setup = {'fills': [{'id': ROLE, 'name': ROLE_NAME}, {'id': setup_id, 'name': setup_name}], 'text': False}
    finished = _piece_also(monkeypatch, client, setup, {'pieces': 'document', 'fills': [ROLE_NAME, setup_name]}, [
        ('set_field', {'document': 'Story', 'refs': ['s1.w1'], 'field': 'IPA', 'value': 'FIELDVAL'}),
        ('set_orthography', {'document': 'Story', 'refs': ['s1.w2'], 'orthography': 'IPA', 'value': 'ORTHVAL'})])
    assert finished['state'] == 'done', finished.get('reason')
    totals = finished['report']['totals']
    assert totals['fields'] == fields, totals
    assert totals['outside'] == outside, totals
    (doc,) = finished['report']['documents']
    assert doc['counts']['fields'] == fields and doc['counts']['outside'] == outside, doc['counts']
