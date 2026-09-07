"""A lexicon in Lexicography Mode: the sense tree, references between entries,
and promoted usage examples.

The point of most of these is that the agent writes what the app reads. The
shapes live in plaid-igt/src/domain/vocabDictionary.js, and the app's load-time
validator throws away anything that does not match, so a tool that writes a
form where an id belongs loses the user's work quietly.
"""

import pytest

from fixtures import FakeClient, VOCAB, project_raw, document_raw, scan_ws
from plaid_igt_agent.tools import call_tool

# gloss and pos are ordinary text; variantOf points at one entry, seeAlso at
# several, and etymology belongs to an entry rather than to each of its senses.
FIELDS = {
    'gloss': {'inline': True},
    'pos': {'inline': True},
    'variantOf': {'inline': False, 'type': 'item'},
    'seeAlso': {'inline': False, 'type': 'item', 'many': True},
    'etymology': {'inline': False, 'scope': 'entry'},
}

# kwatha is an entry with two senses, the first of which has a subsense.
ITEMS = [
    {'id': 'd-kwatha', 'form': 'kwatha', 'metadata': {'gloss': 'cook', 'pos': 'v', 'etymology': 'Proto-Bantu'}},
    {'id': 'd-boil', 'form': 'kwatha', 'metadata': {'gloss': 'boil', 'parent': 'd-kwatha', 'senseOrder': 1}},
    {'id': 'd-simmer', 'form': 'kwatha', 'metadata': {'gloss': 'simmer', 'parent': 'd-boil', 'senseOrder': 1}},
    {'id': 'd-ferment', 'form': 'kwatha', 'metadata': {'gloss': 'ferment', 'parent': 'd-kwatha', 'senseOrder': 2}},
    {'id': 'd-phika', 'form': 'phika', 'metadata': {'gloss': 'cook', 'variantOf': 'd-kwatha'}},
    {'id': 'd-nyumba', 'form': 'nyumba', 'metadata': {'gloss': 'house', 'seeAlso': ['d-kwatha', 'd-phika']}},
]


def dict_ws(dictionary=True, items=None):
    raw = project_raw()
    raw['vocabs'][0]['config'] = {'igt': {'fields': dict(FIELDS)}}
    if dictionary:
        raw['vocabs'][0]['config']['igt']['dictionary'] = True
    c = FakeClient(project=raw, documents={'d1': document_raw()})
    c._lexicon = {'id': VOCAB, 'name': 'Lexicon',
                  'items': [dict(it, metadata=dict(it['metadata'])) for it in (items or ITEMS)]}
    return scan_ws(c)


def ops_of(w, kind):
    return [o for o in w.ops if o.get('kind') == kind]


# ---- reading ---------------------------------------------------------------

def test_read_lexicon_draws_senses_under_their_entry():
    out = call_tool(dict_ws(), 'read_lexicon', {})
    assert 'Lexicography Mode): 3 entries, 3 senses' in out
    lines = [l for l in out.splitlines() if 'kwatha' in l]
    # The entry, then its senses indented and numbered as the user sees them.
    assert lines[0].strip().startswith('kwatha | gloss=cook')
    assert '1 kwatha | sense 1 of "kwatha" | gloss=boil' in lines[1]
    assert lines[1].index('1 kwatha') > lines[0].index('kwatha')
    assert '1.1 kwatha | sense 1.1 of "kwatha" | gloss=simmer' in lines[2]
    assert '2 kwatha | sense 2 of "kwatha" | gloss=ferment' in lines[3]


def test_a_flat_lexicon_is_unchanged():
    out = call_tool(dict_ws(dictionary=False), 'read_lexicon', {})
    assert 'Lexicography Mode' not in out and 'Lexicon": 6 entries' in out
    assert 'sense' not in out


def test_reserved_keys_never_read_as_fields():
    out = call_tool(dict_ws(), 'read_lexicon', {})
    # parent and senseOrder are structure, said in words instead of printed raw.
    assert 'parent=' not in out and 'senseOrder=' not in out and 'd-kwatha' not in out
    # A reference reads as the entry it points at, not as an id.
    assert 'variantOf="kwatha"' in out and 'seeAlso="kwatha", "phika"' in out


