"""Moving a sentence boundary: the one shape op with an exact spec in the app.

`ConlluDocument.toggleSentenceBoundary` is that spec. What is worth pinning is
the two things it does that nothing enforces: a relation never spans a
sentence, and a boundary renumbers everything after it.
"""

import pytest

from plaid_agent.ud.plan import validate_ops
from plaid_agent.ud.sentences import crossing_relations
from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace, call_tool
from ud_fixtures import PID, ud_client


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def run(ws, name, **args):
    return call_tool(ws, name, args)


# --- which relations a cut would orphan ------------------------------------

def test_a_cut_orphans_the_relations_that_straddle_it(ws):
    """The app deletes these in the same batch as the split, silently, because
    nothing on the server refuses a relation spanning two sentences and
    reconcile-on-open would delete them on the next read anyway."""
    doc = ws.doc('Viaje')
    s1 = doc.sentences[0]
    # "Vamos al mar": every word hangs off the root, so a cut anywhere inside
    # leaves at least one relation straddling it.
    inside = s1.words[1].token.begin
    assert crossing_relations(s1, inside), 'a cut inside a connected sentence orphans something'


def test_a_cut_before_the_first_word_orphans_nothing(ws):
    doc = ws.doc('Viaje')
    s1 = doc.sentences[0]
    assert crossing_relations(s1, s1.begin) == []


def test_the_root_is_a_self_relation_and_never_crosses(ws):
    """head 0 is written as a relation from a word to itself, so its endpoints
    are always on the same side of any cut."""
    doc = ws.doc('Viaje')
    s1 = doc.sentences[0]
    roots = [w for w in s1.words if w.head == 0]
    assert roots, 'the fixture has a root'
    ids = crossing_relations(s1, s1.words[-1].token.begin)
    assert all(r != roots[0].relation_id for r in ids)


# --- what the tools refuse -------------------------------------------------

def test_splitting_at_the_first_word_is_refused(ws):
    out = run(ws, 'split_sentence', document='Viaje', ref='s1.w1')
    assert 'already starts' in out


def test_a_sentence_that_owns_its_leading_space_still_refuses_a_split_at_its_first_word(ws):
    """The sentence layer is a partitioning layer, so a sentence owns the
    whitespace before its first word and `sentence.begin` is short of it. The
    guard compared those two numbers, so the split went through and planned a
    sentence holding no words at all, plus a renumber of everything after it."""
    from ud_fixtures import FakeClient, PID, document_raw, project_raw
    from plaid_agent.ud.project import load_project

    raw = document_raw()
    sents = raw['text_layers'][0]['token_layers'][0]['tokens']
    assert sents[1]['begin'] == 14
    sents[1]['begin'] = 13          # the real shape: no gap between sentences
    client = FakeClient(project=project_raw(), documents={'ud1': raw})
    w = Workspace(client, load_project(client, PID))

    out = call_tool(w, 'split_sentence', {'document': 'Viaje', 'ref': 's2.w1'})
    assert 'already starts' in out, out
    assert not w.ops


def test_a_split_inside_a_multi_word_token_is_refused(ws):
    """Every word of a multi-word token shares that token's begin, so a cut
    "before w3" of the token w2-3 really falls before w2. It was planned, and
    labelled with the word it does not cut before."""
    out = run(ws, 'split_sentence', document='Viaje', ref='s1.w3')
    assert 'cannot begin inside one' in out, out
    assert not ws.ops


def test_merging_the_first_sentence_is_refused(ws):
    out = run(ws, 'merge_sentences', document='Viaje', ref='s1')
    assert 'nothing before it' in out


def test_a_boundary_and_an_edit_cannot_share_a_plan(ws):
    """Every reference is positional, so s2.w1 means a different word once a
    boundary has moved. The plan refuses rather than resolving it by a rule
    nobody would remember."""
    run(ws, 'split_sentence', document='Viaje', ref='s1.w2')
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    assert 'renumbers' in out


def test_the_same_holds_the_other_way_round(ws):
    """The edit was planned first, so THIS is the op that would invalidate it.
    The old assertion here was `'renumbers' in out or 'plan' in out.lower()`,
    and the SUCCESS message begins "Planned: s1 splits before ...", so it was
    green over a real hole: the split was accepted and the whole plan was
    refused only once the user had approved it."""
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    out = run(ws, 'split_sentence', document='Viaje', ref='s1.w2')
    assert 'plan of its own' in out, out
    assert not any(op.get('kind') == 'split_sentence' for op in ws.ops)


def test_a_plan_moves_at_most_one_boundary(ws):
    run(ws, 'split_sentence', document='Viaje', ref='s1.w2')
    out = run(ws, 'merge_sentences', document='Viaje', ref='s2')
    assert 'renumbers' in out


