"""The piece after a text edit, and a respelled word (RPF3-B, RP2-2).

A piece whose landed write changed the text of sentences is followed ONCE by
a piece over those sentences as the edit left them, told what is empty there
of what the job fills, offered no text tool. A following piece is followed
by none, and none runs when nothing is empty there. A word a write respelled
keeps its analysis, whose morpheme forms still spell the old word (core's
one rule, as for a person's edit): the report lists it for a person to
check, and re-segments nothing."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JAT'
BEFORE = [{'words': [('sa', [('sa', 'one')], 'human'), ('jut', [('jut', 'thing')], 'human')]},
          {'words': [('kvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}]
AFTER = [{'words': [('sa', [('sa', 'one')], 'human'), 'xosan', ('jut', [('jut', 'thing')], 'human')]},
         {'words': [('kIvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}]


def _job(monkeypatch, answer, after=AFTER):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', BEFORE)})
    job = start(client, 'Insert xosan in s1, respell kvalaxar as kIvalaxar, and segment and gloss the new word.',
                id=J, plan='document')
    sent = []

    def execute(c, ops, **kw):
        # The fake has no text server: the edits are taken as written. The
        # added word keeps no id of an old one: jut's moves to w3.
        sent.append([o['kind'] for o in ops])
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', after, version=len(sent) + 1)
            if after is AFTER:
                words = raw['text_layers'][0]['token_layers'][1]['tokens']
                words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
                for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                    m['id'] = m['id'].replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    model = use(monkeypatch, Model(answer))
    return client, job, model, sent


def _editing(asked, n, kwargs):
    if 'Instructions from' not in asked:
        return reply('Done.')
    if igt_job.AFTER_TEXT_LINE in asked:
        if n == 1:
            return reply(calls=[call(9, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "xosan"', 'morphemes': [
                {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Glossed xosan.')
    if n == 1:
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'sa xosan jut.'}),
                            call(2, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'kIvalaxar.'})])
    return reply('Inserted xosan and respelled kvalaxar.')


def test_the_sentences_a_text_edit_changed_are_taken_once_more_with_no_text_tool(monkeypatch):
    client, job, model, sent = _job(monkeypatch, _editing)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    after = [c for c in model.calls if igt_job.AFTER_TEXT_LINE in c['asked'] and c['n'] == 1]
    assert len(after) == 1, 'once, never a loop'
    offered = {t['function']['name'] for t in after[0]['kwargs'].get('tools') or []}
    assert 'retype_sentence' not in offered and 'set_analysis' in offered
    asked = after[0]['asked']
    assert 'Your piece: s1, s2.' in asked and 'xosan' in asked, asked
    assert sent == [['edit_text'], ['edit_text'], ['set_analysis']], 'a try per edit, then the analysis'
    rows = [p['piece'] for p in client.jobs.pieces(J) if p['piece'].get('document')]
    assert sorted(r.get('after_text') or '' for r in rows) == ['', 'edited'], rows


def test_a_respelled_word_that_kept_its_analysis_is_listed_for_a_person_to_check(monkeypatch):
    _client, job, _model, _sent = _job(monkeypatch, _editing)
    finished = run_job(job, runner(job))
    report = finished['report']
    assert report['respelled'] == [{'document_id': 'd1', 'name': 'Story', 'sentence_id': 'd1-s2', 'sentence': 's2',
                                    'ref': 's2.w1', 'form': 'kIvalaxar', 'old': 'kvalaxar',
                                    'morphemes': ['kvalax', 'ar']}], report.get('respelled')
    message = igt_job.summary_message(report)
    assert '"Story" s2.w1 kvalaxar to kIvalaxar' in message


def test_no_piece_follows_when_nothing_is_empty_in_the_sentences_the_edit_changed(monkeypatch):
    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n == 1:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2',
                                                            'text': 'kIvalaxar.'})])
        return reply('Respelled.')
    _client, job, model, _sent = _job(monkeypatch, answer, after=[BEFORE[0], AFTER[1]])
    finished = run_job(job, runner(job))
    assert len(finished['report']['respelled']) == 1
    assert not [c for c in model.calls if igt_job.AFTER_TEXT_LINE in c['asked']]


def test_a_word_left_unsegmented_is_said_beside_the_morpheme_fields_blanks(monkeypatch):
    """RP2-2 finding 3: "Gloss left blank 0 morphemes" beside a word Left
    blank lists for segmentation and Gloss. Such a word is counted once, as a
    word, under segmentation, and said beside Gloss's morphemes."""
    from plaid_agent.core.job import blank_text
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    job = start(client, 'Segment and gloss every word.', id=J, plan='document')

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Glossed ka, left ta.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
    use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    blank = {b['target']: b for b in report['totals']['blank']}
    assert (blank['segmentation']['left'], blank['Morph Gloss']['left']) == (1, 0), blank
    assert blank['Morph Gloss']['unsegmented'] == 1, blank
    assert 'Morph Gloss left blank 0 morphemes and 1 word not segmented' in blank_text(report['totals']['blank'])