def test_lexicon_entry_says_where_it_sits():
    w = dict_ws()
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#1'})
    assert 'Sense 1 of entry "kwatha"' in out and 'entry_form "kwatha#1"' in out
    assert 'Senses (1):' in out and '1.1 kwatha' in out
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha'})
    assert 'Entry "kwatha"' in out and 'also its sense' not in out
    assert 'Referred to by:' in out
    assert '"kwatha" sense 1 (a sense of it)' in out and '"phika" (variantOf)' in out


# ---- addressing ------------------------------------------------------------

def test_a_bare_form_is_the_entry_and_a_suffix_is_the_sense():
    w = dict_ws()
    # Every sense here carries the headword, so without this rule a bare
    # "kwatha" would be four candidates rather than one entry.
    assert 'Entry "kwatha"' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha'})
    assert 'Sense 1.1' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#1.1'})
    assert 'Sense 2' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#2'})
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#9'})
    assert 'no sense 9' in out.lower() or 'No lexicon entry' in out


def test_the_homograph_suffix_still_works_without_the_mode():
    w = dict_ws(dictionary=False)
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha'})
    # Flat: the four items sharing the form are four candidates again.
    assert 'Several entries match "kwatha"' in out


# ---- writing fields --------------------------------------------------------

def test_a_reference_field_takes_a_form_and_stores_an_id():
    w = dict_ws()
    out = call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'variantOf', 'value': 'phika'})
    assert 'Planned 1 change' in out
    assert w.ops[-1]['value'] == 'd-phika'
    assert w.ops[-1]['label'] == 'entry "nyumba": variantOf "phika"'


def test_a_reference_to_an_ambiguous_form_asks_which():
    w = dict_ws(items=ITEMS + [{'id': 'd-phika2', 'form': 'phika', 'metadata': {'gloss': 'burn'}}])
    out = call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'variantOf', 'value': 'phika'})
    assert 'names several entries, so variantOf cannot tell which' in out
    assert 'id=d-phika' in out and 'id=d-phika2' in out
    assert not ops_of(w, 'set_entry_field')


def test_a_reference_that_names_nothing_is_refused_not_written_as_text():
    w = dict_ws()
    out = call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'variantOf', 'value': 'nonesuch'})
    assert 'has no entry "nonesuch" for variantOf to refer to' in out
    assert not ops_of(w, 'set_entry_field')


def test_a_many_reference_appends_and_an_empty_value_clears():
    w = dict_ws()
    call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'seeAlso', 'value': 'kwatha#2'})
    assert w.ops[-1]['value'] == ['d-kwatha', 'd-phika', 'd-ferment']
    call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'seeAlso', 'value': ''})
    assert w.ops[-1]['value'] == ''


def test_an_entry_may_not_refer_to_itself():
    w = dict_ws()
    out = call_tool(w, 'set_entry_field', {'entry_form': 'phika', 'field': 'variantOf', 'value': 'phika'})
    assert 'cannot refer to itself' in out


def test_an_entry_scope_field_is_refused_on_a_sense():
    w = dict_ws()
    out = call_tool(w, 'set_entry_field', {'entry_form': 'kwatha#1', 'field': 'etymology', 'value': 'x'})
    assert 'belongs to an entry rather than to each sense' in out and 'Set it on "kwatha"' in out
    assert 'Planned 1 change' in call_tool(w, 'set_entry_field',
                                           {'entry_form': 'kwatha', 'field': 'etymology', 'value': 'x'})


@pytest.mark.parametrize('name,says', [
    ('parent', 'add_sense, make_sense_of or free_sense'),
    ('senseOrder', 'move_sense'),
    ('examples', 'promote_example'),
    ('form', 'rename_entry'),
])
def test_a_reserved_key_is_never_a_field(name, says):
    out = call_tool(dict_ws(), 'set_entry_field', {'entry_form': 'phika', 'field': name, 'value': 'x'})
    assert f'"{name}" is not an entry field' in out and says in out


# ---- the sense tree --------------------------------------------------------

def test_add_sense_numbers_after_the_senses_there_are():
    w = dict_ws()
    out = call_tool(w, 'add_sense', {'entry_form': 'kwatha', 'fields': {'gloss': 'stew'}})
    assert 'Planned 1 change' in out
    op = ops_of(w, 'create_entry')[0]
    assert op['form'] == 'kwatha' and op['metadata'] == {'gloss': 'stew', 'parent': 'd-kwatha', 'senseOrder': 3}
    assert 'new sense of "kwatha"' in op['label']


