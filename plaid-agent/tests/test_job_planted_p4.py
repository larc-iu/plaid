"""Planted-faults campaign PF, lane 4 (igt/job.py lines 4351 to 5800): tests
for behaviours of the job worker that a fault planted there left unnoticed.
Each test names the behaviour, never the fault."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job

J = 'JP4'


# --- people's precedent follows the project's documents --------------------------------------

def _gloss_a_then_b(monkeypatch, during_a):
    """A job over A (one blank "mo") then B (one blank "ka"). P, outside the
    job, holds a person's analysis of ka as "eat". While A's stretch runs,
    ``during_a(client)``. The model's calls, to read what B was told."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['mo']}]),
                        'B': document('B', 'Doc B', [{'words': ['ka']}]),
                        'P': document('P', 'Other', [{'words': [('ka', [('ka', 'eat')], 'human')]}])})
    client.after_write['A'] = document('A', 'Doc A', [{'words': [('mo', [('mo', 'x')], J)]}])
    client.after_write['B'] = document('B', 'Doc B', [{'words': ['ka']}])
    job = start(client, id=J, documents=['A', 'B'])

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if 'Document "Doc A"' in asked:
            during_a(client)
            return reply(calls=[call(1, 'set_analysis', {'document': 'Doc A', 'ref': 's1.w1', 'morphemes': [
                {'form': 'mo', 'type': 'stem', 'fields': {'Morph Gloss': 'x'}}]})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    return next(c['asked'] for c in model.calls if 'Document "Doc B"' in c['asked'])


def _delete_p(client):
    del client._holder('P')['documents']['P']


@pytest.mark.parametrize('deleted', [False, True])
def test_a_document_deleted_during_the_job_is_no_longer_peoples_precedent(monkeypatch, deleted):
    """People's precedent is the project as it is when a document's walk
    begins: a document deleted since the job read it gives none."""
    asked_b = _gloss_a_then_b(monkeypatch, _delete_p if deleted else lambda client: None)
    assert ('people: ka ‘eat’ (1)' in asked_b) is not deleted, asked_b


# --- whose values the evidence counts as people's ---------------------------------------------

@pytest.mark.parametrize('who, shown', [('human', True), ('confirmed:machine', True), ('machine', False)])
def test_another_producers_unverified_value_is_not_peoples_evidence(monkeypatch, who, shown):
    """A Role job: "sa" is empty in Role in s2 and holds Role patient in s1.
    A person's value, or a machine one a person confirmed, is people's
    evidence. Another producer's unverified value is no one's: the block
    never offers it as what people wrote."""
    from job_fixtures import ROLE, fields_project, with_values
    spec = [{'words': ['sa']}, {'words': ['sa', 'mo']}]
    raw = with_values(document('d1', 'Story', spec), [(ROLE, 'd1-s1w1', 'patient', who)])
    client = JobClient({'d1': raw}, project=fields_project())
    job = start(client, 'Fill Role.', id=J, fills=(ROLE,))
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    run_job(job, runner(job))
    asked = model.calls[0]['asked']
    assert ('- "sa": people: patient (1)' in asked) is shown, asked


# --- the changes a write proposes are kept only once the write landed -------------------------

def test_a_write_put_off_with_nothing_landed_proposes_nothing(monkeypatch):
    """A document piece glosses sa (applied) and renames the document (project
    setup: proposed). Its write is refused with the document locked (423)
    before anything of it lands, so the document is put off. Taken again,
    the piece glosses sa alone. The rename never went with a write that
    landed: the report proposes nothing (REV-J-B2 S4)."""
    from plaid_client import PlaidAPIError
    from plaid_agent.core.plan import PlanError
    from plaid_agent.igt import job as igt_job
    from test_job_pieces import _docs, _model
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='document')
    pieces = []

    def piece(asked, n):
        if n == 1:
            pieces.append(1)
            calls = [call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's2.w1', 'morphemes': [
                {'form': 'sa', 'fields': {'Morph Gloss': 'G'}}]})]
            if len(pieces) == 1:
                calls.append(call(3, 'rename_document', {'document': 'Story 1', 'new_name': 'Story one'}))
            return reply(calls=calls)
        return reply('Glossed sa.')
    use(monkeypatch, _model(piece=piece))
    real, refused = igt_job.execute_plan, []

    def execute(c, ops, **kw):
        if not refused:
            refused.append(1)
            raise PlanError('locked', 0, len(ops)) from PlaidAPIError('HTTP 423', status=423, method='POST')
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert refused and len(pieces) == 2 and finished['state'] == 'done', (refused, pieces, finished['state'])
    assert finished['report']['proposed'] == [], finished['report']['proposed']
    assert finished['report']['totals']['proposed'] == 0


# --- only a sentence too long for a job is refused as one -------------------------------------

