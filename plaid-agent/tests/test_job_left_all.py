"""Left blank covers every sentence the job was to work (BRIEF NW round 3):
a piece that ran and staged nothing leaves its blank words listed and
counted, a sentence the job never reached is counted apart as not reached,
and what the job analysed, left blank, skipped and did not reach adds up to
the words of the sentences it was to work. A document's row in core never
says left 0 for words it has not counted: its counts carry no left, the
report does."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JLA'
N = 6
WORDS = 2 * N


def _doc(analysed, version=1):
    return document('d1', 'Story', [{'words': [(w, [(w, 'g')], J) if f'd1-s{i}w{k}' in analysed else w
                                               for k, w in enumerate([f'ka{i}', f'ta{i}'], start=1)]}
                                    for i in range(1, N + 1)], version=version)


def _applying(monkeypatch, client, after=None):
    analysed, real = set(), igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        analysed.update(o['word_id'] for o in ops if o.get('kind') == 'set_analysis')
        client.after_write['d1'] = _doc(analysed, version=len(client.writes) + 1)
        if after:
            after()
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


def _first_piece_only(asked, n, kwargs):
    """Stages both words of each sentence of the first piece, and nothing
    on any other piece ("Done.")."""
    if n > 1 or 'Your piece: s' not in asked:
        return reply('Done.')
    mine = targets_named(asked)
    if 1 not in mine:
        return reply('Done.')
    return reply(calls=[call(10 * s + w, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{w}', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for s in mine for w in (1, 2)])


def adds_up(doc, words_to_work, skipped_words=0):
    """THE totals check: analysed, left, untouched (in sentences it worked
    and wrote nothing in, RPF-A9), skipped and not reached are the words of
    the sentences the job was to work, each once."""
    c = doc['counts']
    assert c['words'] + c['left'] + (c.get('untouched') or 0) + skipped_words + (c.get('not_reached') or 0) \
        == words_to_work, c


# Not 'selection': after its piece nothing more is worked (SF round 2), so
# the walk this counts never follows it.
@pytest.mark.parametrize('plan', ['sentences', 'document'])
def test_a_piece_that_staged_nothing_counts_its_words_untouched_and_the_row_claims_no_left(monkeypatch, plan):
    """Pieces s3-s4 and s5-s6 answer "Done." with nothing staged: their
    eight words are counted as blank in sentences the job wrote nothing in,
    never listed as Left blank, which lists only what is blank where the job
    wrote (RPF-A9: the instructions may have told it to leave them). The
    document's row in core carries no left (it was left 0, which said
    nothing was left)."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J, plan=plan)
    _applying(monkeypatch, client)
    use(monkeypatch, Model(_first_piece_only))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 4 and doc['counts']['left'] == 0, doc['counts']
    assert doc['counts']['untouched'] == WORDS - 4 and doc['left'] == [] and not doc['counts'].get('not_reached')
    seg = next(b for b in doc['counts']['blank'] if b['target'] == 'segmentation')
    assert seg['untouched'] == WORDS - 4 and seg['left'] == 0, seg
    adds_up(doc, WORDS)
    row = client.jobs.get(J)['documents'][0]['counts']
    assert 'left' not in row and 'left_translations' not in row, row


def test_a_stopped_job_counts_the_sentences_it_did_not_reach_apart(monkeypatch):
    """The job is cancelled once the first piece's write landed. s3 to s6
    were never reached: their words are counted as not reached, never as
    left blank."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J)
    _applying(monkeypatch, client, after=lambda: client.jobs.cancel(J))
    use(monkeypatch, Model(_first_piece_only))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled'
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 4 and doc['counts']['left'] == 0 and doc['left'] == []
    assert doc['counts']['not_reached'] == WORDS - 4, doc['counts']
    adds_up(doc, WORDS)


def test_a_document_the_job_never_reached_counts_its_blanks_as_not_reached(monkeypatch):
    """REV-DF-S-3: cancelled after the first piece of Story, Tale (three
    blank words) was never reached. Its blanks are read at the end and
    counted as not reached, in its row and in the totals, never listed and
    never left. A document the plan left out is not read."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    tale = document('d2', 'Tale', [{'words': ['mo', 'ri']}, {'words': ['su']}])
    client = JobClient({'d1': _doc(set()), 'd2': tale})
    job = start(client, id=J)
    _applying(monkeypatch, client, after=lambda: client.jobs.cancel(J))
    use(monkeypatch, Model(_first_piece_only))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled'
    story, never = finished['report']['documents']
    assert never['state'] == 'not-reached' and never['done'] in (0, None) and never['left'] == []
    assert never['counts']['not_reached'] == 3, never['counts']
    seg = next(b for b in finished['report']['totals']['blank'] if b['target'] == 'segmentation')
    assert seg['not_reached'] == WORDS - 4 + 3 and seg['left'] == 0, seg


def test_a_document_the_plan_left_out_is_not_read_for_its_blanks(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    from job_fixtures import keep_plan
    tale = document('d2', 'Tale', [{'words': ['mo', 'ri']}])
    client = JobClient({'d1': _doc(set()), 'd2': tale})
    job = start(client, id=J, plan=None)
    keep_plan(client, J, 'sentences', documents=[0])
    _applying(monkeypatch, client)
    use(monkeypatch, Model(_first_piece_only))
    finished = run_job(job, runner(job))
    assert [d['document_id'] for d in finished['report']['plan']['left_out']] == ['d2']
    tale_doc = finished['report']['documents'][1]
    assert 'blank' not in tale_doc['counts'] and not tale_doc['counts'].get('not_reached'), tale_doc


def test_a_skipped_sentence_is_neither_left_nor_not_reached(monkeypatch):
    """s3's piece fails every time (halved to s3 alone, then skipped): its
    words are under Skipped, not Left blank, and the totals add up with
    them."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J)
    _applying(monkeypatch, client)

    def model(asked, n, kwargs):
        if 'Your piece: s' in asked and 3 in targets_named(asked):
            return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])
        return _first_piece_only(asked, n, kwargs)
    use(monkeypatch, Model(model))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    assert [s['sentence'] for s in doc['skipped']] == ['s3']
    assert not any(e['sentence_id'] == 'd1-s3' for e in doc['left'])
    assert doc['counts']['left'] == 0 and doc['counts']['untouched'] == WORDS - 4 - 2
    adds_up(doc, WORDS, skipped_words=2)
