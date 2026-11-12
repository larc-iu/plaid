"""People's analyses as the project is when they are used (REV-J-B2 S2-1):
harmonize reads them afresh when it begins, and each document the walk takes
up sees what people wrote since the job started. A person's correction made
while the job runs is never voted against, and a second analysis a person
adds meanwhile leaves the form ``people-differ``."""

import copy

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job

J = 'JN'


def _morph(gloss):
    return [{'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': gloss}}]


def _job_ka(gloss, who=J):
    return ('ka', [('ka', gloss)], who)


def _person_edits(client, document_id, raw):
    """A person's edit of ``document_id`` to ``raw``: what reads answer from
    now on, at a version one past the one listed."""
    holder = client._holder(document_id)['documents'][document_id]
    holder['version'] = holder.get('version', 1) + 1
    client.after_write[document_id] = {**raw, 'version': holder['version']}


def _job_over_a_then_b(monkeypatch, edit):
    """Document A, four blank "ka" the model glosses go, go, come, go. While
    the model works on B, ``edit(client)`` runs: a person's edit."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['ka', 'ka', 'ka', 'ka']}]),
                        'B': document('B', 'Doc B', [{'words': ['mo']}]),
                        'P': document('P', 'Other', [{'words': ['zz']}])})
    # What A reads as once the job wrote it.
    client.after_write['A'] = document('A', 'Doc A', [{'words': [
        _job_ka('go'), _job_ka('go'), _job_ka('come'), _job_ka('go')]}])
    job = start(client, ['gloss'], id=J, documents=['A', 'B'])
    edited = {}

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if 'Document "Doc A"' in asked:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Doc A', 'analyses': [
                {'ref': f's1.w{i}', 'morphemes': _morph(g)} for i, g in enumerate(['go', 'go', 'come', 'go'], 1)]})])
        edit(client)
        edited['yes'] = True
        return reply(calls=[call(1, 'set_analysis', {'document': 'Doc B', 'ref': 's1.w1', 'morphemes': [
            {'form': 'mo', 'type': 'stem', 'fields': {'Morph Gloss': 'x'}}]})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert edited, 'the person edited during the job'
    return finished, model, client


def _corrected(client):
    """A person corrects the job's A w4 from go to come (the app's edit
    confirms the span it changes)."""
    _person_edits(client, 'A', document('A', 'Doc A', [{'words': [
        _job_ka('go'), _job_ka('go'), _job_ka('come'),
        ('ka', [('ka', 'come')], {'token': J, 'span': f'confirmed:{J}', 'link': J})]}]))


def test_harmonize_takes_a_correction_a_person_made_during_the_job(monkeypatch):
    finished, model, client = _job_over_a_then_b(monkeypatch, _corrected)
    harmonize = finished['report']['harmonize']
    assert harmonize['changed'] == [{'form': 'ka', 'to': 'ka ‘come’', 'by': 'person',
                                     'from': [{'analysis': 'ka ‘go’', 'count': 2, 'documents': ['A']}]}], harmonize


def test_a_second_analysis_a_person_adds_during_the_job_leaves_the_form(monkeypatch):
    def edit(client):
        # A person corrects A's w4 to come, and analyses ka as walk in P,
        # a document outside the job.
        _corrected(client)
        _person_edits(client, 'P', document('P', 'Other', [{'words': [('ka', [('ka', 'walk')], 'human')]}]))
    finished, model, client = _job_over_a_then_b(monkeypatch, edit)
    assert finished['report']['harmonize']['changed'] == []
    assert [x['reason'] for x in finished['report']['harmonize']['left']
            if x['form'] == 'ka'][:1] == ['people-differ'], finished['report']['harmonize']


def test_a_later_document_is_told_of_a_correction_a_person_made_during_the_job(monkeypatch):
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['mo']}]),
                        'B': document('B', 'Doc B', [{'words': ['ka']}]),
                        'P': document('P', 'Other', [{'words': ['ka']}])})
    client.after_write['A'] = document('A', 'Doc A', [{'words': [('mo', [('mo', 'x')], J)]}])
    client.after_write['B'] = copy.deepcopy(client._holder('B')['documents']['B'])
    job = start(client, ['gloss'], id=J, documents=['A', 'B'])

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if 'Document "Doc A"' in asked:
            # While A's stretch runs, a person analyses ka in P.
            _person_edits(client, 'P', document('P', 'Other', [{'words': [('ka', [('ka', 'eat')], 'human')]}]))
            return reply(calls=[call(1, 'set_analysis', {'document': 'Doc A', 'ref': 's1.w1', 'morphemes': [
                {'form': 'mo', 'type': 'stem', 'fields': {'Morph Gloss': 'x'}}]})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    asked_b = next(c['asked'] for c in model.calls if 'Document "Doc B"' in c['asked'])
    assert 'people: ka ‘eat’ (1)' in asked_b, asked_b


def test_the_people_are_read_again_only_where_a_document_changed(monkeypatch):
    """The cost of seeing people's work as it is: per document the walk
    takes up, one list of the project's documents and a read of each one
    whose version moved, never a walk of the whole project again."""
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['x']}]) for i in range(1, 7)}
    client = JobClient(docs)
    reads = {}
    get = client.documents.get

    def counted(document_id, **kw):
        reads[document_id] = reads.get(document_id, 0) + 1
        return get(document_id, **kw)
    client.documents.get = counted
    job = start(client, ['gloss'], documents=['d1', 'd2', 'd3'])

    def answer(asked, n, kwargs):
        if n == 1 and 'Document "Story 2"' in asked:
            _person_edits(client, 'd5', document('d5', 'Story 5', [{'words': [('x', [('x', 'y')], 'human')]}]))
        return reply('Done.')
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    assert [reads.get(d, 0) for d in ('d4', 'd5', 'd6')] == [1, 2, 1], reads