# --- the backstop, for a plan that got past the tools ----------------------

def test_validate_refuses_a_mixed_plan_even_if_the_tools_did_not():
    ops = [
        {'kind': 'split_sentence', 'document_id': 'd1', 'sentence_id': 's1', 'char_pos': 6},
        {'kind': 'set_span', 'document_id': 'd1', 'layer_id': 'L', 'token_id': 'w1', 'value': 'x'},
    ]
    with pytest.raises(ValueError, match='renumbers'):
        validate_ops(ops)


def test_validate_refuses_two_boundaries():
    ops = [
        {'kind': 'split_sentence', 'document_id': 'd1', 'sentence_id': 's1', 'char_pos': 6},
        {'kind': 'split_sentence', 'document_id': 'd1', 'sentence_id': 's1', 'char_pos': 9},
    ]
    with pytest.raises(ValueError, match='at most one sentence boundary per document'):
        validate_ops(ops)


def test_a_boundary_in_ANOTHER_document_is_fine():
    """The renumbering is per document, so a plan may move one boundary and
    edit a different document."""
    ops = [
        {'kind': 'split_sentence', 'document_id': 'd1', 'sentence_id': 's1', 'char_pos': 6},
        {'kind': 'set_span', 'document_id': 'd2', 'layer_id': 'L', 'token_id': 'w1', 'value': 'x'},
    ]
    validate_ops(ops)


def test_the_plan_says_how_many_relations_a_split_takes_with_it():
    """Deleting them is silent in the sense that nothing asks, the way the
    editor does it. The COUNT is still part of what is being approved."""
    from plaid_agent.ud.plan import summarize

    assert summarize([{'kind': 'split_sentence', 'relation_ids': ['a', 'b', 'c']}]) == (
        '3 removed dependencies, 1 sentence split')
    assert summarize([{'kind': 'split_sentence', 'relation_ids': []}]) == '1 sentence split'
    assert summarize([{'kind': 'merge_sentences'}]) == '1 sentence merge'


def test_a_plan_of_sentence_ops_is_not_summarized_as_nothing():
    """It was: summarize knew six op kinds and a plan of the two new ones read
    "no changes", which is what a user would have been asked to approve."""
    from plaid_agent.ud.plan import summarize

    assert summarize([{'kind': 'merge_sentences'}]) != 'no changes'


def test_a_count_that_ends_in_y_pluralizes_properly():
    """It read "3 removed dependencys", and del_relation had the same bug."""
    from plaid_agent.ud.plan import summarize

    assert summarize([{'kind': 'del_relation'}, {'kind': 'del_relation'}]) == (
        '2 removed dependencies')


# --- restore -----------------------------------------------------------------

def test_a_restore_will_not_share_a_plan(ws):
    """It rewrites every layer, so anything else planned would be addressing
    what the restore is about to replace. Same reasoning as a parse."""
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    out = run(ws, 'restore_document', document='Viaje', as_of='2026-09-05T18:45:49Z')
    assert 'plan of its own' in out


def test_a_restore_needs_a_real_instant(ws):
    out = run(ws, 'restore_document', document='Viaje', as_of='last Tuesday')
    assert 'ISO-8601' in out


def test_validate_refuses_a_restore_beside_anything_else():
    from plaid_agent.ud.plan import validate_ops

    ops = [
        {'kind': 'restore_document', 'document_id': 'd1', 'as_of': '2026-09-05T18:45:49Z'},
        {'kind': 'set_span', 'document_id': 'd1', 'layer_id': 'L', 'token_id': 'w1', 'value': 'x'},
    ]
    with pytest.raises(ValueError, match='only op in its plan'):
        validate_ops(ops)


def test_the_restore_summary_reads_as_english():
    """The dry run's counts become the phrase the user approves, so a count of
    one must not say "1 dependencies" and three must not say "3 dependencys"."""
    from plaid_agent.ud.restore import restore_lines

    class P:
        sentence_layer_id, token_layer_id, word_layer_id = 'S', 'T', 'W'

    assert restore_lines(P(), {'relations': {'deleted': 1}}) == ['1 dependency']
    assert restore_lines(P(), {'relations': {'deleted': 3}}) == ['3 dependencies']
    assert restore_lines(P(), {'tokens': {'by_layer': [{'layer_id': 'S', 'inserted': 1}]}}) == [
        '1 sentence']


