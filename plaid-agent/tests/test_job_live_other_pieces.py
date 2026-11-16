"""A piece's project-wide op that writes in another piece's sentences closes
none of them, on a real core (BRIEF NW): a stretch plan, a document plan
worked in stretches, a selection that read part of its document, and a
crash between the bulk piece's write and the next piece. The model is
scripted (no model runs): the piece of s1 glosses ka everywhere with
set_analysis_for_form, which also writes s3.w1, and every piece glosses
the words its message names as empty, but lu. Every word ends analysed or
listed under Left blank, and the totals add up.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import re

import pytest

from fixtures import MORPH_LAYER, WORD_LAYER
from job_fixtures import Model, call, document, empty_word_lines, every_tool, reply, use
from test_job_left_all import adds_up
from test_job_live_entries import _job, _runner, world  # noqa: F401 - the fixture

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner


@pytest.fixture(autouse=True)
def _every_tool(monkeypatch):
    """These tests script tools a piece of a plan in sentences is no longer offered."""
    every_tool(monkeypatch)

SENTENCES = [['ka', 'mi'], ['pa', 'ni'], ['ka', 'sa'], ['mo', 'lu']]
WORDS = sum(len(s) for s in SENTENCES)


class Crash(BaseException):
    """The worker's process dies here."""


def _gloss(k, ref, form):
    return call(k, 'set_analysis', {'document': 'Alpha', 'ref': ref, 'morphemes': [
        {'form': form, 'fields': {'Morph Gloss': 'g'}}]})


def _bulk(k):
    return call(k, 'set_analysis_for_form', {'form': 'ka', 'document': 'Alpha', 'morphemes': [
        {'form': 'ka', 'fields': {'Morph Gloss': 'g'}}]})


def _model(pieces):
    """The scripted model. A selection reads s1 and s2 alone, glosses ka
    everywhere and mi, pa, ni. A piece of one document glosses ka everywhere
    when s1 is empty in it, and every other word its message names as
    empty, lu aside. ``pieces`` gets the sentences each piece of one
    document was handed as empty."""
    def answer(asked, n, kwargs):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Alpha', 'from_sentence': 1,
                                                              'to_sentence': 2})])
            if n == 2:
                return reply(calls=[_bulk(2), _gloss(3, 's1.w2', 'mi'), _gloss(4, 's2.w1', 'pa'),
                                    _gloss(5, 's2.w2', 'ni')])
            return reply('Glossed s1 and s2, and ka everywhere.')
        if 'Your piece:' not in asked:
            return reply('Done.')
        if n > 1:
            return reply('Glossed.')
        empty = empty_word_lines(asked)
        pieces.append([int(s) for s, _ in empty])
        calls, k = [], 1
        for s, words in empty:
            for i, form in re.findall(r'w(\d+) "([^"]+)"', words):
                if s == '1' and form == 'ka':
                    calls.append(_bulk(k))
                elif form != 'lu':
                    calls.append(_gloss(k, f's{s}.w{i}', form))
                k += 1
        return reply(calls=calls)
    return answer


def _analysed(admin, s):
    """The refs of the words of Alpha holding a morpheme the job wrote."""
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    layers = {tk['id']: tk for tl in raw['text_layers'] for tk in tl['token_layers']}
    words = layers[s.ids[WORD_LAYER]]['tokens']
    stamped = {(t['begin'], t['end']) for t in layers[s.ids[MORPH_LAYER]].get('tokens') or []
               if (t.get('metadata') or {}).get('prov')}
    refs, i = [], 0
    for si, sentence in enumerate(SENTENCES, start=1):
        for wi in range(1, len(sentence) + 1):
            if (words[i]['begin'], words[i]['end']) in stamped:
                refs.append(f's{si}.w{wi}')
            i += 1
    return refs


def _check(admin, s, finished):
    assert finished['state'] == 'done', (finished.get('reason'), finished.get('report', {}).get('plan'))
    every = [f's{si}.w{wi}' for si, ws in enumerate(SENTENCES, start=1) for wi in range(1, len(ws) + 1)]
    assert _analysed(admin, s) == [r for r in every if r != 's4.w2'], 'sa is glossed by the piece of s3'
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s4.w2'], doc['left']
    assert doc['counts']['words'] == WORDS - 1 and doc['counts']['left'] == 1
    adds_up(doc, WORDS)
    assert doc['done'] == doc['targets'] == len(SENTENCES)