def test_move_sense_renumbers_the_siblings():
    w = dict_ws()
    out = call_tool(w, 'move_sense', {'entry_form': 'kwatha#2', 'number': '1'})
    assert 'Planned 2 changes' in out
    by_id = {o['item_id']: o['patch'] for o in ops_of(w, 'set_entry_metadata')}
    assert by_id == {'d-ferment': {'senseOrder': 1}, 'd-boil': {'senseOrder': 2}}
    assert 'sense 2 becomes sense 1' in ops_of(w, 'set_entry_metadata')[0]['label']


def test_moving_a_sense_nowhere_says_so_and_plans_nothing():
    w = dict_ws()
    out = call_tool(w, 'move_sense', {'entry_form': 'kwatha#1.1', 'number': '1'})
    assert 'Planned 0 changes' in out and 'no siblings to move among' in out
    assert not w.ops


def test_an_entry_cannot_be_renumbered():
    out = call_tool(dict_ws(), 'move_sense', {'entry_form': 'phika', 'number': '2'})
    assert 'carries no sense number of its own' in out


def test_make_sense_of_and_free_sense():
    w = dict_ws()
    call_tool(w, 'make_sense_of', {'entry_form': 'phika', 'under_form': 'kwatha'})
    assert w.ops[-1]['patch'] == {'parent': 'd-kwatha', 'senseOrder': 3}
    assert 'becomes a sense of "kwatha"' in w.ops[-1]['label']
    w2 = dict_ws()
    call_tool(w2, 'free_sense', {'entry_form': 'kwatha#1'})
    # The subsense below it comes along: only the parent link is cut.
    assert w2.ops[-1]['patch'] == {'parent': None, 'senseOrder': None}
    assert 'with 1 sense below it' in w2.ops[-1]['label']


def test_a_sense_cannot_be_moved_under_its_own_descendant():
    w = dict_ws()
    out = call_tool(w, 'make_sense_of', {'entry_form': 'kwatha', 'under_form': 'kwatha#1.1'})
    assert 'would make a loop' in out
    assert not w.ops


def test_structural_tools_compose_within_one_plan():
    w = dict_ws()
    call_tool(w, 'free_sense', {'entry_form': 'kwatha#1'})
    # d-boil is an entry now, so its own former subsense is addressed under it.
    out = call_tool(w, 'read_lexicon', {})
    assert '4 entries, 2 senses' in out


# ---- usage examples --------------------------------------------------------

def test_promote_and_remove_an_example():
    w = dict_ws()
    out = call_tool(w, 'promote_example', {'entry_form': 'phika', 'document': 'd1', 'ref': 's1.w2'})
    assert 'Planned 1 change' in out
    assert w.ops[-1]['patch'] == {'examples': [{'document': 'd1', 'token': 'w-2'}]}
    assert 'usage example "Text 1" s1.w2 "gam"' in w.ops[-1]['label']
    # It shows up numbered, and that number is what removes it.
    assert '[0] "Text 1" s1.w2' in call_tool(w, 'lexicon_entry', {'entry_form': 'phika'})
    call_tool(w, 'remove_example', {'entry_form': 'phika', 'index': 0})
    assert w.ops[-1]['patch'] == {'examples': None}


def test_a_duplicate_example_is_ignored_and_a_bad_index_says_the_range():
    w = dict_ws()
    call_tool(w, 'promote_example', {'entry_form': 'phika', 'document': 'd1', 'ref': 's1.w2'})
    out = call_tool(w, 'promote_example', {'entry_form': 'phika', 'document': 'd1', 'ref': 's1.w2'})
    assert 'already has that example' in out
    assert 'numbered 0 to 0' in call_tool(w, 'remove_example', {'entry_form': 'phika', 'index': 4})


def test_the_dictionary_tools_refuse_a_lexicon_without_the_mode():
    w = dict_ws(dictionary=False)
    out = call_tool(w, 'add_sense', {'entry_id': 'd-phika'})
    assert 'not in Lexicography Mode' in out and 'no senses, entry references or usage examples' in out


