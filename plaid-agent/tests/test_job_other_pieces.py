"""A piece's project-wide op that writes in a later piece's sentences closes
none of them (BRIEF NW, 2026-11-14). Observed on a real model: a stretch's
``set_analysis_for_form`` wrote a word or two in nearly every sentence of the
document, every such sentence then read as finished, their own pieces never
ran, and the report neither counted nor listed the words left blank there.

The rule (the piece key, CONTRACT "Added by JH-FIX" and "Added by RX"): a
sentence is closed to a piece only by that piece's own landed write in it as
one of its own sentences. The sentence's own piece still gets it, sees what
is analysed there, and works the rest. A word or a translation any landed
write of the job wrote is never a target again, in any sentence: one a
person cleared is never written again (REV-LNW-1). And the report's Left
blank is read from the document as it is at the end: every word with no
analysis in a sentence the job worked, but those the job wrote.

The fake applies each set_analysis it is sent to the document its reads
answer next, so each piece reads what the pieces before it wrote. The bulk
tool's query runs on the session's core (``live.answer``)."""

import re

import pytest

from job_fixtures import every_tool, JobClient, Model, call, document, keep_plan, reply, runner, start, targets_named, use
from test_job_left_all import adds_up

from plaid_agent.core.job import analysis_key, canonical, run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import PLAN_FORM


@pytest.fixture(autouse=True)
def _every_tool(monkeypatch):
    """These tests script tools a piece of a plan in sentences is no longer offered."""
    every_tool(monkeypatch)


J = 'JNW'
SENTENCES = [['ka', 'mi'], ['pa', 'ni'], ['ka', 'sa'], ['mo', 'lu']]


def _doc(analysed, version=1):
    """The document with the words ``analysed`` (ids) analysed by the job."""
    out = []
    for si, words in enumerate(SENTENCES, start=1):
        out.append({'words': [(w, [(w, 'g')], J) if f'd1-s{si}w{wi}' in analysed else w
                              for wi, w in enumerate(words, start=1)]})
    return document('d1', 'Story', out, version=version)


def _applying(monkeypatch, client):
    """Each write's set_analysis ops applied to what the reads answer next."""
    analysed, real = set(), igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        analysed.update(o['word_id'] for o in ops if o.get('kind') == 'set_analysis')
        client.after_write['d1'] = _doc(analysed, version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return analysed


def _keep_plan(client, pieces, every):
    if not every:
        keep_plan(client, J, pieces)
        return
    text = canonical({'pieces': pieces, 'piece_instructions': '', 'documents': None, 'by': 'model', 'why': None,
                      'every_sentence': True})
    client.jobs.add_decisions(J, 'worker-1', [{'form': PLAN_FORM, 'key': analysis_key(text), 'analysis': text,
                                               'count': 1, 'document_id': None, 'sentence_id': None}])


def _bulk_then_each(asked, n, kwargs):
    """The piece of s1 and s2 glosses ka everywhere with the bulk tool (s1.w1
    and s3.w1) and the rest of its own words. A piece of s3 glosses sa, one
    of s4 glosses mo and leaves lu."""
    if n > 1 or 'Your piece: s' not in asked:
        return reply('Done.')
    mine = targets_named(asked)
    calls = []
    if 1 in mine:
        calls.append(call(1, 'set_analysis_for_form', {'form': 'ka', 'document': 'Story', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'g'}}]}))
        calls += [call(2 + i, 'set_analysis', {'document': 'Story', 'ref': ref, 'morphemes': [
            {'form': form, 'fields': {'Morph Gloss': 'g'}}]})
            for i, (ref, form) in enumerate([('s1.w2', 'mi'), ('s2.w1', 'pa'), ('s2.w2', 'ni')])]
    if 3 in mine:
        calls.append(call(10, 'set_analysis', {'document': 'Story', 'ref': 's3.w2', 'morphemes': [
            {'form': 'sa', 'fields': {'Morph Gloss': 'g'}}]}))
    if 4 in mine:
        calls.append(call(11, 'set_analysis', {'document': 'Story', 'ref': 's4.w1', 'morphemes': [
            {'form': 'mo', 'fields': {'Morph Gloss': 'g'}}]}))
    return reply(calls=calls)


