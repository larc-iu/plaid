"""A plan card row names an entry with the number the app shows after its
form (A1-IGT-4), so a relink between homographs or senses says which entry
the link leaves and which it moves to, on both sides."""

from fixtures import FakeClient, document_raw, lexicon_raw, scan_ws

from plaid_agent.igt.toolkit import call_tool


def _ws():
    lex = lexicon_raw()
    lex['items'] += [
        {'id': 'vi-net1', 'form': 'gam', 'metadata': {'gloss': 'net', 'parent': 'vi-gam2', 'senseOrder': 1}},
        {'id': 'vi-net2', 'form': 'gam', 'metadata': {'gloss': 'snare', 'parent': 'vi-gam2', 'senseOrder': 2}},
    ]
    doc = document_raw()
    words = doc['text_layers'][0]['token_layers'][1]
    words['vocabs'][0]['vocab_links'].append(
        {'id': 'l-3', 'vocab_item': {'id': 'vi-net1', 'form': 'gam'}, 'tokens': ['w-2']})
    return scan_ws(FakeClient(documents={'d1': doc}, lexicon=lex))


def _labels(w):
    return [op['label'] for op in w.ops]


def test_a_relink_between_senses_names_both():
    w = _ws()
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w2'], 'entry_form': 'gam#2.2'})
    assert 'Planned 1' in out, out
    assert _labels(w)[0].endswith(': link "gam₂.₁" → "gam₂.₂"'), _labels(w)


def test_a_homograph_carries_its_number_and_a_lone_headword_does_not():
    w = _ws()
    call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w3'], 'entry_form': 'gam#1'})
    call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w1'], 'entry_form': 'gam#1'})
    assert _labels(w)[0].endswith(': link "gam₁"'), _labels(w)
    assert _labels(w)[1].endswith(': link "Ali" → "gam₁"'), _labels(w)


def test_an_unlink_names_the_entry_it_takes_away():
    w = _ws()
    call_tool(w, 'unlink_entry', {'document': 'Text 1', 'refs': ['s1.w2']})
    assert _labels(w)[0].endswith(': unlink "gam₂.₁"'), _labels(w)


def test_a_new_entry_is_its_form():
    w = _ws()
    out = call_tool(w, 'create_entry', {'form': 'gam', 'fields': {'gloss': 'trap'}})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w3'], 'entry_id': key})
    assert _labels(w)[-1].endswith(': link "gam"'), _labels(w)


def test_a_phrase_link_carries_the_number():
    w = _ws()
    call_tool(w, 'link_phrase', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'], 'entry_form': 'gam#2'})
    assert _labels(w)[0].endswith(': link phrase "gam₂"'), _labels(w)
