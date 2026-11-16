"""Many values, or many links, in one call of a job's piece (BRIEF SP item 2).

A piece's set_field and link_entry take ``items``, each item what one single
call takes for one reference. Each item is run as that single call, so every
guard, refusal, keep rule and count is the single call's, item by item, and
one refused item never loses the rest. The answer: how many were staged,
then each item refused or not staged, by number and reference, with the
single call's own words. The step's line says what the call did ("Set 14
values", "Linked 9 morphemes, 2 refused"). A chat's tools are unchanged.

Each guard is also run through the items form by the job test modules that
opt into ``both_forms`` (conftest.py): every set_field and link_entry call
their scripted models make runs a second time as items."""

import json

import pytest

from fixtures import FakeClient
from job_fixtures import Model, call, itemized, reply, use
from test_retype_word_refs import machine_raw

from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_ITEMS_MAX
from plaid_agent.core.tools import Refusal
from plaid_agent.igt import items as items_mod, prompt, toolkit, targets as tg
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.trace import TRACER
from plaid_agent.igt.workspace import Workspace


def _ws(raw=None, job=True):
    c = FakeClient(documents={'d1': raw}) if raw is not None else FakeClient()
    project = load_project(c, 'p1')
    return JobWorkspace(c, project) if job else Workspace(c, project)


def _schema(tools, name):
    return next(t for t in tools if t['function']['name'] == name)['function']['parameters']


# --- what is offered ------------------------------------------------------------------------------

def test_a_piece_is_offered_items_on_set_field_and_link_entry():
    ws = _ws()
    for name in ('set_field', 'link_entry'):
        params = _schema(toolkit.job_piece_tools(ws), name)
        assert params['properties']['items'] == items_mod.ITEMS_SCHEMA[name]
        assert 'refs' not in params['required'] and 'document' in params['required']


def test_a_piece_in_sentences_is_offered_items_too():
    ws = _ws()
    ws.in_sentences = True
    gloss = ws.project.gloss_field('Morpheme')
    ws.fills = [t for t in tg.fillable(ws.project) if t.id in (tg.SEGMENTATION, gloss.layer_id)]
    tools = toolkit.job_piece_tools(ws)
    assert 'items' in _schema(tools, 'set_field')['properties']
    assert 'items' in _schema(tools, 'link_entry')['properties']


def test_the_chat_is_offered_neither_and_refuses_items_as_any_argument_it_does_not_take():
    ws = _ws(job=False)
    for name in ('set_field', 'link_entry'):
        params = _schema(toolkit.tools_for(ws), name)
        assert 'items' not in params['properties'] and 'refs' in params['required']
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss',
                                              'items': [{'ref': 's1.w2', 'value': 'fish'}]})
    assert isinstance(out, Refusal) and 'set_field cannot be called with those arguments' in out
    assert ws.ops == []


def test_the_piece_prompt_says_values_and_links_may_be_staged_many_at_a_time():
    project = _ws().project
    assert prompt.JOB_ITEMS_LINE in prompt.build_job_prompt(project)
    gloss = project.gloss_field('Morpheme')
    glossing = [t for t in tg.fillable(project) if t.id in (tg.SEGMENTATION, gloss.layer_id)]
    assert prompt.JOB_ITEMS_LINE in prompt.build_job_prompt(project, sentences=True, targets=glossing)
    # A piece that fills a field linked to no lexicon is not offered link_entry.
    translation = [t for t in tg.fillable(project) if t.scope == 'Sentence']
    assert 'link_entry' not in toolkit.sentences_piece_tools(translation, project)
    said = prompt.build_job_prompt(project, sentences=True, targets=translation)
    assert prompt.JOB_ITEMS_VALUES_LINE in said and prompt.JOB_ITEMS_LINE not in said
    from plaid_agent.igt.prompt import build_system_prompt
    chat = build_system_prompt(project)
    assert 'take items' not in chat and 'takes items' not in chat


# --- the answer -----------------------------------------------------------------------------------

