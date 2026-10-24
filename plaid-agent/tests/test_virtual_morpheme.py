"""A word nobody has segmented has no morpheme token, and the editor shows it
one all the same: the whole word, under ``virtual:<word id>``, made by the
first write that names it (plaid-igt's virtualMorpheme.js and
``_planMorphemes``). The assistant reads it and writes to it the same way,
so "gloss every akuna as go" and ``set_field s1.w3.m1`` reach the word the
grid shows with an empty Gloss cell. In the fixture, ``akuna`` (w-3, 11-16)
has no morpheme token, as after Tokenize."""

from plaid_client.testing import as_fragment

from fixtures import FakeClient, MGLOSS, MORPH_LAYER, TEXT_ID, document_raw, fake_ws, lexicon_raw

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.bulk import planned_changes

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
    w = fake_ws(FakeClient())
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
    w = fake_ws(FakeClient())
    out = call_tool(w, 'set_field_for_form', {'form': 'akuna', 'field': 'Morph Gloss', 'value': 'go',
                                              'document': 'd1'})
    assert 'Nothing to change' not in out, out
    [rule] = w.ops
    assert rule['kind'] == 'bulk_scope' and rule['tool'] == 'set_field_for_form'
    [op] = planned_changes(w)
    assert op['kind'] == 'set_span' and op['token_id'] == VIRTUAL and op['virtual_at'] == AT


def test_a_gloss_and_a_link_on_one_derived_morpheme_make_one_morpheme():
    w = fake_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m1'], 'entry_id': 'vi-gam'})
    assert 'Planned 1 change' in out, out
    _counts, c = _applied(w)
    mid, _meta = _made_morpheme(c)
    assert c.payloads('spans.create')[0]['args'][1] == [mid]
    assert c.payloads('vocab_links.create')[0]['args'][1] == [mid]


def test_a_form_or_a_type_on_a_derived_morpheme_is_made_with_it():
    w = fake_ws(FakeClient())
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m1', 'form': 'akun', 'type': 'stem'})
    _counts, c = _applied(w)
    mid, meta = _made_morpheme(c)
    assert meta == {'form': 'akun', **STAMP}
    # The type is the second change to the morpheme the first one made.
    [(patched, patch)] = c.patches('tokens')
    assert patched == mid and as_fragment(patch)['morphType'] == 'stem'


def test_an_analysis_planned_after_a_gloss_on_the_derived_morpheme_takes_its_place():
    w = fake_ws(FakeClient())
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
    w = fake_ws(FakeClient())
    call_tool(w, 'split_word', {'document': 'd1', 'ref': 's1.w3', 'at': 3})
    _counts, c = _applied(w)
    assert not c.payloads('tokens.bulk_delete')
    # And a gloss on it beside the split is refused as the plan is built.
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    assert 'Planned 1 change' not in out


def test_a_comment_on_a_derived_morpheme_points_at_the_word():
    w = fake_ws(FakeClient())
    out = call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w3.m1', 'body': 'check this'})
    assert 'not segmented yet' in out and 's1.w3' in out
    assert w.ops == []


def test_reads_and_counts_are_unchanged():
    w = fake_ws(FakeClient())
    out = call_tool(w, 'read_document', {'document': 'd1'})
    assert '  w3 akuna\n' in out  # nothing after the surface, as for a word with a stored default morpheme


# --- a link writes no morph type (R2, 2026-10-24) ------------------------------

def test_a_link_writes_no_morph_type_on_the_morpheme():
    """A morpheme linked to an entry goes by the entry's type and stores no
    copy of it, so a link writes nothing on the morpheme, as the editor's."""
    w = fake_ws(FakeClient())
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m1'], 'entry_id': 'vi-erg'})  # derived
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m2'], 'entry_id': 'vi-erg'})  # stored, enclitic
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-erg'})     # a word
    assert not any('morph_type' in op for op in w.ops)
    _counts, c = _applied(w)
    _mid, meta = _made_morpheme(c)
    assert meta == STAMP
    assert not c.patches('tokens')


def test_a_link_to_a_morpheme_of_a_planned_analysis_writes_no_type():
    w = fake_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [{'form': 'aku'}, {'form': 'na'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m2'], 'entry_id': 'vi-erg'})
    _counts, c = _applied(w)
    assert not c.patches('tokens')


def test_a_read_shows_a_linked_morpheme_by_its_entrys_type():
    """-di holds no type of its own, as a linked morpheme stores none, and its
    entry goes by enclitic: the read joins it with = and names that type."""
    raw = document_raw()
    morphemes = raw['text_layers'][0]['token_layers'][2]['tokens']
    next(m for m in morphemes if m['id'] == 'm-1b')['metadata'].pop('morphType')
    lexicon = lexicon_raw()
    next(it for it in lexicon['items'] if it['id'] == 'vi-erg')['metadata']['morphType'] = 'enclitic'
    w = fake_ws(FakeClient(documents={'d1': raw}, lexicon=lexicon))
    out = call_tool(w, 'read_document', {'document': 'd1'})
    line = next(ln for ln in out.splitlines() if ln.strip().startswith('w1 '))
    assert 'seg=Ali=di' in line and 'types=?,enclitic' in line, line


# --- the card's accepted-work flag (REV-FX3-AGENT-3) ------------------------------

def test_a_change_on_a_derived_morpheme_replaces_no_accepted_work():
    w = fake_ws(FakeClient())
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m1', 'type': 'stem', 'form': 'akun'})
    assert not any(op.get('replaces_work') for op in w.plan_payload()['ops'])
