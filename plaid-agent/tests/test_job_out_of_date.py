"""A lexicon entry deleted or merged away while the model works never ends
the job (SPEC 12, REV-J-B3 B3-3): a link to it is dropped as ``changed`` and
the rest of the stretch is written. Harmonize lists a document's words it
could not write as ``refused``, and the entries pass keeps its drafts. Each
other error the write can meet is sorted on purpose."""

from fixtures import lexicon_raw
from job_fixtures import JobClient, Model, call, document, recorded, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError, PlanOutOfDate
from plaid_agent.igt import job as igt_job

J = 'JO'


def _gam_job(monkeypatch, delete_at=2):
    """A gloss and link job over Story (one blank "gam") and Other (one
    blank "zu"). The model links gam to the entry vi-gam, and a person
    deletes that entry while the model is still at work."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['gam']}]),
                        'd2': document('d2', 'Other', [{'words': ['zu']}])}, lexicon=lexicon_raw())
    job = start(client, ['gloss', 'link'], id=J)

    def answer(asked, n, kwargs):
        if n == 1 and 'Story' in asked.split('\n')[0]:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'gam', 'type': 'stem', 'fields': {'Morph Gloss': 'fish'}}]}),
                call(2, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'], 'entry_id': 'vi-gam'})])
        if n == delete_at and 'Story' in asked.split('\n')[0]:
            client._lexicon['items'] = [i for i in client._lexicon['items'] if i['id'] != 'vi-gam']
        return reply('Done.')
    use(monkeypatch, Model(answer))
    return client, job


def test_an_entry_deleted_while_the_model_works_drops_its_link_and_the_job_goes_on(monkeypatch):
    client, job = _gam_job(monkeypatch)
    client.after_write['d1'] = document('d1', 'Story', [{'words': [('gam', [('gam', 'fish')], J)]}], version=2)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), client.jobs.rows[J].get('message'))
    written = [p for k, p in client.calls if k.startswith(('tokens', 'spans', 'vocab_links', 'documents'))]
    assert "'fish'" in str(written), 'the analysis is written'
    assert not [p for k, p in client.calls if k.startswith('vocab_links') and 'd1-s1w1' in str(p)], 'not the link'
    rows = {r['document_id']: r for r in client.jobs.get(J)['documents']}
    assert rows['d1']['counts']['changed'] == 1 and rows['d1']['counts']['words'] == 1
    assert rows['d2']['state'] == 'done', 'the next document is worked'


def test_core_out_of_reach_while_the_entries_are_checked_is_tried_again(monkeypatch):
    """The plan's check could not read a lexicon (core's 502): passing
    trouble, the document taken again, never a link dropped for it."""
    client, job = _gam_job(monkeypatch, delete_at=0)
    real = igt_job.execute_plan
    left = {'n': 1}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 502', status=502)
            except PlaidAPIError as e:
                raise PlanOutOfDate(['the lexicon "Lexicon" could not be read']) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert [p for k, p in client.calls if k.startswith('vocab_links')], 'the link is written on the second try'
    assert client.jobs.get(J)['documents'][0]['counts']['changed'] == 0


def test_a_write_refused_for_something_gone_puts_the_document_off(monkeypatch):
    """A 404 inside the write (the document, or an entry, gone in the moment
    since the check): the document is put off, and the next walk reads
    what is there. Never the job's end."""
    client, job = _gam_job(monkeypatch, delete_at=0)
    real = igt_job.execute_plan
    left = {'n': 1}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 404 Vocab item not found', status=404)
            except PlaidAPIError as e:
                raise PlanError('Vocab item not found', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'deferred'


def _harmonize_job(monkeypatch, refusing):
    client = JobClient({'d1': document('d1', 'Story', [{'words': [
        ('ka', [('ka', 'go')], J), ('ka', [('ka', 'go')], J), ('ka', [('ka', 'come')], J)]}])})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if kw.get('label') == igt_job.HARMONIZE_LABEL:
            raise refusing
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return client, job


def test_harmonize_lists_a_documents_words_refused_when_an_entry_went_since_staging(monkeypatch):
    client, job = _harmonize_job(monkeypatch, PlanOutOfDate(['the lexicon entry "ka" no longer exists']))
    out = runner(job).harmonize(job)
    assert out['changed'] == []
    assert {'form': 'ka', 'reason': 'refused', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']


def test_harmonize_lists_a_documents_words_refused_when_something_went_in_the_write(monkeypatch):
    try:
        raise PlaidAPIError('HTTP 404 Vocab item not found', status=404)
    except PlaidAPIError as e:
        try:
            raise PlanError('Vocab item not found', 0, 1) from e
        except PlanError as refusal:
            client, job = _harmonize_job(monkeypatch, refusal)
    out = runner(job).harmonize(job)
    assert {'form': 'ka', 'reason': 'refused', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']


def test_the_entries_pass_keeps_its_drafts_when_one_went_since_staging(monkeypatch):
    """A person deletes the draft (or links it from a project the job
    cannot open) between the staging of the delete and its write: the plan
    is refused as out of date before anything is written, and the drafts
    are kept and listed."""
    from test_job_entries import _hanging_job
    client, job = _hanging_job()
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if kw.get('label') == igt_job.ENTRIES_LABEL:
            raise PlanOutOfDate(['the lexicon entry "aa" no longer exists'])
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    out = runner(job).entries(job)
    assert out['deleted'] == [] and [e['id'] for e in out['unlinked']] == ['e-unlinked']
