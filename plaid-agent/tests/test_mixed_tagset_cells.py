"""A morpheme field under a mixed tagset (the fixture's Leipzig: PL, ERG,
delimiters ".:") refuses what the grid's cell refuses (plaid-igt
validateValue with the cell's morphemeGlossReading): a part neither listed
nor a lexical gloss, an affix's gloss read with no fall-back. Luke
2026-10-31: the assistant applies the mixed check, not only the closed one."""

from fixtures import fake_ws, FakeClient

from plaid_agent.igt.toolkit import call_tool


def ws():
    return fake_ws(FakeClient())


def test_a_morpheme_value_off_a_mixed_tagset_is_refused():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'NOM'})
    assert '"NOM" is not allowed in Morph Gloss' in out and 'ERG' in out, out
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'fish.NOM'}}]})
    assert '"fish.NOM" is not allowed in Morph Gloss' in out, out
    assert w.ops == []
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'ERG.PL'})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'fish.PL'}}]})
    assert len(w.ops) == 2, w.ops


def test_an_affix_cell_reads_its_gloss_with_no_fall_back():
    """erg.PL on a stem is the word erg, and on the suffix it is the
    abbreviation ERG in lower case, which the list does not hold."""
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'erg.PL'})
    assert '"erg.PL" is not allowed in Morph Gloss' in out and '"erg"' in out, out
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'ga', 'fields': {'Morph Gloss': 'fish'}},
        {'form': 'm', 'type': 'suffix', 'fields': {'Morph Gloss': 'erg.PL'}}]})
    assert '"erg.PL" is not allowed in Morph Gloss' in out, out
    assert w.ops == []
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss', 'value': 'erg.PL'})
    assert len(w.ops) == 1, w.ops
