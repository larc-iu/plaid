"""What a job's model and a job's reader are told (job review 2026-11-18, lane JR2).

Each test pins one false statement the review found, by what the model or
read_job is shown, on the fake."""

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core import job as core_job
from plaid_agent.core.limits import JOB_CORE_TRIES, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project


def _job_ws():
    c = FakeClient()
    return JobWorkspace(c, load_project(c, 'p1'))


# --- D8: a rule or a setup change is proposed, never applied -------------------------------------

def test_a_rule_staged_in_a_job_is_told_as_proposed_with_no_card_and_no_user():
    ws = _job_ws()
    out = toolkit.job_piece_call(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'ALI'})
    assert [o['kind'] for o in ws.ops] == ['bulk_scope']
    assert out.startswith('Staged 1 value in 1 document. 1 proposed change in all, listed in the report and '
                          'never applied.')
    for chat in ('applied when you end', 'card', 'approve'):
        assert chat not in out
    assert ws.result_line() == '[Staged: 0 changes to apply, 1 proposed change only listed in the report.]'


def test_a_setup_change_beside_a_value_is_counted_apart_from_it():
    ws = _job_ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss',
                                                   'value': 'x'})
    assert out.startswith('Staged 1 change. 1 change staged in all, applied when you end.')
    assert ws.result_line() == '[Staged: 1 change.]'
    out = toolkit.job_piece_call(ws, 'guidelines', {'action': 'add', 'title': 'T', 'body': 'x'})
    assert out.startswith('Staged 1 change. 1 proposed change in all, listed in the report and never applied. '
                          '1 change staged in all, applied when you end.')
    assert ws.result_line() == '[Staged: 1 change to apply, 1 proposed change only listed in the report.]'
    status = toolkit.job_piece_call(ws, 'plan_status', {})
    assert 'approve' not in status and status.splitlines()[0] == '2 planned changes:'


# --- D9: a job that stands undone says so ---------------------------------------------------------

UNDONE = {'operation': 'op-1', 'time': '2026-11-18T03:10:00Z', 'user': 'u1'}


def _undone_job():
    return {'id': 'j1', 'project': 'p1', 'state': 'done', 'undone': UNDONE, 'created_at': '2026-11-18T01:00:00Z',
            'started_by': 'u1', 'documents': ['d1'], 'instructions': 'Gloss.',
            'report': {'notice': "People's work: 3 values people wrote were changed.",
                       'totals': {'changes': 40}, 'documents': []}}


def test_read_job_says_an_undone_job_is_undone_and_drops_its_notice():
    from plaid_agent.igt.jobread import summary
    lines = summary(_undone_job())
    assert lines[0] == 'State: done, undone 2026-11-18 03:10 UTC.'
    said = '\n'.join(lines)
    assert "People's work" not in said
    assert 'Undone 2026-11-18 03:10 UTC: the counts below are what the job had written, not what stands now.' in lines


def test_the_list_of_jobs_says_which_stand_undone():
    from plaid_agent.igt.jobread import _list_jobs

    class _Jobs:
        def list(self, project):
            return [{**_undone_job(), 'document_count': 1}, {**_undone_job(), 'id': 'j2', 'undone': None}]

    class _Ws:
        client = type('C', (), {'jobs': _Jobs()})()
        project = type('P', (), {'id': 'p1'})()

        def note_read(self, *a, **k):
            pass

    out = _list_jobs(_Ws(), 1)
    assert 'j1 | done, undone 2026-11-18 03:10 UTC |' in out
    assert 'j2 | done |' in out


# --- D14: core out of reach is not people editing -------------------------------------------------

def _two_documents(monkeypatch, down_reads):
    """A job over two documents whose reads of d1 meet a 502 the first
    ``down_reads`` times, on a fake clock."""
    clock = {'t': 1_800_000_000.0}
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in (1, 2)}
    client = JobClient(docs)
    job = start(client, now=lambda: clock['t'])

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': asked.split('"')[1], 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    r = runner(job)
    real, left = r.read, {'n': down_reads}

    def read(project, document_id, client=None):
        if document_id == 'd1' and left['n']:
            left['n'] -= 1
            raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='GET')
        return real(project, document_id, client)
    r.read = read
    return client, job, r


