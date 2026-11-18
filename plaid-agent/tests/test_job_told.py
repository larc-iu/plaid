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

def _two_documents(monkeypatch, down_reads, from_work=False):
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
    real, left = r.read, {'n': 0 if from_work else down_reads}
    if from_work:
        # Core fails from the walk on, not at the checks.
        work = r.work

        def armed(job):
            left['n'] = down_reads
            return work(job)
        r.work = armed

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


# --- REV-JR2-1: no line a job sends lists more than a few sentences -------------------------------

def _utf16(s):
    return len(s.encode('utf-16-le')) // 2


def test_no_progress_line_for_a_500_sentence_document_passes_cores_cap():
    from plaid_agent.igt.job import SENTENCES_NAMED, sentences_text
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}]),
                        'd2': document('d2', 'Other', [{'words': ['ta']}])})
    job = start(client)
    r = runner(job)
    total = 500
    shapes = [list(range(1, total + 1)), list(range(1, total + 1, 2)), list(range(3, total + 1, 7)), [5],
              list(range(1, 2 * SENTENCES_NAMED, 2))]
    name = 'Story of a long name ' * 4
    lines = []
    for idx in shapes:
        lines.append(r.progress_line(name, False, idx, total))
        lines.append(r.after_text_line(name, idx))
    lines.append(r.progress_line(name, True, shapes[0], total))
    assert all(_utf16(x) <= 300 for x in lines), [x for x in lines if _utf16(x) > 300]
    assert sentences_text(list(range(3, 41, 3))) == '13 sentences from 3 to 39'
    assert sentences_text(list(range(1, 2 * SENTENCES_NAMED, 2))) == \
        'sentences ' + ', '.join(str(i) for i in range(1, 2 * SENTENCES_NAMED, 2))


