"""A piece's project-wide op that writes in a later piece's sentences closes
none of them (BRIEF NW, 2026-11-14). Observed on a real model: a stretch's
``set_analysis_for_form`` wrote a word or two in nearly every sentence of the
document, every such sentence then read as finished, their own pieces never
ran, and the report neither counted nor listed the words left blank there.

The rule (the piece key, CONTRACT "Added by JH-FIX" and "Added by RX"): a
sentence is closed to a piece only by that piece's own landed write in it as
one of its own sentences. The sentence's own piece still gets it, sees what
is analysed there, and works the rest. And the report's Left blank is read
from the document as it is at the end: every word with no analysis in a
sentence the job worked, whoever staged what.

The fake applies each set_analysis it is sent to the document its reads
answer next, so each piece reads what the pieces before it wrote. The bulk
tool's query runs on the session's core (``live.answer``)."""

import re

import pytest

from job_fixtures import JobClient, Model, call, document, keep_plan, reply, runner, start, targets_named, use

from plaid_agent.core.job import analysis_key, canonical, run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import PLAN_FORM

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
    assert doc['counts']['words'] + doc['counts']['left'] == sum(len(s) for s in SENTENCES)
    assert doc['done'] == doc['targets'] == 4


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
    assert doc['counts']['words'] + doc['counts']['left'] == sum(len(s) for s in SENTENCES)