def _said(client):
    return [b.get('message') for k, b in client.jobs.calls if k == 'heartbeat' and b.get('message')]


def test_a_document_core_did_not_answer_for_is_waited_for_as_such_and_finished_after(monkeypatch):
    client, job, r = _two_documents(monkeypatch, JOB_CORE_TRIES)
    r.work(job)
    assert job.rows['d1']['state'] == 'done' and job.rows['d2']['state'] == 'done'
    assert not job.rows['d1'].get('defers')
    said = _said(client)
    assert not [m for m in said if m.startswith('Waiting for people')], said
    assert 'The server did not answer. Trying again in 10 minutes.' in said
    assert job.paused['edits'] == 0, "not a wait for people's edits"


def test_core_out_of_reach_for_good_ends_the_document_not_reached_never_in_use(monkeypatch):
    """Put off by core as often as a person's document would be before it
    ends in use, it ends not reached, and the job goes on (REV-JG-4)."""
    client, job, r = _two_documents(monkeypatch, 10 ** 6)
    r.work(job)
    assert job.rows['d1']['state'] == 'not-reached' and not job.rows['d1'].get('defers')
    assert job.rows['d2']['state'] == 'done'
    assert job.paused['edits'] == 0
    waits = [m for m in _said(client) if m == 'The server did not answer. Trying again in 10 minutes.']
    assert len(waits) == JOB_DEFER_ROUNDS and JOB_DEFER_WAIT_S == 600
    assert not [m for m in _said(client) if m.startswith('Waiting for people')]


@pytest.mark.parametrize('status,person', [(502, False), (429, False), (423, True)])
def test_a_put_off_by_core_names_its_error_and_a_lock_names_a_person(monkeypatch, status, person):
    """The selection's write and the walk put a document off through one
    helper: a lock (423) is a person in the document, anything else core
    could not answer is not, and the selection records the fallback
    reason by it."""
    from plaid_agent.igt.job import Deferred
    client, job, r = _two_documents(monkeypatch, 0)

    def step():
        raise PlaidAPIError('refused', status=status, method='POST')
    with pytest.raises(Deferred) as e:
        r.off_on_trouble('d1', step)
    assert (e.value.error is None) is person


# --- D10: core's own report, read as the page reads it --------------------------------------------

def test_read_job_says_the_words_core_s_own_report_holds_in_its_documents_and_whose_line_it_is():
    from plaid_agent.igt.jobread import summary
    job = {'id': 'j1', 'project': 'p1', 'state': 'cancelled', 'documents': ['d1'], 'instructions': 'Respell.',
           'report': {'totals': {'text_changes': 3, 'peoples_values_changed': 0},
                      'documents': [{'state': 'done', 'counts': {'words_added': 25, 'tokens_changed': 2,
                                                                 'text_changes': 3}}]}}
    top = next(line for line in summary(job) if line.startswith("The report's top line"))
    assert top == ('The report\'s top line: "Text: 25 words added, 2 existing words or punctuation marks changed or '
                   'removed."'), top


# --- D11: a sentence too long for a job is not a skipped target ------------------------------------

def test_too_long_sentences_past_the_list_are_counted_apart_from_the_skipped_ones(monkeypatch):
    from plaid_agent.core.limits import JOB_SENTENCE_MAX_WORDS
    from plaid_agent.igt import job as igt_job
    monkeypatch.setattr(igt_job, 'JOB_SKIPPED_PER_DOCUMENT', 1)
    long = {'words': ['a'] * (JOB_SENTENCE_MAX_WORDS + 1)}
    client = JobClient({'d1': document('d1', 'Story', [long, {'words': ['blank']}, long])})
    job = start(client)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    r = runner(job)
    assert r.check(job) is None
    row = job.rows['d1']
    assert [s['reason'] for s in row['skipped']] == ['too-long'] and row['targets'] == 1
    assert row['counts'].get('too_long_more') == 1 and not row['counts'].get('skipped_more')
    assert r.document('d1') == 'done'
    row = job.rows['d1']
    assert row['done'] == 1 and row['counts'].get('too_long_more') == 1 and not row['counts'].get('skipped_more')