def test_a_change_to_a_filled_value_in_a_retyped_sentence_is_listed_and_promises_nothing(monkeypatch):
    """REV-RPF3-1 (the reviewer's b1): the piece respells kvalaxar in s2 and
    changes its morpheme ar's gloss from PL to PLURAL, a filled value, which
    no piece after the text edit takes up. Refused as retyped, listed with its
    sentence, and the model is not told a piece follows."""
    from plaid_agent.core.prompt import JOB_LEAVE_IT, JOB_TEXT_THEN_FILL

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply('Nothing to fill.')
        if n == 1:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'kIvalaxar.'}),
                                call(2, 'set_analysis', {'document': 'Story', 'ref': 's2.w1', 'morphemes': [
                                    {'form': 'kvalax', 'fields': {'Morph Gloss': 'work'}},
                                    {'form': 'ar', 'fields': {'Morph Gloss': 'PLURAL'}}]})])
        return reply('Respelled kvalaxar.')
    _client, job, model, _sent = _job(monkeypatch, answer, after=[BEFORE[0], AFTER[1]])
    finished = run_job(job, runner(job))
    told = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    refusal = next(t for t in told if t.startswith('Error'))
    assert JOB_LEAVE_IT in refusal and JOB_TEXT_THEN_FILL not in refusal, refusal
    (doc,) = finished['report']['documents']
    assert [(r['code'], r['sentence']) for r in doc['refused']] == [('retyped', 's2')], doc.get('refused')


