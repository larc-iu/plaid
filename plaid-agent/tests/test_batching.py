"""One call per sentence, not per word: analyses_of over several forms,
set_analysis over several words, and set_morpheme for one morpheme's form
or type without rewriting its chain."""

import pytest
from plaid_client.testing import as_fragment

from fixtures import fake_ws, FakeClient

from plaid_agent.igt.plan import execute_plan, normalize_ops
from plaid_agent.igt.toolkit import call_tool


def ws():
    return fake_ws(FakeClient())


def test_analyses_of_takes_several_forms():
    w = ws()
    out = call_tool(w, 'analyses_of', {'forms': ['gam', 'di', 'gam']})
    blocks = out.split('\n\n')
    assert len(blocks) == 2
    assert blocks[0].startswith('Word "gam": 1 occurrence') and 'Morpheme "gam": 2 occurrences' in blocks[0]
    assert blocks[1].startswith('Word "di": no occurrences.') and 'Morpheme "di": 1 occurrence' in blocks[1]
    assert call_tool(w, 'analyses_of', {'form': 'gam'}) == blocks[0]
    assert 'Give a form' in call_tool(w, 'analyses_of', {})
    assert 'At most' in call_tool(w, 'analyses_of', {'forms': [f'f{i}' for i in range(41)]})


def test_set_analysis_takes_several_words_and_stages_them_together():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'analyses': [
        {'ref': 's1.w2', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]},
        {'ref': 's1.w3', 'morphemes': [{'form': 'aku', 'fields': {'Morph Gloss': 'see'}}, {'form': 'na', 'type': 'suffix'}]}]})
    assert out.startswith('Planned 2 changes') and 's1.w3 (note: forms "akuna"' not in out
    assert [(o['kind'], o['word_id']) for o in w.ops] == [('set_analysis', 'w-2'), ('set_analysis', 'w-3')]
    # A bad item leaves nothing planned.
    w2 = ws()
    out = call_tool(w2, 'set_analysis', {'document': 'd1', 'analyses': [
        {'ref': 's1.w2', 'morphemes': [{'form': 'gam'}]}, {'ref': 's1.w2', 'morphemes': [{'form': 'ga'}, {'form': 'm'}]}]})
    assert 'analysed twice' in out and w2.ops == []
    assert 'each analysis needs a ref' in call_tool(w2, 'set_analysis', {'document': 'd1', 'analyses': [{'morphemes': []}]})
    assert 'Give ref and morphemes' in call_tool(w2, 'set_analysis', {'document': 'd1'})
    # Allomorphy notes name the word when several are planned.
    out = call_tool(w2, 'set_analysis', {'document': 'd1', 'analyses': [
        {'ref': 's2.w1', 'morphemes': [{'form': 'gam'}, {'form': 'ar'}]}, {'ref': 's1.w2', 'morphemes': [{'form': 'gam'}]}]})
    assert 's2.w1 (note: forms "gamar" differ from the surface "Gam-ar"' in out


def _no_type_copy():
    """The fixture as after R2's backfill: m-1b, linked to the suffix entry
    vi-erg, holds no type of its own."""
    from fixtures import document_raw
    raw = document_raw()
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for t in tk.get('tokens', []):
                if t['id'] == 'm-1b':
                    t['metadata'] = {'form': 'di'}
    return raw


def test_set_morpheme_refuses_a_type_on_a_linked_morpheme_and_points_to_its_entry():
    # A linked morpheme goes by its entry's type, so a type planned on the
    # morpheme would change nothing anyone sees. The editor edits the entry.
    w = fake_ws(FakeClient(documents={'d1': _no_type_copy()}))
    for t in ('enclitic', 'suffix', ''):
        out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m2', 'type': t})
        assert 'linked to "-di"' in out and 'set_entry_field' in out and 'unlink_entry' in out, out
        assert '"suffix"' in out
    assert w.ops == []
    # Its form is the morpheme's own.
    assert 'Planned 1' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m2', 'form': 'de'})


def test_set_morpheme_set_back_to_the_stored_type_takes_the_planned_change_back():
    w = ws()
    assert 'Planned 1' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'suffix'})
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'enclitic'})
    assert w.ops == [] and 'Took back' in out