def test_the_documents_count_a_document_whose_targets_were_all_worked_as_done():
    from plaid_agent.igt.job import document_counts
    d = {'state': 'done', 'done': 3, 'targets': 3, 'counts': {'too_long_more': 2},
         'skipped': [{'sentence': f's{i}', 'sentence_id': f't{i}', 'reason': 'too-long'} for i in range(3)]}
    assert document_counts({'totals': {'documents_done': 1}, 'documents': [d]})['done'] == 1


def test_a_too_long_sentence_cut_from_the_report_is_counted_as_one_more_too_long():
    from plaid_agent.core.job import build_report, fit_report
    rows = [{'sentence': f's{i}', 'sentence_id': f't{i}' * 40, 'reason': 'too-long', 'kind': None}
            for i in range(40)]
    report = {'totals': {'skipped_too_long': 40}, 'documents': [{'skipped': list(rows), 'counts': {}}]}
    fit_report(report, budget=2000)
    d = report['documents'][0]
    cut = 40 - len(d['skipped'])
    assert cut and d['counts'].get('too_long_more') == cut and not d['counts'].get('skipped_more')
    assert report['totals']['too_long_more'] == cut and not report['totals'].get('skipped_more')
    assert report['totals']['skipped_too_long'] == 40 - cut
    assert build_report.__doc__


# --- D12: scattered sentences are named, never shown as a run ------------------------------------

def test_a_part_of_scattered_sentences_is_named_one_by_one_on_the_line_and_the_work_list(monkeypatch):
    """Only s3, s5 and s7 hold something empty: the heartbeat and the piece's
    summary name those three, never "3 to 7"."""
    from plaid_agent.core.job import run_job
    filled = {'words': [('ka', [('ka', 'go')], 'human')]}
    sents = [filled, filled, {'words': ['sa']}, filled, {'words': ['sa']}, filled, {'words': ['sa']}]
    client = JobClient({'d1': document('d1', 'Story', sents), 'd2': document('d2', 'Other', [{'words': ['ta']}])})
    job = start(client, 'Gloss what is empty.', id='JPN', only_empty=True)
    lines = []

    def answer(asked, n, kwargs):
        if n == 1 and '"Story"' in asked:
            lines.append(job.status.get('message'))
        return reply('Nothing.')
    use(monkeypatch, Model(answer))
    r = runner(job)
    run_job(job, r)
    assert lines == ['Story: sentences 3, 5, 7 of 7.'], lines
    import json
    from plaid_agent.igt.job import PIECE_FORM
    rows = [json.loads(x['analysis']) for x in job.lookup_decisions([PIECE_FORM])]
    rows = [p for p in rows if p.get('document') == 'd1']
    assert [(p['first'], p['last'], p.get('sentences')) for p in rows] == [('s3', 's7', ['s3', 's5', 's7'])], rows


def test_a_run_of_sentences_keeps_its_range():
    from plaid_agent.igt.job import sentences_text
    assert sentences_text([3, 4, 5]) == 'sentences 3 to 5'
    assert sentences_text([4]) == 'sentence 4'
    assert sentences_text([3, 11, 19]) == 'sentences 3, 11, 19'


# --- D22: documents the plan left out ----------------------------------------------------------