def test_a_one_sentence_stretch_reads_sentence_n_of_m():
    """REV-JR2-10."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}]),
                        'd2': document('d2', 'Other', [{'words': ['ta']}])})
    job = start(client)
    assert runner(job).progress_line('Story', False, [5], 7) == 'Story: sentence 5 of 7.'


# --- REV-JR2-2: the work list's list of sentences is capped ---------------------------------------

def test_a_piece_summary_lists_at_most_a_fixed_number_of_its_sentences():
    from types import SimpleNamespace
    from plaid_agent.igt.job import SENTENCES_LISTED
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client)
    r = runner(job)
    part = [SimpleNamespace(index=i, id=f'x{i}') for i in range(1, 600, 2)]
    r.steps_now = 0
    r.begin_summary('k', 'd1', 'Story', part, False, 'note', [], after_text='edited')
    p = r.unsummed['k']
    assert p['sentences'] == [f's{s.index}' for s in part[:SENTENCES_LISTED]]
    assert p['sentences_more'] == len(part) - SENTENCES_LISTED


# --- REV-JR2-4: as many waits for core in a selection as anywhere ---------------------------------

@pytest.mark.parametrize('pieces', ['sentences', 'selection'])
def test_a_document_core_never_writes_gets_the_same_waits_whatever_the_plan(monkeypatch, pieces):
    from plaid_agent.igt import job as igt_job
    clock = {'t': 1_800_000_000.0}
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, now=lambda: clock['t'], plan=pieces)

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))

    def down(c, ops, **kw):
        raise PlaidAPIError('HTTP 502', status=502, method='POST')
    monkeypatch.setattr(igt_job, 'execute_plan', down)
    r = runner(job)
    r.work(job)
    waits = [m for m in _said(client) if m == 'The server did not answer. Trying again in 10 minutes.']
    assert len(waits) == JOB_DEFER_ROUNDS, (pieces, _said(client))


# --- REV-JR2-8: the chat's six text-edit refusals are byte for byte as before ---------------------

def _chat_ws():
    from plaid_agent.igt.workspace import Workspace
    c = FakeClient()
    return Workspace(c, load_project(c, 'p1'))


@pytest.mark.parametrize('first,then,said', [
    (('delete_sentence', {'document': 'Text 1', 'refs': ['s2']}),
     ('respell', {'document': 'Text 1', 'ref': 's2.w1', 'new_text': 'Gem-ar'}),
     'Error: Text 1 s2.w1: this plan deletes s2, which this would change. Plan one of them, or discard_plan to '
     'start over'),
    (('respell', {'document': 'Text 1', 'ref': 's1.w2', 'new_text': 'gom'}),
     ('split_word', {'document': 'Text 1', 'ref': 's1.w2', 'at': 1}),
     'Error: s1.w2: this plan already respells this word. Plan the split, merge or delete on its own once that is '
     'applied.'),
    (('split_word', {'document': 'Text 1', 'ref': 's1.w2', 'at': 1}),
     ('respell', {'document': 'Text 1', 'ref': 's1.w2', 'new_text': 'gom'}),
     'Error: Text 1 s1.w2: this plan already splits, merges or deletes this word. Plan the respelling on its own '
     'once that is applied.'),
    (('retype_sentence', {'document': 'Text 1', 'ref': 's1', 'text': 'Ali-di gam akuna mo.'}),
     ('respell', {'document': 'Text 1', 'ref': 's2.w1', 'new_text': 'Gem-ar'}),
     'Error: Text 1 s2.w1: a sentence before or at this point is retyped or appended in this plan; respell it in a '
     'separate plan'),
])
def test_the_chats_text_edit_refusals_are_unchanged(first, then, said):
    ws = _chat_ws()
    toolkit.call_tool(ws, *first)
    assert str(toolkit.call_tool(ws, *then)) == said


def test_the_chats_overlap_and_reshape_refusals_are_unchanged():
    from plaid_agent.core.tools import ToolError
    from plaid_agent.igt import bulk, tools
    ws = _chat_ws()
    ws.planned_respells = lambda text_id: [(0, 5)]
    with pytest.raises(ToolError) as e:
        tools.check_respell_overlap(ws, 'tx', 2, 8, 'Text 1 s1.w1')
    assert str(e.value) == ('Text 1 s1.w1: overlaps a respelling already planned for 0-5 in the same text; '
                            'discard_plan or narrow the pattern')
    with pytest.raises(ToolError) as e:
        bulk.clear_of_reshapes([{'kind': 'split_word', 'doc': 'd1'}], ['d1'], 'respelling')
    assert str(e.value) == ('This plan already reshapes text or words in a document this respelling reaches. Let '
                            'the user approve one, then plan the other, or discard_plan and plan this alone.')


# --- REV-JR2-5: no answer to a job's piece names a user, an approval or a card -------------------

CHAT_WORDS = ('user', 'approv', 'card', 'ask again', 'tokenized')


def _no_chat(text):
    return not any(w in str(text).lower() for w in CHAT_WORDS)


def test_a_partial_rule_and_a_rewritten_change_are_told_as_facts_in_a_job():
    from plaid_agent.igt import bulk
    op, unit = {'partial': (500, 900), 'count': 3}, ('value', 'values')
    chat = bulk._partial_note(op, unit, _chat_ws())
    assert chat.endswith('Tell the user so: once they approve this, ask again (the same call) for the rest.')
    assert chat == bulk._partial_note(op, unit)
    job = bulk._partial_note(op, unit, _job_ws())
    assert _no_chat(job) and job.endswith('and the rest are not in the plan.'), job
    assert bulk._rewritten(2, 2, _chat_ws()) == ('2 planned changes rewritten by this one back to the value stored: '
                                                  'approval leaves them as they are.')
    assert bulk._rewritten(2, 1, _job_ws()) == '2 planned changes rewritten by this one, 1 of them back to the value stored.'


def test_a_new_document_in_a_job_is_not_said_to_be_tokenized():
    out = toolkit.job_piece_call(_job_ws(), 'create_document', {'name': 'New', 'text': 'Ali gam. Mo.'})
    assert _no_chat(out), out
    assert 'will be tokenized' in str(toolkit.call_tool(_chat_ws(), 'create_document', {'name': 'New',
                                                                                         'text': 'Ali gam. Mo.'}))


def test_the_lexicon_and_tagset_refusals_name_no_user_in_a_job(monkeypatch):
    from plaid_agent.core.prompt import JOB_LEAVE_IT
    for ws, job in ((_job_ws(), True), (_chat_ws(), False)):
        ws.requester_id = 'w@x.org'
        monkeypatch.setattr(type(ws), 'requester_role', lambda self: 'writer')
        monkeypatch.setattr(type(ws), 'requester_is_admin', lambda self: False)
        rights = ws.lexicon_rights()
        out = (toolkit.job_piece_call if job else toolkit.call_tool)(
            ws, 'tagsets', {'action': 'edit', 'tagset': 'X', 'changes': {}})
        if job:
            assert rights.startswith("The job's starter is a Writer here") and out.endswith(JOB_LEAVE_IT), out
            assert 'Tell them' not in out
        else:
            assert rights.startswith('The user is a Writer here') and out.endswith('Tell them who can.'), out
        v = {'id': 'vx', 'name': 'Lexicon', 'borrowed': True}
        said = ws.lexicon_refusal(v, 'writer')
        assert said.endswith('Tell the user its entries are changed in its own project, by a Writer or Maintainer '
                             'of that project.')


def test_a_restore_beside_other_changes_is_refused_in_a_job_without_a_chat_step():
    ws = _job_ws()
    for staging in (True, False):
        assert _no_chat(ws.exclusive_message(staging)) and 'discard_plan' not in ws.exclusive_message(staging)


# --- REV-JR2-3: a job done with documents core never answered for says so ------------------------

def test_a_document_core_never_answered_for_is_marked_counted_and_said_on_the_top_line(monkeypatch):
    from plaid_agent.core.job import run_job
    from plaid_agent.igt.job import UNANSWERED, state_text
    # Core fails d1's reads through every put-off, then answers again for
    # the job's later passes.
    client, job, r = _two_documents(monkeypatch, JOB_CORE_TRIES * (JOB_DEFER_ROUNDS + 1), from_work=True)
    finished = run_job(job, r)
    assert finished['state'] == 'done'
    d1 = next(d for d in finished['report']['documents'] if d['document_id'] == 'd1')
    assert d1['state'] == 'not-reached' and d1['counts'].get(UNANSWERED) is True
    assert finished['report']['totals']['documents_unanswered'] == 1
    assert finished['report']['notice'] == '1 document was not worked: the server did not answer.'
    assert state_text(d1) == 'not worked: the server did not answer'
    from plaid_agent.igt.job import document_counts
    counts = document_counts(finished['report'])
    assert (counts['unanswered'], counts['not_reached']) == (1, 0), counts


def test_the_unanswered_line_is_said_for_many_and_read_from_cores_own_report():
    from plaid_agent.core.job import notice
    from plaid_agent.igt.jobread import notice_counts
    assert notice({'documents_unanswered': 2}) == '2 documents were not worked: the server did not answer.'
    report = {'totals': {}, 'documents': [{'state': 'not-reached', 'counts': {'unanswered': True}},
                                          {'state': 'done', 'counts': {}}]}
    assert notice_counts(report)['documents_unanswered'] == 1
