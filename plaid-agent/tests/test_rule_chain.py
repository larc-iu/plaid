"""igt rules resolve in plan order, each over only the rules before it, a kept
value read as stored, whatever changed the plan (REV3-AGENT-1 to 3). The
generated sweep is ``test_rule_chain_oracle.py``."""

from test_igt_rules import _approved, _replace, _ws
from test_tools import call_tool

from plaid_agent.core.plan import plan_changes


def _set(w, ref, value, **kw):
    args = {'document': 'd1', 'refs': [ref], **({'values': {'Gloss': value}} if kw.get('values') else
                                                {'field': 'Gloss', 'value': value})}
    return call_tool(w, 'set_field', args)


def _approve(client, w):
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    return dict(client.updates('spans'))


def test_a_keep_made_after_two_chained_rules_counts_and_approves_what_the_chain_writes():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _replace(w, 'Bob', 'Cy', whole=True)
    out = _set(w, 's1.w1', 'Ali')
    assert out.endswith('The plan now holds 1 change.'), out
    payload = w.plan_payload()
    assert plan_changes(payload['ops']) == 1
    assert [(r['rule'] or {}).get('total') for r in payload['changes'] if r.get('rule')] == [0, 1]
    assert call_tool(w, 'plan_status', {}).startswith('1 planned change and 1 kept value')
    assert _approve(client, w) == {'sp-x2': 'Cy'}


def test_a_keep_replaced_by_a_named_value_is_no_longer_read_as_stored():
    for values in (False, True):
        # The keep made before the later rule, and after it.
        for keep_first in (True, False):
            client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
            _replace(w, 'Ali', 'Bob', whole=True)
            if keep_first:
                _set(w, 's1.w1', 'Ali')
            _replace(w, 'Bob', 'Cy', whole=True)
            if not keep_first:
                _set(w, 's1.w1', 'Ali', values=values)
            _set(w, 's1.w1', 'Carl', values=values)
            assert plan_changes(w.plan_payload()['ops']) == 2
            assert _approve(client, w) == {'sp-g1': 'Carl', 'sp-x2': 'Cy'}


# --- FX-E-AGENT (REV4-AGENT): a value that ends as stored is no change ---------------


def test_rules_that_end_on_the_stored_value_count_and_write_nothing():
    # "Ali" → "Bob", then "Bob" → "Ali": nothing changes (REV4-AGENT-1).
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    out = _replace(w, 'Bob', 'Ali', whole=True)
    assert out.startswith('Planned 0 values in 0 documents'), out
    assert '2 values it matches go back to what is stored, so approval writes nothing there.' in out, out
    payload = w.plan_payload()
    assert plan_changes(payload['ops']) == 0
    assert [r['rule']['total'] for r in payload['changes']] == [0, 0]
    assert call_tool(w, 'plan_status', {}).startswith('0 planned changes in 2 numbered entries')
    # Nothing to write: approved, it settles as discarded (Luke 2026-10-16).
    _plan, helper = _approved(client, w)
    assert helper.errors == ['Nothing to write. The plan was discarded.'], helper.errors
    assert dict(client.updates('spans')) == {}


def test_a_named_change_a_rule_sets_back_to_the_stored_value_is_kept():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Bob'})
    _set(w, 's1.w1', 'Bob')
    out = _replace(w, 'Bob', 'Ali', whole=True)
    assert ('1 planned change rewritten by this one back to the value stored: approval leaves it as it is.'
            in out), out
    assert w.ops[0]['kind'] == 'keep' and w.ops[0]['label'].endswith('Gloss stays "Ali"')
    assert plan_changes(w.plan_payload()['ops']) == 1
    assert _approve(client, w) == {'sp-x2': 'Ali'}


def test_a_rule_rewrites_a_named_change_before_it_and_never_one_after_it():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Bob'})
    _set(w, 's1.w1', 'Bob')
    out = _replace(w, 'Bob', 'Zed', whole=True)
    assert '1 planned change rewritten by this one.' in out, out
    assert w.ops[0]['value'] == 'Zed'
    assert _approve(client, w) == {'sp-g1': 'Zed', 'sp-x2': 'Zed'}
    # A value named after the rule is never rewritten by it, even named again
    # in the earlier one's place.
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Bob'})
    _set(w, 's1.w1', 'Bob')
    _replace(w, 'Bob', 'Zed', whole=True)
    _set(w, 's1.w1', 'Bob')
    assert w.ops[0]['value'] == 'Bob'
    assert _approve(client, w) == {'sp-g1': 'Bob', 'sp-x2': 'Zed'}


