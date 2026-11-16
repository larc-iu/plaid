"""A job that fills only the words it adds (RPF-A7, the owner's R3).

RP-6: asked to insert ∅ where a clause has no subject and give each ∅ a Word
class, a job also filled Word class on 154 existing words, because its card
could not say "only on the words it inserts". The card can now say so
(propose_job's ``only_new``, the setup's ``onlynew``), the planner is told
in its setup line, and the job's workspace refuses, whatever path stages
it, a value of a setup target on a word, a morpheme of it or a sentence the
job did not add: listed as refused with the code ``not-added``. A word the
job added is decided by its own text edits and the token ids they made,
never by form."""

import json

import pytest

from fixtures import FakeClient, GLOSS, MGLOSS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job, jobcard, targets as tg, toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project

J = 'JON'


def _setup(only=True, text=True, fills=((GLOSS, 'Gloss'),)):
    return {'fills': [{'id': i, 'name': n} for i, n in fills], 'text': text, 'conversation': 'c1',
            **({'onlynew': True} if only else {})}


# --- the card and the setup --------------------------------------------------------------------

def _drafting():
    from plaid_agent.igt.workspace import Workspace
    client = FakeClient()
    client.jobs.active = lambda project_id: None
    return Workspace(client, load_project(client, 'p1'))


def _draft(ws, **kw):
    return toolkit.call_tool(ws, 'propose_job', {'action': 'draft', 'documents': ['all'], 'fills': ['Gloss'],
                                                 'brief': 'Insert ∅ before each verb with no subject.', **kw})


def test_the_card_fills_only_the_words_the_job_adds_only_when_it_may_edit_the_text():
    ws = _drafting()
    out = _draft(ws, only_new=True)
    assert jobcard.ONLY_NEW_REFUSAL in str(out), out
    assert ws.job_card is None
    _draft(ws, only_new=True, edits_text=True)
    assert ws.job_card['only_new'] is True and ws.job_card['edits_text'] is True
    _draft(ws, edits_text=True)
    assert ws.job_card['only_new'] is False, 'always said on a new card'


def test_the_setup_reads_onlynew_and_the_planner_is_told():
    project = load_project(FakeClient(), 'p1')
    setup = tg.setup_of(project, _setup())
    assert setup.only_new is True
    assert setup.line == 'This job was set up to fill only "Gloss", only on the words it adds. It may edit the text.'
    assert tg.said_setup(_setup()) == setup.line
    assert tg.setup_of(project, _setup(only=False)).only_new is False
    assert tg.setup_of(project, {**_setup(), 'onlynew': 'yes'}).unread, 'onlynew is a boolean or absent'


def test_a_setup_with_no_onlynew_is_read_with_no_limit_as_the_page_reads_it():
    """Every setup made before R3, and every card without the row, has no
    ``onlynew``: readable, with no limit, as the job page's ``readableSetup``
    reads it. ``onlynew`` present and null is unreadable on both sides."""
    project = load_project(FakeClient(), 'p1')
    for setup in (_setup(only=False), {**_setup(only=False), 'onlynew': False}):
        read = tg.setup_of(project, setup)
        assert not read.unread and read.only_new is False and tg.readable(setup)
        assert read.line == 'This job was set up to fill only "Gloss". It may edit the text.'
    assert tg.setup_of(project, {**_setup(), 'onlynew': None}).unread


# --- the guard ------------------------------------------------------------------------------------

def _piece(added=(set(), set())):
    client = FakeClient()
    ws = JobWorkspace(client, load_project(client, 'p1'))
    ws.edits_text = True
    ws.only_new = (set(added[0]), set(added[1]))
    return ws


def test_a_value_on_a_word_the_job_did_not_add_is_refused_as_not_added():
    ws = _piece()
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert 'this job fills only the words it adds' in str(out), out
    assert ws.ops == []
    assert [e['code'] for e in ws.left_by_refusal] == ['not-added']