def test_each_item_is_staged_or_refused_on_its_own_and_the_answer_says_which():
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'ref': 's1.w1', 'value': 'person'}, {'ref': 's1.w2', 'field': 'Glos', 'value': 'fish'},
        {'ref': 's9.w1', 'value': 'x'}, {'ref': 's1.w3', 'value': 'see'}, {'ref': 's1.w3', 'value': 'see'},
        {'ref': 's1.w2.m1', 'field': 'Morph Gloss', 'value': 'fish'}]})
    assert not isinstance(out, Refusal)
    assert out == ('Staged 3 of 6 values. 3 changes staged in all, applied when you end.\n'
                   'Refused: item 2 s1.w2: No field named "Glos". Fields: Word: Gloss; Morpheme: Morph Gloss; '
                   'Sentence: Translation\n'
                   'Refused: item 3 s9.w1: s9.w1: document "Text 1" has 2 sentences\n'
                   'Not staged: item 5 s1.w3: Nothing to change: every value named already holds what was given.')
    assert [(o['token_id'], o['value']) for o in ws.ops] == [
        ('w-1', 'person'), ('w-3', 'see'), (ws.ops[2]['token_id'], 'fish')]
    assert ws.step_label == 'Set 3 values, 2 refused, 1 not staged'


def test_a_link_batch_says_what_it_linked_by_what_the_references_name():
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'link_entry', {'document': 'Text 1', 'items': [
        {'ref': 's1.w2.m1', 'entry_form': 'gam#2'}, {'ref': 's1.w1.m1', 'entry_form': 'nothing'},
        {'ref': 's1.w3', 'entry_id': 'vi-gam'}]})
    assert out.splitlines() == [
        'Staged 2 of 3 links. 2 changes staged in all, applied when you end.',
        'Refused: item 2 s1.w1.m1: No lexicon entry "nothing". Use read_lexicon to look, or create_entry to add one.']
    assert [o['kind'] for o in ws.ops] == ['link', 'link']
    assert ws.step_label == 'Linked 1 morpheme and 1 word, 1 refused'
    ws2 = _ws()
    toolkit.job_piece_call(ws2, 'link_entry', {'document': 'Text 1', 'items': [
        {'ref': 's1.w2.m1', 'entry_form': 'gam#2'}, {'ref': 's1.w3.m1', 'entry_form': 'gam#2'}]})
    assert ws2.step_label == 'Linked 2 morphemes'


def test_the_steps_line_of_a_batch_is_the_tools_own():
    ws = _ws()
    toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w3', 'value': 'see'}]})
    assert ws.step_label == 'Set 2 values'
    # A call every item of which was refused is a refusal, its step the
    # arguments' line.
    assert TRACER.describe('set_field', {'document': 'Text 1', 'items': [{}, {}, {}]}) == \
        'Planned 3 values in \u201cText 1\u201d'
    assert TRACER.describe('link_entry', {'document': 'Text 1', 'items': [
        {'ref': 's1.w2.m1'}, {'ref': 's1.w3.m1'}]}) == 'Planned linking 2 morphemes in \u201cText 1\u201d'


def test_a_call_whose_every_item_is_refused_is_a_refusal():
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'items': [
        {'ref': 's1.w1', 'field': 'Nope', 'value': 'x'}]})
    assert isinstance(out, Refusal)
    assert str(out).startswith('Error: Staged 0 of 1 value.') and 'item 1 s1.w1: No field named "Nope"' in out


@pytest.mark.parametrize('args,said', [
    ({'items': [{'ref': 's1.w1', 'field': 'Gloss', 'value': 'x'}] * (JOB_ITEMS_MAX + 1)},
     f'items takes at most {JOB_ITEMS_MAX} in one call, and {JOB_ITEMS_MAX + 1} were given. Give the rest in another '
     'call.'),
    ({'items': []}, 'items is a list of {"ref": ..., field, value} objects, at least one.'),
    ({'items': 's1.w1'}, 'items is a list of {"ref": ..., field, value} objects, at least one.'),
    ({'refs': ['s1.w1'], 'field': 'Gloss', 'items': [{'ref': 's1.w1', 'value': 'x'}]},
     'items goes in place of refs, value, values: leave out refs.'),
])
def test_what_the_whole_call_is_refused_for(args, said):
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', **args})
    assert isinstance(out, Refusal) and str(out) == f'Error: {said}'
    assert ws.ops == []


