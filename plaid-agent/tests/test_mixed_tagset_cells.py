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


def _held_off_list():
    """The fixture with -di's gloss stored as "OBL", which the mixed list does
    not hold (an import, or a list made mixed after the data)."""
    from fixtures import document_raw
    raw = document_raw()
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for sl in tk.get('span_layers', []):
                for sp in sl.get('spans', []):
                    if sp['id'] == 'sp-m1b':
                        sp['value'] = 'OBL'
    return raw


def test_a_new_analysis_carries_a_gloss_the_word_holds_off_the_list():
    """REV-FX-AGENT-IGT-2: an analysis restates every gloss it keeps, and the
    check refused the word's own "OBL", so the word could not be segmented
    again without losing it. The app checks only a value that changes."""
    from fixtures import FakeClient, fake_ws
    w = fake_ws(FakeClient(documents={'d1': _held_off_list()}))
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'Al'}, {'form': 'i'}, {'form': 'di', 'fields': {'Morph Gloss': 'OBL'}}]})
    assert out.startswith('Planned'), out
    # A new off-list value is refused all the same.
    w = fake_ws(FakeClient(documents={'d1': _held_off_list()}))
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'Ali'}, {'form': 'di', 'fields': {'Morph Gloss': 'DAT'}}]})
    assert '"DAT" is not allowed in Morph Gloss' in out, out


def test_set_analysis_for_form_carries_a_gloss_the_word_holds_off_the_list():
    from fixtures import FakeClient, fake_ws
    w = fake_ws(FakeClient(documents={'d1': _held_off_list()}))
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [
        {'form': 'Ali'}, {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'OBL'}}]})
    assert out.startswith('Planned'), out


def test_set_analysis_for_form_reads_what_the_word_holds_from_its_corpus_read(monkeypatch):
    """REV-LAST-3: on a large corpus set_analysis_for_form loads no document,
    and what each word holds comes from the spans its query finds
    (Workspace.word_held). The test above reaches the word's loaded document,
    so here every document is out of sight while the check reads."""
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.workspace import Workspace
    real = Workspace.held_values

    def corpus_only(self, word_id, f):
        saved, self._docs = self._docs, {}
        try:
            return real(self, word_id, f)
        finally:
            self._docs = saved
    monkeypatch.setattr(Workspace, 'held_values', corpus_only)
    w = fake_ws(FakeClient(documents={'d1': _held_off_list()}))
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [
        {'form': 'Ali'}, {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'OBL'}}]})
    assert out.startswith('Planned'), out
    assert w.word_held.get(('w-1', 'sl-mgloss')) == {'Ali', 'OBL'}