@pytest.mark.parametrize('tool,args', [
    ('set_field', {'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'}),
    ('set_head', {'ref': 's1.w2', 'head': 1, 'deprel': 'obl'}),
    ('confirm', {'refs': ['s1.w1']}),
    ('discard_predictions', {'refs': ['s1.w1']}),
    # No refs means "the whole document", which used to reach the words by a
    # route with no guard on it at all.
    ('confirm', {}),
    ('discard_predictions', {}),
    ('set_words', {'ref': 's1.w1', 'forms': ['a', 'b']}),
    ('split_sentence', {'ref': 's1.w2'}),
    ('merge_sentences', {'ref': 's2'}),
])
def test_nothing_joins_a_restore_whatever_tool_is_used(ws, tool, args):
    """The guard has to look FORWARD as well as back. Refusing only when the
    restore is planned SECOND let an edit slip in after one, and two tools
    (run_parse, discard_predictions) never reached the shared chokepoint at
    all."""
    run(ws, 'restore_document', document='Viaje', as_of='2026-09-05T18:45:49Z')
    # Asserted, not skipped. As a skip it would have turned every case green
    # the day the fake stopped reporting something to restore, which is the
    # one day this test matters.
    assert any(op.get('kind') == 'restore_document' for op in ws.ops), \
        'the fixture must plan a restore for this test to mean anything'
    out = run(ws, tool, document='Viaje', **args)
    assert 'nothing else can share the plan' in out, f'{tool} slipped past the guard'


# --- the whole-document route ------------------------------------------------

@pytest.mark.parametrize('tool', ['confirm', 'discard_predictions'])
def test_a_whole_document_review_cannot_join_a_reshape(ws, tool):
    """Naming no references meant "every word in the document", and that route
    skipped the guards the named route owes. So a plan could reshape a token
    and confirm a span sitting on one of its words, and the batch deleted the
    token before patching the span."""
    run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    out = run(ws, tool, document='Viaje')
    assert 'reshapes the token' in out, out
    assert not any(op.get('kind') in ('confirm', 'set_span') for op in ws.ops)


@pytest.mark.parametrize('tool', ['confirm', 'discard_predictions'])
def test_a_whole_document_review_cannot_join_a_moved_boundary(ws, tool):
    run(ws, 'split_sentence', document='Viaje', ref='s1.w2')
    out = run(ws, tool, document='Viaje')
    assert 'renumbers' in out, out


# --- the guards, from both sides -----------------------------------------------

def test_a_reshape_will_not_join_a_plan_that_annotates_the_token_it_deletes(ws):
    """`_not_being_reshaped` refused annotate-AFTER-reshape. The other order was
    staged, shown on the card, approved, and only then refused by validate_ops."""
    run(ws, 'set_field', document='Viaje', refs=['s1.w2'], field='upos', value='ADP')
    out = run(ws, 'set_words', document='Viaje', ref='s1.w2', forms=['a', 'el'])
    assert 'already annotates a word of this token' in out, out
    assert not any(op.get('kind') == 'set_words' for op in ws.ops)


def test_the_same_token_is_not_reshaped_twice(ws):
    """Two reshapes delete its words twice and create both sets, so the token
    ends up holding the union or the batch fails outright."""
    run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    out = run(ws, 'set_words', document='Viaje', ref='s1.w2', forms=['a', 'el'])
    assert 'reshapes' in out.lower(), out


def test_validate_refuses_a_confirm_on_a_word_a_reshape_deletes():
    """A confirm op carries a span_id, not a token_id, so listing the kinds
    that name a word let it straight through the backstop."""
    ops = [
        {'kind': 'set_words', 'document_id': 'd1', 'existing_word_ids': ['w1', 'w2'],
         'forms': ['a', 'b'], 'surface': 'ab', 'token_id': 't1', 'text_id': 'tx',
         'word_layer_id': 'W', 'form_layer_id': 'F', 'lemma_layer_id': 'L'},
        {'kind': 'confirm', 'span_id': 'sp1', 'token_id': 'w1', 'document_id': 'd1'},
    ]
    with pytest.raises(ValueError, match='annotates one of its words'):
        validate_ops(ops)


def test_a_turn_that_read_the_web_cannot_plan_a_change(ws):
    """IGT has refused this since its web tools landed, and the prompt UD ships
    says the workspace enforces it. UD's did not, so a page returned by a web
    search could tell the model to stage changes and the user would be
    approving a card whose origin was a stranger's page."""
    class Web:
        read = True

    ws.web = Web()
    for tool, args in [
        ('set_field', {'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'}),
        ('set_head', {'ref': 's1.w2', 'head': 1, 'deprel': 'obl'}),
        ('confirm', {}),
        ('set_words', {'ref': 's1.w1', 'forms': ['a', 'b']}),
        ('split_sentence', {'ref': 's1.w2'}),
        ('merge_sentences', {'ref': 's2'}),
        ('restore_document', {'as_of': '2026-09-05T18:45:49Z'}),
    ]:
        out = run(ws, tool, document='Viaje', **args)
        assert 'read the web' in out, f'{tool} planned anyway: {out}'
    assert not ws.ops