def test_a_value_on_a_word_the_job_added_is_staged():
    ws = _piece()
    doc = ws.doc('Text 1')
    w = doc.sentences[0].words[0]
    ws.only_new = ({w.id}, set())
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'values': {'Gloss': 'x'}})
    assert [o['kind'] for o in ws.ops] == ['set_span']


@pytest.mark.parametrize('tool,args', [
    # A field the setup does not name (the setup fills Gloss only).
    ('set_field', {'refs': ['s1.w2.m1'], 'values': {'Morph Gloss': 'fish'}}),
    # A sentence-level value on a sentence the job did not add.
    ('set_field', {'refs': ['s2'], 'values': {'Translation': 'A fish.'}}),
    ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'ga'}, {'form': 'm', 'type': 'suffix'}]}),
    ('analyze_sentence', {'sentences': [{'ref': 's2', 'words': ['Gam-ar fish-ERG']}]}),
    ('set_morpheme', {'ref': 's2.w1.m2', 'type': 'suffix'}),
    ('set_orthography', {'refs': ['s1.w2'], 'orthography': 'IPA', 'value': 'gam'}),
    ('link_entry', {'refs': ['s1.w2'], 'entry_form': 'gam#2'}),
    ('unlink_entry', {'refs': ['s1.w1']}),
    ('link_phrase', {'refs': ['s1.w2', 's1.w3'], 'entry_form': 'gam#1'}),
])
def test_no_value_analysis_link_or_orthography_on_what_the_job_did_not_add_whatever_field(tool, args):
    """REV-RPF-W-1: "Fills only the words this job adds" holds for every
    value, analysis, segmentation, link and orthography, set up or not, on a
    word, a morpheme of it or a sentence the job did not add. The setup's
    targets do not decide it (the old rule asked only them, and a Translation
    on an existing sentence and an analysis on two existing words were
    written)."""
    ws = _piece()
    out = toolkit.call_tool(ws, tool, {'document': 'Text 1', **args})
    assert [o for o in ws.ops if o.get('kind') != 'create_entry'] == [], (out, ws.ops)
    assert 'this job fills only the words it adds' in str(out), out
    # analyze_sentence says its refusals in its own answer, sentence by sentence.
    assert {e['code'] for e in ws.left_by_refusal} <= {'not-added'}


def test_a_value_on_a_sentence_the_job_added_is_staged():
    """A sentence counts as added only when the job made it (a new id under
    the lock): its sentence-level fields are the job's to write."""
    ws = _piece()
    ws.only_new = (set(), {'s-2'})
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s2'], 'values': {'Translation': 'A fish.'}})
    assert [o['kind'] for o in ws.ops] == ['set_span']


def test_a_value_on_the_new_word_of_a_retype_in_the_same_piece_is_staged_and_an_old_ones_refused():
    ws = _piece()
    toolkit.call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'zz Gam-ar.'})
    retyped = [o for o in ws.ops if o['kind'] == 'edit_text']
    assert retyped, ws.ops
    new = [i for i, p in enumerate(retyped[0]['planned_words'], start=1) if p['word_id'] is None]
    old = [i for i, p in enumerate(retyped[0]['planned_words'], start=1) if p['word_id'] is not None]
    assert new and old, retyped[0]['planned_words']
    toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': [f's2.w{new[0]} "zz"'],
                                        'values': {'Gloss': 'he'}})
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': [f's2.w{old[0]} "Gam-ar"'],
                                             'values': {'Gloss': 'x'}})
    assert 'this job fills only the words it adds' in str(out), out
    assert [o['value'] for o in ws.ops if o['kind'] == 'set_span'] == ['he']


def test_the_text_edits_themselves_pass():
    ws = _piece()
    toolkit.call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'zz Gam-ar.'})
    assert [o['kind'] for o in ws.ops] == ['edit_text'] and not ws.left_by_refusal


# --- a job --------------------------------------------------------------------------------------

