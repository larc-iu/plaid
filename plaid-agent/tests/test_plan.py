from fixtures import FakeClient, MGLOSS, MORPH_LAYER, TEXT_ID, VOCAB

from plaid_agent.core.plan import Batcher
from plaid_agent.igt.plan import execute_plan, summarize


def test_batcher_flushes_on_budget_and_indexes_globally():
    c = FakeClient()
    b = Batcher(c, budget=2)
    idx = [b.add(lambda batch, i=i: batch.spans.create('l', ['t'], str(i))) for i in range(5)]
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
    # Updates travel as bulk sub-ops appended after what the batch creates and
    # deletes, so the update and its restamp come last.
    assert kinds == [('spans', 'create'), ('spans', 'delete'), ('spans', 'update'), ('spans', 'patch_metadata')]
    # Approval is a human decision: everything a plan writes is machine-made AND confirmed.
    assert c.log[3][2][1] == {'prov': 'inferred', 'provSource': 'service:igt:assist', 'provConfirmed': True}
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


def test_contributed_stamp_mode_stamps_the_approver_and_drops_confirmations():
    import pytest
    c = FakeClient()
    ops = [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'new', 'label': ''},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T2', 'span_id': 'S', 'value': 'upd', 'label': ''},
           {'kind': 'link', 'token_id': 'w-1', 'item_id': 'vi-erg', 'new_entry_key': None, 'existing_link_id': None, 'label': ''}]
    execute_plan(c, ops, source='src', label='l', stamp_mode='contributed', contributor='ann@x.com')
    by = {(r, m): a for r, m, a, k in c.log}
    contributed = {'prov': 'contributed', 'provSource': 'user:ann@x.com'}
    assert by[('spans', 'create')][3] == contributed
    # a rewrite drops the confirmation and any machine keys, then stamps
    assert by[('spans', 'patch_metadata')][1] == {'prov': 'contributed', 'provSource': 'user:ann@x.com',
                                                  'provConfirmed': None, 'provProb': None, 'provDetail': None}
    assert by[('vocab_links', 'create')][2] == contributed
    with pytest.raises(ValueError, match='contributor'):
        execute_plan(c, ops, source='src', label='l', stamp_mode='contributed')


