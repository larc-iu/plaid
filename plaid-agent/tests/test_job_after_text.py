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