def test_an_item_with_no_ref_or_an_argument_the_tool_does_not_take_is_refused_alone():
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'value': 'x'}, {'ref': 's1.w2', 'value': 'fish', 'refs': ['s1.w3']}, {'ref': 's1.w3', 'value': 'see'}]})
    assert out.splitlines()[1:] == [
        'Refused: item 1: give each item a ref and field, value.',
        'Refused: item 2 s1.w2: an item takes ref, field, value, not refs.']
    assert [o['token_id'] for o in ws.ops] == ['w-3']


def test_a_garbled_item_is_refused_alone():
    """The garble guard a single call meets before its tool runs is asked of
    each item: one value typed in a broken character never refuses the
    rest, and the whole call is not refused for it."""
    ws = _ws()
    args = {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'ref': 's1.w2', 'value': 'fi�sh'}, {'ref': 's1.w3', 'value': 'see'}]}
    assert ws.garbled(args) is None
    assert ws.garbled({'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fi�sh'})
    out = toolkit.job_piece_call(ws, 'set_field', args)
    assert out.splitlines()[1].startswith('Refused: item 1 s1.w2: "fi�sh" has a broken character in it')
    assert [o['token_id'] for o in ws.ops] == ['w-3']


# --- every guard, as the single call meets it ------------------------------------------------------

def _one_by_one(tool, args):
    """A set_field or link_entry call on several refs as one call per ref."""
    if tool not in items_mod.ITEM_ARGS or not isinstance(args.get('refs'), list):
        return [args]
    return [{**args, 'refs': [r]} for r in args['refs']]


def _run(steps, raw=None, setup=lambda ws: None, items=False):
    """``steps`` on a fresh piece's workspace: each set_field and link_entry
    call as items, or as one single call per reference. The answers, one
    per step (the single calls' refusal, if any, else their last)."""
    ws = _ws(raw)
    setup(ws)
    said = []
    for tool, args in steps:
        args = {'document': 'Text 1' if raw is None else 'd1', **args}
        if items:
            said.append(toolkit.job_piece_call(ws, tool, itemized(tool, args)))
            continue
        outs = [toolkit.job_piece_call(ws, tool, a) for a in _one_by_one(tool, args)]
        said.append(next((o for o in outs if isinstance(o, Refusal)), outs[-1]))
    return ws, said


def _ops(ws):
    return json.dumps(ws.ops, sort_keys=True, default=str)


def _same_by_both_forms(steps, raw=None, setup=lambda ws: None):
    """The steps run as single calls one reference at a time and as items:
    the same plan, the same refusals left for the report, and each single
    call's refusal said, in its own words, for its item."""
    one, said_one = _run(steps, raw, setup)
    many, said_many = _run(steps, raw, setup, items=True)
    assert _ops(one) == _ops(many), (said_one, said_many)
    assert one.left_by_refusal == many.left_by_refusal
    for (tool, args), a, b in zip(steps, said_one, said_many):
        if tool in items_mod.ITEM_ARGS and isinstance(a, Refusal):
            fact = str(a)[len('Error: '):]
            assert fact in str(b), (a, b)
    return one, said_one


def _steps_naming(scenarios):
    return {k: v for k, v in scenarios.items() if any(t in items_mod.ITEM_ARGS for t, _ in v)}


from test_job_refusals import SCENARIOS as REFUSALS  # noqa: E402


@pytest.mark.parametrize('scenario', list(_steps_naming(REFUSALS)))
def test_refusals_a_job_cannot_follow_are_the_same_per_item(scenario):
    """Each refusal with its code and the job's closing line, and what it
    left for the report's refused list (test_job_refusals' scenarios)."""
    def edits(ws):
        ws.edits_text = True
    one, said = _same_by_both_forms(REFUSALS[scenario], machine_raw(), edits)
    assert one.left_by_refusal, said