@pytest.mark.parametrize('plan', ['sentences', 'document-in-stretches'])
def test_a_bulk_op_closes_no_sentence_of_a_later_piece(world, monkeypatch, plan):
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': w} for w in SENTENCES])})
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    if plan != 'sentences':
        # Too long for one piece: worked in stretches, by the same rule.
        monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    pieces = []
    use(monkeypatch, Model(_model(pieces)))
    job = _job(admin, writer, s, 'sentences' if plan == 'sentences' else 'document')
    finished = run_job(job, _runner(job))
    assert pieces == [[1, 2], [3, 4]], 'the piece of s3 runs, s3.w1 already analysed'
    _check(admin, s, finished)


def test_a_crash_between_the_bulk_write_and_the_next_piece(world, monkeypatch):
    """The worker dies after the bulk piece's write landed, before its
    record. Core says it landed: the piece is not asked again, and s3 is
    still its own piece's."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': w} for w in SENTENCES])})
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    pieces = []
    use(monkeypatch, Model(_model(pieces)))
    job = _job(admin, writer, s, 'sentences')
    real = IgtRunner.record

    def record(self, *a, **kw):
        raise Crash()
    monkeypatch.setattr(IgtRunner, 'record', record)
    with pytest.raises(Crash):
        run_job(job, _runner(job))
    monkeypatch.setattr(IgtRunner, 'record', real)
    job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
    finished = run_job(job, _runner(job))
    assert pieces == [[1, 2], [3, 4]], 'the bulk piece once, then the piece of s3'
    _check(admin, s, finished)


def test_a_selection_that_read_part_of_a_document_is_followed_by_no_walk(world, monkeypatch):
    """The selection reads s1 and s2, glosses them and ka everywhere (s3.w1
    too). s3 was never shown to it, and nothing more is worked after its
    piece (SF round 2): no piece follows, and the document ends done in the
    one step, not all read."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': w} for w in SENTENCES])})
    pieces = []
    use(monkeypatch, Model(_model(pieces)))
    job = _job(admin, writer, s, 'selection')
    finished = run_job(job, _runner(job))
    assert pieces == [], pieces
    (d,) = finished['documents']
    assert d['state'] == 'done' and d['counts'].get('one_step') is True and d['counts'].get('not_all_read') is True


def test_a_word_the_bulk_op_wrote_and_the_starter_cleared_is_not_written_again(world, monkeypatch):
    """REV-LNW-1 on a real core: the starter clears ka in s3 right after the
    bulk piece's write. The piece of s3 and s4 is not told it is empty and
    never writes it, and glosses sa. ka in s3 is counted as written, not
    as left."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': w} for w in SENTENCES])})
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    pieces, sent = [], []
    use(monkeypatch, Model(_model(pieces)))
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        sent.append([o.get('word_id') for o in ops if o.get('kind') == 'set_analysis'])
        if len(sent) == 1:
            raw = admin.documents.get(s.ids['dA'], include_body=True)
            layers = {tk['id']: tk for tl in raw['text_layers'] for tk in tl['token_layers']}
            ka3 = layers[s.ids[WORD_LAYER]]['tokens'][4]
            for t in layers[s.ids[MORPH_LAYER]].get('tokens') or []:
                if (t['begin'], t['end']) == (ka3['begin'], ka3['end']):
                    writer.tokens.delete(t['id'])
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    job = _job(admin, writer, s, 'sentences')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done'
    assert pieces == [[1, 2], [3, 4]]
    later = {w for ws in sent[1:] for w in ws}
    assert s.ids['dA-s3w1'] in set(sent[0]) and s.ids['dA-s3w1'] not in later, sent
    assert s.ids['dA-s3w2'] in later
    assert _analysed(admin, s) == ['s1.w1', 's1.w2', 's2.w1', 's2.w2', 's3.w2', 's4.w1']
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == ['s4.w2'] and doc['counts']['words'] == WORDS - 1
    adds_up(doc, WORDS)
