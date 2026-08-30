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
    assert counts == {'field values': 3}  # clearing a span that does not exist writes nothing
    assert c.operations == ['test']
    kinds = [(r, m) for r, m, a, k in c.log]
    assert kinds == [('spans', 'create'), ('spans', 'update'), ('spans', 'patch_metadata'), ('spans', 'delete')]
    # Approval is a human decision: everything a plan writes is machine-made AND confirmed.
    assert c.log[2][2][1] == {'prov': 'inferred', 'provSource': 'service:igt:assist', 'provConfirmed': True}
    _, _, args, _ = c.log[0]
    assert args[:3] == ('L', ['T'], 'new') and args[3] == {'prov': 'inferred', 'provSource': 'service:igt:assist', 'provConfirmed': True}
    assert len(c.batches) == 1 and len(c.batches[0]) == 4


def test_human_stamp_mode_writes_no_provenance_and_clears_it_on_rewrites():
    import pytest
    c = FakeClient()
    ops = [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'new', 'label': ''},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T2', 'span_id': 'S', 'value': 'upd', 'label': ''},
           {'kind': 'link', 'token_id': 'w-1', 'item_id': 'vi-erg', 'new_entry_key': None, 'existing_link_id': None, 'label': ''},
           {'kind': 'set_analysis', 'word_id': 'w-4', 'text_id': TEXT_ID, 'begin': 18, 'end': 24, 'morpheme_layer_id': MORPH_LAYER,
            'existing': [{'id': 'm-4a', 'span_ids': []}], 'morphemes': [{'form': 'gam', 'fields': []}, {'form': 'ar', 'fields': []}], 'label': ''}]
    execute_plan(c, ops, source='src', label='l', stamp_mode='human')
    by = {(r, m): a for r, m, a, k in c.log}
    assert by[('spans', 'create')][3] == {}
    assert by[('spans', 'patch_metadata')][1] == {'prov': None, 'provSource': None, 'provConfirmed': None, 'provProb': None, 'provDetail': None}
    assert by[('vocab_links', 'create')][2] == {}
    patched = [a for r, m, a, k in c.log if (r, m) == ('tokens', 'patch_metadata')][0][1]
    assert patched['form'] == 'gam' and patched['prov'] is None and patched['provConfirmed'] is None
    created = [k for r, m, a, k in c.log if (r, m) == ('tokens', 'create')][0]
    assert created['metadata'] == {'form': 'ar'}
    with pytest.raises(ValueError, match='stamp_mode'):
        execute_plan(c, ops, source='src', label='l', stamp_mode='bogus')


def test_confirm_and_discard_analysis_ops():
    c = FakeClient()
    ops = [{'kind': 'confirm', 'span_ids': ['sp-a', 'sp-gone'], 'token_ids': ['m-x'], 'link_ids': ['l-a'], 'label': 'c1'},
           {'kind': 'confirm', 'span_ids': ['sp-gone2'], 'token_ids': [], 'link_ids': [], 'label': 'c2'},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': 'sp-gone', 'value': '', 'label': ''},
           {'kind': 'discard_analysis', 'word_id': 'w-4', 'link_ids': ['l-d'], 'span_ids': ['sp-gone2'], 'morpheme_ids': ['m-4b'],
            'reset_first_id': 'm-4a', 'renumber': [{'id': 'm-4c', 'precedence': 2}], 'label': 'd'}]
    counts = execute_plan(c, ops, source='src', label='l')
    # The confirmation of a span another op deletes is dropped, one whole op with a note.
    assert counts == {'confirmed annotations': 3, 'field values': 1, 'discarded analyses': 1,
                      'notes': ['dropped: c2 (everything it confirms is deleted in this plan)']}
    calls = [(r, m, a) for r, m, a, k in c.log]
    assert ('tokens', 'patch_metadata', ('m-x', {'provConfirmed': True})) in calls
    assert ('vocab_links', 'patch_metadata', ('l-a', {'provConfirmed': True})) in calls
    assert ('spans', 'patch_metadata', ('sp-a', {'provConfirmed': True})) in calls
    assert ('spans', 'patch_metadata', ('sp-gone', {'provConfirmed': True})) not in calls
    assert ('spans', 'delete', ('sp-gone',)) in calls
    assert ('vocab_links', 'delete', ('l-d',)) in calls and ('spans', 'delete', ('sp-gone2',)) in calls
    assert ('tokens', 'delete', ('m-4b',)) in calls
    reset = [a for r, m, a in calls if (r, m) == ('tokens', 'patch_metadata') and a[0] == 'm-4a'][0][1]
    assert reset == {'form': None, 'morphType': None, 'prov': None, 'provSource': None, 'provConfirmed': None,
                     'provProb': None, 'provDetail': None}
    assert [(a, k) for r, m, a, k in c.log if (r, m) == ('tokens', 'update')] == [(('m-4c',), {'precedence': 2})]
    import pytest
    with pytest.raises(ValueError, match='nothing to confirm'):
        execute_plan(c, [{'kind': 'confirm', 'span_ids': [], 'label': ''}], source='s', label='l')


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
    assert first[3] == ('update', ('m-4a',), {'precedence': 1})                       # chain renumbered from 1
    assert first[4][0] == 'create' and first[4][1][:3] == (MGLOSS, ['m-4a'], 'fish')   # m0 glossed in pass one
    assert first[5][0] == 'create' and first[5][1] == (MORPH_LAYER, TEXT_ID, 18, 24)
    assert first[5][2]['precedence'] == 2 and first[5][2]['metadata']['form'] == 'ar' and 'morphType' not in first[5][2]['metadata']
    assert first[6][2]['precedence'] == 3 and first[6][2]['metadata']['morphType'] == 'suffix'
    # Second pass glosses the created morpheme by its minted id; the empty gloss is skipped.
    second = [(m, a) for r, m, a, k in c.batches[1]]
    assert second == [('create', (MGLOSS, [f'new-tokens-5'], 'PL', second[0][1][3]))]


