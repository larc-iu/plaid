"""What a landed write records after it is sent (the words it added, the
words it respelled, the sentences whose text it edited, its proposed changes
and its record) is never lost to core's passing trouble after the send (D4
of the job review 2026-11-18): each step is tried again on its own, the
read after the send too, and a write put off after some of its tries landed
records what they did before it is put off. So an onlynew job's piece after
its text edit still fills the word it added."""

import pytest

from fixtures import MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.core.plan import PlanError

J = 'JLB'


def _setup():
    return {'fills': [{'id': 'segmentation', 'name': 'segmentation'}, {'id': MGLOSS, 'name': 'Morph Gloss'}],
            'text': True, 'conversation': 'c1', 'onlynew': True}


@pytest.mark.parametrize('where', ['added-row', 'read-after', 'later-try-put-off', 'record-blip', 'update-blip',
                                   'later-try-502', 'later-try-500', 'later-try-401', 'lock-lost'])
def test_the_word_a_landed_text_edit_added_is_filled_whatever_core_does_after_the_send(monkeypatch, where):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and analyse it.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup())
    sent = []
    state = {'edited': False, 'failed': False}

    def execute(c, ops, **kw):
        sent.append(ops)
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
            state['edited'] = True
        elif where.startswith('later-try-') and where != 'later-try-put-off' and state['edited'] \
                and not state['failed'] and any(o['kind'] == 'delete_sentence' for o in ops):
            # REV-JR1-4: the later try fails any other way (core's trouble
            # past the client's resends, a fault, a token refused).
            state['failed'] = True
            status = int(where.rsplit('-', 1)[1])
            try:
                raise PlaidAPIError(f'HTTP {status}', status=status)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        elif where == 'later-try-put-off' and state['edited'] and not state['failed'] \
                and any(o['kind'] == 'delete_sentence' for o in ops):
            # A person's browser wrote between the tries: the later try is
            # refused, and the write is put off after its edit landed.
            state['failed'] = True
            try:
                raise PlaidAPIError('HTTP 409 version', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    if where == 'added-row':
        real = client.jobs.add_decisions

        def add_decisions(job_id, worker_id, rows):
            if not state['failed'] and any(r['form'].startswith(igt_job.ADDED_FORM) for r in rows):
                state['failed'] = True
                raise PlaidAPIError('HTTP 502', status=502)
            return real(job_id, worker_id, rows)
        client.jobs.add_decisions = add_decisions
    if where == 'read-after':
        real_get = client.documents.get

        def get(document_id, **kw):
            if state['edited'] and not state['failed']:
                state['failed'] = True
                raise PlaidAPIError('HTTP 502', status=502)
            return real_get(document_id, **kw)
        client.documents.get = get

    if where == 'lock-lost':
        # REV-JR1-4: the lock lapsed as the landed write ended.
        import contextlib
        from plaid_client import DocumentLockLost
        locked = client.documents.locked

        @contextlib.contextmanager
        def losing(document_id, **kwargs):
            with locked(document_id, **kwargs) as held:
                yield held
            if state['edited'] and not state['failed']:
                state['failed'] = True
                raise DocumentLockLost('The lock on document d1 lapsed.', document_id='d1',
                                       cause=PlaidAPIError('HTTP 423', status=423))
        client.documents.locked = losing
    seen = []
    if where in ('record-blip', 'update-blip'):
        # REV-JR1-3: one 502 in record() after the write landed, or in its
        # row's update. The write is never made again from its gate with the
        # piece's old prints, so the job's own sentence never reads as changed.
        real_record = igt_job.IgtRunner.record

        def record(self, project, document_id, doc, part, st, changed=frozenset(), vouched=frozenset(),
                   made=frozenset()):
            seen.append(sorted(changed))
            if not state['failed'] and state['edited']:
                state['failed'] = True
                if where == 'record-blip':
                    raise PlaidAPIError('HTTP 502', status=502)
                real_up = self.job.update_row

                def up(*a, **kw):
                    self.job.update_row = real_up
                    raise PlaidAPIError('HTTP 502', status=502)
                self.job.update_row = up
            return real_record(self, project, document_id, doc, part, st, changed, vouched, made)
        monkeypatch.setattr(igt_job.IgtRunner, 'record', record)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply(calls=[call(5, 'set_analysis', {'document': 'Story', 'ref': 's2.w1 "zz"', 'morphemes': [
                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
        calls = [call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'})]
        if where.startswith('later-try-'):
            calls.append(call(2, 'delete_sentence', {'document': 'Story', 'refs': ['s1']}))
        return reply(calls=calls)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert state['failed'], ('the trouble was met', sent)
    assert finished['state'] == 'done', finished.get('reason')
    analysed = [o for ops in sent for o in ops if o['kind'] == 'set_analysis']
    assert [o['word_id'] for o in analysed] == ['d1-zz'], sent
    assert all(not ch for ch in seen), seen