def test_set_morpheme_changes_form_or_type_in_place():
    w = ws()
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'suffix'})
    assert 'Planned 1 change' in out
    assert w.ops[-1] == {'kind': 'set_morph_type', 'morpheme_id': 'm-4b', 'morph_type': 'suffix',
                         'label': 'Text 1 s2.w1.m2 (in "Gam-ar"): morpheme type "enclitic" → "suffix"', 'change_at': 31}
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'är', 'type': ''})
    assert [o['kind'] for o in w.ops] == ['set_morph_type', 'set_morpheme_form']  # the type op was replaced (last wins)
    assert w.ops[0]['morph_type'] is None and '(cleared)' in w.ops[0]['label']
    assert w.ops[1] == {'kind': 'set_morpheme_form', 'morpheme_id': 'm-4b', 'form': 'är', 'restamp': True,
                        'label': 'Text 1 s2.w1.m2 (in "Gam-ar"): morpheme form "ar" → "är"', 'change_at': 31}
    assert 'superseded' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'är'})  # last wins
    assert call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'ar'}).startswith('Planned 0')
    assert 'is not a morpheme' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1', 'form': 'x'})
    assert 'Unknown morph type' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'sufix'})
    assert 'Give form and/or type' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2'})
    # Applied as ONE metadata patch on the morpheme (the two ops merge into
    # one bulk entry, in plan order), stamped as the approved correction it
    # is; a rewrite of the chain supersedes both.
    w.ops[1]['form'] = 'är'
    c = w.client
    execute_plan(c, w.ops, source='s', label='l')
    [patch] = [p for tid, p in c.patches('tokens') if tid == 'm-4b']
    assert as_fragment(patch) == {'morphType': None, 'morphTypeFromEquals': None, 'form': 'är',
                                  'prov': 'inferred', 'provSource': 's',
                                  'provConfirmed': True, 'provProb': None, 'provDetail': None}
    # A rewrite of the chain deletes every morpheme after the first, so the two
    # form changes above are writes to something that will not be there. The
    # tools refuse the pair as it is staged; this is the backstop under that.
    rewrite = {'kind': 'set_analysis', 'word_id': 'w-4', 'text_id': 't', 'begin': 18, 'end': 24,
               'morpheme_layer_id': 'ml', 'existing': [{'id': 'm-4a', 'span_ids': []}, {'id': 'm-4b', 'span_ids': []}],
               'morphemes': [{'form': 'Gamar', 'fields': []}], 'label': ''}
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(w.ops + [rewrite])
    # Staged after them, the rewrite supersedes both: it replaces the chain
    # and every form and type on it.
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'Gamar'}]})
    assert '2 changes planned on the morphemes of a word this analysis replaces were taken out' in out, out
    assert [o['kind'] for o in w.ops] == ['set_analysis']
    # The first morpheme of the chain is kept and reused, so a form change on
    # it is superseded rather than refused.
    out, notes = normalize_ops([{'kind': 'set_morpheme_form', 'morpheme_id': 'm-4a', 'form': 'G', 'label': 'f1'},
                                rewrite])
    assert [o['kind'] for o in out] == ['set_analysis'] and len(notes) == 1


def test_a_cleared_clitic_type_takes_back_the_equals_that_typed_it():
    """As the grid's clear does (R47 round 3): clearing the type of the
    clitic a typed "=" names takes away the key that records the "=", so a
    later edit in the grid does not type it again."""
    from fixtures import document_raw
    raw = document_raw()
    morphs = raw['text_layers'][0]['token_layers'][2]['tokens']
    gam = next(m for m in morphs if m['id'] == 'm-4b')
    gam['metadata'] = {'form': 'ar', 'morphType': 'enclitic', 'morphTypeFromEquals': 'enclitic',
                       'equalsBefore': True}
    w = fake_ws(FakeClient(documents={'d1': raw}))
    # the host's clear takes nothing: the "=" names the enclitic
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m1', 'type': 'stem'})
    assert 'equals_taken' not in w.ops[-1]
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': ''})
    assert w.ops[-1]['equals_taken'] == ['m-4b']
    c = w.client
    execute_plan(c, w.ops, source='s', label='l')
    [patch] = [p for tid, p in c.patches('tokens') if tid == 'm-4b']
    frag = as_fragment(patch)
    assert frag['morphType'] is None and frag['equalsBefore'] is None


