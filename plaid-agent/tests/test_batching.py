"""One call per sentence, not per word: analyses_of over several forms,
set_analysis over several words, and set_morpheme for one morpheme's form
or type without rewriting its chain."""

from fixtures import scan_ws, FakeClient

from plaid_agent.igt.plan import execute_plan, normalize_ops
from plaid_agent.igt.tools import call_tool


def ws():
    return scan_ws(FakeClient())


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


def test_set_morpheme_changes_form_or_type_in_place():
    w = ws()
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'suffix'})
    assert 'Planned 1 change' in out
    assert w.ops[-1] == {'kind': 'set_morph_type', 'morpheme_id': 'm-4b', 'morph_type': 'suffix',
                         'label': 'Text 1 s2.w1.m2 (in "Gam-ar"): morpheme type "enclitic" → "suffix"'}
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'är', 'type': ''})
    assert [o['kind'] for o in w.ops] == ['set_morph_type', 'set_morpheme_form']  # the type op was replaced (last wins)
    assert w.ops[0]['morph_type'] is None and '(cleared)' in w.ops[0]['label']
    assert w.ops[1] == {'kind': 'set_morpheme_form', 'morpheme_id': 'm-4b', 'form': 'är',
                        'label': 'Text 1 s2.w1.m2 (in "Gam-ar"): morpheme form "ar" → "är"'}
    assert 'superseded' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'är'})  # last wins
    assert call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'ar'}).startswith('Planned 0')
    assert 'is not a morpheme' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1', 'form': 'x'})
    assert 'Unknown morph type' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'type': 'sufix'})
    assert 'Give form and/or type' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2'})
    # Applied as one metadata patch each; a rewrite of the chain supersedes both.
    w.ops[1]['form'] = 'är'
    c = w.client
    execute_plan(c, w.ops, source='s', label='l')
    assert ('tokens', 'patch_metadata', ('m-4b', {'morphType': None}), {}) in c.log
    assert ('tokens', 'patch_metadata', ('m-4b', {'form': 'är'}), {}) in c.log
    out, notes = normalize_ops(w.ops + [{'kind': 'set_analysis', 'word_id': 'w-4', 'text_id': 't', 'begin': 18, 'end': 24,
                                         'morpheme_layer_id': 'ml', 'existing': [{'id': 'm-4a', 'span_ids': []}, {'id': 'm-4b', 'span_ids': []}],
                                         'morphemes': [{'form': 'Gamar', 'fields': []}], 'label': ''}])
    assert [o['kind'] for o in out] == ['set_analysis'] and len(notes) == 2
