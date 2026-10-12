"""What a lexicon lookup that misses says (2026-10-12 survey): an entry_gloss
that is no field's whole value lists the entries of that form with their
fields, and a new: id from an earlier message's plan says what names the
entry now."""
from fixtures import FakeClient, fake_ws
from plaid_agent.igt.toolkit import call_tool


def test_a_gloss_no_entry_has_lists_the_entries_of_that_form():
    out = call_tool(fake_ws(FakeClient()), 'link_entry',
                    {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam', 'entry_gloss': 'fishing net'})
    assert out.startswith('Error: No entry "gam" has a field valued "fishing net".')
    assert 'id=vi-gam ' in out and 'fish' in out and 'id=vi-gam2 ' in out and 'net' in out


def test_a_gloss_on_a_form_with_no_entry_is_refused_as_before():
    out = call_tool(fake_ws(FakeClient()), 'lexicon_entry', {'entry_form': 'zzq', 'entry_gloss': 'fish'})
    assert 'No lexicon entry "zzq" with a field valued "fish"' in out


def test_a_new_id_from_an_earlier_plan_says_what_names_the_entry_now():
    out = call_tool(fake_ws(FakeClient()), 'lexicon_entry', {'entry_id': 'new:v1:akun#1'})
    assert 'A new: id names an entry only within the plan that created it' in out
    assert 'name the entry by its form' in out