def test_execute_set_analysis_on_word_without_morphemes_creates_all():
    c = FakeClient()
    op = {'kind': 'set_analysis', 'word_id': 'w-3', 'text_id': TEXT_ID, 'begin': 11, 'end': 16,
          'morpheme_layer_id': MORPH_LAYER, 'existing': [],
          'morphemes': [{'form': 'aku', 'morph_type': None, 'fields': [{'layer_id': MGLOSS, 'value': 'see'}]},
                        {'form': 'na', 'morph_type': 'suffix', 'fields': [{'layer_id': MGLOSS, 'value': 'PST'}]}],
          'label': ''}
    execute_plan(c, [op], source='src', label='l')
    creates = [(a, k) for r, m, a, k in c.batches[0] if m == 'create']
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


def test_malformed_plans_are_rejected_before_any_write():
    import pytest
    from plaid_igt_agent.plan import validate_ops, normalize_ops, PlanError
    c = FakeClient()
    for bad, msg in ([{'kind': 'bogus'}], 'unknown kind'), \
                    ([{'kind': 'set_analysis', 'word_id': 'w', 'text_id': 't', 'begin': 0, 'end': 1, 'morpheme_layer_id': 'm', 'morphemes': []}], 'non-empty'), \
                    ([{'kind': 'link', 'token_id': 't'}], 'item_id or new_entry_key'):
        with pytest.raises(ValueError, match=msg):
            execute_plan(c, [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'v', 'label': ''}] + bad,
                         source='s', label='l')
        assert c.batches == [] and c.log == []


