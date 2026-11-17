"""An entry a plan creates is reachable by the rest of that plan (2026-11-17
survey, item 5): run_code's lexicon() did not list it, so code that set
variantOf on each new entry found none of them and set nothing, and a
reference field could not name it at all ("approve the plan, then set the
reference"). create_entry answers with the entry_id every later call of the
plan takes. lexicon() lists the plan's new entries under that id, marked
``staged``. A reference field may name a planned entry by it, and approval
writes the id the entry is made under."""

import pytest

from fixtures import applied
from test_dictionary import dict_ws

from plaid_agent.core import sandbox
from plaid_agent.igt.plan import validate_ops
from plaid_agent.igt.toolkit import call_tool


def _key(out):
    return out.split('entry_id: ', 1)[1].split()[0]


def _made_under(c, form):
    """The id approval made the entry spelled ``form`` under."""
    return next(p['kwargs']['id'] for p in c.payloads('vocab_items.create') if p['args'][1] == form)


def _patches(c, item_id):
    return [ops for iid, ops in c.patches('vocab_items') if iid == item_id]


def test_lexicon_in_run_code_lists_the_entries_the_plan_creates():
    if sandbox.available() is not None:
        pytest.skip(sandbox.available())
    w = dict_ws()
    code = ('print(plan("create_entry", form="lalo", fields={"gloss": "cook"}))\n'
            'new = [e for e in lexicon() if e["staged"]]\n'
            'print([(e["form"], e["fields"]["gloss"]) for e in new])\n'
            'print(all(not e["staged"] for e in lexicon() if e["form"] == "kwatha"))\n'
            'for e in new:\n'
            '    print(plan("set_entry_field", entry_id=e["id"], field="variantOf", value="kwatha"))\n')
    out = call_tool(w, 'run_code', {'code': code})
    assert "[('lalo', 'cook')]" in out and '\nTrue\n' in out
    create = next(o for o in w.ops if o['kind'] == 'create_entry')
    assert create['metadata']['variantOf'] == 'd-kwatha'


def test_a_reference_field_names_a_planned_entry_by_its_entry_id():
    w = dict_ws()
    key = _key(call_tool(w, 'create_entry', {'form': 'lalo', 'fields': {'gloss': 'cook'}}))
    out = call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'seeAlso', 'value': key})
    assert out.startswith('Planned 1 change, entry "nyumba": seeAlso "kwatha", "phika", "lalo" (new)'), out
    c = applied(w)
    made = _made_under(c, 'lalo')
    assert _patches(c, 'd-nyumba') == [[{'op': 'set', 'path': ['seeAlso'], 'value': ['d-kwatha', 'd-phika', made]}]]


def test_a_new_entry_names_one_the_plan_creates_after_it():
    w = dict_ws()
    first = _key(call_tool(w, 'create_entry', {'form': 'lalo', 'fields': {'gloss': 'cook'}}))
    second = _key(call_tool(w, 'create_entry', {'form': 'lalu', 'fields': {'gloss': 'cook'}}))
    # Set on the first one created, naming the second, and the other way round.
    assert 'updated the pending new entry' in call_tool(w, 'set_entry_field', {
        'entry_id': first, 'field': 'variantOf', 'value': second})
    assert 'updated the pending new entry' in call_tool(w, 'set_entry_field', {
        'entry_id': second, 'field': 'seeAlso', 'value': first})
    assert [o['label'] for o in w.ops] == ['Lexicon: new entry lalo | gloss=cook | variantOf="lalu" (new)',
                                           'Lexicon: new entry lalu | gloss=cook | seeAlso="lalo" (new)']
    # And an entry may not name itself.
    assert 'cannot refer to itself' in call_tool(w, 'set_entry_field', {
        'entry_id': first, 'field': 'seeAlso', 'value': first})
    c = applied(w)
    lalo, lalu = _made_under(c, 'lalo'), _made_under(c, 'lalu')
    made = {p['args'][1]: p['args'][2] for p in c.payloads('vocab_items.create')}
    assert made['lalo']['variantOf'] == lalu and made['lalu']['seeAlso'] == [lalo]


def test_a_plan_naming_an_entry_no_create_of_it_makes_is_refused():
    ops = [{'kind': 'set_entry_field', 'item_id': 'd-nyumba', 'field': 'variantOf', 'value': 'new:v1:lalo#1',
            'label': ''}]
    with pytest.raises(Exception, match='names an entry this plan does not create'):
        validate_ops(ops)
