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


def test_a_write_refused_for_something_gone_every_time_skips_its_sentences_as_changed(monkeypatch):
    """REV-FIX3-5: the same refusal on every walk. The JOB_DEFER_ROUNDS-th
    time the stretch's sentences are skipped as changed and the document is
    done, never ended "in use", which would say people were working in it."""
    client, job = _gam_job(monkeypatch, delete_at=0)

    def execute(c, ops, **kw):
        try:
            raise PlaidAPIError('HTTP 404 Vocab item not found', status=404)
        except PlaidAPIError as e:
            raise PlanError('Vocab item not found', 0, len(ops)) from e
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    rows = {r['document_id']: r for r in client.jobs.get(J)['documents']}
    assert rows['d1']['state'] == 'done' and rows['d2']['state'] == 'done', rows
    assert [(x['sentence'], x['reason']) for x in rows['d1']['skipped']] == [('s1', 'changed')]
    assert not client.batches


def test_refusals_for_something_gone_of_different_stretches_do_not_add_up(monkeypatch):
    """REV-B4-3: three stretches each refused once for an entry deleted in
    the moment, each written on its next walk. The count is per stretch (its
    first sentence), so none is skipped: only a refusal that keeps coming
    back for the same stretch skips it."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}, {'words': ['ta']}, {'words': ['pa']}])})
    job = start(client, ['gloss'], id=J)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        s = int(next(x for x in asked.splitlines() if x.startswith('Analyse '))[len('Analyse s'):].split('.')[0])
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w1', 'morphemes': [
            {'form': 'x', 'fields': {'Morph Gloss': 'go'}}]})])
    use(monkeypatch, Model(model))
    real = igt_job.execute_plan
    refused = set()

    def execute(c, ops, **kw):
        sentence = ops[0]['word_id'].rsplit('w', 1)[0]
        if sentence not in refused:
            refused.add(sentence)
            try:
                raise PlaidAPIError('HTTP 404 Vocab item not found', status=404)
            except PlaidAPIError as e:
                raise PlanError('Vocab item not found', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    r = runner(job)
    state = r.document('d1')
    while state == 'deferred':
        r.waited.add('d1')
        state = r.document('d1')
    assert state == 'done'
    assert refused == {'d1-s1', 'd1-s2', 'd1-s3'}
    assert not job.rows['d1'].get('skipped'), job.rows['d1']['skipped']


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


def test_harmonize_taken_again_after_core_trouble_reports_what_it_wrote_the_first_time(monkeypatch):
    """Core fails a call after harmonize rewrote Story 1, and harmonize is
    run again from its start (``through_core``). Story 1's rewrite is still
    in the report (REV-J-B3 B3-6)."""
    from plaid_agent.core.job import through_core
    ka = {'go': ('ka', [('ka', 'go')], J), 'come': ('ka', [('ka', 'come')], J)}
    docs = {'d1': [{'words': [ka['go'], ka['go'], ka['come']]}], 'd2': [{'words': [ka['go'], ka['go'], ka['come']]}]}
    client = JobClient({d: document(d, f'Story {d}', s) for d, s in docs.items()})
    job = start(client, ['gloss'], id=J)
    for d in docs:
        job.update_row(d, state='done')
    recorded(job)
    real = igt_job.execute_plan
    seen = {'n': 0}

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        seen['n'] += 1
        if seen['n'] == 1:
            # What Story 1 reads once its rewrite landed, then core fails the
            # next call.
            client._holder('d1')['documents']['d1'] = document('d1', 'Story d1', [
                {'words': [ka['go'], ka['go'], ka['go']]}], version=2)
            client.comments.list = _failing_once(client.comments.list)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    kept = runner(job)
    out = through_core(job, lambda: kept.harmonize(job))
    assert out['changed'] == [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority', 'from': [
        {'analysis': 'ka ‘come’', 'count': 2, 'documents': ['d1', 'd2']}]}], out


def _failing_once(call):
    left = {'n': 1}

    def failing(*a, **kw):
        if left['n']:
            left['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
        return call(*a, **kw)
    return failing
