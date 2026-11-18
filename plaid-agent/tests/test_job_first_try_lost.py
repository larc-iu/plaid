"""A write whose first or only try is a text edit that lands with its
answer lost (a 502 past the client's resends, a timeout) still records what
the edit did (REV-JR1-R2-3, D4's rule on its likeliest trigger): the word it
added is known as added, so under onlynew the piece after the text edit
fills it. The fake core learns the try landed as core would, from the write
the mocked executor records under the try's seed (``landed_writes``)."""

import pytest

from fixtures import MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job

J = 'JFT'


def _setup():
    return {'fills': [{'id': 'segmentation', 'name': 'segmentation'}, {'id': MGLOSS, 'name': 'Morph Gloss'}],
            'text': True, 'conversation': 'c1', 'onlynew': True}


@pytest.mark.parametrize('plan', ['sentences', 'selection'])
def test_a_text_edit_whose_answer_was_lost_on_the_first_try_still_has_its_word_filled(monkeypatch, plan):
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and analyse it.', id=J, plan=plan, edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup())
    starter = client.jobs.rows[J]['started_by']
    sent = []
    state = {'lost': False}

    def execute(c, ops, seed=None, **kw):
        sent.append(ops)
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
            if not state['lost']:
                # It landed, as core's record of the try says, and its answer was lost.
                state['lost'] = True
                client.landed_writes.append({'key': f'{seed}.0', 'user': starter, 'audited': True})
                try:
                    raise PlaidAPIError('HTTP 502', status=502, method='POST')
                except PlaidAPIError as e:
                    raise PlanError('lost', 0, len(ops), unknown=True) from e
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply(calls=[call(5, 'set_analysis', {'document': 'Story', 'ref': 's2.w1 "zz"', 'morphemes': [
                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
        if 'Your piece: the whole selection above.' in asked or ('sc tqmc' in asked and 'pa ro' in asked):
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert state['lost'], 'the answer was lost'
    assert finished['state'] == 'done', finished.get('reason')
    analysed = [o for ops in sent for o in ops if o['kind'] == 'set_analysis']
    assert [o['word_id'] for o in analysed] == ['d1-zz'], [[o['kind'] for o in ops] for ops in sent]
