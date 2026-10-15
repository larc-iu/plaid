"""A ``where`` on replace_in_field and set_field_for_form (survey item 4,
7a3d3dee): a conditional corpus-wide change stays ONE rule with its card, the
condition is one word's conditions as sequence_search takes them, and it is
asked again at approval. Run against the session's real core (``live``)."""

import fixtures as igt_fx
from fixtures import FakeClient, fake_ws
from test_replaced_work_corpus import _store
from test_stale_by_sentence import APPS, _approve

from plaid_agent.core import rules
from plaid_agent.core.bidi import for_model
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.trace import describe_step


def _ws():
    client = FakeClient()
    return client, fake_ws(client)


def test_a_condition_on_a_morpheme_field_of_the_word_holds_the_replacement():
    _client, w = _ws()
    # Ali is glossed Ali on m-1a, in the word whose other morpheme is ERG.
    out = for_model(call_tool(w, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'Ali', 'replacement': 'PN',
                                                      'whole': True, 'where': {'Morph Gloss': 'erg'}}))
    assert out.startswith('Planned 1 value in 1 document, as one row on the card'), out
    [op] = w.ops
    assert rules.is_rule(op) and op['args']['where'] == {'Morph Gloss': 'erg'}
    assert op['head'].endswith(', where Morph Gloss is "erg"')
    # A word with no enclitic: the same replacement finds nothing.
    _client, w = _ws()
    out = call_tool(w, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'Ali', 'replacement': 'PN',
                                            'whole': True, 'where': {'type': 'enclitic'}})
    assert out.startswith('Nothing to change'), out
    assert w.ops == []


def test_a_condition_on_the_word_form_holds_set_field_for_form_and_survives_approval():
    client, w = _ws()
    # "gam" matches the morpheme of w-2 (gam) and the first of w-4 (Gam-ar),
    # ignoring case. The condition keeps only the word spelled gam.
    out = for_model(call_tool(w, 'set_field_for_form', {'form': 'gam', 'field': 'Morph Gloss', 'value': 'fish',
                                                        'where': {'form': 'gam'}}))
    assert out.startswith('Planned 1 value'), out
    [op] = w.ops
    assert op['args']['where'] == {'form': 'gam'}
    payload = w.plan_payload()
    [row] = payload['changes']
    assert row['change'].endswith(', where form is "gam"') and row['rule']['total'] == 1
    # Without the condition both are changed.
    _c2, w2 = _ws()
    assert call_tool(w2, 'set_field_for_form', {'form': 'gam', 'field': 'Morph Gloss', 'value': 'fish'}) \
        .startswith('Planned 2 values')
    plan = _store(w, client, igt_fx.PID, 'igt')
    helper = _approve(APPS['igt'](), client, plan)
    assert not helper.errors, helper.errors
    # Found again at approval with its condition: only the one value.
    assert [c['args'][1:3] for c in client.payloads('spans.create')] == [(['m-2'], 'fish')]
    assert client.payloads('spans.bulk_create') == []


def test_the_same_rule_with_another_condition_is_another_rule():
    _client, w = _ws()
    base = {'form': 'gam', 'field': 'Morph Gloss', 'value': 'fish', 'only_empty': False}
    call_tool(w, 'set_field_for_form', {**base, 'where': {'form': 'gam'}})
    call_tool(w, 'set_field_for_form', {**base, 'where': {'form': 'Gam-ar'}})
    assert len(w.ops) == 2 and {op['args']['where']['form'] for op in w.ops} == {'gam', 'Gam-ar'}
    call_tool(w, 'set_field_for_form', {**base, 'where': {'form': 'gam'}})
    assert len(w.ops) == 2


def test_a_bad_condition_is_refused_with_the_keys_it_takes():
    _client, w = _ws()
    out = for_model(call_tool(w, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'Ali', 'replacement': 'PN',
                                                      'where': {'pos': 'n'}}))
    assert 'No condition key "pos"' in out and '"form", "morpheme", "type"' in out and w.ops == []
    out = for_model(call_tool(w, 'replace_in_field', {'field': 'Translation', 'pattern': 'fish',
                                                      'replacement': 'net', 'where': {'form': 'gam'}}))
    assert 'a sentence field has no one word' in out and w.ops == []
    out = for_model(call_tool(w, 'set_field_for_form', {'form': 'gam', 'field': 'Morph Gloss', 'value': 'x',
                                                        'where': 'form=gam'}))
    assert 'where is one word\'s conditions' in out and w.ops == []


def test_a_planned_value_is_restated_only_on_a_word_that_meets_the_condition():
    _client, w = _ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2.m1', 's2.w1.m1'], 'field': 'Morph Gloss',
                               'value': 'top'})
    out = call_tool(w, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'top', 'replacement': 'TOP',
                                            'whole': True, 'where': {'form': 'gam'}})
    assert '1 planned change rewritten by this one.' in out, out
    by_token = {op.get('token_id'): op.get('value') for op in w.ops if op.get('kind') == 'set_span'}
    assert by_token == {'m-2': 'TOP', 'm-4a': 'top'}


def test_the_trace_says_the_condition():
    line = describe_step('replace_in_field', {'field': 'Gloss', 'pattern': 'ter', 'replacement': 'CAUS',
                                              'where': {'form': 'di'}})
    text = line['text'] if isinstance(line, dict) else str(line)
    assert text == 'Planned replacing “ter” → “CAUS” in Gloss where form is “di”'


def test_a_condition_holds_a_replacement_in_stored_morpheme_forms():
    _client, w = _ws()
    base = {'field': 'morpheme form', 'pattern': 'Gam', 'replacement': 'gam', 'whole': True}
    out = call_tool(w, 'replace_in_field', {**base, 'where': {'form': 'Gam-ar'}})
    assert out.startswith('Planned 1 morpheme form'), out
    _client, w = _ws()
    assert call_tool(w, 'replace_in_field', {**base, 'where': {'form': 'gam'}}).startswith('Nothing to change')
