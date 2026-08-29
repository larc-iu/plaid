from fixtures import FakeClient, MGLOSS, MORPH_LAYER, TEXT_ID, VOCAB

from plaid_igt_agent.plan import execute_plan, summarize, Batcher


def test_batcher_flushes_on_budget_and_indexes_globally():
    c = FakeClient()
    b = Batcher(c, budget=2)
    idx = [b.add(lambda i=i: c.spans.create('l', ['t'], str(i))) for i in range(5)]
    assert idx == [0, 1, 2, 3, 4]
    assert len(c.batches) == 2  # two full batches flushed, one op still open
    b.flush()
    assert len(c.batches) == 3 and [len(x) for x in c.batches] == [2, 2, 1]
    assert len(b.results) == 5
    b.flush()  # no-op when nothing is open
    assert len(c.batches) == 3


def test_execute_set_span_variants():
    c = FakeClient()
    counts = execute_plan(c, [
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'new', 'label': ''},
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': 'S', 'value': 'upd', 'label': ''},
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': 'S2', 'value': '', 'label': ''},
        {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': '', 'label': ''},
    ], source='service:igt:assist', label='test')
    assert counts == {'field values': 4}
    assert c.operations == ['test']
    kinds = [(r, m) for r, m, a, k in c.log]
    assert kinds == [('spans', 'create'), ('spans', 'update'), ('spans', 'patch_metadata'), ('spans', 'delete')]
    _, _, args, _ = c.log[0]
    assert args[:3] == ('L', ['T'], 'new') and args[3]['prov'] == 'inferred' and args[3]['provSource'] == 'service:igt:assist'
    assert len(c.batches) == 1 and len(c.batches[0]) == 4


def test_execute_set_analysis_replaces_chain_and_glosses_new_morphemes_second_pass():
    c = FakeClient()
    op = {'kind': 'set_analysis', 'word_id': 'w-4', 'text_id': TEXT_ID, 'begin': 18, 'end': 24,
          'morpheme_layer_id': MORPH_LAYER,
          'existing': [{'id': 'm-4a', 'span_ids': ['sp-old']}, {'id': 'm-4b', 'span_ids': []}],
          'morphemes': [{'form': 'gam', 'morph_type': 'stem', 'fields': [{'layer_id': MGLOSS, 'value': 'fish'}]},
                        {'form': 'ar', 'morph_type': None, 'fields': [{'layer_id': MGLOSS, 'value': 'PL'}]},
                        {'form': 'x', 'morph_type': 'suffix', 'fields': [{'layer_id': MGLOSS, 'value': ''}]}],
          'label': ''}
    counts = execute_plan(c, [op], source='src', label='l')
    assert counts == {'analyses': 1}
    first = [(m, a, k) for r, m, a, k in c.batches[0]]
    assert first[0][0] == 'delete' and first[0][1] == ('m-4b',)                       # extra morpheme dropped
    assert first[1][0] == 'delete' and first[1][1] == ('sp-old',)                     # old gloss on m0 dropped
    assert first[2][0] == 'patch_metadata' and first[2][1][0] == 'm-4a'
    assert first[2][1][1]['form'] == 'gam' and first[2][1][1]['morphType'] == 'stem' and first[2][1][1]['prov'] == 'inferred'
    assert first[3][0] == 'create' and first[3][1][:3] == (MGLOSS, ['m-4a'], 'fish')   # m0 glossed in pass one
    assert first[4][0] == 'create' and first[4][1] == (MORPH_LAYER, TEXT_ID, 18, 24)
    assert first[4][2]['precedence'] == 2 and first[4][2]['metadata']['form'] == 'ar' and 'morphType' not in first[4][2]['metadata']
    assert first[5][2]['precedence'] == 3 and first[5][2]['metadata']['morphType'] == 'suffix'
    # Second pass glosses the created morpheme by its minted id; the empty gloss is skipped.
    second = [(m, a) for r, m, a, k in c.batches[1]]
    assert second == [('create', (MGLOSS, [f'new-tokens-4'], 'PL', second[0][1][3]))]