def _asked(model):
    return [targets_named(c['asked']) for c in model.calls if c['n'] == 1 and 'Your piece: s' in c['asked']]


@pytest.mark.parametrize('every', [False, True], ids=['blank-sentences', 'every-sentence'])
def test_a_bulk_op_of_one_piece_closes_no_sentence_of_another(monkeypatch, every):
    """Piece s1-s2 glosses ka in s1 and s3 with set_analysis_for_form. The
    piece of s3 and s4 still runs over s3, sees ka analysed, glosses sa, and
    every word is analysed or listed: 7 analysed and lu left, 8 words."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J, plan=None)
    _keep_plan(client, 'sentences', every)
    analysed = _applying(monkeypatch, client)
    model = use(monkeypatch, Model(_bulk_then_each))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _asked(model) == [[1, 2], [3, 4]], 'the piece of s3 runs over s3'
    assert 'd1-s3w1' in analysed and 'd1-s3w2' in analysed
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s4.w2']
    assert doc['counts']['words'] == 7 and doc['counts']['left'] == 1
    adds_up(doc, sum(len(s) for s in SENTENCES))
    assert doc['done'] == doc['targets'] == 4


def _first_words(asked, n, kwargs):
    """Glosses the first word of each sentence of its piece."""
    if n > 1 or 'Your piece: s' not in asked:
        return reply('Done.')
    return reply(calls=[call(k, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w1', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for k, s in enumerate(targets_named(asked), 1)])


def test_left_blank_is_what_the_document_holds_blank_at_the_end(monkeypatch):
    """Left blank is read from the document as the report is written. pata,
    which the model left and a person analysed during the job, is not
    listed. ka in s2, which the job glossed and a person cleared, is counted
    as written and not listed (REV-LNW-4): analysed plus left counts each
    word once. ta and sa, which nobody staged anything for, are listed."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'pata']}, {'words': ['ka', 'ta', 'sa']}])})
    mine = ('ka', [('ka', 'g')], J)
    theirs = ('pata', [('pata', 'p')], 'human')
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine, theirs]}, {'words': ['ka', 'ta', 'sa']}],
                                        version=2)
    job = start(client, id=J)
    use(monkeypatch, Model(_first_words))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s2.w2', 's2.w3']
    assert doc['counts']['left'] == 2 and doc['left_more'] == 0 and doc['counts']['words'] == 2


def test_the_left_count_is_the_whole_list_when_the_list_is_cut(monkeypatch):
    from plaid_agent.core import job as core_job
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'pata', 'mo']}, {'words': ['ka', 'ta']}])})
    mine = ('ka', [('ka', 'g')], J)
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine, 'pata', 'mo']}, {'words': [mine, 'ta']}],
                                        version=2)
    job = start(client, id=J)
    use(monkeypatch, Model(_first_words))
    real = core_job.cut
    monkeypatch.setattr(core_job, 'cut', lambda items, limit=None: real(items, 2))
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s1.w2', 's1.w3'] and doc['left_more'] == 1
    assert doc['counts']['left'] == 3 == len(doc['left']) + doc['left_more']


def _empty_named(asked, n, kwargs):
    """A stretch over all four sentences reads for ever (it is halved). A
    piece glosses ka everywhere when s1.w1 is empty in it, and each other
    word its message names as empty, lu aside."""
    if 'Your piece: s' not in asked:
        return reply('Done.')
    if len(targets_named(asked)) == 4:
        return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])
    if n > 1:
        return reply('Done.')
    calls = []
    for s, words in re.findall(r'^Empty in s(\d+): words (.*?)(?: and the translation)?\.$', asked, re.M):
        for i, form in re.findall(r'w(\d+) "([^"]+)"', words):
            if (s, form) == ('1', 'ka'):
                calls.append(call(len(calls) + 1, 'set_analysis_for_form', {
                    'form': 'ka', 'document': 'Story', 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'g'}}]}))
            elif form != 'lu':
                calls.append(call(len(calls) + 1, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{i}',
                                                                   'morphemes': [{'form': form,
                                                                                  'fields': {'Morph Gloss': 'g'}}]}))
    return reply(calls=calls)


