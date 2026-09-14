"""Every list of op kinds in either app is the registry read, never typed out.

A kind name written into an `if` is invisible debt: the rule keeps working for
the kinds that were there when it was written and silently skips the next one.
Each test here declares a NEW kind with the tag the rule is built on, and holds
the rule to it. A kind reading its own keys (a validation of one shape, the
card's wording for one op) is not this, and is not swept.
"""

import pathlib
import sys

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.core import opkind as ok  # noqa: E402
from plaid_agent.core.opkind import OpKind  # noqa: E402


# ---- IGT -------------------------------------------------------------------

def test_every_igt_shape_kind_says_what_it_re_cuts():
    """`reshaped_subjects` reads `extra['reshapes']`, so a shape kind without
    one takes part in no shape guard at all and nothing says so."""
    from plaid_agent.igt.plan import KIND, SENTENCE_SHAPE, WORD_SHAPE
    for name in ok.shaped(KIND, WORD_SHAPE, SENTENCE_SHAPE):
        assert KIND[name].extra.get('reshapes'), f'{name} reshapes nothing it names'


def test_a_new_shape_kind_joins_the_one_shape_op_per_item_rule():
    from plaid_agent.igt import plan as igt_plan
    from plaid_agent.igt.plan import KIND, WORD_SHAPE
    extra = dict(KIND['merge_words'].extra)
    fused = OpKind('fuse_words', ('fusion', 'fusions'), apply=lambda ctx, op: 1,
                   shape=WORD_SHAPE, extra={**extra, 'reshapes': ('word_id', 'other_ids'),
                                            'merge': True})
    reg = dict(KIND, fuse_words=fused)
    op = {'kind': 'fuse_words', 'word_id': 'w-1', 'other_ids': ['w-2', 'w-3']}
    saved = igt_plan.KIND
    try:
        igt_plan.KIND = reg
        assert igt_plan.reshaped_subjects([op]) == {'w-1', 'w-2', 'w-3'}
        assert igt_plan.reshaped_subjects([op], merges_only=True) == {'w-1', 'w-2', 'w-3'}
        assert igt_plan.reshaped_subjects([op], WORD_SHAPE) == {'w-1', 'w-2', 'w-3'}
    finally:
        igt_plan.KIND = saved


def test_a_merge_is_the_registry_s_flag_not_a_name():
    """A split or a delete clashes only with a MERGE of the same item; a merge
    clashes with any shape op. The two sets used to be four kind names."""
    from plaid_agent.igt import plan as igt_plan
    ops = [{'kind': 'split_word', 'word_id': 'w-1'},
           {'kind': 'merge_sentences', 'sentence_id': 's-1', 'other_id': 's-2'}]
    assert igt_plan.reshaped_subjects(ops) == {'w-1', 's-1', 's-2'}
    assert igt_plan.reshaped_subjects(ops, merges_only=True) == {'s-1', 's-2'}


def test_a_text_edit_is_a_sentence_shape_to_the_guard_and_a_word_guess_to_approval():
    """Its WORD ids are a guess (`certain=False`), so a split of one is dropped
    when the plan is applied rather than refused as it is built. It must not
    reach `reshaped_subjects`, and it must reach `_reshaped_words`."""
    from plaid_agent.igt import plan as igt_plan
    from plaid_agent.igt.plan import KIND
    assert KIND['edit_text'].extra['reshapes'] == ('sentence_id',)
    op = {'kind': 'edit_text', 'sentence_id': 's-1', 'word_ids': ['w-9'], 'morpheme_ids': []}
    assert igt_plan.reshaped_subjects([op]) == {'s-1'}
    assert 'w-9' in ok.removed_tokens(KIND, [op])


def test_every_igt_scope_kind_is_placed_at_its_document_on_the_card():
    """`locate` named one scope kind. A second is placed nowhere: it names no
    entity of its own, so every per-kind lookup below misses it and the row
    reaches the card with no document."""
    from fixtures import FakeClient, scan_ws
    from plaid_agent.igt import changes
    from plaid_agent.igt.plan import SCOPES
    ws = scan_ws(FakeClient())
    assert SCOPES, 'the sweep is green on an empty list without this'
    saved = changes.SCOPES
    try:
        changes.SCOPES = SCOPES + ('sweep_it',)
        for name in changes.SCOPES:
            where = changes.locate(ws, {'kind': name, 'documents': ['d1'], 'counts': {}})
            assert where and where['kind'] == 'document' and where['document_id'] == 'd1', name
    finally:
        changes.SCOPES = saved


def test_the_entries_a_plan_removes_have_one_reader():
    """The tools refuse a write to a doomed entry and the executor refuses a
    merge into one. Written twice, the two could disagree about the set."""
    from fixtures import FakeClient, scan_ws
    from plaid_agent.igt.plan import KIND, removed_entries
    ops = [{'kind': 'delete_entry', 'item_id': 'vi-a', 'links': []},
           {'kind': 'merge_entries', 'keep_id': 'vi-b', 'remove_id': 'vi-c', 'links': []}]
    assert removed_entries(ops) == {'vi-a', 'vi-c'}
    ws = scan_ws(FakeClient())
    ws.ops.extend(ops)
    assert ws.doomed_entries() == removed_entries(ops)
    declared = {n for n, k in KIND.items() if k.extra.get('removes_entry')}
    assert declared == {'delete_entry', 'merge_entries'}


