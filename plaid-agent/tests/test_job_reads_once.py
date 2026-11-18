"""A job reads an unchanged document whole once (SCL7-6). Each piece read its
document whole four times (the walk, the model's piece, twice in the write)
and every document twice more before the work started, about 40 s a piece
of a 20,000-word document with a model that answered at once. A read now
asks the document's record for its version and takes the body this process
read at that version, by the same layers, and parses it by the project the
caller holds: the ignored-token rule and the fields as they are now
(REV-CU-1)."""
from job_fixtures import JobClient, Model, cache_documents, document, reply, runner, start, use
from plaid_agent.core.job import run_job


def _client():
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['ta']}]) for i in (1, 2)}
    client = cache_documents(JobClient(docs))
    whole = []
    get = client.documents.get

    def counting(document_id, **kw):
        if kw.get('include_body'):
            whole.append(document_id)
        return get(document_id, **kw)
    client.documents.get = counting
    return client, whole


def test_a_job_reads_each_unchanged_document_whole_once(monkeypatch, fresh_document_cache):
    client, whole = _client()
    job = start(client, 'Gloss every morpheme.', plan='sentences')
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'))
    # Once by the job's reads (18 whole reads of the two before), and once by
    # the read of people's work, whose parses the process keeps by the
    # documents' list (read_people).
    assert sorted(whole) == ['d1', 'd1', 'd2', 'd2'], (len(whole), whole)


def test_a_kept_body_is_parsed_by_the_project_the_reader_holds_now(fresh_document_cache):
    """The body is kept, never the parse: a rule changed since gives a parse
    by the new rule from the same body, with no second whole read."""
    import dataclasses
    from plaid_agent.igt.project import load_project
    client, whole = _client()
    job = start(client, 'Gloss every morpheme.', plan='sentences')
    run = runner(job)
    project = load_project(client, job.project_id)
    before = run.read(project, 'd1', client)
    hiding = dataclasses.replace(project, ignored_cfg={'type': 'blacklist', 'blacklist': ['ka']})
    after = run.read(hiding, 'd1', client)
    assert [w.surface for s in before.sentences for w in s.words] == ['ka', 'ta']
    assert [w.surface for s in after.sentences for w in s.words] == ['ta']
    assert whole == ['d1'], whole