ONLY_NEW = {
    'a value on a word the job did not add': [('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x'})],
    'a field the setup does not name': [('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph Gloss',
                                                       'value': 'fish'})],
    'a translation on a sentence the job did not add': [('set_field', {'refs': ['s2'], 'field': 'Translation',
                                                                       'value': 'A fish.'})],
    'a link on a word the job did not add': [('link_entry', {'refs': ['s1.w2'], 'entry_form': 'gam#2'})],
    'the new word of a retype and an old one': [
        ('retype_sentence', {'ref': 's2', 'text': 'zz Gam-ar.'}),
        ('set_field', {'refs': ['s2.w1 "zz"', 's2.w2 "Gam-ar"'], 'field': 'Gloss', 'value': 'he'})],
}


@pytest.mark.parametrize('scenario', list(ONLY_NEW))
def test_onlynew_and_outside_the_words_the_job_adds_are_the_same_per_item(scenario):
    """A job set up to fill only the words it adds (test_job_only_new's
    cases): refused with code not-added on what it did not add, item by
    item, and the items it may fill staged."""
    def only_new(ws):
        ws.edits_text = True
        ws.only_new = (set(), set())
    one, said = _same_by_both_forms(ONLY_NEW[scenario], setup=only_new)
    assert {e['code'] for e in one.left_by_refusal} == {'not-added'}, said