def test_a_morpheme_writer_is_the_registry_s_token_keys():
    from plaid_agent.igt.plan import MORPHEME_WRITERS
    assert set(MORPHEME_WRITERS) == {'set_morpheme_form', 'set_morph_type'}


# ---- UD --------------------------------------------------------------------

def test_ud_supersession_uses_the_registry_target_everywhere():
    """The workspace supersedes by `OpKind.target` while the plan is built and
    `normalize_ops` wrote the same rule out again for three kinds by name, so
    a fourth declaring a target was deduped while staging and not at approval,
    and the plan wrote twice to one thing."""
    from plaid_agent.ud import plan as ud_plan
    retag = OpKind('retag', ('tag', 'tags'), apply=lambda ctx, op: 1,
                   target=lambda op: ('tag', op.get('word_id')))
    saved = ud_plan.KIND
    try:
        ud_plan.KIND = dict(saved, retag=retag)
        one = {'kind': 'retag', 'word_id': 'w-1', 'value': 'a', 'label': 'first'}
        two = {**one, 'value': 'b', 'label': 'second'}
        out, notes = ud_plan.normalize_ops([one, two])
        assert out == [two], 'a kind with a target kept both writes to it'
        assert notes and 'superseded' in notes[0]
    finally:
        ud_plan.KIND = saved


def test_a_ud_kind_without_a_target_supersedes_nothing():
    from plaid_agent.ud.plan import normalize_ops
    ops = [{'kind': 'add_comment', 'entity_type': 'token', 'entity_id': 't', 'body': 'a'},
           {'kind': 'add_comment', 'entity_type': 'token', 'entity_id': 't', 'body': 'b'}]
    out, notes = normalize_ops(ops)
    assert out == ops and not notes


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_the_kind_tables_are_not_empty(app):
    """Without this every sweep above is green on an empty registry."""
    mod = __import__(f'plaid_agent.{app}.plan', fromlist=['KIND'])
    assert len(mod.KIND) > 10


def test_the_compaction_spec_has_one_name_in_both_apps():
    """UD called it COMPACT and IGT built it in `workspace.compact_spec`, and
    the README named UD's. A reader following either name found half the
    package."""
    from plaid_agent.igt.workspace import compact_spec as igt_spec
    from plaid_agent.ud.tools import compact_spec as ud_spec
    from plaid_agent.igt.plan import KIND as IGT_KIND
    from plaid_agent.ud.plan import KIND as UD_KIND
    assert set(ud_spec(None)) == {n for n, k in UD_KIND.items() if k.compact_each}
    from fixtures import FakeClient, scan_ws
    assert set(igt_spec(scan_ws(FakeClient()))) == {n for n, k in IGT_KIND.items() if k.compact_each}
    readme = (pathlib.Path(__file__).resolve().parent.parent / 'README.md').read_text()
    assert 'compact_spec' in readme and '`COMPACT`' not in readme


def test_a_change_made_by_name_beats_a_scope_by_the_kind_s_own_declaration():
    """At approval a scope drops what the model already named. The two sets it
    compared were four kind names written into the resolver, so a kind added
    later wrote over a change the user had read on the card. Each kind names
    the stored entity it writes to instead."""
    from plaid_agent.ud import plan as ud_plan
    from plaid_agent.ud.plan import KIND, entity_of
    assert entity_of({'kind': 'set_head', 'relation_id': 'r1'}) \
        == entity_of({'kind': 'set_deprel', 'relation_id': 'r1'}) \
        == entity_of({'kind': 'del_relation', 'relation_id': 'r1'}) == ('relation', 'r1')
    assert entity_of({'kind': 'set_head', 'word_id': 'w1'}) is None   # it makes the relation
    assert entity_of({'kind': 'set_span', 'layer_id': 'L', 'token_id': 't'}) == ('span', 'L', 't')
    assert entity_of({'kind': 'add_comment'}) is None
    declared = {n for n, k in KIND.items() if k.extra.get('entity')}
    assert declared == {'set_span', 'set_head', 'del_relation', 'set_deprel'}

    # A new kind writing the same relation is seen as writing it.
    relabel = OpKind('relabel', ('relabel', 'relabels'), apply=lambda ctx, op: 1,
                     extra={'entity': KIND['set_deprel'].extra['entity']})
    saved = ud_plan.KIND
    try:
        ud_plan.KIND = dict(saved, relabel=relabel)
        assert ud_plan.entity_of({'kind': 'relabel', 'relation_id': 'r1'}) == ('relation', 'r1')
    finally:
        ud_plan.KIND = saved
