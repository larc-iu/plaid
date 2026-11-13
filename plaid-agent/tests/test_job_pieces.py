"""A job's model contexts (the owner's rulings 14 and 15 of 2026-11-13): the
planning context, made once and kept; pieces of the three sizes; a piece's
note and the tables its code makes; the final context that writes the
report's prose; and a crash and resume at each new step."""

import json
import re

import pytest

from job_fixtures import JobClient, Model, call, document, keep_plan, reply, runner, start, use

from plaid_agent.core import sandbox
from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_PLAN_NOW
from plaid_agent.igt import job as igt_job

J = 'JP'
PLANNING = 'Plan the job and end with plan_work.'
SUMMARY = 'Write the summary now.'


def _docs(n=2):
    return {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'ta'], 'translation': ('T.', 'human')},
                                                       {'words': ['sa'], 'translation': ('S.', 'human')}])
            for i in range(1, n + 1)}


def _plan_rows(client):
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items() if f == ' plan']


def _kind(asked):
    if asked.rstrip().endswith(PLANNING):
        return 'plan'
    if asked.rstrip().endswith(SUMMARY):
        return 'summary'
    return 'piece'


def _model(plan=None, piece=None, summary='The job glossed the words it was asked to.'):
    """A model that plans with ``plan`` (args of plan_work, or None to end
    without), does ``piece(asked, n)`` for a piece, and writes ``summary``."""
    seen = {'plan': 0, 'piece': 0, 'summary': 0}

    def answer(asked, n, kwargs):
        kind = _kind(asked)
        seen[kind] += n == 1
        if kind == 'plan':
            told = any(m.get('content') == JOB_PLAN_NOW for m in kwargs['messages'])
            if plan is not None and (n == 1 or told):
                return reply(calls=[call(90 + n, 'plan_work', plan)])
            return reply('Planned.')
        if kind == 'summary':
            if isinstance(summary, Exception):
                raise summary
            return reply(summary)
        return piece(asked, n) if piece else reply('Nothing to do here.')
    model = Model(answer)
    model.seen = seen
    return model


def _gloss_all(asked, n):
    if n > 1:
        return reply('Glossed every blank word of the piece.')
    doc = asked.split('"')[1]
    import re
    calls = []
    for m in re.finditer(r'^Empty in s(\d+): words (.*?)(?: and the translation)?\.$', asked, re.M):
        for w, form in re.findall(r'w(\d+) "([^"]*)"', m.group(2)):
            calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f's{m.group(1)}.w{w}',
                                                              'morphemes': [{'form': form, 'fields': {'Morph Gloss': 'G'}}]}))
    return reply(calls=calls)


# --- the plan ---------------------------------------------------------------------------

def test_the_first_context_plans_and_the_plan_is_kept_and_reported(monkeypatch):
    client = JobClient(_docs())
    job = start(client, 'Segment and gloss the blank words.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'piece_instructions': 'Gloss ka as go.'},
                                    piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert model.calls[0]['asked'].splitlines()[0] == 'Instructions from user:'
    assert 'Story 1": 2 sentences, 3 words, 3 words nobody analysed, 0 empty translations' in model.calls[0]['asked']
    plan_tools = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert 'plan_work' in plan_tools and 'set_analysis' not in plan_tools
    assert _plan_rows(client) == [{'pieces': 'sentences', 'piece_instructions': 'Gloss ka as go.', 'documents': None,
                                   'by': 'model', 'why': None}]
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert pieces and all('Instructions from user:\nSegment and gloss the blank words.' in p for p in pieces), \
        'the instructions verbatim'
    assert all('How to do every piece, as the job was planned:\nGloss ka as go.' in p for p in pieces), 'and the plan'
    assert finished['report']['plan']['pieces'] == 'sentences' and finished['report']['plan']['fallback'] == []
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_failed'] is False


def test_a_planning_that_ends_without_a_plan_gets_one_decide_now_round_then_works_in_sentences(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan=None, piece=_gloss_all))
    finished = run_job(job, runner(job))
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert len(planning) == 2, 'the planning, then one round told to end with plan_work'
    assert any(m.get('content') == JOB_PLAN_NOW for m in planning[1]['kwargs']['messages'])
    assert {t['function']['name'] for t in planning[1]['kwargs']['tools']} == {'plan_work'}
    assert finished['report']['plan'] == {'pieces': 'sentences', 'piece_instructions': '', 'documents': None,
                                          'by': 'default', 'why': 'no-plan', 'fallback': [], 'left_out': []}


