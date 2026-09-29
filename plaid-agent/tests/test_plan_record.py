"""What a settled plan keeps of what it proposed.

A plan the user discards, or one refused as out of date, writes nothing, so the
audit log never sees it. For a study of what the assistant proposed and what
people did with it, those are half the record. The settled card used to keep
only `changes` and `labels` (for people), so the ids a change targeted and the
value it proposed were gone with `ops` (plaid_assistant_record_size ruling).

Now each change the plan stood for keeps ``[kind, target id, short value]``
(and the second thing it joins, for a kind that joins two) under ``proposed``, at most :data:`PROPOSED_MAX` of them with ``proposed_count``
saying how many there were, and the item keeps when it was settled. Approval
is of the whole plan, so each change's outcome is the plan's ``status``.
"""

import copy

import pytest

import test_stale_by_sentence as sbs

from plaid_agent.core.conversation import (
    PROPOSED_MAX, PROPOSED_VALUE_MAX, ConversationStore, assistant_item, build_meta, compact_plan,
    proposed_changes, settle_plan, user_item)
from plaid_agent.core.plan import PlanError
from plaid_agent.igt.service import AssistantService as IgtService
from plaid_agent.ud.service import AssistantService as UdService
from plaid_agent.umr.service import AssistantService as UmrService

T1, T2, T3 = ('019a0000-0000-7000-8000-00000000000%d' % i for i in (1, 2, 3))
IGT = IgtService.proposed_keys


def _item(ops, status='discarded'):
    plan = {'id': 'p1', 'summary': 's', 'labels': ['l'] * len(ops), 'changes': [{'label': 'l'}] * len(ops),
            'ops': ops, 'documents': [{'id': 'd1', 'name': 'Text', 'version': 3}]}
    plan['proposed'], plan['proposed_count'] = proposed_changes(ops, *IGT)
    return {**assistant_item('a', plan, [], [], '', 'm'), 'status': status}


def test_each_change_keeps_its_kind_target_and_a_short_value():
    ops = [
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': T1, 'span_id': None, 'value': 'fish', 'label': 'x'},
        {'kind': 'link', 'token_id': None, 'analysis_word_id': T2, 'item_id': T3, 'entry_form': 'kai'},
        {'kind': 'confirm', 'span_id': T3, 'label': 'x'},
        {'kind': 'link_phrase', 'token_ids': [T2, T3], 'label': 'x'},
        {'kind': 'edit_text', 'document_id': 'd1', 'sentence_id': T1, 'new': 'x' * 100, 'label': 'x'},
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': T1, 'value': None, 'label': 'clear'},
        {'kind': 'add_guideline', 'title': 'Glossing', 'body': 'long', 'label': 'x'},
        {'kind': 'split_word', 'word_id': T1, 'position': 4, 'label': 'x'},
        {'kind': 'set_morph_type', 'morpheme_id': T2, 'morph_type': True},
    ]
    plan = compact_plan(_item(ops))['plan']
    assert 'ops' not in plan and 'documents' not in plan and plan['op_count'] == len(ops)
    long = 'x' * (PROPOSED_VALUE_MAX - 1) + '…'
    assert plan['proposed'] == [
        ['set_span', T1, 'fish'],
        ['link', T2, 'kai', T3],
        ['confirm', T3, None],
        ['link_phrase', T2, None, None],
        ['edit_text', T1, long],
        ['set_span', T1, None],
        ['add_guideline', None, 'Glossing'],
        ['split_word', T1, None],
        ['set_morph_type', T2, None],
    ]
    assert plan['proposed_count'] == len(ops)


def test_each_app_names_its_own_targets_and_values():
    head = {'kind': 'set_head', 'word_id': T2, 'head_id': T3, 'word_form': 'corre', 'deprel': 'nsubj'}
    assert proposed_changes([head], *UdService.proposed_keys)[0] == [['set_head', T2, 'nsubj', T3]]
    edge = {'kind': 'create_edge', 'relation_layer_id': 'L', 'role': ':ARG0', 'source_span_id': T1}
    concept = {'kind': 'set_concept', 'span_id': T2, 'var': 's1e', 'concept': 'eat-01', 'ref': 's1.s1e'}
    assert proposed_changes([edge, concept], *UmrService.proposed_keys)[0] == [
        ['create_edge', T1, ':ARG0', None], ['set_concept', T2, 'eat-01']]