def test_the_second_half_of_a_halved_stretch_keeps_its_sentence_the_first_half_wrote_in(monkeypatch):
    """As observed: s1 to s4 fail as one stretch and are halved. The first
    half glosses ka everywhere, s3.w1 too. The second half is still handed
    s3 with sa empty in it, writes there as one of its own sentences, and
    sa is glossed."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 4)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J)
    analysed = _applying(monkeypatch, client)
    model = use(monkeypatch, Model(_empty_named))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert sorted({tuple(x) for x in _asked(model)}) == [(1, 2), (1, 2, 3, 4), (3, 4)]
    assert 'd1-s3w2' in analysed, 'sa glossed by the second half'
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s4.w2']
    adds_up(doc, sum(len(s) for s in SENTENCES))


# --- a word the job wrote and a person cleared is never written again (REV-LNW-1) ---------------

def _stage_named(asked, n, kwargs, also=()):
    """The piece of s1 is _bulk_then_each's. Any other piece glosses every
    word its message names as empty, and stages ``also`` besides."""
    if n > 1 or 'Your piece: s' not in asked:
        return reply('Done.')
    if 1 in targets_named(asked):
        return _bulk_then_each(asked, n, kwargs)
    calls = list(also)
    for s, words in re.findall(r'^Empty in s(\d+): words (.*?)(?: and the translation)?\.$', asked, re.M):
        for i, form in re.findall(r'w(\d+) "([^"]+)"', words):
            calls.append(call(len(calls) + 20, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{i}', 'morphemes': [
                {'form': form, 'fields': {'Morph Gloss': 'g'}}]}))
    return reply(calls=calls)


def _clearing(monkeypatch, client, cleared):
    """Each write's set_analysis applied to what the reads answer next, and
    the starter clearing ``cleared`` (word ids) right after the first. The
    words each write sent."""
    analysed, real, writes = set(), igt_job.execute_plan, []

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        writes.append([o['word_id'] for o in ops if o.get('kind') == 'set_analysis'])
        analysed.update(writes[-1])
        if len(writes) == 1:
            analysed.difference_update(cleared)
        client.after_write['d1'] = _doc(analysed, version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return writes


@pytest.mark.parametrize('blind', [False, True], ids=['as-told', 'staged-anyway'])
def test_a_word_the_bulk_op_wrote_and_a_person_cleared_is_not_written_again(monkeypatch, blind):
    """The reviewer's probe (REV-LAND-NW): piece s1-s2 glosses ka in s1 and
    s3 with set_analysis_for_form, the starter clears ka in s3 at once. The
    piece of s3 and s4 is not told s3.w1 is empty and never writes it
    (staged anyway, it is left out and counted as changed during the job),
    and it glosses the rest of s3. ka in s3 is counted as written, not as
    left: 8 words, 8 analysed, nothing left."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J)
    writes = _clearing(monkeypatch, client, {'d1-s3w1'})
    again = [call(19, 'set_analysis', {'document': 'Story', 'ref': 's3.w1', 'morphemes': [
        {'form': 'ka', 'fields': {'Morph Gloss': 'g'}}]})] if blind else []
    model = use(monkeypatch, Model(lambda a, n, k: _stage_named(a, n, k, again)))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _asked(model) == [[1, 2], [3, 4]]
    assert 'd1-s3w1' in writes[0], 'the bulk op wrote ka in s3'
    later = [w for ws in writes[1:] for w in ws]
    assert 'd1-s3w1' not in later, 'ka in s3, cleared by a person, is never written again'
    assert {'d1-s3w2', 'd1-s4w1', 'd1-s4w2'} <= set(later), 'the rest of s3 and s4 is worked'
    (doc,) = finished['report']['documents']
    second = next(c['asked'] for c in model.calls if c['n'] == 1 and targets_named(c['asked']) == [3, 4])
    assert re.findall(r'^Empty in s3: words (.*?)(?: and the translation)?\.$', second, re.M) == ['w2 "sa"']
    assert doc['left'] == [] and doc['counts']['left'] == 0 and doc['counts']['words'] == 8
    adds_up(doc, sum(len(s) for s in SENTENCES))
    assert doc['counts'].get('changed', 0) == (1 if blind else 0)