def test_what_the_piece_after_the_text_edit_leaves_empty_is_in_left_blank(monkeypatch):
    """The refusal of xosan's analysis is not listed, as the piece after the
    text edit takes it up. That piece writes nothing: xosan is in Left blank
    (REV-RPF3-1)."""
    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply('Left it.')
        if n == 1:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'sa xosan jut.'}),
                                call(2, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "xosan"', 'morphemes': [
                                    {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Inserted xosan.')
    _client, job, _model, _sent = _job(monkeypatch, answer, after=[AFTER[0], BEFORE[1]])
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert not doc.get('refused'), doc.get('refused')
    assert [e['form'] for e in doc['left']] == ['xosan'], doc['left']


def _inserting(asked, n, kwargs):
    if 'Instructions from' not in asked:
        return reply('Done.')
    if igt_job.AFTER_TEXT_LINE in asked:
        if n == 1:
            return reply(calls=[call(9, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "xosan"', 'morphemes': [
                {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Glossed xosan.')
    if n == 1:
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'sa xosan jut.'})])
    return reply('Inserted xosan.')


def test_a_piece_after_a_text_edit_put_off_is_taken_again_once_and_never_shown_beside_no_changes(monkeypatch):
    """REV-RPF3-5 (the reviewer's b2a): the write of the piece after the text
    edit meets a person's edit, twice. It goes back to be taken at the start
    of the walk once; put off again, it is left. No row shows its note beside
    no changes, and xosan is in Left blank."""
    from plaid_agent.core.plan import PlanError
    from plaid_client import PlaidAPIError
    client, job, model, sent = _job(monkeypatch, _inserting, after=[AFTER[0], BEFORE[1]])
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if any(o['kind'] == 'set_analysis' for o in ops):
            try:
                raise PlaidAPIError('HTTP 409 version', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    after = [c for c in model.calls if igt_job.AFTER_TEXT_LINE in c['asked'] and c['n'] == 1]
    assert len(after) == 2, 'taken again once'
    rows = [p['piece'] for p in client.jobs.pieces(J)]
    assert not [r for r in rows if r.get('after_text') and r.get('note')], rows
    (doc,) = finished['report']['documents']
    assert [e['form'] for e in doc['left']] == ['xosan'], doc['left']


def test_a_piece_after_a_text_edit_whose_model_fails_is_skipped_failed_on_a_row(monkeypatch):
    """REV-RPF3-5 (b2b): its model fails. Its sentence is skipped "failed" and
    it has a row of its own, as a stretch's failure has."""
    from plaid_agent.core.job import StretchFailed

    def answer(asked, n, kwargs):
        if 'Instructions from' in asked and igt_job.AFTER_TEXT_LINE in asked:
            raise StretchFailed('output', 'the model failed')
        return _inserting(asked, n, kwargs)
    client, job, _model, _sent = _job(monkeypatch, answer, after=[AFTER[0], BEFORE[1]])
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert [(s['sentence'], s['reason'], s['kind']) for s in doc['skipped']] == [('s1', 'failed', 'output')]
    rows = [p['piece'] for p in client.jobs.pieces(J) if p['piece'].get('after_text')]
    assert len(rows) == 1 and rows[0].get('skipped'), rows


def test_a_piece_after_a_text_edit_waits_while_a_person_edits_the_document(monkeypatch):
    """REV-RPF3-8: the same in-use check a stretch makes. A person edits the
    document as the text edit lands: the piece after it is not run then; the
    document is put off and the piece runs when the walk takes it again."""
    client, job, model, _sent = _job(monkeypatch, _inserting, after=[AFTER[0], BEFORE[1]])
    r = runner(job)
    calls = {'n': 0}
    real = type(r).in_use

    def in_use(self, last, ref):
        calls['n'] += 1
        return calls['n'] == 2 or real(self, last, ref)
    monkeypatch.setattr(type(r), 'in_use', in_use)
    finished = run_job(job, r)
    assert finished['state'] == 'done', finished.get('reason')
    after = [c for c in model.calls if igt_job.AFTER_TEXT_LINE in c['asked'] and c['n'] == 1]
    assert len(after) == 1, 'run once, after the wait'
    assert finished['report']['documents'][0]['left'] == []



def test_the_progress_line_numbers_a_piece_as_the_work_list_does(monkeypatch):
    """RP4-5 F4: the line said "sentences 1 to 5 of 15" for the piece the work
    list named "s3 to s7". One numbering: the sentences' own, of the
    document's sentences."""
    from job_fixtures import Model, document, reply, runner, start, use, JobClient
    from plaid_agent.core.job import run_job
    sents = [{'words': [('ka', [('ka', 'go')], 'human')]}] * 2 + [{'words': ['sa']}] * 5
    client = JobClient({'d1': document('d1', 'Story', sents), 'd2': document('d2', 'Other', [{'words': ['ta']}])})
    job = start(client, 'Gloss what is empty.', id='JPN', only_empty=True)
    lines = []

    def answer(asked, n, kwargs):
        if n == 1 and '"Story"' in asked:
            lines.append(job.status.get('message'))
        return reply('Nothing.')
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    assert lines == ['Story: sentences 3 to 7 of 7.'], lines
