"""Talking with the assistant about a job (BRIEF-JD, 2026-11-13): a turn asked
from a job's page is given the job's short summary, read from core as the turn
starts, and ``read_job`` reads the project's jobs and a section of a job's
report by page, through the user's own access."""

import pytest
from fixtures import FakeClient, fake_ws
from plaid_client import PlaidAPIError

from plaid_agent.igt import jobread
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import TOOLS, call_tool

WORKER = '0193a5c0-0000-7000-8000-0000000000ff'


def _report(**over):
    """A report as the worker writes it (CONTRACT 5.3, snake_case as the
    client hands it over): Text 1 done with a word left blank and a sentence
    skipped, a form left inconsistent, an entry created."""
    report = {
        'state': 'done', 'reason': None, 'instructions': 'Gloss ka as "go".',
        'started_by': 'user@example.com', 'model': 'm', 'started_at': '2026-11-12T22:01:00Z',
        'finished_at': '2026-11-13T03:10:00Z', 'paused_for_people_s': 0, 'paused_for_model_s': 0,
        'stopped': None,
        'totals': {'documents_done': 1, 'documents_in_use': 0, 'documents_gone': 0, 'documents_not_reached': 0,
                   'sentences': 4, 'translations': 0, 'refreshed': 0, 'words': 9, 'links': 7, 'entries': 1,
                   'skipped_too_long': 1, 'skipped_failed': 0, 'skipped_changed': 0, 'skipped_more': 0,
                   'changed': 0, 'proposed': 0},
        'documents': [{'document_id': 'd1', 'name': 'Text 1', 'state': 'done', 'sentences': 5, 'targets': 5,
                       'done': 5, 'counts': {'words': 9, 'links': 7, 'left': 1},
                       'skipped': [{'sentence': 's5', 'sentence_id': 'S5', 'reason': 'too-long', 'kind': None}],
                       'gloss_group': 'g1', 'harmonize_group': None,
                       'left': [{'ref': 's2.w3', 'sentence_id': 'S2', 'begin': 14, 'form': 'pele'}],
                       'left_more': 0}],
        'harmonize': {'changed': [], 'left': [{'form': 'ka', 'reason': 'no-clear-majority',
                                               'analyses': [{'analysis': 'ka ‘go’', 'count': 2},
                                                            {'analysis': 'ka ‘come’', 'count': 2}]}],
                      'changed_more': 0, 'left_more': 0},
        'entries': {'created': [{'id': 'e9', 'lexicon': 'v1', 'form': 'tuna', 'gloss': 'fish'}], 'deleted': [],
                    'unlinked': [], 'created_more': 0, 'deleted_more': 0, 'unlinked_more': 0, 'lexicons': ['v1'],
                    'proposed': [], 'proposed_more': 0},
    }
    report.update(over)
    return report


def _ended(client, report=None, note='Gloss ka as "go".', project='p1'):
    """A job of ``project`` over Text 1, claimed and finished with ``report``."""
    made = client.jobs.create(project, 'igt', note, ['d1'])
    client.jobs.claim(WORKER, 'm', ['igt'])
    client.jobs.finish(made['id'], WORKER, 'done', report or _report())
    return made['id']


def _ws(client=None):
    ws = fake_ws(client or FakeClient())
    ws.reads = []
    return ws


# --- the summary a turn from the job's page is given --------------------------------------

def test_a_turn_from_a_job_page_is_given_its_summary():
    ws = _ws()
    job = _ended(ws.client)
    noun, name, note = AssistantService.place(AssistantService.__new__(AssistantService), ws,
                                              {'kind': 'job', 'id': job, 'name': 'Job of 13 Nov'})
    assert (noun, name) == ('job', job)
    # JD's point 1: the job by its page's name, beside its id, which is for
    # read_job only.
    assert f'"Job of 13 Nov" (job {job})' in note
    assert 'Call it "Job of 13 Nov" to the user: its id is for read_job only.' in note
    assert 'State: done.' in note
    assert 'Started by user, 2026-' in note and 'Ended 2026-' in note
    assert 'Documents: 1.' in note and 'Tasks' not in note
    assert 'Instructions as sent: "Gloss ka as "go"."' in note
    assert 'Totals: documents done 1, sentences 4, words 9, links 7, entries 1, skipped too long 1.' in note
    # JD's point 3: a section by the page's heading with its key.
    assert ('Report sections and their rows: Documents (documents) 1, Skipped sentences (skipped) 1, Left blank '
            '(left) 1, Forms left inconsistent (harmonize.left) 1, Entries created (entries.created) 1.') in note
    # The summary, never the report: no row of it.
    assert 'pele' not in note and 's2.w3' not in note and 'tuna' not in note