def test_a_planning_that_runs_out_of_budget_works_in_sentences(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply(calls=[call(n, 'read_document', {'document': 'Story 1'})])
        return _gloss_all(asked, n)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    # Told to decide, it is offered plan_work alone, and its reads are refused
    # until its turn ends: no plan, so the job works in stretches.
    assert finished['report']['plan']['by'] == 'default' and finished['report']['plan']['pieces'] == 'sentences'


def test_a_subset_of_documents_in_the_plans_order_and_the_rest_not_reached(monkeypatch):
    client = JobClient(_docs(3))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': ['Story 3', 'Story 1']},
                                    piece=_gloss_all))
    finished = run_job(job, runner(job))
    worked = []
    for c in model.calls:
        if _kind(c['asked']) == 'piece' and c['n'] == 1:
            name = c['asked'].split('"')[1]
            if name not in worked:
                worked.append(name)
    assert worked == ['Story 3', 'Story 1']
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'not-reached', 'done']
    # Each document the plan left out is listed as such (the lead's ruling).
    assert finished['report']['plan']['left_out'] == [{'document_id': 'd2', 'name': 'Story 2'}]


def test_a_document_gone_at_the_checks_is_gone_and_not_left_out_by_the_plan(monkeypatch):
    """REV-JG2-7: Story 2 is deleted before the checks, and the plan names
    the other two. The report lists Story 2 as gone, never as left out by
    the plan."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(3))
    job = start(client, id=J, plan=None)
    get = client.documents.get

    def going(document_id, **kw):
        if document_id == 'd2':
            raise PlaidAPIError('HTTP 404', status=404)
        return get(document_id, **kw)
    client.documents.get = going
    use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': ['Story 3', 'Story 1']}, piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'gone', 'done']
    assert finished['report']['plan']['left_out'] == []


def test_a_resumed_job_does_not_plan_again(monkeypatch):
    """A crash after plan_work was kept: the next worker reads the plan back."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    use(monkeypatch, _model(plan={'pieces': 'document'}))

    class Crash(BaseException):
        pass
    r = runner(job)
    real = r.work

    def crash(j):
        raise Crash()
    r.work = crash
    with pytest.raises(Crash):
        run_job(job, r)
    assert job.status['phase'] == 'working' and len(_plan_rows(client)) == 1
    model = use(monkeypatch, _model(plan={'pieces': 'selection'}))
    finished = run_job(job, runner(job))
    assert not [c for c in model.calls if _kind(c['asked']) == 'plan'], 'no planning again'
    assert finished['report']['plan']['pieces'] == 'document'
    assert real