def test_a_job_refuses_a_value_on_an_existing_word_and_lists_it(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'Insert ∅ before each verb with no subject and give it the Gloss "he".', id=J,
                plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())

    def answer(asked, n, kwargs):
        if 'Your piece' not in asked or n > 1:
            return reply('Refused on tqmc.')
        # A piece that may edit the text: the words it adds are filled in
        # the piece after its text edit (RPF3-B).
        assert igt_job.ONLY_NEW_TEXT_LINE in asked
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w2'], 'values': {'Gloss': 'x'}})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert not [c for c in client.calls if c[0].startswith('spans')], 'nothing written on an existing word'
    refused = finished['report']['documents'][0]['refused']
    assert [r['code'] for r in refused] == ['not-added'] and refused[0]['sentence'] == 's1'


def test_the_apply_rule_refuses_a_value_on_an_existing_word_that_staging_let_through(monkeypatch):
    """The staging guard is one line of defence. Where a job's ops are
    applied, under the document's lock, the same rule holds: a value of a
    setup target on a word the job did not add is listed as refused
    (``not-added``) and never written, whatever path staged it (RPF-INT 4)."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'Insert ∅ before each verb with no subject and give it the Gloss "he".', id=J,
                plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    monkeypatch.setattr(JobWorkspace, 'refuse_not_added', lambda self, op: None)

    def answer(asked, n, kwargs):
        if 'Your piece' not in asked or n > 1:
            return reply('Glossed tqmc.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w2'], 'values': {'Gloss': 'x'}})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert not [c for c in client.calls if c[0].startswith('spans')], 'nothing written on an existing word'
    refused = finished['report']['documents'][0]['refused']
    assert [(r['code'], r['sentence']) for r in refused] == [('not-added', 's1')], refused
    assert finished['report']['totals']['changes'] == 0


def test_the_words_a_write_added_are_kept_and_a_later_piece_may_fill_them(monkeypatch):
    """What one write added (by id, under the lock) is kept among the job's
    rows, so a later worker reads it back."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'x', id=J, plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    r = runner(job)
    before = r.read(r.project(), 'd1')
    after_raw = document('d1', 'Story', [{'words': ['sc', 'zz', 'tqmc']}])
    tokens = after_raw['text_layers'][0]['token_layers'][1]['tokens']
    tokens[1]['id'], tokens[2]['id'] = 'new-zz', 'd1-s1w2'
    client._holder('d1')['documents']['d1'] = after_raw
    r.record_added('d1', before, r.read(r.project(), 'd1'))
    rows = [json.loads(x['analysis']) for (f, _k), x in client.jobs.decision_rows[J].items()
            if f == igt_job.ADDED_FORM + 'd1']
    assert rows == [{'document': 'd1', 'words': ['new-zz'], 'sentences': []}]
    assert runner(job).added() == ({'new-zz'}, set()), 'read back by the next worker'


def test_left_blank_of_such_a_job_lists_only_the_words_it_added(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    job = start(client, 'x', id=J, plan='document', edits_text=True, fills=(GLOSS,), setup=_setup())
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Nothing to add.')))
    finished = run_job(job, runner(job))
    doc = finished['report']['documents'][0]
    assert doc.get('left', []) == [] and doc['counts']['blank'][0]['untouched'] == 0


def test_harmonize_of_such_a_job_writes_nothing_on_a_word_the_job_did_not_add(monkeypatch):
    """Harmonize stages through the job's workspace and asks the same rule
    (REV-RPF-W-1): a rewrite on a word the job did not add is refused and the
    word listed as left, never written."""
    from job_fixtures import recorded
    from test_job_harmonize import w
    client = JobClient({'d1': document('d1', 'Story d1', [{'words': [w('ka', 'go', J), w('ka', 'go', J)]}]),
                        'd2': document('d2', 'Story d2', [{'words': [w('ka', 'come', J), w('ta', 'x', J)]}])})
    job = start(client, id=J, edits_text=True, fills=('segmentation', MGLOSS), setup=_setup(
        fills=(('segmentation', 'segmentation'), (MGLOSS, 'Morph Gloss'))))
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)
    out = runner(job).harmonize(job)
    assert not [c for c in client.calls if c[0].startswith(('spans', 'tokens'))], 'nothing written'
    assert [(x['form'], x['reason']) for x in out['left']] == [('ka', 'refused')], out