def test_a_translation_the_job_wrote_and_a_person_cleared_is_not_written_again(monkeypatch):
    """Piece s1-s2 also translates s3 (the bulk of its instructions), the
    starter clears it. The piece of s3 and s4 is not told s3's translation
    is empty, and when it writes one anyway it is left out."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    sentences = [{'words': [w]} for w in ('ka', 'pa', 'sa', 'mo')]
    client = JobClient({'d1': document('d1', 'Story', sentences)})
    job = start(client, 'Translate the empty translations.', id=J)
    real, sent, translated = igt_job.execute_plan, [], set()

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        sent.append([o.get('token_id') for o in ops if o.get('kind') == 'set_span'])
        translated.update(sent[-1])
        if len(sent) == 1:
            translated.discard('d1-s3')
        client.after_write['d1'] = document('d1', 'Story', [
            {**x, **({'translation': ('T.', J)} if f'd1-s{i}' in translated else {})}
            for i, x in enumerate(sentences, start=1)], version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    told = []

    def model(asked, n, kwargs):
        if n > 1 or 'Your piece: s' not in asked:
            return reply('Done.')
        mine = targets_named(asked)
        told.append(re.findall(r'^Empty in s(\d+): .*the translation\.$', asked, re.M))
        refs = ['s1', 's2', 's3'] if 1 in mine else ['s3', 's4']
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': refs, 'field': 'Translation',
                                                  'value': 'T.'})])
    use(monkeypatch, Model(model))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert told == [['1', '2'], ['4']], told
    assert 'd1-s3' in sent[0] and all('d1-s3' not in x for x in sent[1:]), sent
    (doc,) = finished['report']['documents']
    assert doc['counts']['changed'] == 1 and doc['left'] == []


def test_a_document_unreadable_at_the_report_says_so_and_counts_no_left(monkeypatch):
    """REV-LNW-2: the document cannot be read as the report is written. Its
    counts hold no left at all (never 0), the document says Left blank
    could not be read, and so does the final context."""
    from plaid_agent.core import job as core_job
    from plaid_agent.igt.job import summary_message
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'pata']}])})
    client.after_write['d1'] = document('d1', 'Story', [{'words': [('ka', [('ka', 'g')], J), 'pata']}], version=2)
    job = start(client, id=J)
    use(monkeypatch, Model(_first_words))
    real_left = igt_job.IgtRunner.left_blank

    def left_blank(self, job):
        def read(*a, **kw):
            raise RuntimeError('core answered 503 for good')
        self.read = read
        return real_left(self, job)
    monkeypatch.setattr(igt_job.IgtRunner, 'left_blank', left_blank)
    monkeypatch.setattr(core_job, 'through_core', lambda job, f, **kw: f())
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert 'left' not in doc['counts'] and 'left_translations' not in doc['counts'], doc['counts']
    assert doc['left_unread'] is True and doc['left'] == []
    assert 'Left blank could not be read' in summary_message(finished['report'])


@pytest.mark.parametrize('writes_s4', [True, False], ids=['wrote-in-the-rest', 'left-the-rest'])
def test_a_selection_that_read_part_of_a_document_and_wrote_in_the_rest_read_it(monkeypatch, writes_s4):
    """REV-LNW-3: the selection reads s1 to s3 and glosses them, and s4.w1
    too (a sentence it was never shown). s4 is not its own, so the walk
    works it, but the plan does not say the selection did not read the
    document. Had it written nothing in s4, it would."""
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J, plan='selection')
    _applying(monkeypatch, client)

    def model(asked, n, kwargs):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story', 'from_sentence': 1,
                                                              'to_sentence': 3})])
            if n > 2:
                return reply('Done.')
            refs = [f's{s}.w{w}' for s in (1, 2, 3) for w in (1, 2)] + (['s4.w1'] if writes_s4 else [])
            return reply(calls=[call(k, 'set_analysis', {'document': 'Story', 'ref': r, 'morphemes': [
                {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for k, r in enumerate(refs, start=2)])
        return reply('Done.')
    use(monkeypatch, Model(model))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    fallback = [f['reason'] for f in finished['report']['plan']['fallback'] if f['document_id'] == 'd1']
    assert fallback == ([] if writes_s4 else ['not-read']), fallback