def test_a_rule_asked_again_applies_last():
    # REV4-AGENT-4: the last thing asked was "Bob" → "Cy".
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Bob'})
    for p, r in [('Ali', 'Bob'), ('Bob', 'Cy'), ('Cy', 'Bob')]:
        _replace(w, p, r, whole=True)
    out = _replace(w, 'Bob', 'Cy', whole=True)
    assert out.startswith('Planned 2 values'), out
    assert ('It was planned already as entry 2: that copy is gone, and this one applies after the changes planned '
            'since.') in out, out
    assert [op['args']['pattern'] for op in w.ops] == ['Ali', 'Cy', 'Bob']
    assert _approve(client, w) == {'sp-g1': 'Cy', 'sp-x2': 'Cy'}


def test_a_quoted_document_name_is_read_as_the_name():
    # REV4-AGENT-6: every read and refusal prints a name in quotes.
    _client, w = _ws({'sp-g1': 'Ali'})
    for name in ('"Text 1"', '“Text 1”'):
        assert w.resolve_document_id(name) == 'd1'
    assert not call_tool(w, 'read_document', {'document': '"Text 2"'}).startswith('Error')


def test_a_quoted_label_is_the_document_it_quotes_not_one_whose_name_holds_the_quotes():
    # REV5-AGENT-6: reads print Cuento as "Cuento", and "Cuento" as ""Cuento"".
    _client, w = _ws({'sp-g1': 'Ali'})
    w._doc_list = [{'id': 'q', 'name': '"Cuento"'}, {'id': 'c', 'name': 'Cuento'}, {'id': 'm', 'name': "'Mito'"}]
    for given, want in (('Cuento', 'c'), ('"Cuento"', 'c'), ('“Cuento”', 'c'), ('"cuento"', 'c'),
                        ('""Cuento""', 'q'), ('"“Cuento”"', 'q'), ("'Mito'", 'm'), ("\"'Mito'\"", 'm')):
        assert w.resolve_document_id(given) == want, given
    w._doc_list = [{'id': 'q', 'name': '"Cuento"'}]
    assert w.resolve_document_id('"Cuento"') == 'q'


def test_a_rule_asked_again_that_stays_says_what_its_entry_writes_and_why():
    # REV5-AGENT-4: kept, then named.
    client, w = _ws({'sp-g1': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _set(w, 's1.w1', 'Ali')
    out = _replace(w, 'Ali', 'Bob', whole=True)
    assert out == ('Nothing to change after the changes planned since: this change is entry 1 already, which stays '
                   'where it is and writes nothing now: the plan keeps the 1 value it matches as it is. For this '
                   'change to reach it, discard_plan and stage it again without that keep.'), out
    client, w = _ws({'sp-g1': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _set(w, 's1.w1', 'Cy')
    out = _replace(w, 'Ali', 'Bob', whole=True)
    assert out == ('Nothing to change after the changes planned since: this change is entry 1 already, which stays '
                   'where it is and writes nothing now: the plan names its own value for the 1 value it matches. '
                   'For this change to reach it, discard_plan and stage it again without that change.'), out
    assert _approve(client, w) == {'sp-g1': 'Cy'}


def test_a_rule_asked_again_names_each_rule_its_move_leaves_with_nothing():
    # REV5-AGENT-5 (Luke 2026-10-16): it still applies last, and says so.
    client, w = _ws({'sp-g1': 'Ali', 'sp-y1': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _replace(w, 'Bob', 'Cy', whole=True, document='Text 1')
    out = _replace(w, 'Ali', 'Bob', whole=True)
    assert out.split('\n')[0].endswith(
        'It was planned already as entry 1: that copy is gone, and this one applies after the changes planned since. '
        'Gloss "Bob" → "Cy" in "Text 1" now changes nothing (entry 1), and approval writes nothing for it.'), out
    assert _approve(client, w) == {'sp-g1': 'Bob', 'sp-y1': 'Bob'}
