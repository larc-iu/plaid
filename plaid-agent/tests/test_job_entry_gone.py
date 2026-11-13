"""A job never makes again an entry it made that a person deleted (the
lead's ruling on REV-JG3-5): a create of the form and gloss of an entry this
job made, which nothing in the lexicon fits now, is a proposed change, and
the links naming it are proposed with it. For every piece kind, for a later
piece's fresh choice as for the selection's second document, and after a
crash and resume (the job's rows of the entries it made are in core)."""

import pytest

from job_fixtures import JobClient, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from test_job_pieces import _docs, _lexicon_takes_creates, _model

J = 'JP'


def _creates(client):
    return [p for k, p in client.calls if k == 'vocab_items.create']


def _delete_ka(client):
    """The person deletes the job's draft "ka"."""
    client._lexicon['items'][:] = [it for it in client._lexicon['items'] if it.get('form') != 'ka']


def _proposed_create(report):
    return [c for c in report['proposed'] if c['kind'] == 'create_entry']


def _ka_in(doc, ref='s1.w1', entry='new:v1:ka#1'):
    """A piece's calls: analyse ka in ``doc``, make the entry, link it."""
    return [call(1, 'set_analysis', {'document': doc, 'ref': ref,
                                     'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
            call(2, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})], \
        [call(3, 'link_entry', {'document': doc, 'refs': [f'{ref}.m1'], 'entry_id': entry})]


def _selection_both(asked, n):
    """The selection reads both texts, analyses ka in each, makes one entry
    and links it in both."""
    if n == 1:
        return reply(calls=[call(1, 'read_document', {'document': 'Story 1'}),
                            call(2, 'read_document', {'document': 'Story 2'})])
    if n == 2:
        return reply(calls=[
            call(3, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                     'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
            call(4, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                     'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
            call(5, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})])
    if n == 3:
        return reply(calls=[call(6 + i, 'link_entry', {'document': d, 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:ka#1'})
                            for i, d in enumerate(['Story 1', 'Story 2'])])
    return reply('Glossed ka in both texts and linked it.')


def test_a_draft_a_person_deleted_between_two_documents_of_a_selection_is_proposed(monkeypatch):
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.write_piece

    def write_piece(self, project, d, *a, **kw):
        if d == 'd2':
            _delete_ka(client)
        return real(self, project, d, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write_piece', write_piece)
    use(monkeypatch, _model(piece=_selection_both))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len(_creates(client)) == 1, 'the draft the person deleted was created again'
    gone = _proposed_create(finished['report'])
    assert gone and igt_job.ENTRY_GONE in gone[0]['label'], gone
    assert [c for c in finished['report']['proposed'] if c['kind'] == 'link' and c['document'] == 'Story 2'], \
        'the link naming it is proposed with it'
    links = [p for k, p in client.calls if k == 'vocab_links.create']
    assert len(links) == 1, links


def test_a_draft_a_person_deleted_between_two_stretches_is_proposed_by_the_later_piece(monkeypatch):
    """The later stretch's model chooses afresh to make the entry (nothing
    in the lexicon fits it any more, so staging takes the create)."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}] * 6)})
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='sentences')
    real = igt_job.IgtRunner.attempt
    seen = []

    def attempt(self, project, d, ids):
        seen.append(ids)
        if len(seen) == 2:
            _delete_ka(client)
        return real(self, project, d, ids)
    monkeypatch.setattr(igt_job.IgtRunner, 'attempt', attempt)

    def piece(asked, n):
        ref = 's6.w1' if 'Your piece: s6.' in asked else 's1.w1'
        first, then = _ka_in('Story 1', ref)
        if n == 1:
            return reply(calls=first)
        if n == 2:
            return reply(calls=then)
        return reply('Glossed ka and linked it.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len(seen) == 2, seen
    assert len(_creates(client)) == 1, 'the later stretch made the deleted draft again'
    gone = _proposed_create(finished['report'])
    assert gone and igt_job.ENTRY_GONE in gone[0]['label'], finished['report']['proposed']
    proposed = [(c['kind'], c['ref']) for c in finished['report']['proposed']]
    assert ('link', 's6.w1') in proposed, proposed


class Crash(BaseException):
    """The worker's process dies here."""


def test_a_draft_a_person_deleted_after_a_crash_is_proposed_by_the_resumed_job(monkeypatch):
    """The first worker makes the entry with Story 1's write and dies before
    Story 2's. The person deletes the draft. The next worker runs the
    selection again: the job's row of the entry it made is in core, so the
    create is proposed, never made again."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.write

    def write(self, project, d, *a, **kw):
        if d == 'd2':
            raise Crash()
        return real(self, project, d, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write', write)
    use(monkeypatch, _model(piece=_selection_both))
    with pytest.raises(Crash):
        run_job(job, runner(job))
    assert len(_creates(client)) == 1
    monkeypatch.setattr(igt_job.IgtRunner, 'write', real)
    _delete_ka(client)
    use(monkeypatch, _model(piece=_selection_both))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len(_creates(client)) == 1, 'the resumed job made the deleted draft again'
    assert _proposed_create(finished['report']), finished['report']['proposed']


def test_a_write_that_sent_nothing_does_not_count_its_entry_as_made(monkeypatch):
    """A try core refused before anything landed (a 409 from the starter's
    own browser): the job knows its entry was not made, and the try taken
    again makes it."""
    from plaid_client import PlaidAPIError
    from plaid_agent.core.plan import PlanError
    client = JobClient(_docs(1))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='document')
    real = igt_job.execute_plan
    once = []

    def execute(c, ops, **kw):
        if not once:
            once.append(1)
            err = PlanError('conflict', 0, len(ops))
            err.__cause__ = PlaidAPIError('HTTP 409', status=409, method='POST')
            raise err
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        first, then = _ka_in('Story 1')
        return reply(calls=first) if n == 1 else reply(calls=then) if n == 2 else reply('Linked ka.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert once and finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len(_creates(client)) == 1 and not _proposed_create(finished['report'])


def test_an_entry_fits_a_create_only_of_the_same_morph_type():
    """REV-JG3-8: a suffix -ka 'go' the model creates is not the stem ka 'go'
    a person made: the type an entry goes by (its own, else its headword's,
    the reserved key morphType) is compared with form and gloss."""
    v = {'id': 'v1', 'fields': [{'name': 'gloss', 'role': 'gloss', 'declared': True}]}
    stem = {'id': 'e1', 'form': 'ka', 'metadata': {'gloss': 'go'}}
    suffix = {'id': 'e2', 'form': 'ka', 'metadata': {'gloss': 'go', 'morphType': 'suffix'}}
    sense = {'id': 'e3', 'form': 'ka', 'metadata': {'gloss': 'go', 'parent': 'e4'}}
    head = {'id': 'e4', 'form': 'ka', 'metadata': {'morphType': 'prefix'}}
    create = {'kind': 'create_entry', 'form': 'ka', 'metadata': {'gloss': 'go', 'morphType': 'suffix'}}
    assert igt_job.fitting_entry(v, [stem], create) is None
    assert igt_job.fitting_entry(v, [stem, suffix], create) is suffix
    assert igt_job.fitting_entry(v, [sense, head], {**create, 'metadata': {'gloss': 'go', 'morphType': 'prefix'}}) \
        is sense
    assert igt_job.fitting_entry(v, [stem], {**create, 'metadata': {'gloss': 'go'}}) is stem


def test_a_selections_create_that_someone_elses_new_entry_fits_is_proposed(monkeypatch):
    """REV-JG3-8: a person makes an entry that fits the selection's create
    after the piece staged it. Nobody chose that entry: the create and its
    link are proposed, saying so, and nothing is linked to the person's
    entry unasked."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.write_piece

    def write_piece(self, project, d, *a, **kw):
        if d == 'd1' and not [it for it in client._lexicon['items'] if it['id'] == 'e-person']:
            client._lexicon['items'].append({'id': 'e-person', 'form': 'ka', 'metadata': {'gloss': 'go'}})
        return real(self, project, d, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write_piece', write_piece)
    use(monkeypatch, _model(piece=_selection_both))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert not _creates(client) and not [p for k, p in client.calls if k == 'vocab_links.create']
    made = _proposed_create(finished['report'])
    assert made and igt_job.ENTRY_EXISTS in made[0]['label'], made
    assert len([c for c in finished['report']['proposed'] if c['kind'] == 'link']) == 2


def test_a_selections_note_meets_a_502_and_its_model_runs_once(monkeypatch):
    """REV-JG3-9: one 502 on the selection's note row is tried again on its
    own: the model context, maybe hours of work, is not run again."""
    from test_job_marks import _fail_once, _has_form
    client = JobClient(_docs(2))
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    model = use(monkeypatch, _model(piece=_selection_both))
    failed = _fail_once(client, 'add_decisions', _has_form(' note '))
    finished = run_job(job, runner(job))
    assert failed and finished['state'] == 'done'
    assert len([c for c in model.calls if c['n'] == 1 and 'whole selection' in c['asked']]) == 1
    assert [n['note'] for n in finished['report']['notes']] == ['Glossed ka in both texts and linked it.']


def test_a_selection_core_failed_through_its_tries_says_so_in_the_plan(monkeypatch):
    """REV-JG3-9: a selection left to the walk after core's trouble outlasted
    its tries has its fallback row, so the report's plan says it."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')

    def selection_work(self, project, live):
        raise PlaidAPIError('HTTP 502', status=502, method='GET')
    monkeypatch.setattr(igt_job.IgtRunner, 'selection_work', selection_work)
    use(monkeypatch, _model(piece=lambda asked, n: reply('Nothing.')))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert {'document_id': None, 'reason': 'failed'} in finished['report']['plan']['fallback']
