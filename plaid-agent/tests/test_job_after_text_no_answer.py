"""A piece after a text edit that answers nothing, twice, has its sentences
skipped ``no-answer``, as every piece that answers nothing has (CONTRACT,
DF1, REV-DAY-S-16), never left to read as Left blank (complexity-5 of the
job review 2026-11-18)."""

from fixtures import MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JNA'


def test_a_piece_after_a_text_edit_that_answers_nothing_skips_its_sentences_no_answer(monkeypatch):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and gloss it.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS))

    def execute(c, ops, **kw):
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply('')
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    skipped = [(s['sentence'], s['reason']) for s in job.rows['d1'].get('skipped') or []]
    assert ('s2', 'no-answer') in skipped, skipped