def test_the_summary_is_read_fresh_each_turn():
    ws = _ws()
    made = ws.client.jobs.create('p1', 'igt', 'Gloss the words.', ['d1'])
    place = AssistantService.place(AssistantService.__new__(AssistantService), ws,
                                   {'kind': 'job', 'id': made['id'], 'name': 'Job of 13 Nov'})
    # JD's point 2: a job not ended gets one fixed line, never its summary.
    assert place[2] == (f'The user has open the page of an assistant job of this project, "Job of 13 Nov" (job '
                        f'{made["id"]}), which is waiting. Call it "Job of 13 Nov" to the user: its id is for '
                        'read_job only. read_job reads it.')
    ws.client.jobs.claim(WORKER, 'm', ['igt'])
    running = AssistantService.place(AssistantService.__new__(AssistantService), ws,
                                     {'kind': 'job', 'id': made['id'], 'name': 'Job of 13 Nov'})
    assert running[2] == place[2].replace('which is waiting', 'which is running')
    ws.client.jobs.heartbeat(made['id'], WORKER, message='Sentences 1 to 5 of 40.')
    assert AssistantService.place(AssistantService.__new__(AssistantService), ws,
                                  {'kind': 'job', 'id': made['id'], 'name': 'Job of 13 Nov'})[2] == running[2], \
        'the same line every turn while it runs'
    ws.client.jobs.claim(WORKER, 'm', ['igt'])
    ws.client.jobs.finish(made['id'], WORKER, 'done', _report())
    place = AssistantService.place(AssistantService.__new__(AssistantService), ws, {'kind': 'job', 'id': made['id']})
    assert 'State: done.' in place[2] and 'Report sections' in place[2]


def test_the_summary_keeps_to_its_budget_and_says_what_it_cut():
    """A note at core's cap, a long reason line and every section full: a few
    hundred tokens all the same, the instructions cut with a note."""
    ws = _ws()
    note = 'Gloss every word. ' * 111  # 1,998 characters
    many = [{'ref': f's{i}.w1', 'sentence_id': f'S{i}', 'begin': 0, 'form': 'x' * 30} for i in range(500)]
    report = _report(documents=[{**_report()['documents'][0], 'left': many, 'left_more': 4000}],
                     harmonize={'changed': [{'form': 'a', 'to': 'a', 'by': 'majority', 'from': []}] * 500,
                                'left': [], 'changed_more': 900, 'left_more': 0})
    job = _ended(ws.client, report, note=note)
    _, _, said = jobread.job_place(ws, {'kind': 'job', 'id': job})
    assert len(note) > 1900
    assert f'the first {jobread.JOB_SUMMARY_NOTE_CHARS} of {len(note):,} characters (read_job with the job gives ' \
           'it whole)' in said
    assert 'Left blank (left) 4,500' in said and 'Analyses made consistent (harmonize.changed) 1,400' in said
    assert len(said) < 1600, len(said)


def test_a_job_that_is_gone_is_said_to_be_gone():
    ws = _ws()
    _, name, note = jobread.job_place(ws, {'kind': 'job', 'id': 'gone-1', 'name': 'Job of 13 Nov'})
    assert name == 'gone-1'
    assert note == ('The user has open the page of "Job of 13 Nov" (job gone-1), which no longer exists in this '
                    'project.')


def test_a_job_of_another_project_is_not_this_project_s():
    client = FakeClient()
    ws = _ws(client)
    other = _ended(client)
    client.jobs.rows[other]['project'] = 'p2'
    assert 'no longer exists in this project' in jobread.job_place(ws, {'kind': 'job', 'id': other})[2]
    out = call_tool(ws, 'read_job', {'job': other})
    assert out == f'Error: No job of this project has the id "{other}". read_job with no job lists them.'