@pytest.mark.parametrize('calls,code', [
    # The reviewer's only-outside-mgloss-analysis: an analysis of an existing
    # sentence under onlynew.
    ([('analyze_sentence', {'document': 'Story', 'sentences': [{'ref': 's2', 'words': ['pa go', 'ro come']}]})],
     'not-added'),
    # added-word-analysis: a retype adds a word and the same reply analyses
    # the whole sentence, words the job did not add among them: refused as
    # retyped in this plan, and listed (REV-RPF3-1). The added word alone is
    # analysed after the text edit (the next test).
    ([('retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'}),
      ('analyze_sentence', {'document': 'Story', 'sentences': [{'ref': 's2', 'words': ['pa go', 'ro come']}]})],
     'retyped'),
])
def test_a_refusal_analyze_sentence_meets_is_listed_as_refused(monkeypatch, calls, code):
    """REV-RPF2-3: analyze_sentence says each sentence's refusal in its own
    answer, and those refusals reached no screen: the report's Refused list
    read none. Each coded refusal is now kept as the other tools' are."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert and analyse.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup(fills=(('segmentation', 'segmentation'),
                                                                     (MGLOSS, 'Morph Gloss'))))

    def answer(asked, n, kwargs):
        if 'Your piece' not in asked or n > 1:
            return reply('Done.')
        return reply(calls=[call(i + 1, t, a) for i, (t, a) in enumerate(calls)])
    use(monkeypatch, Model(answer))
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    finished = run_job(job, runner(job))
    refused = finished['report']['documents'][0].get('refused') or []
    assert (code, 's2') in [(r['code'], r['sentence']) for r in refused], refused


def test_an_analysis_of_the_added_word_alone_is_taken_up_after_the_text_edit(monkeypatch):
    """added-word-analysis, the word alone: refused in the piece that
    retypes, told the true next step and not listed, and the piece after the
    text edit analyses the added word (RPF3-B, REV-RPF3-1)."""
    from plaid_agent.core.prompt import JOB_TEXT_THEN_FILL
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and analyse it.', id=J, plan='document', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup(fills=(('segmentation', 'segmentation'),
                                                                     (MGLOSS, 'Morph Gloss'))))
    sent = []

    def execute(c, ops, **kw):
        sent.append(ops)
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['zz', 'pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[2]['id'], words[3]['id'], words[4]['id'] = 'd1-zz', 'd1-s2w1', 'd1-s2w2'
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            return reply(calls=[call(5, 'set_analysis', {'document': 'Story', 'ref': 's2.w1 "zz"', 'morphemes': [
                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'zz pa ro.'}),
                            call(2, 'set_analysis', {'document': 'Story', 'ref': 's2.w1 "zz"', 'morphemes': [
                                {'form': 'zz', 'fields': {'Morph Gloss': 'he'}}]})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    told = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert any(JOB_TEXT_THEN_FILL in t for t in told), told
    assert not finished['report']['documents'][0].get('refused')
    analysed = [o for ops in sent for o in ops if o['kind'] == 'set_analysis']
    assert [o['word_id'] for o in analysed] == ['d1-zz'], analysed


def _outside_job(monkeypatch, staged):
    """An onlynew job in stretches of one sentence: the piece of s1 inserts
    zz, the piece after its text edit leaves it, and the piece of s2 stages
    ``staged`` on s1's zz (RP3-2 finding 1)."""
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and gloss it.', id=J, plan='sentences', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup(fills=(('segmentation', 'segmentation'),
                                                                     (MGLOSS, 'Morph Gloss'))))
    sent = []

    def execute(c, ops, **kw):
        sent.append(ops)
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [{'words': ['zz', 'sc', 'tqmc']}, {'words': ['pa', 'ro']}], version=2)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[0]['id'], words[1]['id'], words[2]['id'] = 'd1-zz', 'd1-s1w1', 'd1-s1w2'
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1 or igt_job.AFTER_TEXT_LINE in asked:
            return reply('Done.')
        if 'Your piece: s1.' in asked:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'zz sc tqmc.'})])
        return reply(calls=[call(2, *staged)])
    model = use(monkeypatch, Model(answer))
    return client, job, model, sent