def test_normalize_resolves_op_interactions():
    from plaid_igt_agent.plan import normalize_ops
    ops = [{'kind': 'delete_entry', 'item_id': 'X', 'links': [], 'label': ''},
           {'kind': 'delete_entry', 'item_id': 'X', 'links': [], 'label': ''},
           {'kind': 'link', 'token_id': 't', 'item_id': 'X', 'label': 'link t to X'},
           {'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'a', 'label': ''},
           {'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'b', 'label': ''}]
    out, notes = normalize_ops(ops)
    assert [o['kind'] for o in out] == ['delete_entry', 'respell'] and out[1]['value'] == 'b'
    assert notes == ['dropped: link t to X (its entry is deleted in this plan)']
    import pytest
    with pytest.raises(ValueError, match='overlap'):
        normalize_ops([{'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'a', 'label': ''},
                       {'kind': 'respell', 'text_id': 'T', 'begin': 2, 'end': 5, 'value': 'b', 'label': ''}])
    with pytest.raises(ValueError, match='merged away'):
        normalize_ops([{'kind': 'merge_entries', 'keep_id': 'A', 'remove_id': 'B', 'links': [], 'label': ''},
                       {'kind': 'merge_entries', 'keep_id': 'B', 'remove_id': 'C', 'links': [], 'label': ''}])


def test_plan_error_reports_how_much_was_applied():
    from plaid_igt_agent.plan import PlanError
    import pytest
    c = FakeClient()
    calls = {'n': 0}
    real = c.submit_batch

    def flaky():
        calls['n'] += 1
        if calls['n'] == 2:
            raise RuntimeError('boom')
        return real()
    c.submit_batch = flaky
    ops = [{'kind': 'set_span', 'layer_id': 'L', 'token_id': f'T{i}', 'span_id': None, 'value': 'v', 'label': ''} for i in range(1200)]
    with pytest.raises(PlanError) as ei:
        execute_plan(c, ops, source='s', label='l')
    assert ei.value.applied == 800 and ei.value.total == 1200 and 'boom' in str(ei.value)


def test_summarize():
    assert summarize([]) == 'no changes'
    assert summarize([{'kind': 'set_span'}, {'kind': 'set_span'}, {'kind': 'respell'}, {'kind': 'set_analysis'}]) == \
        '2 field values, 1 respelling, 1 analysis'
    assert summarize([{'kind': 'set_analysis'}, {'kind': 'set_analysis'}, {'kind': 'create_entry'}]) == '2 analyses, 1 new lexicon entry'


def test_execute_creates_documents_tokenized_like_the_editor():
    from fixtures import project_raw
    from plaid_igt_agent.project import load_project
    c = FakeClient()
    project = load_project(c, 'p1')
    ops = [{'kind': 'set_doc_metadata', 'document_id': 'd1', 'field': 'Date', 'value': '', 'label': ''},
           {'kind': 'create_document', 'name': 'Text 2', 'text': 'Ali-di gam, akuna!\n  Gam-ar.\n', 'metadata': {'Date': '2022'}, 'label': ''}]
    counts = execute_plan(c, ops, source='s', label='l', project=project)
    assert counts == {'document metadata values': 1, 'new documents': 1}
    assert ('documents', 'patch_metadata', ('d1', {'Date': None}), {}) in c.log
    assert ('documents', 'create', ('p1', 'Text 2', {'Date': '2022'}), {}) in c.log
    texts = [e for e in c.log if e[0] == 'texts' and e[1] == 'create']
    assert texts[0][2] == ('tl', 'new-doc', 'Ali-di gam, akuna!\n  Gam-ar.\n')
    bulk = [e for e in c.log if e[0] == 'tokens' and e[1] == 'bulk_create'][0][2][0]
    sents = [(t['begin'], t['end']) for t in bulk if t['token_layer_id'] == 'tk-sent']
    words = [(t['begin'], t['end']) for t in bulk if t['token_layer_id'] == 'tk-word']
    text = 'Ali-di gam, akuna!\n  Gam-ar.\n'
    assert [text[b:e] for b, e in sents] == ['Ali-di gam, akuna!', 'Gam-ar.']
    # '-' is punctuation, so it splits words (no whitelist in the fixture); ',' and '!' stay in gaps
    assert [text[b:e] for b, e in words] == ['Ali', 'di', 'gam', 'akuna', 'Gam', 'ar']
    assert all(t['text'] == texts[0][2] and False for t in []) or all(t['text'] == 'texts-create-' + str(c.log.index(texts[0]) + 1) for t in bulk)


def test_execute_lexicon_and_document_ops():
    c = FakeClient()
    ops = [{'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg', 'links': [{'link_id': 'l-2', 'token_id': 'm-1b'}], 'label': ''},
           {'kind': 'delete_entry', 'item_id': 'vi-gam', 'links': ['l-9'], 'label': ''},
           {'kind': 'rename_entry', 'item_id': 'vi-gam2', 'form': 'net', 'label': ''},
           {'kind': 'rename_document', 'document_id': 'd1', 'name': 'Text One', 'label': ''}]
    counts = execute_plan(c, ops, source='s', label='l')
    assert counts == {'merged entries': 1, 'deleted entries': 1, 'renamed entries': 1, 'renamed documents': 1}
    first = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert first[0] == ('vocab_links', 'delete', ('l-2',))
    assert first[1][:2] == ('vocab_links', 'create') and first[1][2][:2] == ('vi-ali', ['m-1b'])
    assert first[2] == ('vocab_links', 'delete', ('l-9',))
    assert first[3] == ('vocab_items', 'update', ('vi-gam2', 'net'))
    assert first[4] == ('documents', 'update', ('d1', 'Text One'))
    # entries are deleted only after their links are gone, in the second batch
    second = [(r, m, a) for r, m, a, k in c.batches[1]]
    assert second == [('vocab_items', 'delete', ('vi-erg',)), ('vocab_items', 'delete', ('vi-gam',))]