def test_a_job_the_user_cannot_read_is_refused_as_core_refuses_it():
    """A non-admin's unknown id is core's 403 unresolved: the same refusal
    as a 404, and nothing of the job."""
    ws = _ws()
    job = _ended(ws.client)

    def hidden(job_id):
        raise PlaidAPIError('HTTP 403', status=403, url='u', method='GET',
                            response_data={'error': 'Forbidden', 'unresolved': True})
    ws.client.jobs.get = hidden
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left'})
    assert out == f'Error: No job of this project has the id "{job}". read_job with no job lists them.'
    assert 'no longer exists' in jobread.job_place(ws, {'kind': 'job', 'id': job})[2]


def test_a_job_that_cannot_be_read_now_leaves_the_turn_to_go_on():
    ws = _ws()

    def down(job_id):
        raise PlaidAPIError('HTTP 502', status=502, url='u', method='GET', response_data={})
    ws.client.jobs.get = down
    noun, name, note = jobread.job_place(ws, {'kind': 'job', 'id': 'j1'})
    assert note.startswith('The user has open the page of job j1, which could not be read now:')


# --- read_job ---------------------------------------------------------------------------

def test_with_no_job_it_lists_the_project_s_jobs():
    ws = _ws()
    first = _ended(ws.client)
    out = call_tool(ws, 'read_job', {})
    assert out.startswith('Jobs of this project, newest first: 1 to 1 of 1.')
    assert f'{first} | done | "Gloss ka as "go"." | started by user, 2026-' in out and '| 1 document' in out
    assert ws.reads[-1] == {'n': 1, 'unit': 'row', 'of': 1}


def test_the_job_list_pages():
    ws = _ws()
    for _ in range(jobread.JOB_LIST_PER_PAGE + 2):
        _ended(ws.client)
    out = call_tool(ws, 'read_job', {})
    assert 'newest first: 1 to 10 of 12.' in out and 'Older jobs: page 2.' in out
    out = call_tool(ws, 'read_job', {'page': 2})
    assert 'newest first: 11 to 12 of 12.' in out and 'Older jobs' not in out
    assert call_tool(ws, 'read_job', {'page': 3}).startswith('Error: Page 3 is past the end: 12 jobs, 10 a page.')


def test_a_job_alone_gives_its_summary_with_the_instructions_whole():
    ws = _ws()
    note = 'Leave loanwords. ' * 50
    job = _ended(ws.client, note=note)
    out = call_tool(ws, 'read_job', {'job': job})
    assert out.startswith(f'Job {job}.\nState: done.')
    assert f'Instructions as sent: "{note}"' in out
    assert ('Report sections and their rows: Documents (documents) 1, Skipped sentences (skipped) 1, Left blank '
            '(left) 1, Forms left inconsistent (harmonize.left) 1, Entries created (entries.created) 1.') \
        in out
    assert out.endswith('read_job with a section reads its rows.')


def test_the_plans_instructions_and_what_it_left_out_are_read_as_the_assistants():
    """The lead's ruling on REV-JG-14: what the planning context told every
    piece is read with the job, as the assistant's own words, apart from the
    instructions the person sent. The documents the plan left out are a
    section, "Left out by the plan"."""
    ws = _ws()
    told = ('Gloss -da as LOC after a noun. ' * 20).strip()
    report = _report(plan={'pieces': 'document', 'piece_instructions': told, 'documents': ['d1'], 'by': 'model',
                           'why': None, 'fallback': [], 'left_out': [{'document_id': 'd2', 'name': 'Text 2'}]})
    job = _ended(ws.client, report, note='Gloss the texts.')
    out = call_tool(ws, 'read_job', {'job': job})
    assert 'Instructions as sent: "Gloss the texts."' in out
    assert f'What the assistant told every piece, as it planned the job: "{told}"' in out
    assert 'Left out by the plan (plan.left_out) 1' in out
    rows = call_tool(ws, 'read_job', {'job': job, 'section': 'Left out by the plan'})
    assert '"Text 2", id d2' in rows or 'name: Text 2' in rows, rows
    _, _, said = jobread.job_place(ws, {'kind': 'job', 'id': job})
    assert f'the first {jobread.JOB_SUMMARY_NOTE_CHARS} of {len(told):,} characters' in said


