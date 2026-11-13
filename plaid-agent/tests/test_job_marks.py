"""What the worker keeps of a call it makes to core, it keeps only once core
took the call (REV-JG3-2): a mark made before the call, and the call failed
once by core's passing trouble, leaves the step taken again finding its work
"already done" and sending nothing. Each place the job path marked first,
with one 502 on its call."""

from collections import Counter

import pytest

from job_fixtures import JobClient, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job, through_core
from plaid_agent.igt.job import Stretch
from test_job_pieces import _docs, _model

J = 'JP'


def _fail_once(client, name, when=lambda args, kwargs: True):
    """``client.jobs.<name>`` raises HTTP 502 once, on the first call
    ``when`` picks, nothing of it kept."""
    from plaid_client import PlaidAPIError
    real, failed = getattr(client.jobs, name), []

    def once(*args, **kwargs):
        if not failed and when(args, kwargs):
            failed.append(1)
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return real(*args, **kwargs)
    setattr(client.jobs, name, once)
    return failed


def _has_form(prefix):
    return lambda args, kwargs: any(str(r.get('form') or '').startswith(prefix) for r in args[2])


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_a_proposed_change_survives_one_502_on_its_row(monkeypatch, pieces):
    """REV-JG3-2: a piece glosses a blank word (applied) and replaces a
    person's translation (proposed). Core answers 502 once as the change's
    row is sent: the step is taken again, and the change is in the report."""
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan=pieces)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'})])
        if n == 2:
            return reply(calls=[
                call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's2.w1', 'morphemes': [
                    {'form': 'sa', 'fields': {'Morph Gloss': 'G'}}]}),
                call(3, 'set_field', {'document': 'Story 1', 'refs': ['s1'], 'field': 'Translation',
                                      'value': 'A better translation.'})])
        return reply('Glossed sa, and proposed a translation for s1.')
    use(monkeypatch, _model(piece=piece))
    failed = _fail_once(client, 'add_decisions', _has_form(' change '))
    finished = run_job(job, runner(job))
    assert failed and finished['state'] == 'done'
    assert [c['ref'] for c in finished['report']['proposed']] == ['s1'], finished['report']['proposed']
    assert finished['report']['totals']['proposed'] == 1


def test_a_put_off_counted_once_when_its_row_meets_a_502():
    """A document's row was kept by the worker before core took it: a defer
    whose row failed once was counted twice when taken again."""
    client = JobClient(_docs(1))
    job = start(client, id=J)
    r = runner(job)
    r.waited.add('d1')
    failed = _fail_once(client, 'update_document', lambda args, kwargs: 'defers' in kwargs)
    through_core(job, lambda: r.defer('d1'))
    assert failed
    core = next(x for x in client.jobs.get(J)['documents'] if x['document_id'] == 'd1')
    assert job.rows['d1']['defers'] == 1 and core['defers'] == 1, (job.rows['d1'], core)


def test_the_counts_a_record_carries_survive_one_502_on_its_call():
    """The counts a stretch carried to the next record (none of its own
    sentences was recorded) were taken off before the call: a 502 there lost
    them."""
    client = JobClient(_docs(1))
    job = start(client, id=J)
    r = runner(job)
    project = r.project()
    doc = r.read(project, 'd1')
    r.settle(project, 'd1', doc)
    r.carry['d1'] = Counter({'changed': 2})
    st = Stretch(doc, project, doc.sentences, J)
    failed = _fail_once(client, 'add_decisions', _has_form(' sentence '))
    through_core(job, lambda: r.record(project, 'd1', doc, doc.sentences, st, Counter(), []))
    assert failed
    assert sum((c or {}).get('changed', 0) for c in r.recorded['d1'].values()) == 2, r.recorded['d1']


def test_a_documents_row_in_core_holds_its_counts_after_one_502_on_its_record(monkeypatch):
    """The row of a document whose last record's row update met a 502: the
    walk's end writes the row's counts whole, so core's row is not left as
    it was before that record."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}])})
    client.after_write['d1'] = document('d1', 'Story 1', [{'words': [('ka', [('ka', 'go')], J)]}], version=2)
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='sentences')

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Glossed ka.')
    use(monkeypatch, _model(piece=piece))
    failed = _fail_once(client, 'update_document', lambda args, kwargs: 'counts' in kwargs and 'state' not in kwargs
                        and (kwargs['counts'] or {}).get('words'))
    finished = run_job(job, runner(job))
    assert failed and finished['state'] == 'done'
    assert finished['report']['documents'][0]['counts']['words'] == 1
    core = next(x for x in client.jobs.get(J)['documents'] if x['document_id'] == 'd1')
    assert core['counts']['words'] == 1, core