def test_a_change_between_two_things_keeps_the_second_one():
    # A head proposal is mostly the head, and an edge mostly its target: with
    # only the dependent or the source kept, a discarded plan's record could
    # not say what it proposed. The kinds that join two things keep the second
    # one in a fourth slot, and only those kinds, so each kind has one shape.
    ud = UdService.proposed_keys
    head = {'kind': 'set_head', 'word_id': T2, 'head_id': T3, 'word_form': 'corre', 'deprel': 'nsubj'}
    root = {**head, 'head_id': T2, 'deprel': 'root'}
    merge = {'kind': 'merge_sentences', 'document_id': 'd1', 'sentence_id': T1, 'previous_id': T2}
    span = {'kind': 'set_span', 'layer_id': 'L', 'token_id': T1, 'value': 'NOUN'}
    assert proposed_changes([head, root, merge, span], *ud)[0] == [
        ['set_head', T2, 'nsubj', T3], ['set_head', T2, 'root', T2], ['merge_sentences', T1, None, T2],
        ['set_span', T1, 'NOUN']]
    umr = UmrService.proposed_keys
    edge = {'kind': 'create_edge', 'relation_layer_id': 'L', 'role': ':ARG0', 'source_span_id': T1,
            'target_span_id': T2}
    to_new = {**edge, 'target_span_id': None, 'target_var': 's1p'}
    triple = {'kind': 'create_triple', 'rel': ':modal', 'source_span_id': T1, 'target_span_id': T3}
    assert proposed_changes([edge, to_new, triple], *umr)[0] == [
        ['create_edge', T1, ':ARG0', T2], ['create_edge', T1, ':ARG0', None], ['create_triple', T1, ':modal', T3]]
    link = {'kind': 'link', 'token_id': T1, 'item_id': T3, 'entry_form': 'kai'}
    phrase = {'kind': 'link_phrase', 'token_ids': [T1, T2], 'item_id': T3, 'entry_form': 'kai'}
    entries = {'kind': 'merge_entries', 'keep_id': T1, 'remove_id': T2}
    words = {'kind': 'merge_words', 'word_id': T1, 'other_ids': [T2, T3]}
    sentences = {'kind': 'merge_sentences', 'sentence_id': T1, 'other_id': T2}
    assert proposed_changes([link, phrase, entries, words, sentences], *IGT)[0] == [
        ['link', T1, 'kai', T3], ['link_phrase', T1, 'kai', T3], ['merge_entries', T1, None, T2],
        ['merge_words', T1, None, T2], ['merge_sentences', T1, None, T2]]


def test_one_kind_of_change_always_names_the_same_kind_of_thing():
    # A phrase link lands on its words (its card row's `at`), whether it links
    # them to an entry that exists or to one the plan makes. Naming the entry in
    # one case and the first word in the other would make one kind's targets
    # two kinds of id, and a reader counting proposals per word would miss half.
    to_old = {'kind': 'link_phrase', 'token_ids': [T2, T3], 'item_id': T1, 'new_entry_key': None,
              'existing_link_id': None, 'entry_form': 'kai'}
    to_new = {**to_old, 'item_id': None, 'new_entry_key': {'form': 'kai'}}
    assert proposed_changes([to_old, to_new], *IGT)[0] == [['link_phrase', T2, 'kai', T1],
                                                          ['link_phrase', T2, 'kai', None]]
    # A node a UMR plan adds to a sentence names the sentence, not the whole
    # document, as the ops of a drafted graph otherwise all would.
    node = {'kind': 'create_node', 'document_id': 'd1', 'ref': 's1.s1e', 'var': 's1e', 'concept': 'eat-01',
            'attrs': [], 'node_layer_id': 'N', 'concept_layer_id': 'C', 'text_id': 'x1', 'sentence_id': T3,
            'begin': 0, 'end': 9}
    assert proposed_changes([node], *UmrService.proposed_keys)[0] == [['create_node', T3, 'eat-01']]


