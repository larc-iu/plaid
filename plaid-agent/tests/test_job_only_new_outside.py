"""Under onlynew a piece writes only in its own sentences, its text edits
too (REV-RPF3B-5): the model is told "a piece writes only in its own", and a
retype of a sentence of another piece is refused with code ``outside``.
And a word split_word adds is offered for filling in the piece after, as a
word a text edit adds is (REV-RPF3B-4). The reviewer's probes p5 and p2."""

import copy

from fixtures import MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JRB'


def _setup():
    return {'fills': [{'id': 'segmentation', 'name': 'segmentation'}, {'id': MGLOSS, 'name': 'Morph Gloss'}],
            'text': True, 'conversation': 'c1', 'onlynew': True}


def _raw(sents, ids, version=2):
    raw = document('d1', 'Story', [{'words': s} for s in sents], version=version)
    for w, i in zip(raw['text_layers'][0]['token_layers'][1]['tokens'], ids):
        w['id'] = i
    return raw


def test_p5_a_piece_may_not_retype_a_sentence_not_its_own(monkeypatch):
    text_edits(monkeypatch)
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz in s2 and gloss it.', id=J, plan='sentences', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup())
    sent = []

    def execute(c, ops, **kw):
        sent.append(copy.deepcopy(ops))
        if any(igt_job.jobapply.edits_text(o) for o in ops):
            client._holder('d1')['documents']['d1'] = _raw([['zz', 'sc', 'tqmc'], ['pa', 'ro']],
                                                            ['d1-zz', 'd1-s1w1', 'd1-s1w2', 'd1-s2w1', 'd1-s2w2'])
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        if 'Your piece: s2.' in asked:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'zz sc tqmc.'})])
        return reply('Nothing.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert not any(igt_job.jobapply.edits_text(o) for ops in sent for o in ops), sent
    told = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert any("this sentence is not one of your piece's: a piece writes only in its own." in t for t in told), told
    doc = finished['report']['documents'][0]
    assert [(r['sentence'], r['code']) for r in doc.get('refused') or []] == [('s1', igt_job.OUTSIDE)], doc


def test_p2_a_word_split_word_adds_is_offered_for_filling(monkeypatch):
    """s1 "sctqmc ro.": split_word s1.w1 at 2 makes sc and tqmc, no change
    of text, tqmc added. The piece after takes s1 and analyses tqmc."""
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sctqmc', 'ro']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Split sctqmc and gloss the new word.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup())
    sent = []

    def after():
        raw = _raw([['sctqmc', 'ro'], ['pa', 'ro']], ['d1-s1w1', 'd1-s1w2', 'd1-s2w1', 'd1-s2w2'])
        words = raw['text_layers'][0]['token_layers'][1]['tokens']
        w = words[0]
        words.insert(1, {'id': 'd1-new', 'begin': w['begin'] + 2, 'end': w['end']})
        w['end'] = w['begin'] + 2
        return raw

    def execute(c, ops, **kw):
        sent.append(copy.deepcopy(ops))
        if any(igt_job.jobapply.edits_text(o) for o in ops):
            client._holder('d1')['documents']['d1'] = after()
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    asked_after = []

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            asked_after.append(asked)
            return reply(calls=[call(5, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "tqmc"',
                                                         'morphemes': [{'form': 'tqmc',
                                                                        'fields': {'Morph Gloss': 'he'}}]})])
        return reply(calls=[call(1, 'split_word', {'document': 'Story', 'ref': 's1.w1', 'at': 2})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert len(asked_after) == 1, 'the piece after the split'
    analysed = [o for ops in sent for o in ops if o['kind'] == 'set_analysis']
    assert [o.get('word_id') for o in analysed] == ['d1-new'], analysed