def test_a_plan_whose_row_meets_a_passing_error_is_kept_and_made_once(monkeypatch):
    """REV-JG-8: one 502 on the plan's own row. The plan is kept (a resumed
    job reads it back, the report shows it), and the planning context is
    not asked again for it."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'document'}))
    real = job.add_decisions
    once = {'n': 1}

    def add(decisions):
        if once['n'] and any(d['form'] == igt_job.PLAN_FORM for d in decisions):
            once['n'] = 0
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    finished = run_job(job, runner(job))
    assert once['n'] == 0, 'the 502 was met'
    assert [p['pieces'] for p in _plan_rows(client)] == ['document']
    assert finished['report']['plan']['pieces'] == 'document'
    assert model.seen['plan'] == 1, 'planned once'


def test_the_largest_plan_the_tool_takes_is_kept_and_read_back_in_its_order(monkeypatch):
    """REV-JG-3: a job of the most documents a job takes, all named by the
    planning context in an order of its own, with the longest piece
    instructions plan_work accepts, written in the characters that cost
    most to keep. The plan fits one row, the job ends done, and a resumed
    job reads the same order back."""
    import uuid
    from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS, JOB_PIECE_INSTRUCTIONS_MAX_CHARS
    ids = [str(uuid.uuid4()) for _ in range(500)]
    glossed = [{'words': [('ka', [('ka', 'go')], 'human')], 'translation': ('T.', 'human')}]
    client = JobClient({d: document(d, f'Text {i}', glossed) for i, d in enumerate(ids)})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan=None)
    told = '"\\\n' * (JOB_PIECE_INSTRUCTIONS_MAX_CHARS // 3)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': list(reversed(ids)),
                                          'piece_instructions': told}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'), finished.get('message'))
    rows = [r for (f, _), r in client.jobs.decision_rows[J].items() if f == igt_job.PLAN_FORM]
    assert len(rows) == 1 and len(rows[0]['analysis']) <= JOB_ANALYSIS_MAX_CHARS
    assert finished['report']['plan']['documents'] == list(reversed(ids))
    r = runner(job)
    assert r.plan(job)['documents'] == list(reversed(ids))
    assert r.plan(job)['piece_instructions'] == told.strip()
    assert model.seen['plan'] == 1


def test_plan_work_refuses_piece_instructions_past_their_cap_with_what_to_do():
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS
    from plaid_agent.core.tools import ToolError
    from plaid_agent.igt.toolkit import t_plan_work

    class Ws:
        job_documents = []
        plan_work = None
    with pytest.raises(ToolError) as e:
        t_plan_work(Ws(), 'sentences', 'x' * (JOB_PIECE_INSTRUCTIONS_MAX_CHARS + 1))
    assert f'at most {JOB_PIECE_INSTRUCTIONS_MAX_CHARS:,} characters' in str(e.value)
    assert 'shorter' in str(e.value)
    t_plan_work(Ws(), 'sentences', 'x' * JOB_PIECE_INSTRUCTIONS_MAX_CHARS)


# --- pieces of a document and of the selection ---------------------------------------------

def test_a_document_piece_sees_the_whole_document_once(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Summarise each text.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Story about ka and ta.')))
    finished = run_job(job, runner(job))
    pieces = [c['asked'] for c in model.calls if c['n'] == 1]
    assert len(pieces) == 2 and all(p.splitlines()[-1].startswith('Your piece: the whole document') for p in pieces)
    assert [n['note'] for n in finished['report']['notes']] == ['Story about ka and ta.'] * 2
    assert {n['name'] for n in finished['report']['notes']} == {'Story 1', 'Story 2'}


def test_a_document_too_large_for_one_piece_is_worked_in_stretches_and_the_report_says_so(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    client = JobClient(_docs(1))
    job = start(client, 'Summarise each text.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert all(not c['asked'].splitlines()[-1].startswith('Your piece: the whole') for c in model.calls)
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'too-long'}]


GLOSSED = [{'words': [('ka', [('ka', 'go')], 'human'), ('ta', [('ta', 'go')], 'human')], 'translation': ('T.', 'human')},
           {'words': [('sa', [('sa', 'go')], 'human')], 'translation': ('S.', 'human')}]


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_a_document_too_long_for_one_piece_is_worked_in_stretches_over_every_sentence(monkeypatch, pieces):
    """REV-JG-7: a check job planned by documents (or as one selection that
    fell back), whose long document has nothing empty. Its stretches cover
    every sentence, so the instructions are carried out on the whole text."""
    monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Check every gloss and propose corrections.', id=J, plan=pieces)
    if pieces == 'selection':
        # The selection's one piece failed: each document is worked alone.
        runner(job).fall_back(igt_job.SELECTION, 'failed')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    named = [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1 and _kind(c['asked']) == 'piece']
    assert named == ['Your piece: s1, s2.'], named
    assert finished['report']['documents'][0]['state'] == 'done'


def test_a_sentences_plan_walks_only_sentences_with_something_empty(monkeypatch):
    """The fixer's ruling 1, kept: in a job planned in sentences, a fully
    glossed document is not read by any piece."""
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='sentences')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    assert not [c for c in model.calls if _kind(c['asked']) == 'piece']
    assert finished['report']['documents'][0]['state'] == 'done'


@pytest.mark.parametrize('every', [True, False])
def test_a_sentences_plan_that_asks_for_every_sentence_walks_glossed_ones_too(monkeypatch, every):
    """BRIEF-JH item 6: plan_work's every_sentence, for a job that corrects
    or checks work already there in stretches. Its plan row keeps the flag
    only when true, and a fully glossed document is then worked."""
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Check every gloss and correct the wrong ones.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'every_sentence': every},
                                    piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    rows = _plan_rows(client)
    assert rows[0].get('every_sentence') is (True if every else None)
    pieces = [c for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert bool(pieces) is every
    assert finished['report']['documents'][0]['state'] == 'done'


def test_a_selection_is_one_piece_whose_writes_land_document_by_document(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Gloss ka in every text.', id=J, plan='selection')
    written = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.append(sorted(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis'))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(9, 'read_sentences', {'items': [{'document': f'Story {i}', 'sentences': [1, 2]}
                                                                     for i in (1, 2)]})])
        if n == 2:
            return reply(calls=[call(1, 'set_analysis', {'document': f'Story {i}', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})
                                for i in (1, 2)])
        return reply('Glossed ka in both texts.')
    model = use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'one context for the whole selection'
    assert written == [['d1-s1w1'], ['d2-s1w1']]
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']
    assert finished['report']['notes'][0]['note'] == 'Glossed ka in both texts.'


def _lexicon_takes_creates(monkeypatch, client):
    """The fake's lexicon holds what the job's writes create, as core's
    does: each entry a write created is in the next read of the lexicon."""
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        before = len(client.calls)
        out = real(c, ops, **kw)
        for kind, p in client.calls[before:]:
            if kind == 'vocab_items.create':
                vocab_id, form, metadata = (list(p['args']) + [None])[:3]
                client._lexicon['items'].append({'id': p['kwargs']['id'], 'form': form,
                                                 'metadata': metadata or p['kwargs'].get('metadata') or {}})
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


@pytest.mark.parametrize('first', ['Story 1', 'Story 2'])
def test_a_selection_that_links_one_new_entry_in_two_documents_creates_it_once(monkeypatch, first):
    """REV-JG2-2: the selection makes one entry and links it in both
    documents, the links staged in either order. The entry is created with
    the first document written that links it, and the other document's link
    names the entry made: the job ends done, one entry, both linked."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')

    def piece(asked, n):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(2, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(3, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})])
        if n == 2:
            names = [first] + [x for x in ('Story 1', 'Story 2') if x != first]
            return reply(calls=[call(4 + i, 'link_entry', {'document': d, 'refs': ['s1.w1.m1'],
                                                           'entry_id': 'new:v1:ka#1'}) for i, d in enumerate(names)])
        return reply('Glossed ka in both texts and linked it.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    made = [p['kwargs']['id'] for k, p in client.calls if k == 'vocab_items.create']
    assert len(made) == 1, made
    links = [p for k, p in client.calls if k == 'vocab_links.create']
    assert len(links) == 2 and all(made[0] in (list(p['args']) + list(p['kwargs'].values())) for p in links), links
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']
    assert [e['id'] for e in finished['report']['entries']['created']] == made


def test_a_selections_second_document_links_an_entry_that_fits_and_creates_none(monkeypatch):
    """The entry the selection staged exists already when its second
    document is written, the job's own (made by the first document's write
    before a passing error): no entry is created where one fits, at the
    write as at staging, and the link names the one there. Someone else's
    entry made meanwhile is never linked unasked (test_job_entry_gone)."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.write_piece

    def write_piece(self, project, d, *a, **kw):
        if d == 'd2':
            from job_fixtures import stamp
            client._lexicon['items'].append({'id': 'e-made', 'form': 'ka', 'metadata': {'gloss': 'go', **stamp(J)}})
        return real(self, project, d, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write_piece', write_piece)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(2, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})])
        if n == 2:
            return reply(calls=[call(3, 'link_entry', {'document': 'Story 2', 'refs': ['s1.w1.m1'],
                                                       'entry_id': 'new:v1:ka#1'})])
        return reply('Glossed ka and linked it.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert not [p for k, p in client.calls if k == 'vocab_items.create']
    links = [p for k, p in client.calls if k == 'vocab_links.create']
    assert len(links) == 1 and 'e-made' in str(links), links


def test_a_document_the_selection_never_read_is_worked_as_a_piece_of_its_own(monkeypatch):
    """REV-JG2-5: the selection's model reads Story 1 and never Story 2 (its
    budget ran out, say). Story 2 is not recorded as worked: the walk works
    it as a piece of its own, and the report's plan says it was worked apart
    from the selection (``not-read``)."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone, written = [], []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis')
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if '"Story 1"' in asked and '"Story 2"' in asked:
            if n == 1:
                return reply(calls=[call(9, 'read_document', {'document': 'Story 1'})])
            if n == 2:
                return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka in Story 1, and ran out of time.')
        if n == 1:
            alone.append(asked.split('"')[1])
        return _gloss_all(asked, n)
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert 'Story 2' in alone, 'Story 2 was never given to a model'
    plan = finished['report']['plan']
    assert {'document_id': 'd2', 'reason': 'not-read'} in plan['fallback'], plan
    assert {'document_id': 'd1', 'reason': 'not-read'} not in plan['fallback']
    assert sorted(w for w in written if w.startswith('d2')) == ['d2-s1w1', 'd2-s1w2', 'd2-s2w1'], written
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']


