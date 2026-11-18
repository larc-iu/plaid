"""After a whole-selection piece, a piece after a text edit that is put off
(a person in the document) goes back to be taken at the start of the
document's walk (REV-RPF3-5), never closed by the one step (D19 of the job
review 2026-11-18): the words the text edit added are still filled."""

from fixtures import MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JTP'


def test_a_put_off_piece_after_a_selections_text_edit_is_taken_by_the_walk(monkeypatch):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['ka']}])})
    job = start(client, 'Insert zz and analyse it.', id=J, plan='selection', edits_text=True,
                fills=('segmentation', MGLOSS))
    sent = []

    def execute(c, ops, **kw):
        sent.append(ops)
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story 1', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    # A person is in Story 1 the first time the piece after the text edit looks.
    real_after, real_in_use = igt_job.IgtRunner.after_text, igt_job.IgtRunner.in_use
    looks = {'after': False, 'n': 0}

    def after_text(self, *a, **kw):
        looks['after'] = True
        try:
            return real_after(self, *a, **kw)
        finally:
            looks['after'] = False

    def in_use(self, *a, **kw):
        if looks['after']:
            looks['n'] += 1
            if looks['n'] == 1:
                return True
        return real_in_use(self, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'after_text', after_text)
    monkeypatch.setattr(igt_job.IgtRunner, 'in_use', in_use)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply(calls=[call(5, 'set_analysis', {'document': 'Story 1', 'ref': 's2.w1 "zz"', 'morphemes': [
                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
        if 'Your piece: the whole selection above.' in asked:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story 1', 'ref': 's2', 'text': 'zz pa ro.'})])
        return reply('Nothing to do.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert looks['n'] >= 1, 'the piece after the text edit was put off once'
    analysed = [o for ops in sent for o in ops if o['kind'] == 'set_analysis']
    assert [o['word_id'] for o in analysed] == ['d1-zz'], sent
