"""An entry_id that is no id says what it is and how to name the entry.

read_lexicon printed an imported entry as ``t | cldfEntry=e107 | gloss=...``,
and its senses as ``cldfEntry=e107/e107-1``: the stamp the CLDF import left,
which reads exactly like an id. It is reserved now and no longer printed, but
the model can still have it from the file, so the refusal still names it. On the bench (build-q38-1,
igt-lex-link-sentence r3 and igt-lex-relink-senses r1) the model passed it as
entry_id 21 times and was told only "No lexicon entry with id e107/e107-1".
"""

import sys

sys.path.insert(0, 'tests')

from fixtures import VOCAB, FakeClient, fake_ws
from plaid_agent.igt.toolkit import call_tool


def _lexicon():
    return {'id': VOCAB, 'name': 'Lexicon', 'items': [
        {'id': 'vi-t', 'form': 't', 'metadata': {'cldfEntry': 'e107'}},
        {'id': 'vi-t1', 'form': 't', 'metadata': {'parent': 'vi-t', 'cldfEntry': 'e107/e107-1', 'gloss': '3.I'}},
        {'id': 'vi-t2', 'form': 't', 'metadata': {'parent': 'vi-t', 'cldfEntry': 'e107/e107-2', 'gloss': '3.II'}},
        {'id': 'vi-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
    ]}


def _link(entry_id):
    w = fake_ws(FakeClient(lexicon=_lexicon()))
    return w, call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': entry_id})


def test_a_field_value_passed_as_an_id_is_named_as_that_field_with_the_entrys_address():
    w, out = _link('e107/e107-1')
    assert out == ('Error: "e107/e107-1" is the cldfEntry field of "t#1.1", not an id. Name it with '
                   'entry_form "t#1.1", as read_lexicon numbers it. entry_id takes only an id a tool gave '
                   '(create_entry, or a list of candidates).'), out
    assert not w.ops
    _w, out = _link('e107')
    assert out.startswith('Error: "e107" is the cldfEntry field of "t", not an id. Name it with entry_form "t",')


def test_the_address_it_names_is_one_link_entry_takes():
    w = fake_ws(FakeClient(lexicon=_lexicon()))
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 't#1.1'})
    assert not out.startswith('Error'), out
    assert w.ops[-1]['item_id'] == 'vi-t1'


def test_an_id_that_matches_nothing_says_what_an_id_is_and_points_to_entry_form():
    _w, out = _link('e999')
    assert out == ('Error: No lexicon entry with id e999. entry_id takes only an id a tool gave (create_entry, '
                   'or a list of candidates). Name an entry by its form with entry_form ("gam", "gam#2", '
                   '"kwatha#1.2" for a sense), as read_lexicon shows it.'), out


def test_every_tool_that_names_an_entry_by_id_says_the_same():
    """find_entry is the one reader of entry_id, so the tools that take it all
    answer alike."""
    w = fake_ws(FakeClient(lexicon=_lexicon()))
    out = call_tool(w, 'set_entry_field', {'entry_id': 'e107/e107-2', 'field': 'gloss', 'value': 'x'})
    assert out.startswith('Error: "e107/e107-2" is the cldfEntry field of "t#1.2", not an id.'), out


def test_the_last_part_of_a_sense_key_names_that_sense():
    """igt-lex-relink-senses r1 (build-q38-fix2) passed "e236-1", the part of
    "e236/e236-1" after the slash, eight times."""
    _w, out = _link('e107-2')
    assert out.startswith('Error: "e107-2" is part of the cldfEntry field of "t#1.2", not an id.'), out