def test_a_document_the_selection_read_in_part_is_worked_where_it_was_not_shown(monkeypatch):
    """REV-JG3-1: what the selection read is what a read printed to the
    model, never what a tool loaded. Its model reads s1 of Story 1 alone,
    glosses ka there and runs out of time. Story 1's s2 was never shown: the
    walk works it as a piece of its own, and the report's plan says Story 1
    was worked apart in part (``not-read``)."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone = []

    def piece(asked, n):
        if '"Story 1"' in asked and '"Story 2"' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story 1', 'from_sentence': 1,
                                                              'to_sentence': 1})])
            if n == 2:
                return reply(calls=[call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka in Story 1 and ran out of time.')
        if n == 1:
            alone.append((asked.split('"')[1], re.search(r'Your piece: ([^.]*)\.', asked).group(1)))
        return _gloss_all(asked, n)
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert ('Story 1', 's2') in alone, alone
    assert {'document_id': 'd1', 'reason': 'not-read'} in finished['report']['plan']['fallback']


def test_a_selection_that_was_shown_every_sentence_of_a_text_works_it_whole(monkeypatch):
    """The guard: a text whose every sentence a read printed is the
    selection's, and no piece of its own works it again."""
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone = []

    def piece(asked, n):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_sentences', {'items': [{'document': 'Story 1',
                                                                          'sentences': ['s1', 's2']}]})])
            if n == 2:
                return reply(calls=[call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka, and left the rest.')
        alone.append(asked)
        return reply('Nothing.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done' and not alone
    assert finished['report']['plan']['fallback'] == []


def test_a_document_piece_shows_every_sentence_of_its_document(monkeypatch):
    """A whole document is handed to its piece whole, past a read's cap of
    sentences (MAX_SENTENCES_PER_READ): its piece says the whole document,
    and the model is shown all of it."""
    from plaid_agent.core.limits import MAX_SENTENCES_PER_READ
    n = MAX_SENTENCES_PER_READ + 5
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [f'w{i}']} for i in range(1, n + 1)])})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=lambda asked, k: reply('Nothing.')))
    run_job(job, runner(job))
    first = next(c['asked'] for c in model.calls if c['n'] == 1 and 'Your piece: the whole document' in c['asked'])
    assert f'Your piece: the whole document "Story 1", {n} sentences.' in first
    assert f'[s{n}] w{n}.' in first.splitlines(), 'the last sentence is shown'