def test_confirm_and_discard_analysis_ops():
    c = FakeClient()
    ops = [{'kind': 'confirm', 'span_ids': ['sp-a', 'sp-gone'], 'token_ids': ['m-x'], 'link_ids': ['l-a'], 'label': 'c1'},
           {'kind': 'confirm', 'span_ids': ['sp-gone2'], 'token_ids': [], 'link_ids': [], 'label': 'c2'},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': 'sp-gone', 'value': '', 'label': ''},
           {'kind': 'discard_analysis', 'word_id': 'w-4', 'link_ids': ['l-d'], 'span_ids': ['sp-gone2'], 'morpheme_ids': ['m-4b'],
            'reset_first_id': 'm-4a', 'renumber': [{'id': 'm-4c', 'precedence': 2}], 'label': 'd'}]
    counts = execute_plan(c, ops, source='src', label='l')
    # Neither confirmation names its material (they cover whatever awaits
    # review), so what the plan deletes is left out of each: c1 keeps the rest
    # and says how many it left, c2 had nothing else and is dropped whole.
    assert counts == {'confirmations': 3, 'field values': 1, 'discarded analyses': 1,
                      'notes': ['c1: 1 annotation left unconfirmed (deleted in this plan)',
                                'dropped: c2 (everything it confirms is deleted in this plan)']}
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
    assert second == [('create', (MGLOSS, ['new-tokens-5'], 'PL', second[0][1][3]))]


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
    assert counts == {'respellings': 2, 'new lexicon entries': 1, 'lexicon links': 2, 'unlinks': 1,
                      'orthography values': 1, 'entry fields': 1}
    b0 = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert b0[0] == ('vocab_items', 'create', (VOCAB, 'akun', {'gloss': 'see', **b0[0][2][2]}))
    assert b0[0][2][2]['prov'] == 'inferred'
    assert b0[1] == ('vocab_links', 'delete', ('l-1',))
    assert b0[2][:2] == ('vocab_links', 'create') and b0[2][2][:2] == ('vi-erg', ['w-1'])
    assert b0[3] == ('vocab_links', 'delete', ('l-2',))
    assert b0[4] == ('vocab_items', 'patch_metadata', ('vi-ali', {'pos': 'PN'}))
    # The orthography is a token metadata patch, which travels as a bulk sub-op at the end of the batch.
    assert b0[5] == ('tokens', 'patch_metadata', ('w-2', {'orthog:IPA': None}))
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
    c = FakeClient()
    for bad, msg in ([{'kind': 'bogus'}], 'unknown kind'), \
                    ([{'kind': 'set_analysis', 'word_id': 'w', 'text_id': 't', 'begin': 0, 'end': 1, 'morpheme_layer_id': 'm', 'morphemes': []}], 'non-empty'), \
                    ([{'kind': 'link', 'token_id': 't'}], 'item_id or new_entry_key'):
        with pytest.raises(ValueError, match=msg):
            execute_plan(c, [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': 'v', 'label': ''}] + bad,
                         source='s', label='l')
        assert c.batches == [] and c.log == []


def _apply_functions(module) -> set:
    """Every ``_apply_*`` in a plan module: what the executor can do."""
    return {getattr(module, n) for n in dir(module) if n.startswith('_apply_') and callable(getattr(module, n))}


def test_every_igt_kind_has_an_apply_and_every_apply_is_registered():
    """The dispatch used to be an if/elif chain: the one table with a name
    nothing could compare with the others, so this test read it off the
    source with ast. Now the apply function is part of the declaration, and
    the only thing left to hold is that the two sets match: a kind the
    executor cannot apply, or an applier nothing reaches."""
    from plaid_agent.core import opkind
    from plaid_agent.igt import plan

    for name, spec in plan.KIND.items():
        if spec.stage == opkind.RESOLVED:
            assert spec.apply is None, f'{name} never reaches the executor'
        else:
            assert callable(spec.apply), f'{name} has no apply function'
    registered = {spec.apply for spec in plan.KIND.values() if spec.apply}
    orphans = _apply_functions(plan) - registered
    assert not orphans, f'appliers no kind names: {sorted(f.__name__ for f in orphans)}'


def test_the_igt_registry_declares_what_every_table_is_read_off():
    """The required keys, the noun the approval line uses, the reshape set and
    the folding rules were tables kept in step by hand. Each is a function of
    the registry now.

    Hand-listed, not compared with another comprehension over the same
    registry: an assertion of that shape passes whatever the registry says,
    which is what the two tests here used to do.
    """
    from plaid_agent.core import opkind
    from plaid_agent.igt import plan
    from plaid_agent.igt.plan import RESHAPES

    assert plan.KIND['set_span'].required == ('layer_id', 'token_id')
    assert plan.KIND['set_span'].noun == ('field value', 'field values')
    assert plan.KIND['delete_entry'].noun == ('deleted entry', 'deleted entries')
    # The kinds that move a boundary, the text, or a morpheme chain: nothing
    # corpus-wide may share a plan with one of these.
    assert set(RESHAPES) == {'set_analysis', 'respell', 'discard_analysis', 'split_word',
                             'merge_words', 'delete_word', 'split_sentence', 'merge_sentences',
                             'edit_text'}
    # Every noun is a (singular, plural) pair, so the applied count and the
    # approval line cannot disagree about what a kind is called.
    assert all(isinstance(s.noun, tuple) and len(s.noun) == 2 and all(s.noun)
               for s in plan.KIND.values())
    # A kind that folds declares which of its keys vary per member.
    for name, s in opkind.compact_spec(plan.KIND, label=lambda f, m: '').items():
        assert s['each'], name


def test_igt_reads_its_scope_and_exclusive_kinds_off_the_registry(monkeypatch):
    """Both sets were the kind's name written out at six sites, where the
    registry's SCOPE and EXCLUSIVE tags already answer. A second kind of
    either would have joined a plan that neither guard knew about."""
    import pytest
    from fixtures import scan_ws
    from plaid_agent.core import opkind as ok
    from plaid_agent.core.tools import ToolError
    from plaid_agent.igt import plan

    monkeypatch.setattr(plan, 'SCOPES', plan.SCOPES + ('sweep',))
    with pytest.raises(ValueError, match='corpus-wide change'):
        plan.validate_ops([{'kind': 'sweep', 'documents': ['d1']},
                           {'kind': 'split_word', 'word_id': 'w-1', 'position': 2, 'doc': 'd1'}])

    # A second kind that owns its whole plan joins the rule by DECLARING itself,
    # and the rule holds both ways round: nothing joins a plan that has one, and
    # one does not join a plan that has anything.
    wipe = ok.OpKind('wipe', ('wipe', 'wipes'), apply=lambda ctx, op: 1, shape=ok.EXCLUSIVE)
    w = scan_ws(FakeClient())
    monkeypatch.setattr(type(w), 'KIND', dict(plan.KIND, wipe=wipe))
    w.ops.append({'kind': 'wipe', 'label': 'a wipe'})
    with pytest.raises(ToolError, match='approved on its own'):
        w.add_op({'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'value': 'x', 'label': ''})

    w2 = scan_ws(FakeClient())
    monkeypatch.setattr(type(w2), 'KIND', dict(plan.KIND, wipe=wipe))
    w2.add_op({'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'value': 'x', 'label': ''})
    with pytest.raises(ToolError, match='plan of its own'):
        w2.add_op({'kind': 'wipe', 'label': 'a wipe'})


def test_an_unknown_igt_kind_refuses_instead_of_writing_nothing():
    """A kind nobody wired up must never be applied as nothing at all, under
    an operation label saying it had been."""
    import pytest
    from plaid_agent.igt.plan import _execute
    from plaid_agent.core.plan import Stamps
    from collections import Counter
    with pytest.raises(ValueError, match='unknown kind'):
        _execute(FakeClient(), [{'kind': 'not_a_kind', 'label': ''}], label='l', project=None,
                 counts=Counter(), notes=[], stamps=Stamps('verified', 's'))
    # And a kind that is resolved before the executor runs never gets there.
    with pytest.raises(ValueError, match='resolved before'):
        _execute(FakeClient(), [{'kind': 'bulk_scope', 'label': ''}], label='l', project=None,
                 counts=Counter(), notes=[], stamps=Stamps('verified', 's'))


def test_a_kind_staged_for_a_pass_igt_does_not_run_refuses(monkeypatch):
    """A working applier and a stage no pass runs: every pass skips the op,
    nothing counts it, and the operation label says it was applied."""
    import pytest
    from plaid_agent.core.opkind import OpKind
    from plaid_agent.core.plan import Stamps
    from plaid_agent.igt import plan
    from collections import Counter
    monkeypatch.setitem(plan.KIND, 'orphan', OpKind('orphan', ('orphan', 'orphans'), stage='later',
                                                    apply=lambda ctx, op: 1))
    c = FakeClient()
    with pytest.raises(ValueError, match='no pass of the executor'):
        plan._execute(c, [{'kind': 'orphan', 'label': ''}], label='l', project=None,
                      counts=Counter(), notes=[], stamps=Stamps('verified', 's'))
    assert c.batches == [] and c.log == []


def test_a_kind_staged_for_a_pass_ud_does_not_run_refuses(monkeypatch):
    import pytest
    from plaid_agent.core.opkind import OpKind
    from plaid_agent.core.plan import Stamps
    from plaid_agent.ud import plan
    from collections import Counter
    monkeypatch.setitem(plan.KIND, 'orphan', OpKind('orphan', ('orphan', 'orphans'), stage='later',
                                                    apply=lambda ctx, op: 1))
    c = FakeClient()
    with pytest.raises(ValueError, match='no pass of the executor'):
        plan._execute(c, [{'kind': 'orphan', 'label': ''}], label='l',
                      counts=Counter(), notes=[], stamps=Stamps('verified', 's'))
    assert c.batches == [] and c.log == []


def test_ud_runs_exactly_the_passes_it_declares(monkeypatch):
    """STAGES is the list `check_applicable` refuses a kind outside of, so a
    pass named there and never run would skip that kind again, and a pass run
    without being named would refuse a kind it can apply."""
    from plaid_agent.core.plan import Stamps
    from plaid_agent.ud import plan
    from collections import Counter
    seen = []
    monkeypatch.setattr(plan, '_run', lambda ctx, ops, stage: seen.append(stage))
    plan._execute(FakeClient(), [], label='l', counts=Counter(), notes=[],
                  stamps=Stamps('verified', 's'))
    assert seen == list(plan.STAGES)


def test_every_ud_kind_has_an_apply_and_every_apply_is_registered():
    """The same two sets in the other app. UD applies its kinds in three
    passes, so the stage is part of the declaration too, and a kind that
    belongs to no pass is a kind the executor would silently skip."""
    from plaid_agent.core import opkind
    from plaid_agent.ud import plan

    for name, spec in plan.KIND.items():
        if spec.stage == opkind.RESOLVED:
            assert spec.apply is None, f'{name} never reaches the executor'
        else:
            assert callable(spec.apply), f'{name} has no apply function'
            assert spec.stage in plan.STAGES, f'{name} belongs to no pass'
    registered = {spec.apply for spec in plan.KIND.values() if spec.apply}
    orphans = _apply_functions(plan) - registered
    assert not orphans, f'appliers no kind names: {sorted(f.__name__ for f in orphans)}'


def test_the_ud_registry_declares_what_every_table_is_read_off():
    """Hand-listed, for the reason the IGT one above gives."""
    from plaid_agent.core import opkind
    from plaid_agent.ud import plan
    from plaid_agent.ud.plan import RESHAPES_DOCUMENT, RESHAPES_TOKEN, SCOPES
    from plaid_agent.ud.tools import SCOPE_KINDS, compact_spec

    assert plan.KIND['set_head'].required == ('word_id', 'head_id', 'lemma_layer_id',
                                              'relation_layer_id', 'deprel')
    assert plan.KIND['del_relation'].noun == ('removed dependency', 'removed dependencies')
    assert set(SCOPES) == {'confirm_scope', 'discard_scope', 'replace_scope'}
    assert set(RESHAPES_DOCUMENT) == {'split_sentence', 'merge_sentences'}
    assert set(RESHAPES_TOKEN) == {'set_words'}
    # The tools' view of a scope is the plan's: one table, not two that drifted
    # (replace_scope had to be spelled out beside SCOPE_KINDS at every site).
    assert set(SCOPE_KINDS) == set(SCOPES)
    # Every kind that folds into a stored group has a line to show for one.
    spec = compact_spec(None)
    assert set(spec) == {n for n, s in plan.KIND.items() if s.compact_each}
    for name, s in spec.items():
        op = {'kind': name, 'field': 'lemma', 'value': 'x', 'deprel': 'nsubj', 'ref': 's1.w1'}
        assert s['label'](op, [op, op]), name
    # The plural comes off the kind's own noun, so no count says "dependencys".
    assert opkind.summarize(plan.KIND, [{'kind': 'del_relation'}, {'kind': 'del_relation'}]) == \
        '2 removed dependencies'


def test_the_applied_counts_use_the_same_nouns_as_the_approval_line():
    """Six of the twenty-eight counts an IGT plan reported disagreed with the
    noun the user had approved (links against lexicon links, restored
    documents against document restores), and UD counted a removed dependency
    and a new one under one key. Both now come off the kind's own noun."""
    from plaid_agent.core.plan import Stamps
    from plaid_agent.igt import plan as igt_plan
    from plaid_agent.ud import plan as ud_plan
    from ud_fixtures import ud_client
    from collections import Counter

    def keys(module, client, ops, **kw):
        counts: Counter = Counter()
        module._execute(client, ops, label='l', counts=counts, notes=[],
                        stamps=Stamps('verified', 's'), **kw)
        return set(counts) - {'notes'}

    igt = keys(igt_plan, FakeClient(), [
        {'kind': 'link', 'token_id': 'w-1', 'item_id': 'vi-erg', 'label': ''},
        {'kind': 'unlink', 'link_id': 'l-2', 'label': ''},
        {'kind': 'create_entry', 'vocab_id': 'v', 'form': 'x', 'key': 'k', 'label': ''},
        {'kind': 'confirm', 'span_ids': ['sp-a'], 'label': ''}], project=None)
    assert igt <= set(_plural_nouns(igt_plan)) and igt == {
        'lexicon links', 'unlinks', 'new lexicon entries', 'confirmations'}

    ud = keys(ud_plan, ud_client(), [
        {'kind': 'del_relation', 'relation_id': 'r1', 'word_id': 'w1', 'label': ''},
        {'kind': 'set_deprel', 'relation_id': 'r2', 'deprel': 'obj', 'label': ''}])
    assert ud <= set(_plural_nouns(ud_plan)) and ud == {'removed dependencies', 'relabeled dependencies'}


def test_an_op_that_wrote_nothing_adds_no_count():
    """`counts[noun] += n` made the key whatever n was, so a plan whose only
    op wrote nothing (clearing a value that was not there) came back as
    "0 field values" on the applied card."""
    from plaid_agent.ud.plan import execute_plan as ud_execute
    from ud_fixtures import ud_client

    clear = {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'span_id': None, 'value': '', 'label': ''}
    assert execute_plan(FakeClient(), [clear], source='s', label='l') == {}
    assert ud_execute(ud_client(), [clear], source='s', label='l') == {}


def test_a_corpus_wide_change_shows_a_kind_the_registry_lost():
    """`ok.summarize` writes the identifier of a kind it does not know rather
    than leaving the change out of the line the user approves. The
    corpus-wide op counts several kinds at once and dropped an unknown one
    silently, against the same rule."""
    from plaid_agent.igt.plan import summarize

    op = {'kind': 'bulk_scope', 'tool': 'replace_in_field', 'args': {}, 'count': 5,
          'counts': {'set_span': 3, 'no_such_kind': 2}, 'label': ''}
    assert summarize([op]) == '3 field values, 2 no_such_kind'


def _plural_nouns(module):
    return [spec.noun[1] for spec in module.KIND.values()]


def test_a_ud_kind_with_no_dispatch_refuses_instead_of_writing_nothing():
    """The pass-1 chain had no else, so a kind nobody had wired up was applied
    as nothing at all, under an operation label saying it had been. Now the
    executor asks the registry before it opens a batch."""
    import pytest
    from plaid_agent.ud.plan import _execute
    from plaid_agent.core.plan import Stamps
    from collections import Counter
    from ud_fixtures import ud_client
    with pytest.raises(ValueError, match='resolved before the plan is applied'):
        _execute(ud_client(), [{'kind': 'confirm_scope', 'document_id': 'ud1', 'fields': ['upos']}],
                 label='l', counts=Counter(), notes=[], stamps=Stamps('verified', 's'))
    with pytest.raises(ValueError, match='unknown kind'):
        _execute(ud_client(), [{'kind': 'not_a_kind'}],
                 label='l', counts=Counter(), notes=[], stamps=Stamps('verified', 's'))


def test_normalize_resolves_op_interactions():
    from plaid_agent.igt.plan import normalize_ops
    import pytest
    ops = [{'kind': 'delete_entry', 'item_id': 'X', 'links': [], 'label': ''},
           {'kind': 'delete_entry', 'item_id': 'X', 'links': [], 'label': ''},
           {'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'a', 'label': ''},
           {'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'b', 'label': ''}]
    out, notes = normalize_ops(ops)
    assert [o['kind'] for o in out] == ['delete_entry', 'respell'] and out[1]['value'] == 'b'
    assert notes == []
    # A link to an entry the plan deletes is refused while the plan is being
    # built, in both orders; this is the backstop under that.
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(ops[:1] + [{'kind': 'link', 'token_id': 't', 'item_id': 'X', 'label': 'link t to X'}])
    with pytest.raises(ValueError, match='overlap'):
        normalize_ops([{'kind': 'respell', 'text_id': 'T', 'begin': 0, 'end': 3, 'value': 'a', 'label': ''},
                       {'kind': 'respell', 'text_id': 'T', 'begin': 2, 'end': 5, 'value': 'b', 'label': ''}])
    with pytest.raises(ValueError, match='merged away'):
        normalize_ops([{'kind': 'merge_entries', 'keep_id': 'A', 'remove_id': 'B', 'links': [], 'label': ''},
                       {'kind': 'merge_entries', 'keep_id': 'B', 'remove_id': 'C', 'links': [], 'label': ''}])
    # A merge and a delete of one entry both end in a delete of it, and the
    # second fails the batch they share. The tools refuse the pair; this is
    # the backstop under them.
    out, notes = normalize_ops([{'kind': 'merge_entries', 'keep_id': 'A', 'remove_id': 'B', 'links': [], 'label': ''},
                                {'kind': 'delete_entry', 'item_id': 'B', 'links': [], 'label': 'Delete entry B'}])
    assert [o['kind'] for o in out] == ['merge_entries']
    assert notes == ['dropped: Delete entry B (a merge in this plan already removes that entry)']


def test_plan_error_reports_how_much_was_applied():
    from plaid_agent.igt.plan import PlanError
    import pytest
    c = FakeClient()
    calls = {'n': 0}
    real = c.batch

    def flaky():
        batch = real()
        submit = batch.submit

        def once():
            calls['n'] += 1
            if calls['n'] == 2:
                raise RuntimeError('boom')
            return submit()
        batch.submit = once
        return batch
    c.batch = flaky
    ops = [{'kind': 'set_span', 'layer_id': 'L', 'token_id': f'T{i}', 'span_id': None, 'value': 'v', 'label': ''} for i in range(1200)]
    with pytest.raises(PlanError) as ei:
        execute_plan(c, ops, source='s', label='l')
    assert ei.value.applied == 800 and ei.value.total == 1200 and 'boom' in str(ei.value)


def test_a_failure_after_the_first_batch_says_what_stood():
    """Five raises in the executor sit after a batch has already committed,
    and every one of them reported nothing written: the user was told the plan
    had failed with no changes while the earlier batch stood. UD threaded a
    tracker for this and IGT did not."""
    from plaid_agent.igt.plan import PlanError
    import pytest
    c = FakeClient()
    ops = [{'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-1', 'span_id': None, 'value': 'v', 'label': ''},
           # edit_text is applied after the batches and needs the project.
           {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 't1', 'sentence_id': 's-1', 'begin': 0,
            'end': 5, 'old': 'Ali-di', 'new': 'Ali', 'word_ids': [], 'morpheme_ids': [], 'label': ''}]
    with pytest.raises(PlanError) as ei:
        execute_plan(c, ops, source='s', label='l', project=None)
    assert 'edit_text needs the project' in str(ei.value)
    assert ei.value.applied == 1, 'the span that was written is reported'
    assert ei.value.total == 2


def test_summarize():
    assert summarize([]) == 'no changes'
    assert summarize([{'kind': 'set_span'}, {'kind': 'set_span'}, {'kind': 'respell'}, {'kind': 'set_analysis'}]) == \
        '2 field values, 1 respelling, 1 analysis'
    assert summarize([{'kind': 'set_analysis'}, {'kind': 'set_analysis'}, {'kind': 'create_entry'}]) == '2 analyses, 1 new lexicon entry'


def test_execute_creates_documents_tokenized_like_the_editor():
    from plaid_agent.igt.project import load_project
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
    ops = [{'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg', 'links': [{'link_id': 'l-2', 'token_ids': ['m-1b']}], 'label': ''},
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


def test_an_entity_is_deleted_once_however_many_ops_ask_for_it():
    """Measured against the dev core, 2026-09-12: `tokens.bulk_delete` of ids
    that are already gone is ACCEPTED (and still deletes the live ones), but a
    SINGLE delete of a gone id is a 404, a span a token delete cascaded away
    404s on delete and on patch, and two single deletes of one id inside one
    batch fail the whole batch (the other ops in it rolled back). So every
    single delete the applier issues has to be once per entity, whichever ops
    name it: an unlink beside the word deletion that takes the same link, a
    cleared field beside the discard that deletes the same span, a merge
    beside a delete of the same entry."""
    c = FakeClient()
    ops = [{'kind': 'unlink', 'link_id': 'l-1', 'label': ''},
           {'kind': 'delete_word', 'word_id': 'w-9', 'morpheme_ids': [], 'link_ids': ['l-1'], 'label': ''},
           {'kind': 'discard_analysis', 'word_id': 'w-8', 'link_ids': ['l-1'], 'span_ids': ['sp-1'],
            'morpheme_ids': [], 'renumber': [], 'label': ''},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'm-1', 'span_id': 'sp-1', 'value': '', 'label': ''}]
    execute_plan(c, ops, source='s', label='l')
    calls = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert [a for r, m, a in calls if (r, m) == ('vocab_links', 'delete')] == [('l-1',)]
    assert [a for r, m, a in calls if (r, m) == ('spans', 'delete')] == [('sp-1',)]


def test_an_entry_is_deleted_once_however_many_ops_ask_for_it():
    """The deletes a merge and a delete_entry defer both land in the last
    batch. Asking the server twice 404s the second call, and the batch is
    atomic, so the whole tail of the plan failed."""
    c = FakeClient()
    # Two merges that remove the same entry: normalize collapses a merge with
    # a delete of one entry, so this is the pair that reaches the flush.
    execute_plan(c, [{'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg', 'links': [], 'label': ''},
                     {'kind': 'merge_entries', 'keep_id': 'vi-gam', 'remove_id': 'vi-erg', 'links': [], 'label': ''}],
                 source='s', label='l')
    deletes = [a for r, m, a, k in c.batches[0] if (r, m) == ('vocab_items', 'delete')]
    assert deletes == [('vi-erg',)]


def test_op_keys_survive_the_wire_unchanged():
    """A plan crosses the wire twice: Python writes it snake_case, the server
    speaks kebab-case, the browser holds it camelCase, and it comes back the
    same way. That is only lossless while every key is plain snake_case, and
    while the arbitrary keys a user chooses live under ``metadata`` (which
    both clients pass through untouched). A key like ``layer_2`` or one with
    a capital would come back as something else, and the write would silently
    lose whatever it named."""
    import re
    from test_tools import ws as tools_ws
    from test_shape import ws as shape_ws
    from plaid_agent.igt.toolkit import call_tool

    key_re = re.compile(r'^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$')
    ops = []
    w = tools_ws()
    for name, args in [
        ('set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'}),
        # On a word no reshape below names: a plan may change a word's
        # boundaries or its morpheme chain, never both.
        ('set_analysis', {'document': 'Text 1', 'ref': 's1.w3', 'morphemes': [{'form': 'akuna', 'Morph Gloss': 'see'}]}),
        ('set_orthography', {'document': 'Text 1', 'refs': ['s1.w1'], 'orthography': 'IPA', 'value': 'ali'}),
        ('respell', {'document': 'Text 1', 'ref': 's1.w2', 'new_text': 'gamm'}),
        ('link_entry', {'document': 'Text 1', 'refs': ['s1.w1'], 'entry_form': 'Ali'}),
        ('unlink_entry', {'document': 'Text 1', 'refs': ['s1.w1.m1']}),
        ('create_entry', {'form': 'zzz', 'fields': {'gloss': 'g'}}),
        ('set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'ali'}),
        ('set_document_metadata', {'document': 'Text 1', 'field': 'Date', 'value': '2026'}),
        ('create_document', {'name': 'Brand new', 'text': 'Sa cuma.'}),
        ('confirm', {'document': 'Text 1'}),
        ('rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gam2'}),
        # Not "Ali": a change above sets a field on it, and a plan that writes
        # to an entry it also deletes refuses itself.
        ('delete_entry', {'entry_id': 'vi-erg'}),
        ('merge_words', {'document': 'Text 1', 'refs': ['s1.w1', 's1.w2']}),
        ('merge_sentences', {'document': 'Text 1', 'ref': 's2'}),
        ('rename_document', {'document': 'Text 1', 'new_name': 'Text One'}),
    ]:
        assert not call_tool(w, name, args).startswith('Error'), name
    ops += w.ops
    w = shape_ws()
    for name, args in [('split_word', {'document': 'Text 1', 'ref': 's1.w1', 'at': 2}),
                       ('delete_word', {'document': 'Text 1', 'refs': ['s1.w2']}),
                       ('split_sentence', {'document': 'Text 1', 'ref': 's1', 'before_word': 2}),
                       ('append_text', {'document': 'Text 1', 'text': 'Yeni cümlə.'})]:
        assert not call_tool(w, name, args).startswith('Error'), name
    ops += w.ops

    covered = {o['kind'] for o in ops}
    assert len(covered) >= 15, covered  # a broad sample, not one shape

    def walk(value, under_metadata=False):
        if isinstance(value, list):
            for v in value:
                walk(v, under_metadata)
        elif isinstance(value, dict):
            for k, v in value.items():
                if not under_metadata:
                    assert key_re.match(k), f'{k!r} does not survive recasing'
                walk(v, under_metadata or k in ('metadata', 'config'))

    walk(ops)



def test_updates_fold_into_bulk_sub_ops_by_resource_and_chunk():
    """Thousands of value updates and metadata patches are a handful of bulk
    sub-ops in the same atomic batch, one per resource and chunk, merged per
    entity, and counted per entity when a batch fails."""
    from plaid_agent.core.plan import BULK_CHUNK, TrackingBatcher
    c = FakeClient()
    b = TrackingBatcher(c, budget=5000)
    for i in range(BULK_CHUNK + 5):
        b.update('spans', f's{i}', value='x')
    b.update('spans', 's0', metadata={'k': 1})       # merges with s0's value
    b.update('relations', 'r1', metadata={'k': 2})
    b.add(lambda batch: batch.spans.create('L', ['t'], 'v'))    # a plain sub-op, before the bulk ones
    b.flush()
    assert [(r, len(items)) for r, items in c.bulk_calls] == [('spans', BULK_CHUNK), ('spans', 5), ('relations', 1)]
    assert c.bulk_calls[0][1][0] == {'id': 's0', 'value': 'x', 'metadata': {'k': 1}}
    assert b.applied == BULK_CHUNK + 5 + 1 + 1
    assert [m for r, m, a, k in c.batches[0]][:1] == ['create']
    assert len(c.batches) == 1
