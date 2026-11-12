"""The entries a job makes (SPEC 7.2, 7.5): none where one fits, never in a
borrowed lexicon, always a machine draft, and after the job only an unlinked
draft of its own is deleted, and only when its starter maintains the
lexicon's home."""

from job_fixtures import JobClient, Model, call, document, job_project, reply, runner, start, stamp, use

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch
from plaid_agent.igt.project import load_project

TASKS = ['gloss', 'link']


def _ws(project=None):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['gam', 'new']}])}, project=project)
    p = load_project(client, 'p1')
    ws = JobWorkspace(client, p, TASKS)
    doc = ws.doc('d1')
    ws.stretch = Stretch(doc, p, doc.sentences, TASKS, 'J1')
    return ws


def _create(ws, form, gloss, **extra):
    return toolkit.job_call_tool(ws, 'create_entry', {'form': form, 'fields': {'gloss': gloss, **extra}}, TASKS)


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
    job = start(client, TASKS)

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


def _entries_job(maintainer):
    p = job_project()
    p['maintainers'] = ['user@example.com'] if maintainer else []
    p['writers'] = [] if maintainer else ['user@example.com']
    doc = document('d1', 'Story', [{'words': [('bb', [('bb', 'BB', 'e-linked')], 'J9')]}])
    client = JobClient({'d1': doc}, lexicon=_lexicon('J9'), project=p)
    job = start(client, TASKS, id='J9')
    return client, job


def test_the_entries_pass_deletes_an_unlinked_draft_of_its_own_for_a_maintainer():
    client, job = _entries_job(maintainer=True)
    out = runner(job).entries(job)
    deleted = [p for k, p in client.calls if k == 'vocab_items.delete']
    assert len(deleted) == 1 and 'e-unlinked' in str(deleted), deleted
    assert [e['id'] for e in out['deleted']] == ['e-unlinked']
    assert out['unlinked'] == []
    assert {e['id'] for e in out['created']} == {'e-linked', 'e-reviewed'}
    tags = [t for t in client.operation_tags if t['kind'] == 'job']
    assert tags == [{'kind': 'job', 'ref': 'job:J9/pass:entries'}]


def test_the_entries_pass_lists_the_draft_for_a_writer_and_deletes_nothing():
    client, job = _entries_job(maintainer=False)
    out = runner(job).entries(job)
    assert not [k for k, _ in client.calls if k == 'vocab_items.delete']
    assert [e['id'] for e in out['unlinked']] == ['e-unlinked'] and out['deleted'] == []
