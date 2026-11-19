"""Gaps the planted-faults campaign (PF, lane 5: the end of ``igt/job.py``)
found: behaviours of the job's record, its piece summaries, its rewrites and
its report that a slip in the code could break with every other test still
passing. Each test here failed with its fault planted."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_SENTENCE_MAX_WORDS
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import PIECE_FORM

import test_job_activity as activity
import test_job_gate as gate
import test_job_harmonize as harmonize
import test_job_tries as tries


def _summaries(client, job_id):
    return {k: json.loads(x['analysis']) for (f, k), x in client.jobs.decision_rows[job_id].items()
            if f == PIECE_FORM and k != '000000'}


# --- a piece's note names its sentences, first to last ----------------------------------------

def test_a_pieces_note_names_its_first_and_last_sentence(monkeypatch):
    """Each stretch of two sentences keeps its note under "s1 to s2" and
    "s3 to s4", as the report's notes list them."""
    client, job, finished = activity._run(monkeypatch, activity._gloss)
    assert finished['state'] == 'done'
    notes = finished['report']['notes']
    assert [n['sentences'] for n in notes] == ['s1 to s2', 's3 to s4'], notes


# --- what a refusal left is listed under the document of its sentence -------------------------

LONG = {'words': [f'zz{i}' for i in range(1, JOB_SENTENCE_MAX_WORDS + 12)]}


def test_a_selections_refusal_is_listed_under_the_document_of_its_sentence(monkeypatch):
    """A whole-selection piece stages a change in Story 2's sentence too long
    for a job: refused, and the report lists it on Story 2's row, never on
    no document's (the selection names none)."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['ta']}, LONG])})
    job = start(client, plan='selection')

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 2'})])
        if n == 2:
            return reply(calls=[call(2, 'set_analysis', {'document': 'Story 2', 'ref': 's2.w3',
                                                         'morphemes': [{'form': 'zz3'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    d1, d2 = finished['report']['documents']
    assert 'refused' not in d1, d1
    assert [(r['sentence'], r['code']) for r in d2.get('refused') or []] == [('s2', 'too-long')], d2


# --- a resumed job numbers its summaries on from core's -------------------------------------------

@pytest.mark.parametrize('seed', [0, 3, 6])
def test_a_worker_taking_a_job_up_never_files_a_summary_under_a_number_core_holds(monkeypatch, seed):
    """The worker dies after a write landed and a new one takes the job up:
    each piece summary sent is the one core keeps under its number, so no
    piece the new worker sums up is lost under the number of an earlier
    worker's (core keeps the first row of a key)."""
    with monkeypatch.context() as m:
        probe = tries.World(m, seed)
        probe.run()
        total = len(probe.client.landed_keys)
    for k in range(1, total + 1):
        with monkeypatch.context() as m:
            world = tries.World(m, seed, fail=(k, 'crash'))
            sent = []
            real = world.client.jobs.add_decisions

            def add(job_id, worker_id, rows, real=real, sent=sent):
                sent.extend((r['key'], r['analysis']) for r in rows if r['form'] == PIECE_FORM)
                return real(job_id, worker_id, rows)
            world.client.jobs.add_decisions = add
            r = world.run()
            r.end_summaries()
            kept = {(key, x['analysis']) for (f, key), x in world.client.jobs.decision_rows[tries.J].items()
                    if f == PIECE_FORM}
            lost = [json.loads(a)['piece'] for key, a in sent if (key, a) not in kept]
            assert not lost, (k, 'a summary filed under a number core already held', lost)


# --- a piece taken up again adds its model calls -----------------------------------------------------

def test_a_piece_taken_up_again_before_its_summary_counts_the_steps_of_both_runs():
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}, {'words': ['ta']}])})
    job = start(client)
    r = runner(job)
    doc = r.read(r.project(), 'd1')
    r.steps_now = 3
    r.begin_summary('k', 'd1', 'Story', doc.sentences, False, 'first', [])
    r.steps_now = 2
    r.begin_summary('k', 'd1', 'Story', doc.sentences, False, 'second', [])
    assert r.unsummed['k']['steps'] == 5, 'the model calls of the run before the write put off, and this one'
    assert r.unsummed['k']['note'] == 'second'


