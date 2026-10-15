"""A close that would list word glosses as tags is asked about before
anything is staged (bench igt-tagset-close-hard after H16-IGT-TOOLS-3): the
check says how many of a field's unlisted parts are word glosses, and an edit
that closes the list and adds every part in use at once stages nothing when
most of what it would add are word glosses. Against the real engine."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def _ws():
    client = FakeClient()
    raw = client._documents['d1']
    for tl in raw['text_layers'][0]['token_layers']:
        for sl in tl.get('span_layers') or []:
            if sl['id'] == 'sl-mgloss':
                sl['spans'] += [{'id': 'sp-w1', 'value': 'fish', 'tokens': ['m-2']},
                                {'id': 'sp-w2', 'value': 'house', 'tokens': ['m-4a']},
                                {'id': 'sp-w3', 'value': 'PL', 'tokens': ['m-4b']}]
    return fake_ws(client)


def test_the_check_says_the_word_glosses_before_any_staging():
    out = call_tool(_ws(), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert ('3 of the 3 unlisted parts of Morph Gloss are word glosses. Closing the list with add_used would '
            'list them as tags: ask the user whether they mean mixed (tags enforced, word glosses free) before '
            'planning a close.') in out, out


def test_closing_with_every_part_in_use_stages_nothing_when_most_are_word_glosses():
    w = _ws()
    out = call_tool(w, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                   'changes': {'mode': 'closed', 'add_used': 'all'}})
    assert out.startswith('Error: Nothing planned: 3 of the 3 values add_used would add are word glosses'), out
    assert 'ask the user' in out and 'add' in out, out
    assert w.ops == []
    # With the values named, it plans.
    out = call_tool(w, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                   'changes': {'mode': 'closed', 'add': ['Ali', 'fish', 'house']}})
    assert not out.startswith('Error'), out
    assert len(w.ops) == 1
    # Tags only, or no close, plan as before.
    w2 = _ws()
    assert not call_tool(w2, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                         'changes': {'mode': 'closed', 'add_used': 'tags'}}).startswith('Error')
    w3 = _ws()
    assert not call_tool(w3, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                         'changes': {'add_used': 'all'}}).startswith('Error')