def test_a_cleared_type_that_is_no_clitic_keeps_the_equals_and_types_the_morpheme():
    """As the grid's clear does (REV-CLITIC CL-9): the "=" stays, and the rule
    types the morpheme the cleared type had blocked."""
    from fixtures import document_raw
    raw = document_raw()
    morphs = raw['text_layers'][0]['token_layers'][2]['tokens']
    gam = next(m for m in morphs if m['id'] == 'm-4b')
    gam['metadata'] = {'form': 'ar', 'morphType': 'suffix', 'equalsBefore': True}
    w = fake_ws(FakeClient(documents={'d1': raw}))
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': ''})
    assert 'equals_taken' not in w.ops[-1] and w.ops[-1]['equals_type'] == 'enclitic'
    c = w.client
    execute_plan(c, w.ops, source='s', label='l')
    [patch] = [p for tid, p in c.patches('tokens') if tid == 'm-4b']
    frag = as_fragment(patch)
    assert frag['morphType'] == 'enclitic' and frag['morphTypeFromEquals'] == 'enclitic'
    assert 'equalsBefore' not in frag


def _with_equals_on_di():
    from fixtures import document_raw
    raw = document_raw()
    morphs = raw['text_layers'][0]['token_layers'][2]['tokens']
    di = next(m for m in morphs if m['id'] == 'm-1b')
    di['metadata'] = {'form': 'di', 'equalsBefore': True}
    return fake_ws(FakeClient(documents={'d1': raw}))


def _token_creates(c):
    """The metadata of every token the plan made, in order."""
    out = []
    for kind, payload in c.calls:
        if kind == 'tokens.bulk_create':
            out.extend(item.get('metadata') or {} for item in payload)
        elif kind == 'tokens.create':
            out.append(payload['kwargs'].get('metadata') or {})
    return out


def test_set_analysis_keeps_a_typed_equals_whose_boundary_stays():
    """REV-CLITIC CL-12: re-setting a word with the same boundary keeps its
    typed "=", and the rule types the pieces nobody typed, as the grid does."""
    w = _with_equals_on_di()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    op = w.ops[-1]
    assert [m.get('equals_before') for m in op['morphemes']] == [None, True]
    assert 'Ali=di' in op['label']
    c = w.client
    execute_plan(c, w.ops, source='s', label='l')
    made = _token_creates(c)
    assert made[0]['equalsBefore'] is True
    assert made[0]['morphType'] == 'enclitic' and made[0]['morphTypeFromEquals'] == 'enclitic'


def test_set_analysis_states_and_drops_a_typed_equals():
    w = _with_equals_on_di()
    # a boundary moved: the "=" before "di" is not kept
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'Al'}, {'form': 'idi'}]})
    assert [m.get('equals_before') for m in w.ops[-1]['morphemes']] == [None, None]
    w = _with_equals_on_di()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'Ali'}, {'form': 'di', 'equals': False}]})
    assert [m.get('equals_before') for m in w.ops[-1]['morphemes']] == [None, None]
    w = fake_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'A'}, {'form': 'li'}, {'form': 'di', 'equals': True}]})
    op = w.ops[-1]
    assert [m.get('equals_before') for m in op['morphemes']] == [None, None, True]
    assert [m.get('morph_type') for m in op['morphemes']] == [None, None, 'enclitic']


def test_set_analysis_for_form_keeps_and_states_a_typed_equals():
    """FX-CLITIC round 5: the bulk set_analysis_for_form reads "=" as
    set_analysis does, word by word, so a person's typed "=" is not lost
    across the corpus."""
    w = _with_equals_on_di()
    call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    op = w.ops[-1]
    assert [m.get('equals_before') for m in op['morphemes']] == [None, True]
    assert [m.get('morph_type') for m in op['morphemes']] == [None, 'enclitic']
    w = fake_ws(FakeClient())
    call_tool(w, 'set_analysis_for_form', {'form': 'akuna',
                                           'morphemes': [{'form': 'aku'}, {'form': 'na', 'equals': True}]})
    op = w.ops[-1]
    assert [m.get('equals_before') for m in op['morphemes']] == [None, True]
    assert 'equals' not in op['morphemes'][1]
