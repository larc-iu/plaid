"""What the job would have asked (BRIEF-JB item 4): the report lists, per
document, every target the job left blank because it could not decide (SPEC
counts them as ``left``), cut by the report's rule with how many more, each
with what the job page links into the grid (the sentence id and the word's
offset). Recorded in each sentence's record among the job's decisions, so a
resumed job reports what an earlier run left too."""

import json

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core import job as core_job
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS
from plaid_agent.igt.job import RECORD_FORM, mark_text

J = 'JL'


def _first_word_only(asked, n, kwargs):
    """A model that analyses the first word of each target sentence and
    leaves the rest."""
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    return reply(calls=[call(k, 'set_analysis', {'document': doc, 'ref': f's{s}.w1', 'morphemes': [
        {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})
        for k, s in enumerate(targets_named(asked), 1)])


def _report(client):
    return client.jobs.rows[J]['report']


def _two_sentences(client_docs=None):
    mine = ('ka', [('ka', 'go')], J)
    before = document('d1', 'Story', [{'words': ['ka', 'pata']}, {'words': ['ka', 'ta', 'sa']}])
    after = document('d1', 'Story', [{'words': [mine, 'pata']}, {'words': [mine, 'ta', 'sa']}], version=2)
    client = JobClient({'d1': before})
    client.after_write['d1'] = after
    return client


def test_the_report_lists_each_word_left_blank_with_where_it_is(monkeypatch):
    client = _two_sentences()
    job = start(client, ['gloss'], id=J)
    use(monkeypatch, Model(_first_word_only))
    assert run_job(job, runner(job))['state'] == 'done'
    (doc,) = _report(client)['documents']
    assert doc['counts']['left'] == 3
    assert doc['left'] == [
        {'ref': 's1.w2', 'begin': 3, 'form': 'pata', 'sentence_id': 'd1-s1'},
        {'ref': 's2.w2', 'begin': 12, 'form': 'ta', 'sentence_id': 'd1-s2'},
        {'ref': 's2.w3', 'begin': 15, 'form': 'sa', 'sentence_id': 'd1-s2'},
    ]
    assert doc['left_more'] == 0


def test_a_translation_left_blank_is_listed_by_its_sentence(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client, ['translate'], id=J)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    assert run_job(job, runner(job))['state'] == 'done'
    (doc,) = _report(client)['documents']
    assert doc['left'] == [{'ref': 's1', 'begin': None, 'form': None, 'sentence_id': 'd1-s1'}]


def test_the_list_is_cut_as_every_report_list_is_with_how_many_more(monkeypatch):
    client = _two_sentences()
    job = start(client, ['gloss'], id=J)
    use(monkeypatch, Model(_first_word_only))
    real = core_job.cut
    monkeypatch.setattr(core_job, 'cut', lambda items, limit=None: real(items, 2))
    assert run_job(job, runner(job))['state'] == 'done'
    (doc,) = _report(client)['documents']
    assert [e['ref'] for e in doc['left']] == ['s1.w2', 's2.w2'] and doc['left_more'] == 1


def test_a_resumed_job_reports_what_an_earlier_run_left(monkeypatch):
    client = _two_sentences()
    job = start(client, ['gloss'], id=J)
    use(monkeypatch, Model(_first_word_only))
    first = runner(job)
    first.work(job)
    # A new run of the worker knows nothing but what core holds.
    again = runner(job)
    (doc,) = again.document_reports(job)
    assert [e['ref'] for e in doc['left']] == ['s1.w2', 's2.w2', 's2.w3']


def test_a_record_holds_what_fits_and_the_rest_is_counted():
    left = [{'ref': f's1.w{i}', 'begin': i * 10, 'form': 'x' * 30} for i in range(1, 200)]
    text = mark_text({'left': len(left)}, 'd1', left)
    assert len(text) <= JOB_ANALYSIS_MAX_CHARS
    kept = json.loads(text)['left']
    assert 0 < len(kept) < len(left) and kept == left[:len(kept)]


def test_a_cut_record_counts_the_rest_as_more(monkeypatch):
    words = [f'w{i:03}' + 'x' * 8 for i in range(100)]
    client = JobClient({'d1': document('d1', 'Story', [{'words': words}])})
    job = start(client, ['gloss'], id=J)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    assert run_job(job, runner(job))['state'] == 'done'
    (doc,) = _report(client)['documents']
    assert doc['counts']['left'] == 100
    assert 0 < len(doc['left']) < 100 and len(doc['left']) + doc['left_more'] == 100
    marks = [r for r in client.jobs.decisions(J) if r['form'].startswith(RECORD_FORM)]
    assert all(len(r['analysis']) <= JOB_ANALYSIS_MAX_CHARS for r in marks)


class _Crash(BaseException):
    """The worker's process dies here."""


def test_a_sentence_recorded_after_a_crash_counts_and_lists_what_was_left_blank(monkeypatch):
    """The worker died between the write and its record: the sentence is
    recorded when the walk comes back to it, and the targets the model left
    blank there are counted and listed as the stretch would have (REV-J-B3
    B3-7), its translation left blank too."""
    client = _two_sentences()
    job = start(client, ['translate', 'gloss'], id=J)
    use(monkeypatch, Model(_first_word_only))
    real = job.add_decisions

    def crash(decisions):
        raise _Crash()
    monkeypatch.setattr(job, 'add_decisions', crash)
    try:
        runner(job).document('d1')
    except _Crash:
        pass
    monkeypatch.setattr(job, 'add_decisions', real)
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    model = use(monkeypatch, Model(_first_word_only))
    assert run_job(job, runner(job))['state'] == 'done'
    assert not model.calls, 'nothing is asked again'
    (doc,) = _report(client)['documents']
    assert doc['counts']['left'] == 5 and doc['counts']['words'] == 2
    assert [x['ref'] for x in doc['left']] == ['s1', 's1.w2', 's2', 's2.w2', 's2.w3']
