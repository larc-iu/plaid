"""A job that fills a field on texts already analysed (BRIEF EW, 2026-11-14).
Real users' jobs are mostly not "gloss the words nobody analysed": they fill a
new word field (thematic role, animacy) on every word of analysed texts by a
guideline, or check the glosses there. A plan in sentences now walks every
sentence unless it says ``only_empty``, so such a job works its documents
whole, and its report says how many values of each field it set.

The fake applies each value a write sets to what the reads answer next."""

import copy

import pytest

from fixtures import WORD_LAYER
from job_fixtures import JobClient, Model, call, document, job_project, keep_plan, reply, runner, start, \
    stamp, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JEW'
ROLE, ROLE_NAME = 'sl-role', 'Thematic role'
GUIDELINE = 'Thematic role: the first word of a sentence is "agent", every other word "patient".'
INSTRUCTIONS = 'Fill Thematic role on every word, as the guideline says.'
# Three sentences, every word analysed and every translation written.
WORDS = [['ka', 'ta', 'pa'], ['sa', 'mo'], ['lu', 'ni', 'ro', 'vi']]
ANALYSED = [{'words': [(w, [(w, 'g')], 'human') for w in ws], 'translation': (f'T{i}.', 'human')}
            for i, ws in enumerate(WORDS, start=1)]
VALUES = sum(len(ws) for ws in WORDS)


def role_project():
    """The job's project with a word field Thematic role."""
    p = job_project()
    words = next(tk for tk in p['text_layers'][0]['token_layers'] if tk['id'] == WORD_LAYER)
    words['span_layers'].append({'id': ROLE, 'name': ROLE_NAME, 'config': {'igt': {'scope': 'Word'}}})
    return p


def role_document(values=None, version=1):
    """The analysed document, with ``values`` (word id to value) set in
    Thematic role by the job."""
    raw = document('d1', 'Story', ANALYSED, version=version)
    words = next(tk for tk in raw['text_layers'][0]['token_layers'] if tk['id'] == WORD_LAYER)
    words['span_layers'].append({'id': ROLE, 'spans': [
        {'id': f'sp-role-{w}', 'value': v, 'tokens': [w], 'metadata': stamp(J)} for w, v in (values or {}).items()]})
    return raw


def role_of(s, w):
    return 'agent' if w == 1 else 'patient'


def _fill(refs_of, read=False, role=lambda run, s, w: role_of(s, w)):
    """A piece that sets Thematic role on every word ``refs_of(asked)``
    names, with the general field tool, as the guideline says, once it has
    seen the guideline in its system prompt. ``read``: it reads the
    document first. ``role(run, s, w)``: the value, by which run of a piece
    this is (from 1)."""
    runs = {'n': 0}

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n == 1:
            runs['n'] += 1
            assert GUIDELINE in kwargs['messages'][0]['content'], 'the piece is given the guideline'
            if read:
                return reply(calls=[call(1, 'read_document', {'document': 'Story'})])
        if n != (2 if read else 1):
            return reply('Filled Thematic role on every word of the piece.')
        calls = [call(10 * s + w, 'set_field', {'document': 'Story', 'refs': [f's{s}.w{w}'], 'field': ROLE_NAME,
                                                'value': role(runs['n'], s, w)}) for s, w in refs_of(asked)]
        return reply(calls=calls)
    return answer


def _piece_words(asked):
    if 'Your piece: the whole document' in asked:
        return _every_word(asked)
    if 'Your piece: s' not in asked:
        return []
    return [(s, w) for s in targets_named(asked) for w in range(1, len(WORDS[s - 1]) + 1)]


def _every_word(asked):
    return [(s, w) for s in range(1, len(WORDS) + 1) for w in range(1, len(WORDS[s - 1]) + 1)]