def test_a_section_gives_its_rows_with_the_places_to_read_and_plan():
    ws = _ws()
    job = _ended(ws.client)
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left'})
    assert out.splitlines() == [
        f'Job {job}, report section Left blank (left): rows 1 to 1 of 1. As the job ended, 2026-11-13 03:10 UTC.',
        '"Text 1" | form: pele | ref: s2.w3']
    assert ws.reads[-1] == {'n': 1, 'unit': 'row', 'of': 1}
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'harmonize.left'})
    assert 'form: ka | reason: no-clear-majority | analyses: ka ‘go’ ×2, ka ‘come’ ×2' in out
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'entries.created'})
    assert 'form: tuna | id: e9 | lexicon: "Lexicon" | gloss: fish' in out
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'documents'})
    assert '"Text 1", id d1 | state: done | sentences: 5 | targets: 5 | done: 5 | counts: words 9, links 7, ' \
           'left 1 | skipped: 1 | left: 1' in out
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'skipped'})
    assert '"Text 1" | sentence: s5 | reason: too-long' in out


def test_the_sections_are_the_report_s_own_lists():
    """A list a later round adds to the report is a section with no change
    here, and an empty one is none."""
    ws = _ws()
    report = _report()
    report['entries']['renamed'] = [{'form': 'kai', 'gloss': 'go'}]
    report['documents'][0]['moved'] = [{'ref': 's1.w1'}]
    job = _ended(ws.client, report)
    names = [name for name, _, _ in jobread.sections(ws.client.jobs.get(job)['report'])]
    assert names == ['documents', 'skipped', 'left', 'moved', 'harmonize.left', 'entries.created',
                     'entries.renamed']
    assert 'form: kai | gloss: go' in call_tool(ws, 'read_job', {'job': job, 'section': 'entries.renamed'})


def test_a_section_pages_and_says_what_it_left_out():
    ws = _ws()
    many = [{'ref': f's{i}.w1', 'sentence_id': f'S{i}', 'begin': 0, 'form': f'w{i}'} for i in range(1, 46)]
    report = _report(documents=[{**_report()['documents'][0], 'left': many, 'left_more': 7}])
    job = _ended(ws.client, report)
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left'})
    lines = out.splitlines()
    assert lines[0].startswith(f'Job {job}, report section Left blank (left): rows 1 to 40 of 45, and 7 more the '
                               'report '
                               'counted and did not list.')
    assert len(lines) == 42 and lines[-1] == 'Rows 41 to 45: page 2.'
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left', 'page': 2})
    assert 'rows 41 to 45 of 45' in out and out.splitlines()[-1] == '"Text 1" | form: w45 | ref: s45.w1'
    assert ws.reads[-1] == {'n': 5, 'unit': 'row', 'of': 45}
    assert call_tool(ws, 'read_job', {'job': job, 'section': 'left', 'page': 3}).startswith(
        'Error: Page 3 is past the end: 45 rows, 40 a page.')


def test_document_narrows_a_section():
    client = FakeClient()
    ws = _ws(client)
    two = _report()
    two['documents'] = [two['documents'][0], {
        'document_id': 'gone-doc', 'name': None, 'state': 'gone', 'sentences': 2, 'targets': 2, 'done': 0,
        'counts': {'left': 1}, 'skipped': [], 'gloss_group': None, 'harmonize_group': None,
        'left': [{'ref': 's1.w1', 'sentence_id': 'X', 'begin': 0, 'form': 'kai'}], 'left_more': 3}]
    job = _ended(client, two)
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left', 'document': 'Text 1'})
    assert 'section Left blank (left) in "Text 1": rows 1 to 1 of 1.' in out and 'kai' not in out
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left', 'document': 'gone-doc'})
    assert 'in a deleted document (gone-doc): rows 1 to 1 of 1, and 3 more the report counted' in out
    assert 'a deleted document (gone-doc) | form: kai | ref: s1.w1' in out
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left', 'document': 'Text 9'})
    assert out == 'Error: The job holds no document "Text 9". Its documents: "Text 1".'
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'harmonize.left', 'document': 'Text 1'})
    assert out.startswith('Error: The rows of Forms left inconsistent (harmonize.left) name no document')


