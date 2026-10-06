"""The near-spelling offer for a form that names no entry (A1-IGT-5):
headwords only, the type the affix marker names first, and how many more
there are when the list is cut."""

from fixtures import FakeClient, lexicon_raw, scan_ws

from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import marked_types


def _ws():
    """A FLEx-shaped lexicon: affixes stored unmarked, the type carrying the
    marker, and seven stems and senses spelled "lam" before the suffix."""
    lex = lexicon_raw()
    items = [{'id': f'r{i}', 'form': 'lam', 'metadata': {'gloss': f'root{i}', 'morphType': 'root'}}
             for i in range(1, 6)]
    items += [{'id': 'r2s1', 'form': 'lam', 'metadata': {'gloss': 's', 'parent': 'r2', 'senseOrder': 1}},
              {'id': 'r2s2', 'form': 'lam', 'metadata': {'gloss': 't', 'parent': 'r2', 'senseOrder': 2}},
              {'id': 'pre', 'form': 'lam', 'metadata': {'gloss': 'P', 'morphType': 'prefix'}},
              {'id': 'suf', 'form': 'lam', 'metadata': {'gloss': 'S', 'morphType': 'suffix'}},
              {'id': 'cl', 'form': 'lam', 'metadata': {'gloss': 'C', 'morphType': 'enclitic'}}]
    lex['items'] += items
    return scan_ws(FakeClient(lexicon=lex))


def _offer(out):
    return out.split('Spelled close to it: ')[1].split('. Use read_lexicon')[0]


def test_a_suffix_marker_offers_the_suffix_first_and_counts_the_rest():
    out = call_tool(_ws(), 'lexicon_entry', {'entry_form': '-lam'})
    offer = _offer(out)
    assert offer.startswith('entry_form "lam#7" (suffix), '), offer
    assert offer.endswith(', and 2 more (read_lexicon lists them)'), offer
    assert '#2.1' not in offer and '#2.2' not in offer, 'senses are offered by their headword'


def test_a_prefix_and_a_clitic_marker_offer_theirs_first():
    assert _offer(call_tool(_ws(), 'lexicon_entry', {'entry_form': 'lam-'})).startswith(
        'entry_form "lam#6" (prefix), ')
    assert _offer(call_tool(_ws(), 'lexicon_entry', {'entry_form': '=lam'})).startswith(
        'entry_form "lam#8" (enclitic), ')


def test_a_short_list_says_no_more():
    out = call_tool(scan_ws(FakeClient()), 'lexicon_entry', {'entry_form': 'di'})
    assert _offer(out) == 'entry_form "-di" (suffix)'


def test_marked_types():
    assert marked_types('-ka') >= {'suffix'} and marked_types('ka-') >= {'prefix'}
    assert marked_types('-ka-') >= {'infix'} and marked_types('=ka') >= {'enclitic', 'clitic'}
    assert marked_types('ka=') >= {'proclitic'} and marked_types('ka') == frozenset()
    assert marked_types('-') == frozenset() and marked_types('') == frozenset()