def _job(monkeypatch, pieces, refs_of=_piece_words, plan=True, **fill):
    client = JobClient({'d1': role_document()}, project=role_project())
    client.guidelines.create('p1', 'Thematic role', body=GUIDELINE)
    job = start(client, INSTRUCTIONS, id=J, plan=None)
    if plan:
        keep_plan(client, J, pieces)
    written = {}
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        for o in ops:
            if o.get('kind') == 'set_span' and o.get('layer_id') == ROLE:
                written[o['token_id']] = written.get(o['token_id'], []) + [o['value']]
        client.after_write['d1'] = role_document({w: v[-1] for w, v in written.items()},
                                                 version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    model = use(monkeypatch, Model(_fill(refs_of, **fill)))
    return client, job, model, written


def _pieces(model):
    return [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1 and 'Instructions from' in c['asked']]


def _check_report(finished, written):
    assert finished['state'] == 'done', (finished.get('reason'), finished['report'].get('documents'))
    assert sorted(written) == sorted(f'd1-s{s}w{w}' for s, w in _every_word(''))
    assert all(len(v) == 1 for v in written.values()), f'a value written twice: {written}'
    report = finished['report']
    (doc,) = report['documents']
    assert doc['counts']['fields'] == [{'field': ROLE_NAME, 'values': VALUES}], doc['counts']
    assert report['totals']['fields'] == [{'field': ROLE_NAME, 'values': VALUES}]
    assert report['totals']['changes'] == VALUES and report['totals']['words'] == 0
    assert doc['left'] == [] and doc['left_more'] == 0 and not doc['counts'].get('left')
    assert not doc['counts'].get('not_reached') and not doc['skipped']
    assert doc['done'] == doc['targets'] == len(WORDS)


@pytest.mark.parametrize('pieces', ['sentences', 'document'])
def test_a_job_fills_a_field_on_every_word_of_a_fully_analysed_document(monkeypatch, pieces):
    """The guideline says how to fill Thematic role. The plan in sentences
    (no only_empty) or by documents takes every sentence, the piece reads
    them as analysed and sets the field on each word with set_field. The
    report counts 9 values of Thematic role, analysed no word and lists
    nothing as left blank."""
    client, job, model, written = _job(monkeypatch, pieces)
    finished = run_job(job, runner(job))
    assert _pieces(model) == (['Your piece: s1, s2, s3.'] if pieces == 'sentences'
                              else ['Your piece: the whole document "Story", 3 sentences.'])
    asked = next(c['asked'] for c in model.calls if c['n'] == 1 and 'Instructions from' in c['asked'])
    assert 'Empty in' not in asked
    assert 'Nothing empty in s1, s2, s3: their words are analysed and their translations written.' in asked
    _check_report(finished, written)
    # The document's row in core holds the field's count too, and the final
    # context and read_job say it.
    assert client.jobs.get(J)['documents'][0]['counts']['fields'] == [{'field': ROLE_NAME, 'values': VALUES}]
    told = igt_job.summary_message(finished['report'])
    assert told.startswith('This job wrote 9 changes in 3 of 3 sentences: Thematic role 9 values.\n'), told
    assert 'changes 9, documents done 1, sentences 3, Thematic role 9 values' in told, told
    assert '- "Story": done, analyzed 3, changes 9, Thematic role 9 values' in told, told
    from plaid_agent.igt.jobread import _totals
    assert _totals(finished['report']).endswith('Thematic role 9 values')


def test_a_default_plan_fills_the_field_too(monkeypatch):
    """A planning context that ends with no plan_work: the job works in
    sentences, every sentence."""
    client, job, model, written = _job(monkeypatch, None, plan=False)
    finished = run_job(job, runner(job))
    assert finished['report']['plan']['by'] == 'default'
    _check_report(finished, written)


def test_only_empty_works_nothing_of_a_fully_analysed_document(monkeypatch):
    """The guard: the same job planned only_empty finds nothing to do."""
    client, job, model, written = _job(monkeypatch, 'sentences', plan=False)
    from plaid_agent.core.job import analysis_key, canonical
    text = canonical({'pieces': 'sentences', 'piece_instructions': '', 'documents': None, 'by': 'model',
                      'why': None, 'only_empty': True})
    client.jobs.add_decisions(J, 'worker-1', [{'form': igt_job.PLAN_FORM, 'key': analysis_key(text),
                                               'analysis': text, 'count': 1, 'document_id': None,
                                               'sentence_id': None}])
    finished = run_job(job, runner(job))
    assert _pieces(model) == [] and written == {}
    assert finished['report']['documents'][0]['state'] == 'done'
    assert 'fields' not in finished['report']['totals']


class Crash(BaseException):
    """The worker's process dies here."""


def _crash_at_record(monkeypatch, job):
    real = igt_job.IgtRunner.record

    def record(self, *a, **kw):
        raise Crash()
    monkeypatch.setattr(igt_job.IgtRunner, 'record', record)
    try:
        run_job(job, runner(job))
    except Crash:
        pass
    monkeypatch.setattr(igt_job.IgtRunner, 'record', real)


def _resume(client, job):
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    return runner(job)


def test_a_field_write_that_landed_before_a_crash_is_never_written_again(monkeypatch):
    """A second visit writes nothing the job wrote: the piece's write lands
    and the worker dies before its record. Core says it landed, so its
    sentences are worked, the model is not asked again, and each value is
    written once."""
    client, job, model, written = _job(monkeypatch, 'sentences')
    _crash_at_record(monkeypatch, job)
    assert len(written) == VALUES
    finished = run_job(job, _resume(client, job))
    assert len(_pieces(model)) == 1, 'the piece is not asked again'
    _check_report(finished, written)
    assert not finished['report']['totals']['repeated']


def test_a_selection_taken_again_leaves_out_the_values_it_wrote_and_counts_them(monkeypatch):
    """The selection reads the document and sets the field, its write lands
    and the worker dies before its record. Run again, it reads and stages
    the field once more, "theme" where it wrote "patient": those 6 changes
    are in sentences its first run wrote, so they are left out, never
    written, and counted repeated. Its 3 "agent" values hold already, and
    the field tool stages nothing for a value a field holds."""
    client, job, model, written = _job(monkeypatch, 'selection', refs_of=_every_word, read=True,
                                       role=lambda run, s, w: role_of(s, w) if run == 1 or w == 1 else 'theme')
    _crash_at_record(monkeypatch, job)
    assert len(written) == VALUES
    first = copy.deepcopy(written)
    finished = run_job(job, _resume(client, job))
    assert _pieces(model) == ['Your piece: the whole selection above.'] * 2, 'the selection ran again, alone'
    assert written == first, written
    _check_report(finished, written)
    assert finished['report']['totals']['repeated'] == VALUES - len(WORDS)


def test_a_selection_that_never_read_its_sentences_has_them_walked_and_nothing_written_twice(monkeypatch):
    """A selection that sets the field without reading the document: its
    sentences are not its own (it was never shown them), so the walk works
    them after it, as a piece of the document (NW). That second visit stages the same
    values, which the field holds already: nothing is written twice."""
    client, job, model, written = _job(monkeypatch, 'selection', refs_of=lambda asked: (
        _every_word(asked) if 'whole selection' in asked else _piece_words(asked)))
    finished = run_job(job, runner(job))
    assert _pieces(model) == ['Your piece: the whole selection above.',
                              'Your piece: the whole document "Story", 3 sentences.']
    _check_report(finished, written)
    assert not finished['report']['totals']['repeated']