def test_a_value_is_clipped_by_code_points():
    clef = '\U0001d11e' * 30
    [[_, _, v]], _ = proposed_changes([{'kind': 'set_span', 'token_id': T1, 'value': clef}], *IGT)
    assert v == '\U0001d11e' * (PROPOSED_VALUE_MAX - 1) + '\u2026'
    [[_, _, v]], _ = proposed_changes([{'kind': 'set_span', 'value': 'y' * PROPOSED_VALUE_MAX}], *IGT)
    assert v == 'y' * PROPOSED_VALUE_MAX, 'a value that fits is kept whole'


def test_a_group_stored_as_one_op_keeps_every_member():
    group = {'kind': 'set_span', 'layer_id': 'L', 'compact': True, 'count': 3, 'label': '3 glosses',
             'items': {'token_id': [T1, T2, T3], 'span_id': [None, None, None],
                       'value': ['a', 'b', 'c'], 'doc': ['d1', 'd1', 'd1']}}
    plan = compact_plan(_item([group, {'kind': 'rename_document', 'document_id': 'd1', 'name': 'N'}]))['plan']
    assert plan['op_count'] == 2, 'the card rows stay lined up with the stored ops'
    assert plan['proposed'] == [['set_span', T1, 'a'], ['set_span', T2, 'b'], ['set_span', T3, 'c'],
                                ['rename_document', 'd1', 'N']]
    assert plan['proposed_count'] == 4


def test_past_the_cap_the_count_says_how_many_there_were():
    n = PROPOSED_MAX + 40
    group = {'kind': 'set_span', 'layer_id': 'L', 'compact': True, 'count': n, 'label': 'many',
             'items': {'token_id': [f't{i}' for i in range(n)], 'value': ['v'] * n}}
    plan = compact_plan(_item([group]))['plan']
    assert len(plan['proposed']) == PROPOSED_MAX and plan['proposed_count'] == n
    assert plan['proposed'][-1] == ['set_span', f't{PROPOSED_MAX - 1}', 'v']


def test_settling_stamps_when_and_an_undecided_plan_is_left_whole():
    item = {**_item([{'kind': 'set_span', 'token_id': T1, 'value': 'a'}]), 'status': None}
    conv = {'messages': [], 'display': [user_item('q'), item, copy.deepcopy(item)]}
    out = settle_plan(conv, 1, 'discarded', None)
    d = out['display'][1]
    assert d['status'] == 'discarded' and d['settled_at'].endswith('Z') and 'T' in d['settled_at']
    assert d['plan']['proposed'] == [['set_span', T1, 'a']] and 'ops' not in d['plan']
    assert 'settled_at' not in out['display'][2] and out['display'][2]['plan']['ops']
    # Compacting twice changes nothing: the record reads the same.
    assert compact_plan(d) is d


# --- the service's three outcomes, in every app ------------------------------------

@pytest.fixture(params=sorted(sbs.APPS))
def spec(request):
    return sbs.APPS[request.param]()