# ---- delete and merge carry the references ---------------------------------

def test_deleting_an_entry_frees_its_senses_and_clears_what_named_it():
    w = dict_ws()
    out = call_tool(w, 'delete_entry', {'entry_form': 'kwatha'})
    assert 'freed or cleared' in out
    by_id = {o['item_id']: o['patch'] for o in ops_of(w, 'set_entry_metadata')}
    # Its two senses become entries; the subsense stays under the one it had.
    assert by_id['d-boil'] == {'parent': None, 'senseOrder': None}
    assert by_id['d-ferment'] == {'parent': None, 'senseOrder': None}
    assert 'd-simmer' not in by_id
    # And the fields that pointed at it let go.
    assert by_id['d-phika'] == {'variantOf': None}
    assert by_id['d-nyumba'] == {'seeAlso': ['d-phika']}


def test_merging_repoints_references_at_the_survivor():
    w = dict_ws()
    out = call_tool(w, 'merge_entries', {'keep_form': 'phika', 'remove_form': 'kwatha'})
    assert 'repointed at the survivor' in out
    by_id = {o['item_id']: o['patch'] for o in ops_of(w, 'set_entry_metadata')}
    # A patch carries only what changes: both senses keep the order they had,
    # because phika has none of its own for them to be appended after.
    assert by_id['d-boil'] == {'parent': 'd-phika'}
    assert by_id['d-ferment'] == {'parent': 'd-phika'}
    assert by_id['d-phika'] == {'variantOf': None}       # it referred to the loser
    assert by_id['d-nyumba'] == {'seeAlso': ['d-phika']}  # deduped onto the survivor


def test_a_flat_lexicon_carries_nothing_extra():
    w = dict_ws(dictionary=False)
    call_tool(w, 'delete_entry', {'entry_id': 'd-kwatha'})
    assert not ops_of(w, 'set_entry_metadata')


# ---- the quality report ----------------------------------------------------

def test_check_lexicon_counts_entries_not_senses():
    out = call_tool(dict_ws(), 'check_lexicon', {'section': 'homographs'})
    # Three items share the form "kwatha", but they are one entry's senses.
    assert 'No homographs.' in out


def test_senses_of_an_attested_entry_are_reported_apart():
    w = dict_ws()
    out = call_tool(w, 'check_lexicon', {'section': 'unused'})
    assert 'senses not linked from a text themselves' in out


def test_a_structural_change_on_a_doomed_entry_is_refused():
    w = dict_ws()
    call_tool(w, 'delete_entry', {'entry_form': 'kwatha'})
    out = call_tool(w, 'add_sense', {'entry_id': 'd-kwatha', 'fields': {'gloss': 'stew'}})
    assert 'deleted or merged away by this same plan' in out
    assert not ops_of(w, 'create_entry')


def test_the_plan_is_what_a_later_read_sees():
    w = dict_ws()
    call_tool(w, 'delete_entry', {'entry_form': 'kwatha'})
    out = call_tool(w, 'read_lexicon', {})
    # The entry is gone and its two senses stand on their own, which is what
    # the delete actually does once approved.
    assert '4 entries, 1 senses' in out and 'gloss=cook | pos=v' not in out
    assert 'variantOf=' not in out and 'seeAlso="phika"' in out


def test_entries_sharing_a_form_are_told_apart_by_their_shown_number():
    """The number is the app's own (buildItemNumbers): a first segment for
    entries that share a form, then the sense path under it."""
    w = dict_ws(items=ITEMS + [{'id': 'd-phika2', 'form': 'phika', 'metadata': {'gloss': 'burn'}}])
    assert '(id d-phika2, entry_form "phika#2")' in call_tool(w, 'lexicon_entry', {'entry_form': 'phika#2'})
    assert '(id d-phika, entry_form "phika#1")' in call_tool(w, 'lexicon_entry', {'entry_form': 'phika#1'})
    # kwatha heads only one entry, so its senses carry no leading segment.
    assert 'Sense 1.1 of entry "kwatha" (id d-simmer' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#1.1'})


def test_a_flat_lexicon_numbers_homonyms_positionally():
    """Without the mode the app numbers items sharing a form 1..n in creation
    order (buildHomonymIndex), and that is what the suffix means."""
    w = dict_ws(dictionary=False)
    assert '(id d-simmer)' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#3'})
    assert '(id d-kwatha)' in call_tool(w, 'lexicon_entry', {'entry_form': 'kwatha#1'})