def test_execute_set_analysis_on_word_without_morphemes_creates_all():
    c = FakeClient()
    op = {'kind': 'set_analysis', 'word_id': 'w-3', 'text_id': TEXT_ID, 'begin': 11, 'end': 16,
          'morpheme_layer_id': MORPH_LAYER, 'existing': [],
          'morphemes': [{'form': 'aku', 'morph_type': None, 'fields': [{'layer_id': MGLOSS, 'value': 'see'}]},
                        {'form': 'na', 'morph_type': 'suffix', 'fields': [{'layer_id': MGLOSS, 'value': 'PST'}]}],
          'label': ''}
    execute_plan(c, [op], source='src', label='l')
    creates = [(a, k) for r, m, a, k in c.batches[0]]
    assert [k['precedence'] for a, k in creates] == [1, 2]
    assert [a[1] for r, m, a, k in c.batches[1]] == [['new-tokens-0'], ['new-tokens-1']]


def test_execute_links_entries_orthography_and_respells_last():
    c = FakeClient()
    ops = [
        {'kind': 'respell', 'text_id': TEXT_ID, 'begin': 0, 'end': 6, 'value': 'Alidi', 'label': ''},
        {'kind': 'create_entry', 'vocab_id': VOCAB, 'form': 'akun', 'metadata': {'gloss': 'see'}, 'key': 'new:1', 'label': ''},
        {'kind': 'link', 'token_id': 'w-3', 'item_id': None, 'new_entry_key': 'new:1', 'existing_link_id': None, 'label': ''},
        {'kind': 'link', 'token_id': 'w-1', 'item_id': 'vi-erg', 'new_entry_key': None, 'existing_link_id': 'l-1', 'label': ''},
        {'kind': 'unlink', 'link_id': 'l-2', 'label': ''},
        {'kind': 'set_orthography', 'word_id': 'w-2', 'key': 'orthog:IPA', 'value': '', 'label': ''},
        {'kind': 'set_entry_field', 'item_id': 'vi-ali', 'field': 'pos', 'value': 'PN', 'label': ''},
        {'kind': 'respell', 'text_id': TEXT_ID, 'begin': 11, 'end': 16, 'value': 'akun', 'label': ''},
    ]
    counts = execute_plan(c, ops, source='src', label='l')
    assert counts == {'respellings': 2, 'lexicon entries': 1, 'links': 2, 'unlinks': 1,
                      'orthography values': 1, 'entry fields': 1}
    b0 = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert b0[0] == ('vocab_items', 'create', (VOCAB, 'akun', {'gloss': 'see', **b0[0][2][2]}))
    assert b0[0][2][2]['prov'] == 'inferred'
    assert b0[1] == ('vocab_links', 'delete', ('l-1',))
    assert b0[2][:2] == ('vocab_links', 'create') and b0[2][2][:2] == ('vi-erg', ['w-1'])
    assert b0[3] == ('vocab_links', 'delete', ('l-2',))
    assert b0[4] == ('tokens', 'patch_metadata', ('w-2', {'orthog:IPA': None}))
    assert b0[5] == ('vocab_items', 'patch_metadata', ('vi-ali', {'pos': 'PN'}))
    # The link to the new entry waits for its id.
    b1 = [(r, m, a) for r, m, a, k in c.batches[1]]
    assert len(b1) == 1 and b1[0][:2] == ('vocab_links', 'create') and b1[0][2][:2] == ('new-vocab_items-0', ['w-3'])
    # Respells are one text update after every batch, highest offset first.
    last = c.log[-1]
    assert last[0] == 'texts' and last[1] == 'update'
    assert last[2] == (TEXT_ID, [{'type': 'replace', 'index': 11, 'length': 5, 'value': 'akun'},
                                 {'type': 'replace', 'index': 0, 'length': 6, 'value': 'Alidi'}])
    assert c.log.index(last) > len(c.batches[0]) + len(c.batches[1]) - 1


def test_unknown_kind_aborts_the_open_batch():
    c = FakeClient()
    try:
        execute_plan(c, [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'v', 'label': ''},
                         {'kind': 'bogus'}], source='s', label='l')
    except ValueError as e:
        assert 'bogus' in str(e)
    else:
        raise AssertionError
    assert c.batches == []


def test_summarize():
    assert summarize([]) == 'no changes'
    assert summarize([{'kind': 'set_span'}, {'kind': 'set_span'}, {'kind': 'respell'}, {'kind': 'set_analysis'}]) == \
        '2 field values, 1 respelling, 1 analysis'
    assert summarize([{'kind': 'set_analysis'}, {'kind': 'set_analysis'}, {'kind': 'create_entry'}]) == '2 analyses, 1 new lexicon entry'