def _staged(spec, client, monkeypatch):
    """The spec's change staged the way a turn stages it, through the
    service, so the plan carries what the turn adds to it."""
    from importlib import import_module
    from plaid_agent.core import service as service_mod
    from plaid_agent.core.agent import ModelConfig, TurnResult
    from test_service_flow import Helper
    call_tool = import_module(f'plaid_agent.{spec["app"]}.toolkit').call_tool
    sid = f'{spec["app"]}:assist:fake'
    store = ConversationStore(client, 'u@x', spec['pid'], spec['app'])
    conv = {'messages': [{'role': 'user', 'content': 'do it'}], 'display': [user_item('do it')]}
    store.save('c1', conv, build_meta(None, 'c1', conv, sid, 'fake/model',
                                      pending={'kind': 'turn', 'request_id': 'r1', 'service_id': sid}))

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        name, args = spec['plan']
        call_tool(ws, name, dict(args))
        assert ws.ops
        return TurnResult('Planned.', [{'role': 'assistant', 'content': 'Planned.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    svc = spec['service']()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = sid
    svc.kit = svc.toolkit()
    helper = Helper(request_id='r1')
    svc.process_request({'requester_client': client, 'requester_id': 'u@x', 'project_id': spec['pid'],
                         'conversation_id': 'c1'}, helper)
    assert not helper.errors, helper.errors
    plan = _stored(spec, client)['plan']
    assert plan['proposed_count'] == len(plan['proposed']) >= 1, 'a staged plan carries what it proposes'
    return plan


def _stored(spec, client):
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return conv['display'][1]


def _check_record(item, plan):
    assert item['settled_at'].endswith('Z')
    kept = item['plan']
    assert 'ops' not in kept
    assert kept['proposed_count'] == len(kept['proposed']) >= 1
    # The target is an id the plan's ops named, never a label or a place.
    ids = set()
    for op in plan['ops']:
        for v in list(op.values()) + list((op.get('items') or {}).values()):
            for x in (v if isinstance(v, list) else [v]):
                if isinstance(x, str):
                    ids.add(x)
    assert all(t is None or t in ids for _, t, _ in kept['proposed']), kept['proposed']


def test_an_applied_plan_keeps_what_it_proposed(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    item = _stored(spec, client)
    assert item['status'] == 'applied'
    _check_record(item, plan)


def test_a_plan_refused_as_out_of_date_keeps_what_it_proposed(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    sbs._edit(client, spec, spec['same'])
    helper = sbs._approve(spec, client, plan)
    assert helper.errors and not helper.done
    item = _stored(spec, client)
    assert item['status'] == 'stale'
    _check_record(item, plan)


def test_a_plan_that_failed_partway_says_so_and_stays_decidable(spec, monkeypatch):
    """A failure after some batches committed leaves the card undecided, as
    before. Discarding it later must not read as "nothing was written"."""
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    svc_cls = spec['service']

    def boom(self, *a, **k):
        raise PlanError('the server refused', applied=1, total=2)

    monkeypatch.setattr(svc_cls, 'execute_plan', boom)
    helper = sbs._approve(spec, client, plan)
    assert helper.errors and 'Stopped partway' in helper.errors[-1]
    item = _stored(spec, client)
    assert item['status'] is None and item['plan']['ops'], 'still undecided, still whole'
    assert item['partly_applied'] is True


def test_a_failure_before_anything_was_written_leaves_no_mark(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)

    def boom(self, *a, **k):
        raise PlanError('the server refused', applied=0, total=2)

    monkeypatch.setattr(spec['service'], 'execute_plan', boom)
    sbs._approve(spec, client, plan)
    assert 'partly_applied' not in _stored(spec, client)


def test_an_applied_plan_keeps_what_was_dropped_when_it_was_applied(spec, monkeypatch):
    """Approval is of the whole plan, but applying may still drop a change
    another one supersedes. That is said in the note to the model, and kept on
    the item so the record says which changes did not land."""
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    real = spec['service'].execute_plan

    def with_note(self, *a, **k):
        out = real(self, *a, **k)
        out['notes'] = ['dropped: X (superseded)']
        return out

    monkeypatch.setattr(spec['service'], 'execute_plan', with_note)
    sbs._approve(spec, client, plan)
    item = _stored(spec, client)
    assert item['status'] == 'applied' and item['apply_notes'] == ['dropped: X (superseded)']


def test_a_contributors_approval_is_recorded_on_the_item(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    svc = spec['service']()
    from plaid_agent.core.agent import ModelConfig
    from test_service_flow import Helper
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = f'{spec["app"]}:assist:fake'
    svc.process_request({'requester_client': client, 'requester_id': 'u@x', 'project_id': spec['pid'],
                         'conversation_id': 'c1',
                         'approve': {'plan_id': plan['id'], 'contributed_by': 'u@x'}}, Helper(request_id='r9'))
    item = _stored(spec, client)
    assert item['status'] == 'applied' and item['contributed'] is True and item['as_human'] is False
