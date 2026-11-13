"""The entries a job makes (SPEC 7.2, 7.5): none where one fits, never in a
borrowed lexicon, always a machine draft, and after the job none is deleted:
an entry of the job with no links is listed for a person to delete (the
lead's ruling on REV-JG2-1, a job deletes nothing)."""

import pytest

from job_fixtures import JobClient, Model, call, document, job_project, reply, runner, start, stamp, use

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch
from plaid_agent.igt.project import load_project



def _ws(project=None):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['gam', 'new']}])}, project=project)
    p = load_project(client, 'p1')
    ws = JobWorkspace(client, p)
    doc = ws.doc('d1')
    ws.stretch = Stretch(doc, p, doc.sentences, 'J1')
    return ws


def _create(ws, form, gloss, **extra):
    return toolkit.job_piece_call(ws, 'create_entry', {'form': form, 'fields': {'gloss': gloss, **extra}})


def test_an_entry_that_fits_is_named_and_not_created():
    ws = _ws()
    out = _create(ws, 'gam', 'fish')
    assert 'exists: link it' in out and 'gam' in out and not ws.ops
    assert 'entry_id' in _create(ws, 'gam', 'cat'), 'another gloss is another entry'


def test_an_entry_staged_earlier_in_the_stretch_fits_too():
    ws = _ws()
    assert 'entry_id' in _create(ws, 'tok', 'stone')
    out = _create(ws, 'tok', 'stone')
    assert 'staged already' in out and len(ws.ops) == 1


def test_no_entry_is_created_in_a_borrowed_lexicon():
    p = job_project()
    p['vocabs'][0]['project'] = 'someone-else'
    ws = _ws(p)
    out = _create(ws, 'tok', 'stone')
    assert 'belongs to another project' in out and not ws.ops