def test_a_document_the_selection_never_read_is_not_reached_when_the_job_stops_first(monkeypatch):
    """The same, the job stopped once the selection is written: Story 2 ends
    not reached, never done."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.selection

    def selection(self, job_, order):
        out = real(self, job_, order)
        client.jobs.cancel(job_.id)
        job_.beat()
        return out
    monkeypatch.setattr(igt_job.IgtRunner, 'selection', selection)

    def piece(asked, n):
        if n == 1 and '"Story 2"' in asked and '"Story 1"' in asked:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Done.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    states = {d['document_id']: d['state'] for d in finished['report']['documents']}
    assert states['d2'] == 'not-reached', states


def _fails_once(real):
    from plaid_client import PlaidAPIError
    failed = []

    def call_(*a, **kw):
        if not failed:
            failed.append(1)
            raise PlaidAPIError('HTTP 502', status=502)
        return real(*a, **kw)
    return call_


def test_a_fallback_core_fails_once_is_kept_and_read_when_tried_again():
    """A fallback row whose call core fails is written when the call is made
    again, and a read of the fallbacks core fails is read again: neither is
    taken for done (the selection's put-off rows go through through_core)."""
    from plaid_agent.core.job import through_core
    client = JobClient(_docs(1))
    job = start(client, id=J, plan='selection')
    r = runner(job)
    client.jobs.add_decisions = _fails_once(client.jobs.add_decisions)
    through_core(job, lambda: r.fall_back('d1', 'not-read'))
    assert [f for (f, _k) in client.jobs.decision_rows[J] if f == ' fallback d1']
    again = runner(job)
    client.jobs.decisions = _fails_once(client.jobs.decisions)
    assert through_core(job, again.fallen_back) == {'d1': 'not-read'}


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
def test_a_change_in_a_document_outside_the_job_is_proposed_and_listed(monkeypatch, pieces):
    """REV-JG-6: a piece stages in a document of the project the job does
    not hold. The job may not write there: the change is a proposed change,
    listed in the report and counted, whatever the plan cut, and the
    document is untouched."""
    docs = _docs(2)
    client = JobClient(docs)
    job = start(client, 'Gloss every word nobody analysed.', documents=['d1'], id=J, plan=pieces)
    written = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Glossed ka in Story 2.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    report = finished['report']
    assert 'd2-s1w1' not in written, 'nothing is written outside the job'
    changes = [(c['document_id'], c['ref'], c['kind']) for c in report['proposed']]
    assert ('d2', 's1.w1', 'set_analysis') in changes, report['proposed']
    assert report['totals']['proposed'] >= 1


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_a_selections_code_makes_a_table_kept_as_data_in_the_report(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Report inconsistent glosses across these texts.', id=J, plan='selection')
    code = ('rows = [[d["name"], len(load(d["id"])["sentences"])] for d in documents()]\n'
            'print(table("Sentences per text", ["text", "sentences"], rows))')

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('Counted the sentences.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['report']['tables'] == [{'title': 'Sentences per text', 'columns': ['text', 'sentences'],
                                             'rows': [['Story 1', 2], ['Story 2', 2]], 'more': 0}]


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_code_in_a_piece_writes_only_through_the_plan(monkeypatch):
    """How the sandbox guarantees it: code runs in a monty worker with no
    filesystem and no network, and reaches the project only through the
    host functions lent to it, none of which is a client. Its one way to
    change anything is plan(), which stages through the workspace's guards
    like a plan tool. Nothing is written while the model works: the job's
    apply rule writes after the piece ends."""
    from plaid_agent.igt.sandbox import api
    from plaid_agent.igt.job import JobWorkspace
    from plaid_agent.igt.project import load_project
    client = JobClient(_docs(1))
    ws = JobWorkspace(client, load_project(client, 'p1'))
    lent = api(ws)
    # The project's reads, plan(), table(), and the conversation's files
    # (none in a job): nothing else.
    assert {'documents', 'load', 'query', 'plan', 'lexicon', 'recording', 'table'} <= set(lent)
    assert set(lent) - {'documents', 'load', 'query', 'plan', 'lexicon', 'recording', 'table'} <= {
        'files', 'read_file', 'file_rows', 'save_file'}, sorted(lent)
    assert not any(hasattr(f, 'client') or getattr(f, '__self__', None) is client for f in lent.values())
    job = start(client, 'Gloss ka.', id=J, plan='sentences')
    seen_writes = []
    code = 'print(plan("set_analysis", document="Story 1", ref="s1.w1", morphemes=[{"form": "ka"}]))'

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        seen_writes.append([k for k, _ in client.calls if k.startswith(('tokens.', 'spans.', 'vocab_'))])
        return reply('Staged ka through code.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert seen_writes == [[]], 'nothing written while the piece ran'
    assert finished['report']['totals']['words'] >= 0
    assert [k for k, _ in client.calls if k.startswith('tokens.')], 'written after it ended, by the rule'


# --- the final context ------------------------------------------------------------------

def test_the_summary_is_given_the_reports_own_sections(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    model = use(monkeypatch, _model(piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    (asked,) = [c['asked'] for c in model.calls if _kind(c['asked']) == 'summary']
    assert asked.startswith('The job\'s instructions:\nSegment and gloss')
    assert 'Changes proposed for a person to approve: 0.' in asked and 'Glossed every blank word' in asked
    assert model.calls[-1]['kwargs'].get('tools') in (None, []), 'no tools'
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'


def test_a_summary_that_cannot_be_written_leaves_the_report_without_prose(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all, summary=RuntimeError('the model fell over')))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert finished['report']['summary'] is None and finished['report']['summary_failed'] is True


def test_core_failing_a_call_of_the_final_context_once_still_writes_its_prose(monkeypatch):
    """REV-JG2-3's sweep: the final context's reads go through the same
    helper as every other call, so one 502 there does not cost the report
    its prose."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)
    real, failed = r.summarize, []

    def summarize(job_, report):
        if not failed:
            failed.append(1)
            raise PlaidAPIError('HTTP 502', status=502)
        return real(job_, report)
    r.summarize = summarize
    finished = run_job(job, r)
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_failed'] is False


def test_a_crash_before_the_final_context_writes_it_when_the_job_resumes(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)

    class Crash(BaseException):
        pass

    def crash(j, report):
        raise Crash()
    r.summarize = crash
    with pytest.raises(Crash):
        run_job(job, r)
    assert job.status['phase'] == 'reporting'
    model = use(monkeypatch, _model(piece=_gloss_all, summary='Written on the second run.'))
    finished = run_job(job, runner(job, write_summary=True))
    assert not [c for c in model.calls if _kind(c['asked']) == 'piece'], 'no piece again'
    assert finished['report']['summary'] == 'Written on the second run.'


def test_a_stopped_job_writes_no_prose(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    model = use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)
    r.work = lambda j: (client.jobs.cancel(j.id), j.beat())
    finished = run_job(job, r)
    assert finished['state'] == 'cancelled' and finished['report']['summary'] is None
    assert not [c for c in model.calls if _kind(c['asked']) == 'summary']


# --- a selection's lexicon changes and its put-off documents (REV-JH-2) -------------------

def _lexicon_selection(monkeypatch, put_off):
    """A selection that glosses ka in both texts and changes the gloss of
    the entry gam, the documents in ``put_off`` in use at its write. The
    kinds each write sent, and the finished job."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss ka in every text and gloss the entry gam as fish-net.', id=J, plan='selection')
    sent = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        sent.append(sorted(o['kind'] for o in ops))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    r = runner(job)
    real_hold, held = r.hold, set()

    def hold(c, document_id):
        if document_id in put_off and document_id not in held:
            held.add(document_id)
            raise igt_job.Deferred(document_id)  # someone edits it right now
        return real_hold(c, document_id)
    r.hold = hold

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing left to do here.')
        if n == 1:
            return reply(calls=[call(9, 'read_sentences', {'items': [{'document': f'Story {i}', 'sentences': [1, 2]}
                                                                     for i in (1, 2)]})])
        if n == 2:
            return reply(calls=[call(i, 'set_analysis', {'document': f'Story {i}', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}) for i in (1, 2)] + [
                call(3, 'set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': 'fish-net'})])
        return reply('Glossed ka in both texts and changed the gloss of gam.')
    use(monkeypatch, _model(piece=piece))
    return sent, run_job(job, r)


def test_a_selections_lexicon_change_goes_with_the_next_write_when_its_first_document_is_put_off(monkeypatch):
    """REV-JH-2: Story 1, whose write would carry the lexicon change, is in
    use. The change goes with Story 2's write, and nothing is proposed."""
    sent, finished = _lexicon_selection(monkeypatch, {'d1'})
    assert finished['state'] == 'done'
    assert sent[0] == ['set_analysis', 'set_entry_field'], sent
    assert sum('set_entry_field' in b for b in sent) == 1, sent
    assert not finished['report'].get('proposed')


def test_a_selections_lexicon_change_no_write_carries_is_proposed(monkeypatch):
    """Every document of the selection is in use at its write: no write
    carries the lexicon change, which is listed as a proposed change."""
    sent, finished = _lexicon_selection(monkeypatch, {'d1', 'd2'})
    assert finished['state'] == 'done'
    assert not any('set_entry_field' in b for b in sent), sent
    proposed = finished['report'].get('proposed') or []
    assert [p['kind'] for p in proposed] == ['set_entry_field'], proposed