def test_move_sense_takes_the_last_segment_of_a_dotted_number():
    """A sense is shown with a dotted number, but it moves among its siblings."""
    w = dict_ws()
    call_tool(w, 'move_sense', {'entry_form': 'kwatha#2', 'number': '1.1'})
    by_id = {o['item_id']: o['patch'] for o in ops_of(w, 'set_entry_metadata')}
    assert by_id == {'d-ferment': {'senseOrder': 1}, 'd-boil': {'senseOrder': 2}}


# ---- homographs ------------------------------------------------------------

# Entries spelled the same, deliberately out of creation order: the second one
# created is homograph 1. A FLEx import writes FLEx's numbers this way.
HOMOGRAPHS = [
    {'id': 'h-late', 'form': 'x', 'metadata': {'gloss': 'late', 'homograph': 2}},
    {'id': 'h-early', 'form': 'x', 'metadata': {'gloss': 'early', 'homograph': 1}},
    {'id': 'h-none', 'form': 'x', 'metadata': {'gloss': 'unnumbered'}},
    {'id': 'h-sense', 'form': 'x', 'metadata': {'gloss': 'a sense', 'parent': 'h-late'}},
    {'id': 'h-solo', 'form': 'y', 'metadata': {'gloss': 'alone'}},
]


def test_the_number_follows_the_stored_homograph_order_not_creation_order():
    """The shown number is homograph segment then sense path, so a sense of the
    second entry reads 2.1. Ordering by creation instead would name a different
    entry than the user sees, which is what a FLEx import makes likely."""
    w = dict_ws(items=HOMOGRAPHS)
    out = call_tool(w, 'read_lexicon', {})
    assert 'id h-early' in call_tool(w, 'lexicon_entry', {'entry_form': 'x#1'})
    assert 'id h-late' in call_tool(w, 'lexicon_entry', {'entry_form': 'x#2'})
    assert 'id h-none' in call_tool(w, 'lexicon_entry', {'entry_form': 'x#3'})
    assert 'id h-sense' in call_tool(w, 'lexicon_entry', {'entry_form': 'x#2.1'})
    # An entry whose form is its own carries no number at all.
    assert 'entry_form "y")' in call_tool(w, 'lexicon_entry', {'entry_form': 'y'})
    assert out.count('sense 2.1') == 1


def test_order_homographs_renumbers_the_group():
    w = dict_ws(items=HOMOGRAPHS)
    out = call_tool(w, 'order_homographs', {'entry_form': 'x#1', 'order': ['3', '1', '2']})
    assert 'Planned 3 changes' in out
    by_id = {o['item_id']: o['patch'] for o in ops_of(w, 'set_entry_metadata')}
    assert by_id == {'h-none': {'homograph': 1}, 'h-early': {'homograph': 2}, 'h-late': {'homograph': 3}}
    assert 'entry "x" (3) becomes number 1' in ops_of(w, 'set_entry_metadata')[0]['label']


def test_order_homographs_checks_the_group_is_named_in_full():
    w = dict_ws(items=HOMOGRAPHS)
    assert 'Give all 3 entries' in call_tool(w, 'order_homographs', {'entry_form': 'x#1', 'order': ['1', '2']})
    assert 'named twice' in call_tool(w, 'order_homographs', {'entry_form': 'x#1', 'order': ['1', '1', '2']})
    out = call_tool(w, 'order_homographs', {'entry_form': 'x#1', 'order': ['1', '2', '9']})
    assert 'not one of the 3 entries spelled "x"' in out
    assert not w.ops


def test_order_homographs_is_refused_for_a_lone_entry():
    w = dict_ws(items=HOMOGRAPHS)
    out = call_tool(w, 'order_homographs', {'entry_form': 'y', 'order': ['1']})
    assert 'only entry spelled that way' in out


def test_the_homograph_key_is_not_a_field():
    out = call_tool(dict_ws(items=HOMOGRAPHS), 'set_entry_field',
                    {'entry_form': 'x#1', 'field': 'homograph', 'value': '3'})
    assert '"homograph" is not an entry field' in out and 'order_homographs' in out