def test_a_row_names_its_form_first_whatever_order_core_keeps_its_keys_in():
    """bench glm53-stretch-3 igt-job-discuss rep 1: asked what the job left
    undone, the model read Forms left inconsistent and named only the blank
    word. Its row came back from core as "analyses: wila ‘MANR’ ×3, wila
    ‘like’ ×2 | reason: no-clear-majority | form: wila", the form last."""
    ws = _ws()
    report = _report(harmonize={'changed': [], 'changed_more': 0, 'left_more': 0, 'left': [
        {'analyses': [{'analysis': 'ka ‘go’', 'count': 2}, {'analysis': 'ka ‘come’', 'count': 2}],
         'reason': 'no-clear-majority', 'form': 'ka'}]})
    job = _ended(ws.client, report)
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'harmonize.left'})
    assert out.splitlines()[1] == 'form: ka | analyses: ka ‘go’ ×2, ka ‘come’ ×2 | reason: no-clear-majority', out


def test_harmonize_rows_name_their_documents_and_narrow_by_them():
    ws = _ws()
    report = _report(harmonize={'changed': [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority',
                                             'from': [{'analysis': 'ka ‘come’', 'count': 1, 'documents': ['d1']}]}],
                                'left': [], 'changed_more': 0, 'left_more': 0})
    job = _ended(ws.client, report)
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'harmonize.changed', 'document': 'd1'})
    assert 'form: ka | to: ka ‘go’ | by: majority | from: ka ‘come’ ×1 in "Text 1"' in out


@pytest.mark.parametrize('args, said', [
    ({'section': 'left'}, 'Name the job: read_job with no job lists them'),
    ({'job': 'J', 'section': 'harmonize'}, 'has no section "harmonize". Its sections: Documents (documents), '
                                           'Skipped sentences (skipped), Left blank (left), Forms left inconsistent '
                                           '(harmonize.left), Entries created (entries.created).'),
    ({'job': 'J', 'document': 'Text 1'}, 'document narrows a section: name the section too.'),
    ({'job': 'J', 'page': 'two'}, '"page" has to be a number'),
])
def test_each_refusal_says_what_to_change(args, said):
    ws = _ws()
    job = _ended(ws.client)
    args = {k: (job if v == 'J' else v) for k, v in args.items()}
    out = call_tool(ws, 'read_job', args)
    assert out.startswith('Error') and said in out, out


def test_a_running_job_has_no_report_to_read():
    ws = _ws()
    made = ws.client.jobs.create('p1', 'igt', 'Gloss the words.', ['d1'])
    ws.client.jobs.claim(WORKER, 'm', ['igt'])
    out = call_tool(ws, 'read_job', {'job': made['id'], 'section': 'left'})
    assert out == f'Error: Job {made["id"]} is running and has no report yet.'
    assert 'No report yet.' in call_tool(ws, 'read_job', {'job': made['id']})


def test_what_the_tool_tells_the_model_has_no_semicolon_or_em_dash():
    ws = _ws()
    job = _ended(ws.client)
    schema = str(next(t for t in TOOLS if t['function']['name'] == 'read_job'))
    texts = [schema, call_tool(ws, 'read_job', {'section': 'help'}), call_tool(ws, 'read_job', {}),
             call_tool(ws, 'read_job', {'job': job}), jobread.job_place(ws, {'kind': 'job', 'id': job})[2]]
    texts += [call_tool(ws, 'read_job', {'job': job, 'section': s}) for s in
              ('documents', 'skipped', 'left', 'harmonize.left', 'entries.created')]
    for text in texts:
        assert ';' not in text and '—' not in text, text


