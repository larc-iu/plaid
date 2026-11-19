"""Tests the planted-faults campaign PF (lane 2, job.py's guards, the writing
rows and the runner's reads) found missing: each fails with a small slip
planted in ``plaid_agent.igt.job`` that the job tests let through."""

from collections import Counter

import pytest

from fixtures import FakeClient, GLOSS, MGLOSS, lexicon_raw
from job_fixtures import JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanOutOfDate
from plaid_agent.igt import job as igt_job, toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch, Write
from plaid_agent.igt.project import load_project

J = 'JP2'


def _piece(only_new=None):
    client = FakeClient()
    ws = JobWorkspace(client, load_project(client, 'p1'))
    ws.edits_text = True
    ws.only_new = only_new
    return ws


def _write(client, doc_id, ops, within=None):
    project = load_project(client, 'p1')
    doc = igt_job.parse_document(client.documents.get(doc_id, include_body=True), project)
    st = Stretch(doc, project, list(doc.sentences), J)
    return Write(doc_id, '', st, [s.id for s in doc.sentences], ops, Counter(), doc, within=within), doc


# --- the staging guards --------------------------------------------------------------------------

def test_a_phrase_link_over_an_added_word_and_one_the_job_did_not_add_is_refused():
    """Under onlynew, every word a multi-word expression's link names must be
    one the job added, not only the first."""
    ws = _piece()
    w2 = ws.doc('Text 1').sentences[0].words[1]
    ws.only_new = ({w2.id}, set())
    out = toolkit.call_tool(ws, 'link_phrase', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'],
                                                'entry_form': 'gam#1'})
    assert [o for o in ws.ops if o.get('kind') != 'create_entry'] == [], (out, ws.ops)
    assert [e['code'] for e in ws.left_by_refusal] == ['not-added'], out


def test_a_change_in_a_sentence_too_long_for_a_job_is_refused_when_staged():
    """The model is told at once to leave a sentence the checks skipped as
    too long, and nothing is staged there (S8-1)."""
    ws = _piece()
    ws.too_long = {ws.doc('Text 1').sentences[0].id}
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert ws.ops == [], out
    assert 'too long for a job' in str(out), out
    assert [e['code'] for e in ws.left_by_refusal] == ['too-long']


def test_the_same_refusal_met_twice_is_left_once():
    """A model that makes the same refused call again leaves one line in the
    report's refused list, not two."""
    ws = _piece(only_new=(set(), set()))
    for _ in range(2):
        toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert [e['code'] for e in ws.left_by_refusal] == ['not-added'], ws.left_by_refusal


