"""The report's totals, each by its definition (SPEC 9, CONTRACT 5.3,
REV-J-B2 S3-5): "sentences" counts the sentences the job wrote in (an
analysis or a translation), never one it skipped or failed, nor one it only
finished with nothing written. Checked on a job whose every call fails, one
where half of them fail, and one stopped midway."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JT'


def _analysing(bad=()):
    """A model that stages every target sentence named, unless one of them
    is among ``bad``: then the call reaches its output cap."""
    def answer(asked, n, kwargs):
        named = targets_named(asked)
        if set(named) & set(bad):
            return reply('...', finish='length')
        if n > 1:
            return reply('Done.')
        doc = asked.split('"')[1]
        return reply(calls=[call(k, 'set_analysis', {'document': doc, 'ref': f's{s}.w1', 'morphemes': [
            {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}) for k, s in enumerate(named, 1)])
    return answer


def _totals(client):
    return client.jobs.rows[J]['report']['totals']


def _nonzero(totals):
    return {k: v for k, v in totals.items() if v}


def test_a_job_whose_every_call_fails_analysed_no_sentence(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}, {'words': ['ka']}])})
    job = start(client, id=J)
    use(monkeypatch, Model(_analysing(bad=(1, 2))))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 1, 'skipped_failed': 2}


def test_a_job_where_half_the_sentences_fail_counts_the_other_half(monkeypatch):
    mine = ('ka', [('ka', 'go')], J)
    client = JobClient({d: document(d, d, [{'words': ['ka']}, {'words': ['ka']}]) for d in ('d1', 'd2')})
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        # The document once the job wrote its s1, from that write on.
        d = next(o['word_id'] for o in ops if o.get('word_id')).split('-')[0]
        client.after_write[d] = document(d, d, [{'words': [mine]}, {'words': ['ka']}], version=2)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    job = start(client, id=J)
    use(monkeypatch, Model(_analysing(bad=(2,))))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 2, 'sentences': 2, 'words': 2, 'changes': 2,
                                         'skipped_failed': 2}


def test_a_job_that_left_a_sentence_blank_did_not_analyse_it(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client, id=J)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 1}
    assert client.jobs.rows[J]['report']['documents'][0]['done'] == 1, 'the sentence was finished'


def test_a_job_stopped_midway_counts_what_it_wrote_before(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['ka']}])})
    client.after_write['d1'] = document('d1', 'Story 1', [{'words': [('ka', [('ka', 'go')], J)]}], version=2)
    job = start(client, id=J)
    answer = _analysing()

    def stopping(asked, n, kwargs):
        if 'Story 2' in asked:
            client.jobs.cancel(J)
            job.beat()
        return answer(asked, n, kwargs)
    use(monkeypatch, Model(stopping))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled'
    assert _nonzero(_totals(client)) == {'documents_done': 1, 'documents_not_reached': 1, 'sentences': 1,
                                         'words': 1, 'changes': 1}


def test_the_totals_add_up_to_what_the_job_wrote_and_deleted(monkeypatch):
    """A job that corrects what is there (ruling 17): in the first of two
    documents it replaces a person's translation, clears a person's word
    gloss, deletes a word and analyses a blank one, and in the second it
    changes nothing. The totals are the sums
    of the documents' counts, the documents' states add up to the job's
    documents, "changes" is every op the job wrote, "deletions" those that
    took something away, and "sentences" the sentences it wrote in."""
    story = [{'words': [{'form': 'ka', 'gloss': ('go', 'human')}, 'ta'], 'translation': ('Old.', 'human')},
             {'words': ['sa', 'sa']}]
    client = JobClient({'d1': document('d1', 'One', story), 'd2': document('d2', 'Two', story)})
    after = [{'words': ['ka', ('ta', [('ta', 'X')], J)], 'translation': ('New.', J)}, {'words': ['sa']}]
    client.after_write = {'d1': document('d1', 'One', after, version=2)}
    job = start(client, 'Correct the translations, clear wrong glosses, drop doubled words.', id=J,
                plan='document')

    def answer(asked, n, kwargs):
        doc = asked.split('"')[1]
        if n > 1 or doc == 'Two':
            return reply('Corrected.' if doc == 'One' else 'Nothing to correct.')
        return reply(calls=[
            call(1, 'set_field', {'document': doc, 'refs': ['s1'], 'field': 'Translation', 'value': 'New.'}),
            call(2, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'Gloss', 'value': ''}),
            call(3, 'delete_word', {'document': doc, 'refs': ['s2.w2']}),
            call(4, 'set_analysis', {'document': doc, 'ref': 's1.w2', 'morphemes': [{'form': 'ta'}]})])
    use(monkeypatch, Model(answer))
    written = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    report = run_job(job, runner(job))['report']
    totals = report['totals']
    from plaid_agent.igt.jobapply import deletes
    assert totals['changes'] == len(written) == 4
    assert totals['deletions'] == sum(1 for o in written if deletes(o)) == 2
    assert totals['sentences'] == 2 and totals['proposed'] == 0
    docs = report['documents']
    assert sum(totals[k] for k in ('documents_done', 'documents_in_use', 'documents_gone',
                                   'documents_not_reached')) == len(docs) == 2
    for k in ('changes', 'deletions', 'translations', 'refreshed', 'words', 'changed'):
        assert totals[k] == sum((d['counts'] or {}).get(k, 0) for d in docs), k
    assert totals['refreshed'] == 1, 'a person\'s translation replaced is counted'


def test_entries_created_counts_every_entry_the_job_created_and_the_rows_agree(monkeypatch):
    """REV-JH-6, pilot run3 (totals 7, the document's row 5): the job
    re-analyses a person's word with an entry it creates and links, and
    creates an entry nothing links. "Entries created" is 2 in the
    document's row and in the totals."""
    story = [{'words': [('ka', [('ka', 'go')], 'human'), 'ta']}]
    client = JobClient({'d1': document('d1', 'Story', story)})
    job = start(client, 'Analyse ka as kaa "walk" and add the entry tok "stone".', id=J, plan='document')

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[
            call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'kaa', 'type': 'stem', 'fields': {'Morph Gloss': 'walk'}}]}),
            call(2, 'create_entry', {'form': 'kaa', 'fields': {'gloss': 'walk'}}),
            call(3, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:kaa#1'}),
            call(4, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len([k for k, _ in client.calls if k == 'vocab_items.create']) == 2
    report = client.jobs.rows[J]['report']
    assert report['documents'][0]['counts']['entries'] == 2, report['documents'][0]['counts']
    assert report['totals']['entries'] == 2
