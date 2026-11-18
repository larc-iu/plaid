"""STRESS S5-3, option (b) (REV-SJ2-10): a person merges into the sentence
the job last wrote in the words of a sentence it had not reached. The walk
leaves that sentence (REV-B4-1: a sentence holding a word the job wrote is
never a target again), so those words are never worked. The report says so:
they count as blank where the job did not reach, never listed as Left blank,
and the document's row does not count that sentence done."""

from job_fixtures import document, runner
from plaid_agent.core.job import run_job
from test_job_reshape import _after_record, _job, _person_leaves, mine, reshaped


def test_words_merged_into_a_sentence_the_job_wrote_in_count_as_not_reached(monkeypatch):
    client, job, clock = _job(monkeypatch, [{'words': ['ka']}, {'words': ['rua', 'pele']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka')]}, {'words': ['rua', 'pele']},
                                                         {'words': ['sa']}], version=2)
    # s2's words (they keep their ids) merged into s1, s2's id gone.
    merged = reshaped(document('d1', 'Story', [{'words': [mine('ka'), 'rua', 'pele']}, {'words': ['sa']}],
                               version=3),
                      {'d1-s1w2': 'd1-s2w1', 'd1-s1w3': 'd1-s2w2', 'd1-s2w1': 'd1-s3w1', 'd1-s2': 'd1-s3'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, merged, clock))
    finished = run_job(job, runner(job))
    (d,) = finished['report']['documents']
    left = [e['ref'] for e in d.get('left') or []]
    assert not [r for r in left if r.startswith('s1.w2') or r.startswith('s1.w3')], left
    seg = next(b for b in d['counts']['blank'] if b['target'] == 'segmentation')
    assert seg['not_reached'] == 2, seg
    assert d['done'] < d['targets'], d



def _retyping_job(monkeypatch, before, ref, text, retyped, after_text_answers):
    """A whole-document job (Morph Gloss) whose piece retypes ``ref`` to
    ``text`` (core then holds ``retyped``, its added word ``d1-zz``), and
    whose piece after the text edit answers ``after_text_answers``."""
    from fixtures import MGLOSS
    from job_fixtures import JobClient, Model, call, reply, start, text_edits, use
    from plaid_agent.igt import job as igt_job
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', before)})
    job = start(client, 'Insert zz.', id='JRM', plan='document', edits_text=True, fills=(MGLOSS,))
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if any(o['kind'] == 'edit_text' for o in ops):
            # The fake applies no text edit: core now holds ``retyped``.
            client._holder('d1')['documents']['d1'] = retyped
            client.after_write['d1'] = retyped
            return {}
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply(after_text_answers)
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': ref, 'text': text})])
    use(monkeypatch, Model(answer))
    return client, job


def _merged_before_the_report(monkeypatch, client, r, merged):
    """A person's merge lands once the job has finished its work, before the
    report reads the documents (the walk never takes the sentence again)."""
    real = r.left_blank

    def left_blank(job):
        client._holder('d1')['documents']['d1'] = merged
        client.after_write['d1'] = merged
        return real(job)
    monkeypatch.setattr(r, 'left_blank', left_blank)


def _ided(raw, ids):
    """``raw`` with the word ids of its sentences' words given in order."""
    words = sorted(raw['text_layers'][0]['token_layers'][1]['tokens'], key=lambda t: t['begin'])
    for w, i in zip(words, ids):
        w['id'] = i
    return raw


def test_the_job_retypes_a_sentence_then_a_person_merges_words_into_it(monkeypatch):
    """REV-SJ2-R2-2, one order: the job retypes s1 (adding zz), then a
    person merges in words no write of the job named. Theirs are not
    reached and s1 is not counted done, though the job edited s1's text."""
    retyped = _ided(document('d1', 'Story', [{'words': ['ka', 'zz', 'ta']}], version=2),
                    ['d1-s1w1', 'd1-zz', 'd1-s1w2'])
    client, job = _retyping_job(monkeypatch, [{'words': ['ka', 'ta']}], 's1', 'ka zz ta.', retyped, 'Done.')
    r = runner(job)
    merged = _ided(document('d1', 'Story', [{'words': ['ka', 'zz', 'ta', 'rua', 'pele']}], version=3),
                   ['d1-s1w1', 'd1-zz', 'd1-s1w2', 'd1-p1', 'd1-p2'])
    _merged_before_the_report(monkeypatch, client, r, merged)
    finished = run_job(job, r)
    (d,) = finished['report']['documents']
    gloss = next(b for b in d['counts']['blank'] if b['target'] == 'Morph Gloss')
    left = [e['form'] for e in d.get('left') or []]
    assert 'rua' not in left and 'pele' not in left, left
    assert gloss['not_reached'] == 2, d['counts']['blank']
    assert d['done'] < d['targets'], d


def test_the_job_retypes_a_sentence_then_a_person_merges_it_into_another(monkeypatch):
    """The other order: the job retypes s2 (adding zz, which its piece after
    the edit then leaves), and a person merges s2 into s1. zz is the job's:
    left blank by it, never not reached."""
    retyped = _ided(document('d1', 'Story', [{'words': ['ka']}, {'words': ['ta', 'zz', 'sa']}], version=2),
                    ['d1-s1w1', 'd1-s2w1', 'd1-zz', 'd1-s2w2'])
    client, job = _retyping_job(monkeypatch, [{'words': ['ka']}, {'words': ['ta', 'sa']}], 's2', 'ta zz sa.',
                                retyped, '')
    r = runner(job)
    merged = _ided(document('d1', 'Story', [{'words': ['ka', 'ta', 'zz', 'sa']}], version=3),
                   ['d1-s1w1', 'd1-s2w1', 'd1-zz', 'd1-s2w2'])
    _merged_before_the_report(monkeypatch, client, r, merged)
    finished = run_job(job, r)
    (d,) = finished['report']['documents']
    gloss = next(b for b in d['counts']['blank'] if b['target'] == 'Morph Gloss')
    assert not gloss.get('not_reached'), (d['counts']['blank'], d.get('left'))


def test_a_job_that_edits_no_text_neither_stores_nor_reads_added_words(monkeypatch):
    """What telling the job's added words from a person's costs a job that
    edits no text and meets no person's words: no row of added words stored
    and none read back for the report (JOIN19, REV-SJ2-R2-2)."""
    from fixtures import MGLOSS
    from job_fixtures import JobClient, Model, call, reply, start, use
    from plaid_agent.igt.job import ADDED_FORM
    client = JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'lo']}, {'words': ['sa']}])
                        for i in (1, 2)})
    job = start(client, 'Gloss every word.', plan='sentences', fills=(MGLOSS,))
    r = runner(job)
    reads = []
    real = r.added

    def counting():
        reads.append(1)
        return real()
    monkeypatch.setattr(r, 'added', counting)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_field', {'document': doc, 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                                  'value': 'go'})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, r)
    assert finished['state'] == 'done', finished.get('state')
    assert not [x for x in client.jobs.decisions(job.id) if str(x.get('form') or '').startswith(ADDED_FORM)]
    assert reads == [], len(reads)