def test_an_analysis_of_the_added_word_named_by_its_number_alone_is_taken_up_after_the_text_edit(monkeypatch):
    """As test_job_only_new's test of the added word, but the analysis names
    the word by its number in the retyped sentence (``s2.w1``, no form):
    told it is taken up after the text edit, and never listed as refused."""
    from plaid_agent.core.prompt import JOB_TEXT_THEN_FILL
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and analyse it.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS))

    def execute(c, ops, **kw):
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1 or igt_job.AFTER_TEXT_LINE in asked:
            return reply('Done.')
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'}),
                            call(2, 'set_analysis', {'document': 'Story', 'ref': 's2.w1', 'morphemes': [
                                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    told = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert any(JOB_TEXT_THEN_FILL in t for t in told), told
    assert not finished['report']['documents'][0].get('refused')


# --- core's refusals ---------------------------------------------------------------------------

def test_a_tool_that_meets_something_gone_is_the_models_to_hear_and_the_job_goes_on(monkeypatch):
    """Core's 403 that names nothing (``unresolved``: an entry or lexicon
    deleted since) inside a tool call is told to the model, as a 404 is,
    never passed up to end the job or its document."""
    from plaid_agent.igt import workspace
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, id=J)
    real = workspace.Workspace.lexicon

    def lexicon(self, vocab):
        if (getattr(self, 'calling', None) or (None,))[0] == 'read_lexicon':
            raise PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Forbidden', 'unresolved': True})
        return real(self, vocab)
    monkeypatch.setattr(workspace.Workspace, 'lexicon', lexicon)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'read_lexicon', {})])
        if n == 2:
            return reply(calls=[call(2, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), client.jobs.rows[J].get('message'))
    told = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert told and told[0].startswith('Error'), told
    assert client.jobs.get(J)['documents'][0]['state'] == 'done'


def test_core_out_of_reach_while_one_link_is_checked_again_never_drops_the_link(monkeypatch):
    """A try refused out of date has each link checked again alone; core out
    of reach during that check is core's trouble, tried again, never a link
    dropped as changed (``out_of_date``)."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['gam']}])}, lexicon=lexicon_raw())
    job = start(client, id=J)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'gam', 'type': 'stem', 'fields': {'Morph Gloss': 'fish'}}]}),
                call(2, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'], 'entry_id': 'vi-gam'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    real_execute, real_check = igt_job.execute_plan, igt_job.check_entries
    left = {'execute': 1, 'check': 1}

    def execute(c, ops, **kw):
        if left['execute']:
            left['execute'] -= 1
            raise PlanOutOfDate(['an entry this plan links is gone'])
        return real_execute(c, ops, **kw)

    def check(c, ops, project, *a, **kw):
        if left['check']:
            left['check'] -= 1
            try:
                raise PlaidAPIError('HTTP 502', status=502)
            except PlaidAPIError as e:
                raise PlanOutOfDate(['the lexicon "Lexicon" could not be read']) from e
        return real_check(c, ops, project, *a, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    monkeypatch.setattr(igt_job, 'check_entries', check)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert [p for k, p in client.calls if k.startswith('vocab_links')], 'the link is written'
    assert client.jobs.get(J)['documents'][0]['counts']['changed'] == 0


# --- the writing rows --------------------------------------------------------------------------

def _two_sentences():
    return JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}, {'words': ['sa', 'mo']}])})


def test_an_entry_linked_from_both_halves_of_a_cut_try_counts_once():
    """A try cut in two at a sentence boundary: the entry both halves link is
    sent with each (the later links what the earlier made) and counted once."""
    client = _two_sentences()
    _, doc = _write(client, 'd1', [])
    w1, w2 = doc.sentences[0].words[0].id, doc.sentences[1].words[0].id
    create = {'kind': 'create_entry', 'key': 'k1', 'vocab_id': 'v1', 'form': 'zz'}
    ops = [create] + [{'kind': 'link', 'token_id': w, 'new_entry_key': 'k1', 'vocab_item_id': None} for w in (w1, w2)]
    w, _ = _write(client, 'd1', ops)
    halves = w.halve(ops)
    assert halves and len(halves) == 2 and all(any(o['kind'] == 'create_entry' for o in h) for h in halves)
    entries = sum(row['counts'].get('entries', 0) for i, h in enumerate(halves) for _, row in w.rows(f's{i}', h))
    assert entries == 1


def test_a_multi_word_expressions_link_counts_as_a_link_made():
    client = _two_sentences()
    _, doc = _write(client, 'd1', [])
    op = {'kind': 'link_phrase', 'token_ids': [w.id for w in doc.sentences[0].words], 'vocab_item_id': 'vi-gam'}
    w, _ = _write(client, 'd1', [op])
    assert w.counts_of([op])['links'] == 1


def test_each_word_segmented_outside_the_setup_counts():
    """A job set up to fill Gloss alone that segments two words reads two
    segmentations written past its setup, not one."""
    client = _two_sentences()
    _, doc = _write(client, 'd1', [])
    ops = [{'kind': 'set_analysis', 'word_id': w.id, 'morphemes': [{'form': 'x', 'fields': []}]}
           for w in doc.sentences[0].words]
    w, _ = _write(client, 'd1', ops, within={GLOSS})
    assert w.outside_of(ops) == {'segmentation': 2}


def test_a_retyped_sentence_and_the_values_on_its_new_words_count_it_written_in_once():
    """A retype and a value on the word it adds: the edit's row counts the
    sentence written in, its follow-up's row does not count it again."""
    ws = _piece()
    toolkit.call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'zz Gam-ar.'})
    edit = next(o for o in ws.ops if o['kind'] == 'edit_text')
    new = next(i for i, p in enumerate(edit['planned_words'], start=1) if p['word_id'] is None)
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': [f's2.w{new} "zz"'], 'values': {'Gloss': 'he'}})
    assert [o['kind'] for o in ws.ops] == ['edit_text', 'set_span'], ws.ops
    doc = ws.doc('Text 1')
    w, _ = _write(ws.client, doc.id, list(ws.ops))
    sid = edit['sentence_id']
    rows = [row for s, row in w.rows('seed', list(ws.ops)) if s == sid]
    assert len(rows) >= 2, rows
    assert sum(row['counts'].get('analyzed', 0) for row in rows) == 1, rows