PLAIN = {
    'values on words, morphemes and a sentence': [
        ('set_field', {'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'fish'}),
        ('set_field', {'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'GEN'}),
        ('set_field', {'refs': ['s2'], 'field': 'Translation', 'value': 'Gam it is.'})],
    'the keep rule: a value as stored, then one planned taken back': [
        ('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'}),
        ('set_field', {'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
        ('set_field', {'refs': ['s1.w2'], 'field': 'Gloss', 'value': ''})],
    'a value on a morpheme of an analysis the plan writes': [
        ('set_analysis', {'ref': 's1.w3', 'morphemes': [{'form': 'aku'}, {'form': 'na', 'type': 'suffix'}]}),
        ('set_field', {'refs': ['s1.w3.m1', 's1.w3.m2'], 'field': 'Morph Gloss', 'value': 'see'}),
        ('link_entry', {'refs': ['s1.w3.m1'], 'entry_form': 'gam#2'})],
    'links, one already the stored one, and a homograph': [
        ('link_entry', {'refs': ['s1.w1.m2', 's1.w2.m1'], 'entry_form': 'gam#2'}),
        ('link_entry', {'refs': ['s1.w2'], 'entry_id': 'vi-gam'})],
}


@pytest.mark.parametrize('scenario', list(PLAIN))
def test_values_and_links_stage_the_same_plan_per_item(scenario):
    _same_by_both_forms(PLAIN[scenario])


# --- counts, as if staged one by one ---------------------------------------------------------------

def _field_job(monkeypatch, many):
    """test_job_fields' job (Thematic role on every word of three analysed
    sentences), the piece staging every value in one set_field call of
    items (``many``) or one call per word."""
    import test_job_fields as tf
    client, job, _, written = tf._job(monkeypatch, 'sentences')

    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n > 1:
            return reply('Filled.')
        refs = tf._piece_words(asked)
        if many:
            return reply(calls=[call(1, 'set_field', {'document': 'Story', 'field': tf.ROLE_NAME, 'items': [
                {'ref': f's{s}.w{w}', 'value': tf.role_of(s, w)} for s, w in refs]})])
        return reply(calls=[call(10 * s + w, 'set_field', {'document': 'Story', 'refs': [f's{s}.w{w}'],
                                                           'field': tf.ROLE_NAME, 'value': tf.role_of(s, w)})
                            for s, w in refs])
    model = use(monkeypatch, Model(answer))
    from job_fixtures import runner
    finished = run_job(job, runner(job))
    return finished, written, model


def _counted(report):
    keep = ('totals', 'documents')
    # A group's id is minted for each run: everything else must be the same.
    drop = ('gloss_group',)

    def clean(x):
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items() if k not in drop}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x
    return {k: clean(report.get(k)) for k in keep}


def test_values_staged_in_one_call_count_as_staged_one_by_one(monkeypatch):
    with monkeypatch.context() as m:
        one, written_one, model_one = _field_job(m, many=False)
    with monkeypatch.context() as m:
        many, written_many, model_many = _field_job(m, many=True)
    assert written_one == written_many
    assert _counted(one['report']) == _counted(many['report'])
    assert many['report']['totals']['fields'] == [{'field': 'Thematic role', 'id': 'sl-role', 'values': 9}]
    steps = [m for c in model_many.calls for m in c['kwargs']['messages'] if m['role'] == 'tool']
    assert steps and steps[0]['content'].startswith('Staged 9 of 9 values.'), steps


def test_links_staged_in_one_call_count_as_staged_one_by_one(monkeypatch):
    """A piece links each morpheme of an analysed document to an entry, one
    call per morpheme or one call of items: the same writes and counts."""
    from job_fixtures import JobClient, document, runner, start
    from plaid_agent.igt import job as igt_job
    words = [('ka', [('ka', 'go')], 'human'), ('ta', [('ta', 'go')], 'human')]

    def run(many, monkeypatch):
        client = JobClient({'d1': document('d1', 'Story', [{'words': words}, {'words': words[:1]}])})
        job = start(client, 'Link every morpheme to gam.', id='JIL', plan='sentences')
        sent = []
        real = igt_job.execute_plan

        def execute(c, ops, **kw):
            sent.extend(o for o in ops if o.get('kind') == 'link')
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        refs = ['s1.w1.m1', 's1.w2.m1', 's2.w1.m1']

        def answer(asked, n, kwargs):
            if 'Your piece: s' not in asked:
                return reply('Done.')
            if n > 1:
                return reply('Linked.')
            if many:
                return reply(calls=[call(1, 'link_entry', {'document': 'Story', 'items': [
                    {'ref': r, 'entry_id': 'vi-gam'} for r in refs]})])
            return reply(calls=[call(i, 'link_entry', {'document': 'Story', 'refs': [r], 'entry_id': 'vi-gam'})
                                for i, r in enumerate(refs)])
        use(monkeypatch, Model(answer))
        finished = run_job(job, runner(job))
        return finished, sent
    with monkeypatch.context() as m:
        one, sent_one = run(False, m)
    with monkeypatch.context() as m:
        many, sent_many = run(True, m)
    assert json.dumps(sent_one, sort_keys=True) == json.dumps(sent_many, sort_keys=True)
    assert len(sent_many) == 3
    assert _counted(one['report']) == _counted(many['report'])
    assert many['report']['totals']['links'] == 3


def test_a_piece_is_told_a_value_of_its_own_on_each_ref_goes_in_items():
    """The bench saw models write values keyed by ref (tools.ONE_SHAPE): a
    piece is pointed to items, never to one call per ref. The chat is told
    as before."""
    from plaid_agent.igt.tools import ONE_SHAPE, ONE_SHAPE_JOB
    ws = _ws()
    values = _schema(toolkit.job_piece_tools(ws), 'set_field')['properties']['values']['description']
    assert values.endswith('A value of its own on each ref: items.'), values
    wrong = {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss',
             'values': {'s1.w2': 'fish', 's1.w3': 'see'}}
    assert str(toolkit.job_piece_call(ws, 'set_field', wrong)) == f'Error: {ONE_SHAPE_JOB}'
    chat = _ws(job=False)
    assert str(toolkit.call_tool(chat, 'set_field', wrong)) == f'Error: {ONE_SHAPE}'
    assert 'one call per ref' in _schema(toolkit.tools_for(chat), 'set_field')['properties']['values']['description']


# --- several items in ONE call against the same items as single calls in order (REV-SP-2) ------------

#: The reviewer's probe table (scratchpad/REV-SP/probe1.py): items that meet
#: each other in one call. ``before``: calls made first, on both sides.
TOGETHER = {
    'a ref repeated with two values': ('set_field', {'field': 'Gloss'},
                                       [{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w2', 'value': 'see'}], []),
    'set then taken back in one call': ('set_field', {'field': 'Gloss'},
                                        [{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w2', 'value': ''}], []),
    'the same value twice': ('set_field', {'field': 'Gloss'},
                             [{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w2', 'value': 'fish'}], []),
    'a value on a morpheme of an analysis planned by an earlier item\'s call': (
        'set_field', {'field': 'Morph Gloss'}, [{'ref': 's1.w3.m1', 'value': 'see'}, {'ref': 's1.w3.m2', 'value': 'PST'}],
        [('set_analysis', {'ref': 's1.w3', 'morphemes': [{'form': 'aku'}, {'form': 'na', 'type': 'suffix'}]})]),
    'a word and its morpheme linked': ('link_entry', {}, [{'ref': 's1.w2', 'entry_id': 'vi-gam'},
                                                          {'ref': 's1.w2.m1', 'entry_form': 'gam#2'}], []),
    'one morpheme linked to two entries': ('link_entry', {}, [{'ref': 's1.w2.m1', 'entry_form': 'gam#2'},
                                                              {'ref': 's1.w2.m1', 'entry_id': 'vi-gam'}], []),
    'a homonym by bare form beside a good item': ('link_entry', {}, [{'ref': 's1.w2.m1', 'entry_form': 'gam'},
                                                                     {'ref': 's1.w3.m1', 'entry_form': 'gam#2'}], []),
    'an entry form shared beside items': ('link_entry', {'entry_form': 'gam#2'},
                                          [{'ref': 's1.w2.m1'}, {'ref': 's1.w3.m1'}], []),
    'an entry made in the piece, linked twice': (
        'link_entry', {}, [{'ref': 's1.w2.m1', 'entry_form': 'zork'}, {'ref': 's1.w3.m1', 'entry_form': 'zork'}],
        [('create_entry', {'form': 'zork', 'fields': {'gloss': 'ZORK'}})]),
    'a null value and none at all': ('set_field', {'field': 'Gloss'},
                                     [{'ref': 's1.w2', 'value': None}, {'ref': 's1.w3'}], []),
    'a ref by a form that does not match': ('set_field', {'field': 'Gloss'},
                                            [{'ref': 's1.w2 "nope"', 'value': 'x'}, {'ref': 's1.w3', 'value': 'y'}],
                                            []),
}


def _before(ws, before):
    for tool, args in before:
        toolkit.job_piece_call(ws, tool, args if tool == 'create_entry' else {'document': 'Text 1', **args})


@pytest.mark.parametrize('scenario', list(TOGETHER))
def test_items_that_meet_in_one_call_stage_what_the_single_calls_in_order_stage(scenario):
    tool, shared, items, before = TOGETHER[scenario]
    one, many = _ws(), _ws()
    _before(one, before)
    _before(many, before)
    singles = []
    for it in items:
        args = {'document': 'Text 1', **shared, **{k: v for k, v in it.items() if k != 'ref'}, 'refs': [it['ref']]}
        singles.append(toolkit.job_piece_call(one, tool, args))
    out = toolkit.job_piece_call(many, tool, {'document': 'Text 1', **shared, 'items': items})
    assert _ops(one) == _ops(many), (singles, out)
    assert one.left_by_refusal == many.left_by_refusal
    for i, s in enumerate(singles, start=1):
        if isinstance(s, Refusal):
            assert f'item {i} ' in str(out) and str(s)[len('Error: '):] in str(out), (s, out)


def test_an_item_naming_more_than_one_reference_is_refused_alone():
    """REV-SP-3: "s1.w2, s1.w3" in one item staged two changes and was
    counted as one value."""
    ws = _ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': [
        {'ref': 's1.w2, s1.w3', 'value': 'x'}, {'ref': 's1.w1', 'value': 'y'}]})
    assert out.splitlines()[1] == ('Refused: item 1 s1.w2, s1.w3: one reference per item: give s1.w2, s1.w3 each '
                                   'as an item of its own.'), out
    assert [o['token_id'] for o in ws.ops] == ['w-1']


@pytest.mark.parametrize('items,label', [
    ([{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w2', 'value': 'see'}], 'Set 1 value, 1 replaced in this call'),
    ([{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w2', 'value': ''}],
     'Set 0 values, 1 not staged, 1 replaced in this call'),
    ([{'ref': 's1.w2', 'value': 'fish'}, {'ref': 's1.w3', 'value': 'see'}], 'Set 2 values'),
])
def test_the_step_line_counts_what_the_plan_holds_after_the_call(items, label):
    """REV-SP-4: an item whose change a later item of the same call
    superseded or took back is not counted as set."""
    ws = _ws()
    toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'field': 'Gloss', 'items': items})
    assert ws.step_label == label