# --- core's passing trouble on a summary is waited out, never the summary lost -----------------

def test_a_summary_core_did_not_take_for_a_moment_is_kept_when_tried_again(monkeypatch):
    client, job, clock, _ = gate._job(monkeypatch, 'sentences')
    real = job.add_decisions
    once = {'n': 0}

    def add(decisions):
        if any(d['form'] == PIECE_FORM for d in decisions) and not once['n']:
            once['n'] = 1
            raise PlaidAPIError('HTTP 503 busy', status=503, method='POST')
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert once['n'] == 1
    assert len(_summaries(client, gate.J)) == 1, 'the piece is summed up, the 503 waited out'


# --- a sentence a person keeps changing is taken again once -------------------------------------------

@pytest.mark.parametrize('pieces', gate.PIECES)
def test_a_sentence_a_person_edits_during_each_piece_is_taken_again_only_once(monkeypatch, pieces):
    """test_job_gate's "edits during each piece", counting the pieces: the
    first, then s1 once more, then s1 skipped as changed. Never a third
    model context for it."""
    client, job, clock, _ = gate._job(monkeypatch, pieces, after=gate.BLANK)
    version = {'v': 4}

    def model(asked, n, kwargs):
        if n > 1:
            version['v'] += 1
            edited = [{'words': ['ka', 'ta'], 'translation': (f'One, edit {version["v"]}.', 'human')},
                      {'words': ['sa'], 'translation': ('Two.', 'human')}]
            client._holder('d1')['documents']['d1'] = document('d1', 'Story', edited, version=version['v'])
            client.after_write['d1'] = document('d1', 'Story', edited, version=version['v'])
            return reply('Glossed.')
        return gate._gloss()(asked, n, kwargs)
    m = use(monkeypatch, Model(model))
    gate._staged(monkeypatch)
    runner(job).work(job)
    assert ('d1-s1', 'changed') in gate._skipped(job)
    contexts = sum(1 for c in m.calls if c['n'] == 1)
    assert contexts == 2, f'the first piece and s1 once again, not {contexts}'


# --- a change not written that its writing row could not list is still counted -----------------------

def test_a_change_cut_short_that_its_writing_row_could_not_list_is_counted_more(monkeypatch):
    """test_job_landed's sentence written in part, each writing row too big
    to list its changes (``more`` counts them, :func:`writing_text`): the
    change of s1 that did not land is listed nowhere, so the report counts
    it among the proposed changes not shown."""
    import test_job_landed as landed
    real = igt_job.writing_text
    monkeypatch.setattr(igt_job, 'writing_text',
                        lambda row: real({**row, 'ops': [], 'more': len(row.get('ops') or [])}))
    client, job, sent = landed._two_words(monkeypatch, 2, refused=(2,),
                                          after=[{'words': [landed.KA, 'ta']}, {'words': ['sa']}])
    r = runner(job)
    assert r.document('d1') == 'deferred'
    assert r.document('d1') == 'done'
    parts = r.report_parts(job)
    assert parts['proposed'] == [], parts['proposed']
    assert (parts['proposed_dropped'], parts['proposed_more']) == (1, 1), parts


# --- harmonize unlinks what the analysis it sets links to no entry -------------------------------------

def test_a_rewrite_to_an_analysis_with_no_entry_takes_the_old_link_off(monkeypatch):
    """Three of the job's ka read ‘go’ with no entry, a fourth ‘go’ linked to
    an entry: the fourth is set to the majority's analysis, which links no
    entry, so its link is taken off, the one thing that differs."""
    staged = harmonize._staged(monkeypatch)
    client, job, out = harmonize._run_linking({'d1': [{'words': [
        harmonize.w('ka', 'go'), harmonize.w('ka', 'go'), harmonize.w('ka', 'go'), harmonize._linked('vi-ali')]}]},
        monkeypatch)
    assert out['changed'] and out['changed'][0]['to'] == 'ka ‘go’', out
    assert [o['kind'] for o in staged] == ['unlink'], staged