def test_the_schema_is_short():
    """A rare tool (feedback_rare_tools_opt_in): one short schema, the manual
    behind section "help"."""
    schema = next(t for t in TOOLS if t['function']['name'] == 'read_job')['function']
    assert len(str(schema)) < 700, len(str(schema))
    assert schema['parameters'].get('required') == []


# --- a turn from the job's page, through the service ---------------------------------------

def test_a_turn_from_a_job_page_stamps_the_job_shows_its_summary_and_records_only_its_id_and_name(monkeypatch):
    """The model's system prompt carries the summary (the panel shows it under
    the round's Instructions, as any other context), the question is stamped
    with the job, and the record keeps only the job's id and name for the
    place, never the summary. A second turn reads the job again."""
    from test_single_writer import _send, _store

    from plaid_agent.core import turn as turn_mod
    from plaid_agent.core.agent import TurnResult
    from test_service_flow import _service
    client = FakeClient()
    job = _ended(client)
    seen = []

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen.append((system, transcript[-1]['content'], ws.rounds.system))
        return TurnResult('One word left blank.', [{'role': 'assistant', 'content': 'One word left blank.'}], [])
    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    where = {'kind': 'job', 'id': job, 'name': 'Job of Nov 13, 2026, 3:10 AM'}
    helper = _send(_service(), client, text='What did it leave blank?', where=where)
    assert not helper.errors, helper.errors
    system, asked, kept = seen[0]
    assert system == kept, 'the round keeps the instructions the model was given'
    assert f'(job {job}). Call it' in system and 'Its record as read now:' in system
    assert 'Report sections and their rows:' in system
    assert asked == f'[Asked from the job "{job}"]\n\nWhat did it leave blank?'
    conv, meta = _store(client).load('c1')
    assert conv['display'][0]['where'] == where
    assert meta['about'] == {'job_id': job, 'job_name': 'Job of Nov 13, 2026, 3:10 AM'}
    stored = str(conv) + str(meta)
    assert 'Report sections' not in stored and 'State: done' not in stored

    # Reloaded and asked again from the same page: the job is read again, and
    # the stamp is not repeated.
    client.jobs.calls.clear()
    _send(_service(), client, text='And the inconsistent forms?', rid='r2', create=False, where=where)
    assert ('get', {'job_id': job}) in client.jobs.calls
    assert seen[1][1] == 'And the inconsistent forms?'
    assert 'Report sections and their rows:' in seen[1][0]


def test_the_guide_names_the_button_as_the_job_page_does():
    """The guide's section on discussing a job (BRIEF-JD item 6), in the copy
    the assistant reads, names the button by the job page's own words."""
    from pathlib import Path

    from plaid_agent.igt.guide import t_app_guide
    page = (Path(__file__).resolve().parents[2] / 'plaid-igt' / 'src' / 'components' / 'projects' / 'jobs'
            / 'JobPage.jsx').read_text()
    assert 'Discuss with the assistant' in page
    text = t_app_guide(_ws(), 'Discussing a job with the assistant')
    assert '**Discuss with the assistant**' in text, text[:300]
    assert 'why' in text and 'as the job ended' in text


def test_each_step_says_what_it_read_as_the_panel_says_it():
    """The step's label and what it read, as the panel draws them. A section's
    name read as a range once made "row left of 1"."""
    from plaid_agent.core.trace import say_saw
    from plaid_agent.igt.trace import TRACER
    ws = _ws()
    job = _ended(ws.client)
    said = []
    for args in ({}, {'job': job}, {'job': job, 'section': 'left'}, {'job': job, 'section': 'help'}):
        ws.reads = []
        call_tool(ws, 'read_job', args)
        said.append((TRACER.describe('read_job', args), say_saw(ws.reads)))
    assert said[0] == ('Listed the jobs', '1 row')
    assert said[1][0] == 'Read a job\'s summary' and said[1][1].startswith('printed ')
    # JD's point 3: the step names the section by the page's heading, with its key.
    assert said[2] == ('Read \u201cLeft blank (left)\u201d of a job\'s report', '1 row')
    assert TRACER.describe('read_job', {'job': job, 'section': 'Left blank'}) == said[2][0], 'by its heading too'
    assert said[3][0] == 'Read how to read a job'
    assert TRACER.kind('read_job') is not None