def test_documents_the_plan_left_out_are_counted_and_said_apart_from_those_not_reached():
    from plaid_agent.igt.job import document_counts, state_text
    report = {'totals': {'documents_done': 1, 'documents_not_reached': 2},
              'plan': {'left_out': [{'document_id': 'l1', 'name': 'L1'}]},
              'documents': [{'document_id': 'd1', 'state': 'done', 'done': 1, 'targets': 1},
                            {'document_id': 'l1', 'state': 'not-reached', 'done': 0},
                            {'document_id': 'n1', 'state': 'not-reached', 'done': 0}]}
    counts = document_counts(report)
    assert (counts['not_reached'], counts['left_out']) == (1, 1)
    assert state_text(report['documents'][1], {'l1'}) == 'left out by the plan'
    assert state_text(report['documents'][2], {'l1'}) == 'not-reached'


# --- D24: a text-edit refusal in a job carries no chat step ---------------------------------------

def _text_ws():
    ws = _job_ws()
    ws.edits_text = True
    return ws


@pytest.mark.parametrize('first,then', [
    (('delete_sentence', {'document': 'Text 1', 'refs': ['s2']}),
     ('respell', {'document': 'Text 1', 'ref': 's2.w1', 'new_text': 'Gem-ar'})),
    (('respell', {'document': 'Text 1', 'ref': 's1.w2', 'new_text': 'gom'}),
     ('split_word', {'document': 'Text 1', 'ref': 's1.w2', 'at': 1})),
    (('split_word', {'document': 'Text 1', 'ref': 's1.w2', 'at': 1}),
     ('respell', {'document': 'Text 1', 'ref': 's1.w2', 'new_text': 'gom'})),
    (('retype_sentence', {'document': 'Text 1', 'ref': 's1', 'text': 'Ali-di gam akuna mo.'}),
     ('respell', {'document': 'Text 1', 'ref': 's2.w1', 'new_text': 'Gem-ar'})),
])
def test_two_text_changes_that_cannot_stand_together_are_left_with_the_jobs_line(first, then):
    from plaid_agent.core.prompt import JOB_LEAVE_IT
    ws = _text_ws()
    toolkit.job_piece_call(ws, *first)
    held = list(ws.ops)
    out = toolkit.job_piece_call(ws, *then)
    assert out.startswith('Error: ') and out.endswith(JOB_LEAVE_IT), out
    for chat in ('discard_plan', 'separate plan', 'once that is applied', 'approve'):
        assert chat not in out
    assert ws.ops == held and len(ws.left_by_refusal) == 1



# --- D25: the garble refusal in a job names no run_code and no user -------------------------------

def test_a_value_in_a_rare_script_never_read_is_refused_with_a_step_a_piece_can_take():
    ws = _job_ws()
    why = ws.garbled({'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': '\U0001E900\U0001E901'})
    assert why is not None
    for chat in ('run_code', 'user', 'paste', 'file_rows', 'attached'):
        assert chat not in why, why
    assert why.endswith('Do not type it: copy it from where a read or your message prints it, and stage the change '
                        'from there, or leave it and say so in your note.'), why
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'ref': 's1.w1', 'value': '\U0001E900\U0001E901'}]})
    assert 'run_code' not in out and 'paste' not in out, out


def test_the_chat_is_still_told_to_copy_in_run_code_or_ask_the_user():
    from plaid_agent.igt.workspace import Workspace
    c = FakeClient()
    ws = Workspace(c, load_project(c, 'p1'))
    why = ws.garbled({'value': '\U0001E900\U0001E901'})
    assert 'run_code' in why and 'paste it into the chat' in why


# --- D26: a findings piece is never shown a one-line ending ------------------------------------

@pytest.mark.parametrize('sentences', [False, True])
def test_a_findings_piece_is_shown_an_example_that_ends_with_findings(sentences):
    from plaid_agent.core.prompt import JOB_FINDINGS_ENDING
    from plaid_agent.igt.prompt import build_job_prompt
    project = _job_ws().project
    told = build_job_prompt(project, sentences=sentences, targets=[], findings=True)
    assert 'Then you ended with the note' not in told
    assert JOB_FINDINGS_ENDING in told
    assert 'Then you ended with the note' in build_job_prompt(project, sentences=sentences, targets=[])


