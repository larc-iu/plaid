"""What a job reads (REV-J-B S3-10): the project's people's analyses once per
job, not once per document, and a lexicon at most once per stretch."""

from collections import Counter

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job


def _model(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                                 'morphemes': [{'form': 'x', 'fields': {'Morph Gloss': 'G'}}]}),
                        call(2, 'read_lexicon', {}),
                        call(3, 'create_entry', {'form': 'x', 'fields': {'gloss': 'G'}})])


def test_a_three_document_job_reads_each_other_document_once_and_a_lexicon_once_a_stretch(monkeypatch):
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['x']}]) for i in range(1, 7)}
    client = JobClient(docs)
    reads, lexicons = Counter(), Counter()
    get = client.documents.get

    def counted(document_id, **kw):
        reads[document_id] += 1
        return get(document_id, **kw)
    client.documents.get = counted
    real = type(client).vocab_layers.fget

    class Layers:
        def __init__(self, inner):
            self.inner = inner

        def get(self, vid, **kw):
            lexicons[vid] += 1
            return self.inner.get(vid, **kw)

        def __getattr__(self, name):
            return getattr(self.inner, name)
    monkeypatch.setattr(type(client), 'vocab_layers', property(lambda self: Layers(real(self))))
    job = start(client, documents=['d1', 'd2', 'd3'])
    model = use(monkeypatch, Model(_model))
    run_job(job, runner(job))
    stretches = sum(1 for c in model.calls if c['n'] == 1)
    assert stretches == 3
    assert [reads[d] for d in ('d4', 'd5', 'd6')] == [1, 1, 1], reads
    assert lexicons['v1'] <= stretches + 1, lexicons
