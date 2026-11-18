"""STRESS S9-2: a job's delete_entry that core refuses because the entry has
links the job's token cannot see (another project links it: 409 with
``links``) is listed once as a change not applied, with that reason. The
rest of the write stands, the document is not put off, its piece is not
run again, and nothing is counted twice."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.core.plan import PlanError
from plaid_agent.igt.plan import _linked_elsewhere
from plaid_client import PlaidAPIError

J = 'JDL'


@pytest.mark.parametrize('shape', ['request', 'plan'])
def test_a_delete_refused_for_links_the_job_cannot_see_is_listed_once(monkeypatch, shape):
    client = JobClient({'d1': document('d1', 'Alpha', [{'words': ['ka']}]),
                        'd2': document('d2', 'Beta', [{'words': ['ta']}])})
    job = start(client, 'Gloss every morpheme.', id=J, plan='document')
    asked = []

    def answer(text, n, kwargs):
        if n == 1:
            asked.append(text)
        if '"Alpha"' in text and n == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Alpha', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'go-JOB'}),
                                call(2, 'delete_entry', {'entry_id': 'vi-gam2'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    monkeypatch.setattr(igt_job.IgtRunner, 'starter_maintains', lambda self, ws, project: True)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        # Core counts a link in a project the job's token cannot open, as
        # the executor raises it: a refusal of the try's request (seen live),
        # or the plan's own reading of it.
        dels = [o for o in ops if o.get('kind') == 'delete_entry']
        if dels:
            refusal = PlaidAPIError('HTTP 409 This entry has 1 links now, not 0', status=409, method='POST',
                                    response_data={'error': 'This entry has 1 links now, not 0', 'links': 1})
            if shape == 'request':
                raise PlanError(str(refusal), 0, len(ops)) from refusal
            raise _linked_elsewhere(dels) from refusal
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    alpha = finished['report']['documents'][0]
    assert alpha['state'] == 'done' and not alpha.get('defers'), alpha
    assert sum(1 for a in asked if '"Alpha"' in a and 'Your piece' in a) == 1, 'the piece is not run again'
    proposed = finished['report'].get('proposed') or []
    (deleted,) = [p for p in proposed if p['kind'] == 'delete_entry']
    assert 'linked where the job cannot read' in deleted['label'], deleted
    assert not deleted.get('reason'), deleted
    assert 'go-JOB' in str(client.payloads('spans.create'))
    assert 'someone was editing' not in (finished['report'].get('notice') or '')


@pytest.mark.parametrize('others', [0, 1])
def test_a_refused_delete_writes_none_of_its_repairs(monkeypatch, others):
    """REV-SJ2-1: the delete carries its repairs (Ali's See also, which
    names gam2, cleared, and gam2's sense freed), which stand only if it
    goes. Core refuses it for links the job cannot read: none of them is
    written, the lexicon is as before but for the plan's other change (a
    gloss on Ali, ``others``), and the delete is listed once."""
    from fixtures import lexicon_raw
    from job_fixtures import job_project
    project = job_project()
    project['vocabs'][0]['config']['igt']['fields']['seeAlso'] = {'inline': False, 'type': 'item', 'many': True}
    lex = lexicon_raw()
    next(i for i in lex['items'] if i['id'] == 'vi-ali')['metadata']['seeAlso'] = ['vi-gam2']
    lex['items'].append({'id': 'vi-gam2-s1', 'form': 'gam', 'metadata': {'gloss': 'fishing net', 'parent': 'vi-gam2'}})
    client = JobClient({'d1': document('d1', 'Alpha', [{'words': ['ka']}])}, lexicon=lex, project=project)
    job = start(client, 'Tidy the lexicon.', id=J, plan='document')
    staged = {}

    def answer(text, n, kwargs):
        if '"Alpha"' in text and n == 1:
            calls = [call(2, 'delete_entry', {'entry_id': 'vi-gam2'})]
            if others:
                calls.append(call(3, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'gloss', 'value': 'Ali-JOB'}))
            return reply(calls=calls)
        return reply('Done.')
    use(monkeypatch, Model(answer))
    monkeypatch.setattr(igt_job.IgtRunner, 'starter_maintains', lambda self, ws, project: True)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        from plaid_agent.igt.plan import REPAIR_OF
        staged.setdefault('repairs', []).extend(o for o in ops if o.get(REPAIR_OF))
        if any(o.get('kind') == 'delete_entry' for o in ops):
            refusal = PlaidAPIError('HTTP 409 This entry has 1 links now, not 0', status=409, method='POST',
                                    response_data={'error': 'This entry has 1 links now, not 0', 'links': 1})
            raise PlanError(str(refusal), 0, len(ops)) from refusal
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert staged.get('repairs'), 'the delete carried its repairs'
    patched = client.patches('vocab_items')
    touched = {i for i, _ops in patched}
    assert touched == ({'vi-ali'} if others else set()), patched
    assert 'seeAlso' not in str(patched) and 'parent' not in str(patched), patched
    deletes = [p for p in finished['report'].get('proposed') or [] if p['kind'] == 'delete_entry']
    assert len(deletes) == 1, deletes