def test_a_findings_piece_is_told_to_end_with_its_findings_at_every_closing_line(monkeypatch):
    """The decide-now line, the re-ask after an empty answer and the
    closing call's lines of a job that fills nothing ask for its findings."""
    from plaid_agent.core import prompt as p
    for line in (p.JOB_FINDINGS_DECIDE_NOW, p.JOB_FINDINGS_ANSWER_AGAIN, p.JOB_FINDINGS_STEPS_USED_UP,
                 p.JOB_FINDINGS_STEPS_USED_UP_REFUSED):
        assert 'findings' in line and 'note' not in line and 'one line' not in line
    ws = _job_ws()
    ws.findings, ws.closing = True, True
    assert toolkit.job_piece_call(ws, 'plan_status', {}) == 'Error: ' + p.JOB_FINDINGS_STEPS_USED_UP_REFUSED
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, fills=[], plan='document')
    r = runner(job)
    asked = []

    def answer(said, n, kwargs):
        asked.append([m.get('content') for m in kwargs['messages'] if m.get('role') == 'user'][-1])
        return reply('' if len(asked) == 1 else '## Findings')
    use(monkeypatch, Model(answer))
    assert r.fills_nothing()
    pace = r.pace(piece=True)
    assert pace.line == p.JOB_FINDINGS_DECIDE_NOW and pace.used_up == p.JOB_FINDINGS_STEPS_USED_UP
    r.document('d1')
    assert asked[1] == p.JOB_FINDINGS_ANSWER_AGAIN, asked


# --- D28: the planner is told the tools a fills-nothing piece is offered ---------------------------

@pytest.mark.parametrize('edits_text', [False, True])
def test_a_fills_nothing_sentences_plan_names_the_tools_its_pieces_are_offered(edits_text):
    ws = _job_ws()
    ws.in_sentences, ws.fills, ws.edits_text = True, [], edits_text
    offered = {t['function']['name'] for t in toolkit.job_piece_tools(ws)}
    line = toolkit.fills_nothing_sentences(edits_text)
    head = 'Its pieces are offered only '
    assert line.startswith(head) and line.endswith('.'), line
    named = line[len(head):-1].replace(' and ', ', ').split(', ')
    assert set(named) == offered and len(named) == len(offered), (line, offered)


# --- D29: a piece is told of evidence only when its message holds some ---------------------------

def test_a_piece_whose_message_holds_no_evidence_is_not_told_it_does():
    from plaid_agent.core.prompt import JOB_STAGE_EVIDENCE
    from plaid_agent.igt.prompt import build_job_prompt
    project = _job_ws().project
    assert JOB_STAGE_EVIDENCE in build_job_prompt(project)
    assert JOB_STAGE_EVIDENCE not in build_job_prompt(project, evidence=False)


def test_a_piece_filling_sentence_fields_only_is_told_of_sentences_not_other_words():
    from plaid_agent.igt import targets as tg
    from plaid_agent.igt.prompt import JOB_SENTENCE_FIELDS_READ_FIRST, build_job_prompt
    project = _job_ws().project
    translation = [t for t in tg.fillable(project) if t.scope == 'Sentence']
    told = build_job_prompt(project, sentences=True, targets=translation, evidence=False)
    assert JOB_SENTENCE_FIELDS_READ_FIRST in told
    assert 'other words or morphemes' not in told and '"leo" the value N' not in told


def test_the_selection_piece_and_a_fills_nothing_piece_are_built_without_the_evidence_line(monkeypatch):
    """By what the message held: a selection's lists the documents only."""
    from plaid_agent.core.prompt import JOB_STAGE_EVIDENCE
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, plan='selection')
    systems = []

    def answer(said, n, kwargs):
        systems.append(kwargs['messages'][0]['content'])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    r = runner(job)
    r.work(job)
    assert systems and JOB_STAGE_EVIDENCE not in systems[0]


def test_plan_work_promises_what_is_empty_only_to_pieces_shown_it():
    said = toolkit.PLAN_WORK['function']['description']
    assert 'Pieces in sentences and of one document are shown what of it is empty.' in said, said