def test_an_entry_a_job_creates_is_a_machine_draft_whatever_the_model_staged(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['tok']}])})
    job = start(client)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'tok', 'type': 'stem', 'fields': {'Morph Gloss': 'stone'}}]}),
                call(2, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone', 'status': 'published'}}),
            ])
        if n == 2:
            return reply(calls=[call(3, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'],
                                                      'entry_id': 'new:v1:tok#1'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    runner(job).document('d1')
    made = [p for k, p in client.calls if k == 'vocab_items.create']
    assert made, client.kinds
    metadata = made[0]['args'][2] if len(made[0]['args']) > 2 else made[0]['kwargs']['metadata']
    assert metadata['status'] == 'machine'
    assert metadata['prov'] == 'inferred' and metadata['provDetail']['job'] == job.id
    assert 'provConfirmed' not in metadata


def _lexicon(job_id):
    def item(i, form, status, who=job_id):
        return {'id': i, 'form': form, 'metadata': {'gloss': form.upper(), 'status': status, **stamp(who)}}
    return {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        item('e-unlinked', 'aa', 'machine'),
        item('e-linked', 'bb', 'machine'),
        item('e-reviewed', 'cc', 'reviewed'),
        item('e-person', 'dd', 'machine', who='human'),
    ]}


def _entries_job(maintainer, lexicon=None, ref_field=False):
    p = job_project()
    if ref_field:
        p['vocabs'][0]['config']['igt']['fields']['variantOf'] = {'type': 'item', 'inline': False}
    p['maintainers'] = ['user@example.com'] if maintainer else []
    p['writers'] = [] if maintainer else ['user@example.com']
    doc = document('d1', 'Story', [{'words': [('bb', [('bb', 'BB', 'e-linked')], 'J9')]}])
    client = JobClient({'d1': doc}, lexicon=lexicon or _lexicon('J9'), project=p)
    job = start(client, id='J9')
    return client, job


def _no_delete(client):
    """No call of the job's deletes anything, and nothing is executed as a
    plan by the entries pass."""
    return not [k for k, _ in client.calls if 'delete' in k]


@pytest.mark.parametrize('maintainer', [True, False])
def test_the_entries_pass_deletes_nothing_and_lists_each_entry_with_no_links(maintainer):
    """A job deletes nothing (the lead's ruling on REV-JG2-1): an entry the
    job created that has no link is left as it is and listed, whoever
    started the job."""
    client, job = _entries_job(maintainer=maintainer)
    out = runner(job).entries(job)
    assert _no_delete(client), [k for k, _ in client.calls if 'delete' in k]
    assert not [t for t in client.operation_tags if t['kind'] == 'job'], 'the pass writes nothing'
    assert 'deleted' not in out
    assert [e['id'] for e in out['unlinked']] == ['e-unlinked', 'e-reviewed']
    assert {e['id'] for e in out['created']} == {'e-unlinked', 'e-linked', 'e-reviewed'}
    assert all(e['lexicon'] == 'v1' for e in out['unlinked'])


@pytest.mark.parametrize('maintainer', [True, False])
def test_a_job_ending_with_a_draft_of_its_own_with_no_links_deletes_nothing(maintainer):
    """The end of a job (harmonize, the entries pass, the report) with a
    draft of its own nothing links: the draft stays, no delete call of any
    kind is made, and the report lists it with no links."""
    from plaid_agent.core.job import run_job
    client, job = _entries_job(maintainer=maintainer)
    job.status['phase'] = 'harmonizing'
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _no_delete(client), [k for k, _ in client.calls if 'delete' in k]
    entries = finished['report']['entries']
    assert 'deleted' not in entries
    assert [e['id'] for e in entries['unlinked']] == ['e-unlinked', 'e-reviewed']


def _proposed_creates(report):
    return [(c['kind'], c['to']) for c in report['proposed'] if c['kind'] == 'create_entry']


def test_an_entry_the_model_staged_and_nothing_linked_is_created_as_a_machine_draft(monkeypatch):
    """Ruling 17: a create_entry is applied whether or not a link names it
    (a job told to add entries makes them). It is a machine draft, never a
    proposed change."""
    from plaid_agent.core.job import run_job
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['tok']}])})
    job = start(client)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'tok', 'type': 'stem',
                                                        'fields': {'Morph Gloss': 'stone'}}]}),
                call(2, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}}),
            ])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    made = [p for k, p in client.calls if k == 'vocab_items.create']
    assert len(made) == 1 and 'machine' in str(made[0])
    assert _proposed_creates(finished['report']) == [] and finished['report']['totals']['proposed'] == 0


def _tok(link):
    """A stretch's calls: tok analysed, an entry for it staged, and linked
    when ``link``."""
    calls = [call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                 {'form': 'tok', 'type': 'stem', 'fields': {'Morph Gloss': 'stone'}}]}),
             call(2, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}})]
    if link:
        calls.append(call(3, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:tok#1'}))
    return reply(calls=calls)


def _proposed_rows(client, job):
    return [f for (f, _k) in client.jobs.decision_rows.get(job.id, {}) if f.startswith(' change ')]


def test_a_change_is_recorded_as_proposed_only_once_the_stretch_was_written(monkeypatch):
    """REV-J-B2 S4: a stretch whose write never landed (refused twice as the
    document moved under it, so put off) records no proposal. Taken again,
    the model links the entry and it is created: the report proposes
    nothing."""
    from plaid_client import PlaidAPIError
    from plaid_agent.core.job import run_job
    from plaid_agent.core.plan import PlanError
    from plaid_agent.igt import job as igt_job
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['tok']}])})
    job = start(client)
    real, refusals = igt_job.execute_plan, {'n': 2}

    def execute(c, ops, **kw):
        if refusals['n']:
            refusals['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 409', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    stretches = []

    def answer(asked, n, kwargs):
        if n == 1:
            stretches.append(1)
            return _tok(link=len(stretches) > 1)
        if len(stretches) == 1:
            assert not _proposed_rows(client, job)
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert len(stretches) == 2, 'the stretch was asked again once the document was put off'
    assert [p for k, p in client.calls if k == 'vocab_items.create'], 'linked the second time, so created'
    assert not _proposed_rows(client, job), 'the write that would have proposed it never landed'
    assert finished['report']['proposed'] == []
