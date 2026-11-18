"""A sentence a whole-selection piece wrote in unread, before the sentences it
read, whose change its write dropped (changed since the piece read it: the
job's own lexicon write in an earlier document, or the starter's browser
under the lock), is taken again by the walk (CONTRACT SF round 2), never
passed by the cursor (D27 of the job review 2026-11-18)."""

from job_fixtures import JobClient, Model, call, reply, runner, start, use
from test_job_other_pieces import _doc, _applying, J

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job


def test_a_retake_before_the_cursor_is_taken_by_the_walk(monkeypatch):
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J, plan='selection')
    _applying(monkeypatch, client)
    asked_after = []

    def model(asked, n, kwargs):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story', 'from_sentence': 3,
                                                              'to_sentence': 4})])
            if n > 2:
                return reply('Done.')
            refs = [f's{s}.w{w}' for s in (3, 4) for w in (1, 2)] + ['s1.w1']
            return reply(calls=[call(k, 'set_analysis', {'document': 'Story', 'ref': r, 'morphemes': [
                {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for k, r in enumerate(refs, start=2)])
        asked_after.append(asked)
        return reply('Done.')
    use(monkeypatch, Model(model))
    real = igt_job.IgtRunner.recheck
    seen = {'n': 0}

    def recheck(self, ws, project, fresh, st, prints, ops):
        seen['n'] += 1
        if seen['n'] == 1:
            # s1 reads otherwise than the piece read it, at the selection's write.
            prints = {**prints, fresh.sentences[0].id: 'changed'}
        return real(self, ws, project, fresh, st, prints, ops)
    monkeypatch.setattr(igt_job.IgtRunner, 'recheck', recheck)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert any('Your piece:' in a for a in asked_after), 's1 taken again by the walk'


def test_a_sentence_changed_twice_past_the_lists_cap_is_counted_not_listed(monkeypatch):
    """complexity-6: record()'s "changed" skip keeps core's cap of the list,
    as every other skip does: past it the sentence is counted, and core never
    refuses the row (which ended the job worker-error)."""
    from plaid_client import testing
    monkeypatch.setattr(igt_job, 'JOB_SKIPPED_PER_DOCUMENT', 0)
    monkeypatch.setattr(testing, '_JOB_SKIPPED_PER_DOCUMENT', 0)
    client = JobClient({'d1': _doc(set())})
    job = start(client, id=J, plan='selection')
    _applying(monkeypatch, client)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]})])
    use(monkeypatch, Model(model))
    real = igt_job.IgtRunner.recheck

    def recheck(self, ws, project, fresh, st, prints, ops):
        # s1 always reads otherwise than the piece read it.
        return real(self, ws, project, fresh, st, {**prints, fresh.sentences[0].id: 'changed'}, ops)
    monkeypatch.setattr(igt_job.IgtRunner, 'recheck', recheck)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), client.jobs.rows[J].get('message'))
    assert job.rows['d1']['counts'].get('skipped_more') == 1, job.rows['d1']['counts']