def test_a_change_in_a_sentence_skipped_as_failed_is_not_refused_as_too_long(monkeypatch):
    """Stretches of one sentence. s1's stretch fails at the output limit and
    s1 is skipped as failed. s2's stretch analyses its own words and, with
    s1 before it as context, s1's first word too: that change is written, as
    a later piece's change in an earlier sentence is (REV-JH-1). Only a
    sentence the checks skipped as too long refuses a change (S8-1)."""
    from test_job_piece_ceiling import _analyse, _applying, _doc, targets_named
    from plaid_agent.igt import job as igt_job

    def answer(asked, n, kwargs):
        if 'Your piece: s' not in str(asked):
            return reply('Done.')
        if targets_named(asked) == [1]:
            return reply('...', finish='length')
        if n == 1:
            s = targets_named(asked)[0]
            extra = [call(999, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]})] if s == 2 else []
            return reply(calls=_analyse(s) + extra)
        return reply('Done.')
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J)
    client.analysed = _applying(monkeypatch, client)
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    skipped = job.rows['d1']['skipped']
    assert [(s['sentence'], s['reason']) for s in skipped] == [('s1', 'failed')], skipped
    assert 'd1-s1w1' in client.analysed, sorted(client.analysed)


# --- a translation the job refreshed and a person cleared is not written again ----------------

def test_a_machine_translation_the_job_replaced_and_a_person_cleared_is_not_written_again(monkeypatch):
    """s3 holds another producer's machine translation. Piece s1-s2 also
    translates s3, replacing that draft (``refreshed``), and the starter
    clears it at once. The piece of s3 and s4 is not told s3's translation
    is empty, and when it writes one anyway it is left out (REV-LNW-1), as
    for a translation the job wrote in a blank."""
    from fixtures import TRANS
    from job_fixtures import empty_translations, targets_named
    from plaid_agent.igt import job as igt_job
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    sentences = [{'words': [w]} for w in ('ka', 'pa', 'sa', 'mo')]
    first = [{**x, **({'translation': ('Old.', 'machine')} if i == 3 else {})} for i, x in enumerate(sentences, 1)]
    client = JobClient({'d1': document('d1', 'Story', first)})
    job = start(client, 'Translate the sentences.', id=J, fills=(TRANS,))
    real, sent, translated = igt_job.execute_plan, [], set()

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        sent.append([o.get('token_id') for o in ops if o.get('kind') == 'set_span'])
        translated.update(sent[-1])
        if len(sent) == 1:
            translated.discard('d1-s3')
        client.after_write['d1'] = document('d1', 'Story', [
            {**x, **({'translation': ('T.', J)} if f'd1-s{i}' in translated else {})}
            for i, x in enumerate(sentences, start=1)], version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    told = []

    def model(asked, n, kwargs):
        if n > 1 or 'Your piece: s' not in asked:
            return reply('Done.')
        mine = targets_named(asked)
        told.append([str(s) for s in empty_translations(asked)])
        refs = ['s1', 's2', 's3'] if 1 in mine else ['s3', 's4']
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': refs, 'field': 'Translation',
                                                  'value': 'T.'})])
    use(monkeypatch, Model(model))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert 'd1-s3' in sent[0] and all('d1-s3' not in x for x in sent[1:]), sent
    assert told[1:] == [['4']], told
    (doc,) = finished['report']['documents']
    assert doc['counts']['refreshed'] == 1 and doc['counts']['changed'] == 1, doc['counts']


# --- a write refused for something gone is tried JOB_DEFER_ROUNDS times -----------------------

def test_a_write_refused_for_something_gone_is_tried_the_defer_rounds_and_no_more(monkeypatch):
    """REV-FIX3-5: the same stretch refused for something gone on every walk
    is sent JOB_DEFER_ROUNDS times, and its sentences are skipped as changed
    on the last refusal, never sent once more."""
    from plaid_client import PlaidAPIError
    from plaid_agent.core.limits import JOB_DEFER_ROUNDS
    from plaid_agent.core.plan import PlanError
    from plaid_agent.igt import job as igt_job
    from test_job_out_of_date import _gam_job
    client, job = _gam_job(monkeypatch, delete_at=0)
    sent = []

    def execute(c, ops, **kw):
        sent.append(1)
        try:
            raise PlaidAPIError('HTTP 404 Vocab item not found', status=404)
        except PlaidAPIError as e:
            raise PlanError('Vocab item not found', 0, len(ops)) from e
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    rows = {r['document_id']: r for r in client.jobs.get(job.id)['documents']}
    assert [(x['sentence'], x['reason']) for x in rows['d1']['skipped']] == [('s1', 'changed')]
    assert JOB_DEFER_ROUNDS == 3 and len(sent) == JOB_DEFER_ROUNDS, len(sent)


# --- an administrator who starts a job may rename the project's entries -----------------------

@pytest.mark.parametrize('admin', [False, True])
def test_an_administrator_who_only_writes_the_project_has_an_entry_renamed(monkeypatch, admin):
    """The starter writes the project and maintains none of it. A rename of
    a lexicon entry is a maintainer's, so core refuses it to a writer and
    the job proposes it. An administrator counts as a maintainer (CONTRACT
    4, S9-1): the job renames the entry."""
    from job_fixtures import job_project
    p = job_project()
    p['maintainers'], p['writers'] = [], ['user@example.com']
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])}, project=p,
                       admins=('user@example.com',) if admin else ())
    job = start(client, id=J, plan='document')

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(2, 'rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gaam'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    renamed = [x for b in client.batches for k, x in b if k == 'vocab_items.update'] + \
        [x for k, x in client.calls if k == 'vocab_items.update']
    proposed = [c['kind'] for c in finished['report']['proposed']]
    if admin:
        assert renamed and proposed == [], (renamed, proposed)
    else:
        assert not renamed and proposed == ['rename_entry'], (renamed, proposed)
