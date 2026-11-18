"""A whole-selection piece's ops go with the write of the document each
names (D1 of the job review 2026-11-18): an op that names its document by
``doc`` (a respell) is routed by it, as the apply rule places it
(``jobapply.place``), never carried as an op of no document with the first
document written, where it was only proposed while its morpheme form
followup was applied in its own document."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from fixtures import MGLOSS
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job


def test_a_respell_in_the_second_document_is_written_with_that_documents_ops(monkeypatch):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [('ka', [('ka', 'go')], 'human')]}]),
                        'd2': document('d2', 'Story 2', [{'words': [('kta', [('kta', 'come')], 'human')]}])})
    job = start(client, 'Spell kta as kata.', id='JR', plan='selection', fills=(MGLOSS,), edits_text=True)
    writes = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        writes.append(sorted(o.get('kind') for o in ops))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, k, kwargs):
        if 'Story 1' in asked and 'Story 2' in asked and k == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'went'}),
                                call(2, 'respell', {'document': 'Story 2', 'ref': 's1.w1', 'new_text': 'kata'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    # Both written: the respelling in its own request after the batch, as
    # the executor orders a write's tries (``Write.cut``).
    assert ['set_morpheme_form'] in writes and ['respell'] in writes, writes
    assert not any(p.get('kind') == 'respell' for p in finished['report'].get('proposed') or []), \
        finished['report'].get('proposed')


def test_every_op_naming_its_document_by_doc_is_routed_to_it():
    from types import SimpleNamespace as N
    docs = {}
    for d in ('dA', 'dB'):
        m = N(id=f'm{d}')
        docs[d] = N(id=d, text_id=f't{d}', sentences=[N(id=f's{d}', words=[N(id=f'w{d}', morphemes=[m])])])
    ws = N(_docs=docs, ops=[{'kind': 'respell', 'text_id': 'tdB', 'begin': 0, 'end': 3, 'value': 'x', 'doc': 'dB'},
                            {'kind': 'confirm', 'doc': 'dB'},
                            {'kind': 'set_morpheme_form', 'morpheme_id': 'mdB', 'form': 'x'}])
    out = igt_job.IgtRunner.ops_by_document(ws, ['dA', 'dB'])
    assert {k: [o['kind'] for o in v] for k, v in out.items()} == {'dB': ['respell', 'confirm', 'set_morpheme_form']}

