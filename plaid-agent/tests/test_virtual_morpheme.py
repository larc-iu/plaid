"""A word nobody has segmented has no morpheme token, and the editor shows it
one all the same: the whole word, under ``virtual:<word id>``, made by the
first write that names it (plaid-igt's virtualMorpheme.js and
``_planMorphemes``). The assistant reads it and writes to it the same way,
so "gloss every akuna as go" and ``set_field s1.w3.m1`` reach the word the
grid shows with an empty Gloss cell. In the fixture, ``akuna`` (w-3, 11-16)
has no morpheme token, as after Tokenize."""

from plaid_client.testing import as_fragment

from fixtures import FakeClient, MGLOSS, MORPH_LAYER, TEXT_ID, scan_ws

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool

SOURCE = 'service:igt:assist:x'
VIRTUAL = 'virtual:w-3'
AT = {'layer_id': MORPH_LAYER, 'text_id': TEXT_ID, 'begin': 11, 'end': 16}
STAMP = {'prov': 'inferred', 'provSource': SOURCE, 'provConfirmed': True}


def _applied(w):
    w.client.calls.clear()
    counts = execute_plan(w.client, w.plan_payload()['ops'], source=SOURCE, label='l', project=w.project)
    return counts, w.client


def _made_morpheme(c):
    [made] = c.payloads('tokens.create')
    args, kw = made['args'], made['kwargs']
    assert args == (MORPH_LAYER, TEXT_ID, 11, 16) and kw['precedence'] == 1
    return kw['id'], kw['metadata']


def test_a_gloss_on_m1_of_an_unsegmented_word_makes_its_morpheme_in_the_same_batch():
    w = scan_ws(FakeClient())
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    assert 'Planned 1 change' in out, out
    [op] = w.ops
    assert op['token_id'] == VIRTUAL and op['virtual_at'] == AT
    assert op['label'] == 'Text 1 s1.w3.m1 "akuna": Morph Gloss = "go"'
    counts, c = _applied(w)
    assert counts == {'field values': 1}
    mid, meta = _made_morpheme(c)
    assert meta == STAMP
    [span] = c.payloads('spans.create')
    assert span['args'][:3] == (MGLOSS, [mid], 'go')
    # One change, one batch: the morpheme and its gloss land together or not at all.
    [batch] = c.batches
    assert [kind for kind, _ in batch] == ['tokens.create', 'spans.create']


def test_every_occurrence_of_a_form_reaches_unsegmented_words():
    w = scan_ws(FakeClient())
    out = call_tool(w, 'set_field_for_form', {'form': 'akuna', 'field': 'Morph Gloss', 'value': 'go',
                                              'document': 'd1'})
    assert 'Nothing to change' not in out, out
    [op] = w.ops
    assert op['kind'] == 'set_span' and op['token_id'] == VIRTUAL and op['virtual_at'] == AT


def test_a_gloss_and_a_link_on_one_derived_morpheme_make_one_morpheme():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m1'], 'entry_id': 'vi-gam'})
    assert 'Planned 1 change' in out, out
    _counts, c = _applied(w)
    mid, _meta = _made_morpheme(c)
    assert c.payloads('spans.create')[0]['args'][1] == [mid]
    assert c.payloads('vocab_links.create')[0]['args'][1] == [mid]


def test_a_form_or_a_type_on_a_derived_morpheme_is_made_with_it():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m1', 'form': 'akun', 'type': 'stem'})
    _counts, c = _applied(w)
    mid, meta = _made_morpheme(c)
    assert meta == {'form': 'akun', **STAMP}
    # The type is the second change to the morpheme the first one made.
    [(patched, patch)] = c.patches('tokens')
    assert patched == mid and as_fragment(patch)['morphType'] == 'stem'


def test_an_analysis_planned_after_a_gloss_on_the_derived_morpheme_takes_its_place():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3',
                                        'morphemes': [{'form': 'aku'}, {'form': 'na'}]})
    assert 'taken out' in out, out
    assert [op['kind'] for op in w.ops] == ['set_analysis']
    assert w.ops[0]['existing'] == []
    _counts, c = _applied(w)
    # Two morphemes, the analysis's own, and no third for the gloss.
    assert len(c.payloads('tokens.create')) == 2


def test_a_reshape_of_an_unsegmented_word_deletes_no_derived_morpheme():
    w = scan_ws(FakeClient())
    call_tool(w, 'split_word', {'document': 'd1', 'ref': 's1.w3', 'at': 3})
    _counts, c = _applied(w)
    assert not c.payloads('tokens.bulk_delete')
    # And a gloss on it beside the split is refused as the plan is built.
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    assert 'Planned 1 change' not in out


def test_a_comment_on_a_derived_morpheme_points_at_the_word():
    w = scan_ws(FakeClient())
    out = call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w3.m1', 'body': 'check this'})
    assert 'not segmented yet' in out and 's1.w3' in out
    assert w.ops == []


def test_reads_and_counts_are_unchanged():
    w = scan_ws(FakeClient())
    out = call_tool(w, 'read_document', {'document': 'd1'})
    assert '  w3 akuna\n' in out  # nothing after the surface, as for a word with a stored default morpheme


# --- the morph-type cache a link writes (REV-FX3-AGENT-2) ----------------------

def test_a_link_writes_the_entrys_morph_type_with_it_as_the_editor_does():
    """A morpheme linked to an entry goes by the entry's type, and its cached
    morphType is written in the same batch. Left stale, the next person who
    merely opened the document wrote it under their own name."""
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m1'], 'entry_id': 'vi-erg'})  # derived
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m2'], 'entry_id': 'vi-erg'})  # stored, enclitic
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-erg'})     # a word: no type
    _counts, c = _applied(w)
    _mid, meta = _made_morpheme(c)
    assert meta == {'morphType': 'suffix', **STAMP}
    assert [(tid, as_fragment(p)) for tid, p in c.patches('tokens')] == [('m-4b', {'morphType': 'suffix'})]


def test_a_link_whose_entry_agrees_with_the_cache_or_has_no_type_writes_none():
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1'], 'entry_id': 'vi-gam'})  # gam has no type
    assert 'morph_type' not in w.ops[0]
    _counts, c = _applied(w)
    assert not c.patches('tokens')


def test_a_link_to_a_morpheme_of_a_planned_analysis_writes_its_type():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [{'form': 'aku'}, {'form': 'na'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m2'], 'entry_id': 'vi-erg'})
    _counts, c = _applied(w)
    made = [p['kwargs']['id'] for p in c.payloads('tokens.create')]
    assert [(tid, as_fragment(p)) for tid, p in c.patches('tokens')] == [(made[1], {'morphType': 'suffix'})]


# --- the card's accepted-work flag (REV-FX3-AGENT-3) ------------------------------

def test_a_change_on_a_derived_morpheme_replaces_no_accepted_work():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m1', 'type': 'stem', 'form': 'akun'})
    assert not any(op.get('replaces_work') for op in w.plan_payload()['ops'])