@pytest.mark.parametrize('staged', [
    ('set_field', {'document': 'Story', 'refs': ['s1.w1 "zz"'], 'field': 'Gloss', 'value': 'he'}),
    ('set_analysis', {'document': 'Story', 'ref': 's1.w1 "zz"', 'morphemes': [{'form': 'zz',
                                                                                'fields': {'Morph Gloss': 'he'}}]}),
    ('link_entry', {'document': 'Story', 'refs': ['s1.w1 "zz"'], 'entry_id': 'vi-ali'}),
], ids=['set_field', 'set_analysis', 'link_entry'])
def test_a_piece_writes_only_in_its_own_sentences_even_on_a_word_the_job_added(monkeypatch, staged):
    """RP3-2 finding 1: under onlynew the guard let a later piece write on any
    word the job added, outside its own sentences. A piece writes only in its
    own sentences: onlynew narrows that, never widens it. Refused at staging,
    listed, never written."""
    client, job, model, sent = _outside_job(monkeypatch, staged)
    finished = run_job(job, runner(job))
    told = [m['content'] for c in model.calls if 'Your piece: s2.' in c['asked']
            for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert told and told[-1].startswith('Error') and 'not one of your piece' in told[-1], told
    written = [o for ops in sent for o in ops if o['kind'] not in ('edit_text',)]
    assert not written, written
    refused = finished['report']['documents'][0].get('refused') or []
    assert ('outside', 's1') in [(r['code'], r['sentence']) for r in refused], refused


def test_the_piece_after_a_text_edit_writes_only_in_the_sentences_it_was_given(monkeypatch):
    """RP3-2 finding 1, the piece after a text edit ("the words added"): the
    piece of s2 retypes s2 too; the piece after it, given s2, stages a value
    on s1's added zz. Refused and listed."""
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}, {'words': ['pa', 'ro']}])})
    job = start(client, 'Insert zz and yy and gloss them.', id=J, plan='sentences', edits_text=True,
                fills=('segmentation', MGLOSS), setup=_setup(fills=(('segmentation', 'segmentation'),
                                                                     (MGLOSS, 'Morph Gloss'))))
    sent = []
    state = {'s1': False, 's2': False}

    def execute(c, ops, **kw):
        sent.append(ops)
        for o in ops:
            if o['kind'] == 'edit_text':
                state['s1' if o.get('sentence_id') == 'd1-s1' else 's2'] = True
        s1 = ['zz', 'sc', 'tqmc'] if state['s1'] else ['sc', 'tqmc']
        s2 = ['yy', 'pa', 'ro'] if state['s2'] else ['pa', 'ro']
        raw = document('d1', 'Story', [{'words': s1}, {'words': s2}], version=len(sent) + 1)
        words = raw['text_layers'][0]['token_layers'][1]['tokens']
        ids = (['d1-zz', 'd1-s1w1', 'd1-s1w2'] if state['s1'] else ['d1-s1w1', 'd1-s1w2']) + \
              (['d1-yy', 'd1-s2w1', 'd1-s2w2'] if state['s2'] else ['d1-s2w1', 'd1-s2w2'])
        for w, i in zip(words, ids):
            w['id'] = i
        client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        if igt_job.AFTER_TEXT_LINE in asked:
            if 'Your piece: s2.' in asked:
                return reply(calls=[call(3, 'set_field', {'document': 'Story', 'refs': ['s1.w1 "zz"'],
                                                          'field': 'Gloss', 'value': 'he'})])
            return reply('Done.')
        if 'Your piece: s1.' in asked:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'zz sc tqmc.'})])
        return reply(calls=[call(2, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'yy pa ro.'})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert not [o for ops in sent for o in ops if o['kind'] == 'set_span'], sent
    refused = finished['report']['documents'][0].get('refused') or []
    assert ('outside', 's1') in [(r['code'], r['sentence']) for r in refused], refused
