"""The UD tools, over the Spanish fixture: what they read, and what they plan."""

import pytest

from plaid_client.testing import as_fragment
from plaid_agent.ud.plan import execute_plan, summarize
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import TOOLS, WRITE_TOOLS, call_tool
from plaid_agent.ud.tools import Workspace
from ud_fixtures import (DEPREL, ENHANCED, LEMMA, PID, UPOS, WORD_LAYER, suppressor,
                         ud_client, with_enhanced)


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def run(ws, name, **args):
    return call_tool(ws, name, args)


# --- reads --------------------------------------------------------------------

def test_the_overview_says_which_vocabularies_are_rules(ws):
    out = run(ws, 'project_overview')
    assert 'Project "Spanish"' in out and 'Language: es' in out
    assert 'upos: ONLY these values are allowed' in out
    assert 'deprel: these are the expected values, others are allowed' in out
    assert 'features: Gender=Masc/Fem, Number=Sing/Plur' in out
    assert '"Viaje"' in out


def test_read_document_returns_conllu(ws):
    out = run(ws, 'read_document', document='Viaje')
    assert '2-3\tal\t' in out and 'NOUN~' in out


# --- the enhanced graph, read-only (RULED 2026-09-21) --------------------------

def _enhanced_ws(rows):
    client = ud_client(documents={'ud1': with_enhanced(rows)})
    return Workspace(client, load_project(client, PID))


def test_a_read_shows_the_enhanced_graph_where_a_sentence_has_one():
    """The layer holds only what differs from the tree, so a read prints DEPS
    on the sentences that differ and leaves the column off everywhere else. A
    suppressed relation is a word the enhanced graph gives no head."""
    ws = _enhanced_ws([
        # An extra: "mar" (word 4) is given a second head in the graph.
        {'id': 'e-1', 'source': 'sp-l1', 'target': 'sp-l3', 'value': 'nsubj'},
        # And the tree's punct (word 5) is left out of the graph.
        suppressor('e-2', 'sp-l1', 'sp-l4')])
    out = run(ws, 'read_document', document='Viaje')
    s1, s2 = out.split('# sent_id = s2')
    assert 'DEPS' in s1 and 'DEPS' not in s2, 'only the sentence that has one'
    rows = {line.split('\t')[0]: line.split('\t') for line in s1.splitlines() if '\t' in line}
    assert rows['4'][-1] == '1:nsubj|1:obl', 'the tree edge and the extra, once each'
    assert rows['5'][-1] == '_', 'the graph leaves the tree relation out'
    assert rows['1'][-1] == '0:root'


def test_an_extra_edge_with_no_label_writes_nothing_in_deps_as_the_export_does():
    """DEPS names a head and a relation, and plaid-ud's export leaves out an
    edge with no relation to name. The read wrote `1:` for one."""
    ws = _enhanced_ws([{'id': 'e-1', 'source': 'sp-l1', 'target': 'sp-l3', 'value': ''},
                       {'id': 'e-2', 'source': 'sp-l1', 'target': 'sp-l4', 'value': None}])
    out = run(ws, 'read_document', document='Viaje')
    rows = {line.split('\t')[0]: line.split('\t') for line in out.split('# sent_id = s2')[0]
            .splitlines() if '\t' in line}
    assert rows['4'][-1] == '1:obl'
    assert rows['5'][-1] == '1:punct'


def test_a_citation_carries_the_enhanced_graph_only_where_there_is_one():
    from plaid_agent.ud.citations import resolve_citations
    rows = [{'id': 'e-1', 'source': 'sp-l1', 'target': 'sp-l3', 'value': 'nsubj'}]
    ws = _enhanced_ws(rows)
    run(ws, 'read_document', document='Viaje')
    card = resolve_citations(ws, '<example doc="Viaje" ref="s1.w4"/>')[0]
    assert 'deps' in card['columns']
    assert [r['deps'] for r in card['rows'] if r['id'] == '4'] == ['1:nsubj|1:obl']
    # And a treebank with no enhanced annotation reads exactly as before.
    plain = Workspace(ud_client(), load_project(ud_client(), PID))
    run(plain, 'read_document', document='Viaje')
    assert 'deps' not in resolve_citations(plain, '<example doc="Viaje" ref="s1.w4"/>')[0]['columns']


def test_a_head_write_takes_the_suppressors_it_would_strand_with_it():
    """A suppressor stands over a BASIC relation and says the enhanced graph
    leaves that one out. Left behind by a write that moves or removes the
    relation, it suppresses nothing, and it silently suppresses the next
    relation drawn over the same pair: the person redraws the arc and it is
    born faded, with no enhanced head and nothing on screen saying why. The
    editor clears them at both moments; only reconcile-on-open, which runs on
    an open and not after an assistant's plan, caught the agent's."""
    # The tree's punct (word 5 under word 1) is left out of the graph, and so
    # is a pair nothing joins yet (word 4 under word 1 is `obl`; word 5 under
    # word 4 would be a new relation over an old suppressor).
    ws = _enhanced_ws([suppressor('e-1', 'sp-l1', 'sp-l4'),
                       suppressor('e-2', 'sp-l3', 'sp-l4')])
    run(ws, 'set_head', document='Viaje', ref='s1.w5', head=4, deprel='punct')
    assert ws.ops[0]['suppressor_ids'] == ['e-1', 'e-2']
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    deleted = ws.client.payloads('relations.delete')
    assert deleted == ['r-4', 'e-1', 'e-2']
    assert len(ws.client.batches) == 1, 'in the same batch as the relation itself'


def test_a_relabel_keeps_the_enhanced_graph_as_it_was():
    """set_head with the head the word already has is the assistant's relabel.
    The pair stays, so a suppressor over it is not stranded: the enhanced graph
    relabelled that relation (suppressor plus extra), and a relabel of the tree
    must not bring the tree's label back into the graph. The editor's relabel
    keeps it too."""
    ws = _enhanced_ws([suppressor('e-1', 'sp-l1', 'sp-l3'),
                       {'id': 'e-2', 'source': 'sp-l1', 'target': 'sp-l3', 'value': 'obl:a'}])
    run(ws, 'set_head', document='Viaje', ref='s1.w4', head=1, deprel='nmod')
    assert ws.ops[0]['suppressor_ids'] == []
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    deleted = ws.client.payloads('relations.delete')
    assert 'e-1' not in deleted


def test_removing_a_head_takes_the_suppressor_over_it():
    ws = _enhanced_ws([suppressor('e-1', 'sp-l1', 'sp-l4')])
    run(ws, 'del_relation', document='Viaje', refs=['s1.w5'])
    assert ws.ops[0]['suppressor_ids'] == ['e-1']
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    deleted = ws.client.payloads('relations.delete')
    assert deleted == ['r-4', 'e-1']


def test_a_head_write_in_a_treebank_with_no_enhanced_rows_stages_none(ws):
    run(ws, 'set_head', document='Viaje', ref='s1.w5', head=4, deprel='punct')
    assert ws.ops[0]['suppressor_ids'] == []


def test_read_document_takes_a_range(ws):
    out = run(ws, 'read_document', document='Viaje', from_sentence=2)
    assert '# sent_id = s2' in out and '# sent_id = s1' not in out


def test_an_unknown_document_lists_the_ones_there_are(ws):
    assert 'No document "Nope"' in run(ws, 'read_document', document='Nope')


# --- planning an annotation ----------------------------------------------------

def test_set_field_plans_one_op_per_word(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    assert 'Planned lemma = "correr" on 1 word(s): s2.w1' in out
    assert ws.ops[0]['kind'] == 'set_span' and ws.ops[0]['layer_id'] == LEMMA
    assert ws.ops[0]['span_id'] is None          # s2 has no lemma spans yet
    assert ws.ops[0]['value'] == 'correr' and ws.ops[0]['ref'] == 's2.w1'


def test_setting_the_same_field_twice_replaces_the_first_plan_and_says_so(ws):
    """The model asked for two changes and is getting one, so the reply says
    which. The count is a watermark: it is reported once and not again, and a
    tool that stages through another tool does not take the report with it."""
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='NOUN')
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VERB')
    assert len(ws.ops) == 1 and ws.ops[0]['value'] == 'VERB' and ws.replaced == 1
    assert '1 earlier planned change on the same target superseded' in out
    # Reported once.
    assert 'superseded' not in run(ws, 'set_field', document='Viaje', refs=['s2.w2'],
                                   field='upos', value='NOUN')
    # Two at once read as two.
    run(ws, 'set_field', document='Viaje', refs=['s2.w1', 's2.w2'], field='upos', value='ADJ')
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1', 's2.w2'], field='upos', value='NOUN')
    assert '2 earlier planned changes on the same targets superseded' in out
    # A read tool never carries it.
    assert 'superseded' not in run(ws, 'read_document', document='Viaje')


def test_a_closed_list_refuses_a_value_it_does_not_list():
    """R1-DEBT-CORE-4: the rule is the one stored on the layer, as the server
    enforces it, for UPOS and XPOS as for a head's deprel and a replace."""
    ws = _closed_ws(['VERB', 'NOUN', 'ADP', 'DET', 'PUNCT'], deprel_values=['root', 'case', 'nsubj', 'obl'])
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VRB')
    assert '"VRB" is not on the list upos is held to' in out and not ws.ops
    out = run(ws, 'set_head', document='Viaje', ref='s1.w2', head=1, deprel='foo')
    assert '"foo" is not on the list deprel is held to' in out and not ws.ops
    # Only its first part is held to the list.
    assert run(ws, 'set_head', document='Viaje', ref='s1.w2', head=1, deprel='nsubj:pass').startswith('Planned')
    # A replace, staged as one scope and found again at approval, is asked
    # as it is planned (it never was for deprel).
    _engine_rows(ws, [('r-3', 'obl', 'ud1', 'uw-4')])
    out = run(ws, 'replace_in_field', field='deprel', pattern='obl', replacement='foo')
    assert '"foo" is not on the list deprel is held to' in out and len(ws.ops) == 1


def test_a_head_that_would_close_a_cycle_is_refused():
    """R1-DEBT-CORE-4: a basic tree holds no cycle (plaid-ud declares it on
    the layer), and an approved plan with one failed whole."""
    ws = _closed_ws(['VERB', 'NOUN', 'ADP', 'DET', 'PUNCT'], acyclic=True)
    s1 = ws.doc('Viaje').sentences[0]
    w4 = s1.word(4)
    head = s1.word(w4.head)
    assert head is not None and head.index != 4
    # w4 hangs below its head, so that head cannot hang below w4
    out = run(ws, 'set_head', document='Viaje', ref=f's1.w{head.index}', head=4, deprel='obl')
    assert 'cycle' in out and not ws.ops
    # once w4 is the root, its old head can hang below it: one call, which
    # names where the old root goes, since a sentence has one root
    assert head.head == 0
    out = run(ws, 'set_head', document='Viaje', ref='s1.w4', head=0, old_root_head=4, old_root_deprel='obl')
    assert out.startswith('Planned') and [op['kind'] for op in ws.ops] == ['set_head', 'set_head']


def test_an_open_list_takes_anything(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VRB')
    assert out.startswith('Planned') and ws.ops


def test_an_open_vocabulary_takes_anything(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='xpos', value='vmip3s0')
    assert out.startswith('Planned') and ws.ops


def test_a_sentence_reference_says_to_name_a_word(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s1'], field='lemma', value='x')
    assert 'is a sentence' in out and 'an annotation sits on a word' in out


def test_a_multi_word_token_reference_names_its_words(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w2-3'], field='lemma', value='x')
    assert 'carries no annotation of its own' in out


# --- planning a dependency ------------------------------------------------------

def test_set_head_plans_a_relation(ws):
    out = run(ws, 'set_head', document='Viaje', ref='s2.w2', head=1, deprel='punct')
    assert 'Planned s2.w2 (".") as punct of word 1 ("Corre").' == out
    op = ws.ops[0]
    assert op['kind'] == 'set_head' and op['relation_layer_id'] == DEPREL
    assert op['lemma_span_id'] is None and op['head_lemma_span_id'] is None
    assert op['relation_id'] is None


def test_set_head_carries_the_existing_lemma_spans_and_relation(ws):
    run(ws, 'set_head', document='Viaje', ref='s1.w4', head=1, deprel='obj')
    op = ws.ops[0]
    assert op['lemma_span_id'] == 'sp-l3' and op['head_lemma_span_id'] == 'sp-l1'
    assert op['relation_id'] == 'r-3'          # the obl it replaces


def test_head_zero_is_the_root(ws):
    out = run(ws, 'set_head', document='Viaje', ref='s2.w1', head=0)
    assert 'as the root of s2' in out and ws.ops[0]['deprel'] == 'root'


def test_the_root_deprel_and_head_zero_go_together(ws):
    assert 'whose deprel is "root"' in run(ws, 'set_head', document='Viaje', ref='s2.w1',
                                           head=0, deprel='nsubj')
    assert 'belongs to head 0' in run(ws, 'set_head', document='Viaje', ref='s2.w2',
                                      head=1, deprel='root')
    assert not ws.ops


def test_a_head_outside_the_sentence_is_refused(ws):
    assert 'has no word 9' in run(ws, 'set_head', document='Viaje', ref='s2.w1', head=9, deprel='obj')
    assert 'cannot be its own head' in run(ws, 'set_head', document='Viaje', ref='s2.w1',
                                           head=1, deprel='obj')


def test_a_plan_never_confirms_what_it_deletes(ws):
    """Clearing a wrong machine value and confirming the document is one
    gesture a model reaches for, and the value being cleared is machine-made
    and unconfirmed, which is exactly what the confirmation reaches for too.
    Both ops named the same span: the delete goes first, the patch 404s, and
    the batch they share is atomic, so the plan refused itself after the user
    had approved it.

    A change made by name beats one a whole-document review finds, so the
    confirmation of that span is never staged at all: the review is a
    predicate, resolved against the document when the plan is applied. The
    card counted that confirmation, so the applied message says it went and
    why."""
    assert 'cleared' in run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='')
    assert 'confirming 1' in run(ws, 'confirm', document='Viaje')
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert ws.client.batches[0] == [('spans.delete', 'sp-u3')]
    assert 'the plan deletes what it confirms' in ' '.join(counts.get('notes') or [])
    assert counts['cleared values'] == 1


def test_a_confirmation_and_a_discard_of_one_document_refuse_each_other(ws):
    """Both are predicates over the whole document, resolved only when the
    plan is applied, so which values they have in common is not knowable while
    the plan is being built. They used to be staged together and shown on one
    card, and the confirmations were dropped afterwards."""
    assert 'confirming' in run(ws, 'confirm', document='Viaje')
    out = run(ws, 'discard_predictions', document='Viaje')
    assert 'throws values away' in out and 'drop_planned' in out
    assert [op['kind'] for op in ws.ops] == ['confirm_scope']
    # And the other way round.
    ws.ops.clear()
    assert 'discarding' in run(ws, 'discard_predictions', document='Viaje')
    assert 'throws values away' in run(ws, 'confirm', document='Viaje')
    assert [op['kind'] for op in ws.ops] == ['discard_scope']
    # Named on both sides, where the span IS known: refused by id, both orders.
    ws.ops.clear()
    assert 'Planned' in run(ws, 'discard_predictions', document='Viaje', refs=['s1.w4'])
    assert 'writes to something this plan deletes' in run(
        ws, 'confirm', document='Viaje', refs=['s1.w4'], field='upos')
    ws.ops.clear()
    assert 'Planned' in run(ws, 'confirm', document='Viaje', refs=['s1.w4'], field='upos')
    assert 'writes to something this plan deletes' in run(
        ws, 'discard_predictions', document='Viaje', refs=['s1.w4'])


def test_a_refused_batch_leaves_nothing_behind():
    """A tool naming several words where the plan deletes one of them stages
    none of them. Staged op by op it left the others behind, so the user would
    have approved a change the model never said it had planned."""
    from ud_fixtures import FakeClient, document_raw, project_raw
    raw = document_raw()
    # Two machine UPOS values waiting for review, so the confirmation below is
    # a batch of two rather than one.
    upos = [sl for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == UPOS][0]
    upos['spans'][0]['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = FakeClient(project=project_raw(), documents={'ud1': raw})
    ws = Workspace(client, load_project(client, PID))
    assert 'Planned' in run(ws, 'discard_predictions', document='Viaje', refs=['s1.w4'], field='upos')
    out = run(ws, 'confirm', document='Viaje', refs=['s1.w1', 's1.w4'], field='upos')
    assert 'writes to something this plan deletes' in out
    assert [op['kind'] for op in ws.ops] == ['set_span']


def test_a_confirmation_and_a_delete_of_its_word_refuse_each_other(ws):
    """A confirmation names a span, and the word it sits on is named nowhere
    else, so a reshape that deletes the word takes the value with it without
    the plan being able to see it by id."""
    assert 'Planned' in run(ws, 'confirm', document='Viaje', refs=['s1.w4'], field='upos')
    out = run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['de', 'el'])
    assert 'writes to one of its words' in out
    assert [op['kind'] for op in ws.ops] == ['confirm']
    # The backstop under it, which reads the word off the confirmation itself.
    import pytest
    from plaid_agent.ud.plan import validate_ops
    reshape = {'kind': 'set_words', 'document_id': 'ud1', 'existing_word_ids': ['uw-3'],
               'forms': ['de', 'el'], 'token_id': 'ut-3', 'text_id': 'tx', 'word_layer_id': 'W',
               'form_layer_id': 'F', 'lemma_layer_id': 'L'}
    with pytest.raises(ValueError, match='annotates one of its words'):
        validate_ops([reshape, ws.ops[0]])


def test_a_head_that_is_not_a_number_reads_as_english(ws):
    """Every other argument here is a reference, so a model reaches for one
    before it reaches for a bare number, and int() answered that with its own
    error text. A number with a fraction is refused rather than truncated."""
    for bad in ('w1', 's2.w1', 'root', None, 2.7, True, [1]):
        out = run(ws, 'set_head', document='Viaje', ref='s2.w2', head=bad, deprel='punct')
        assert 'is a plain number, not a reference' in out or 'Give head:' in out, (bad, out)
    assert not ws.ops
    # A whole number in either shape still lands.
    assert 'punct of' in run(ws, 'set_head', document='Viaje', ref='s2.w2', head='1', deprel='punct')
    assert 'punct of' in run(ws, 'set_head', document='Viaje', ref='s2.w2', head=1.0, deprel='punct')


def test_del_relation_says_when_there_is_no_head_to_remove(ws):
    assert 'already have no head' in run(ws, 'del_relation', document='Viaje', refs=['s2.w1'])
    assert not ws.ops


# --- review ---------------------------------------------------------------------

def test_confirm_finds_the_one_unconfirmed_value(ws):
    out = run(ws, 'confirm', document='Viaje', refs=['s1.w4', 's1.w1'])
    assert out == 'Planned confirming 1 value(s).'
    assert ws.ops[0] == {'kind': 'confirm', 'span_id': 'sp-u3', 'relation_id': None, 'token_id': 'uw-3',
                         'document_id': 'ud1', 'label': 'confirm upos on s1.w4', 'ref': 's1.w4'}


def test_confirming_a_whole_document_is_one_scope_op_resolved_at_approval(ws):
    """A document with 1300 words and four columns is over five thousand
    spans, and a plan naming each of them was too large for the record to
    hold. The scope op costs one, and approval finds the spans again."""
    out = run(ws, 'confirm', document='Viaje')
    assert out.startswith('Planned confirming 1 value(s) in "Viaje": upos 1.')
    assert ws.ops == [{'kind': 'confirm_scope', 'document_id': 'ud1',
                       'fields': ['lemma', 'upos', 'xpos', 'features', 'deprel'],
                       'count': 1, 'per_field': {'upos': 1}, 'ref': None,
                       'label': 'confirm 1 values in "Viaje" (upos 1)'}]
    assert summarize(ws.ops) == '1 confirmation'
    payload = ws.plan_payload()
    assert payload['changes'][0]['where']['kind'] == 'document'
    counts = execute_plan(ws.client, payload['ops'], source='s', label='l', project=ws.project)
    assert counts == {'confirmations': 1}
    assert ws.client.batches[0] == [
        ('spans.bulk_update', [{'id': 'sp-u3', 'metadata': [{'op': 'set', 'path': ['provConfirmed'], 'value': True}]}])]


def test_a_scope_needs_the_project_to_read_with(ws):
    run(ws, 'confirm', document='Viaje')
    with pytest.raises(ValueError, match='needs the project'):
        execute_plan(ws.client, ws.ops, source='s', label='l')


def test_a_second_confirm_widens_the_scope_instead_of_replacing_it(ws):
    run(ws, 'confirm', document='Viaje', field='upos')
    assert ws.ops[0]['fields'] == ['upos']
    run(ws, 'confirm', document='Viaje', field='lemma')
    assert len(ws.ops) == 1 and ws.ops[0]['fields'] == ['lemma', 'upos']


def test_a_scope_and_a_reshape_of_the_same_document_cannot_share_a_plan(ws):
    run(ws, 'confirm', document='Viaje')
    assert 'changes every matching word' in run(ws, 'set_words', document='Viaje', ref='s1.w2-3',
                                                forms=['al'])
    ws.ops.clear()
    run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    assert 'changes every matching word' in run(ws, 'confirm', document='Viaje')
    # The backstop, for a plan that reached the executor anyway.
    with pytest.raises(ValueError, match='reshapes a token and'):
        execute_plan(ws.client, ws.ops + [{'kind': 'confirm_scope', 'document_id': 'ud1', 'fields': ['upos']}],
                     source='s', label='l', project=ws.project)


def test_the_plan_refuses_to_grow_past_what_a_record_holds(ws, monkeypatch):
    from plaid_agent.core import workspace
    monkeypatch.setattr(workspace, 'PLAN_MAX_OPS', 3)
    run(ws, 'set_field', document='Viaje', refs=['s1.w1', 's1.w2'], field='xpos', value='x')
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w3', 's1.w4'], field='xpos', value='x')
    assert 'more than the 3 one plan may hold' in out
    assert len(ws.ops) == 2  # nothing half staged
    # A whole document's review is one change however many values it covers.
    assert 'Planned confirming' in run(ws, 'confirm', document='Viaje')


def test_a_large_group_of_like_changes_is_stored_as_one_op(ws, monkeypatch):
    from plaid_agent.core import plan as core_plan
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 2)
    run(ws, 'set_field', document='Viaje', refs=['s1.w1', 's1.w2', 's1.w3'], field='xpos', value='x')
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='lemma', value='punto')
    payload = ws.plan_payload()
    assert len(payload['ops']) == 2 and len(payload['changes']) == 2
    group = payload['ops'][0]
    assert group['compact'] and group['count'] == 3 and group['items']['token_id'] == ['uw-1', 'uw-2a', 'uw-2b']
    assert group['label'] == 'xpos = "x" on 3 words (s1.w1, s1.w2, s1.w3)'
    assert payload['changes'][0]['where']['kind'] == 'document'
    assert payload['summary'] == '4 field values'
    assert summarize(payload['ops']) == '4 field values'
    counts = execute_plan(ws.client, payload['ops'], source='s', label='l', project=ws.project)
    assert counts == {'field values': 4}
    assert [p['args'][1] for kind, p in ws.client.batches[0] if kind == 'spans.create'] == [['uw-1'], ['uw-2a'], ['uw-2b']]
    assert ('sp-l3', 'punto') in ws.client.updates('spans')  # s1.w4 "mar" already had a lemma span


def test_confirm_says_so_when_nothing_is_waiting(ws):
    assert 'Nothing in "Viaje" is waiting for review' in run(ws, 'confirm', document='Viaje',
                                                             field='lemma')


def test_discard_predictions_clears_the_machine_value_only(ws):
    out = run(ws, 'discard_predictions', document='Viaje', refs=['s1.w4'])
    assert out == 'Planned discarding 1 unconfirmed machine value(s).'
    assert ws.ops[0]['value'] == '' and ws.ops[0]['span_id'] == 'sp-u3'


def test_discarding_a_whole_document_is_one_scope_op_that_clears_at_approval(ws):
    out = run(ws, 'discard_predictions', document='Viaje')
    assert out == ('Planned discarding 1 unconfirmed machine value(s). That is one planned change '
                   'covering the whole of "Viaje".')
    assert ws.ops[0]['kind'] == 'discard_scope' and ws.ops[0]['per_field'] == {'upos': 1}
    assert summarize(ws.ops) == '1 cleared value'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'cleared values': 1}, 'as the card counts it'
    assert ws.client.batches[0] == [('spans.delete', 'sp-u3')]


# --- the plan -------------------------------------------------------------------

def test_plan_status_numbers_the_changes_and_drop_removes_one(ws):
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VERB')
    assert '1. lemma = "correr" (s2.w1)' in run(ws, 'plan_status')
    assert run(ws, 'drop_planned', indexes=[1]) == 'Dropped 1 planned change(s). 1 remain.'
    assert 'No planned change numbered 5' in run(ws, 'drop_planned', indexes=[5])


def test_the_payload_carries_the_document_version_it_was_read_at(ws):
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    payload = ws.plan_payload()
    [doc] = payload['documents']
    assert {k: doc[k] for k in ('id', 'name', 'version')} == {'id': 'ud1', 'name': 'Viaje', 'version': 3}
    assert [s['id'] for s in doc['sentences']] == ['us-2']
    where = payload['changes'][0]['where']
    assert {k: v for k, v in where.items() if k != 'sentence_id'} == {
        'kind': 'token', 'document_id': 'ud1', 'document_name': 'Viaje', 'ref': 's2.w1',
        'sentence': 2, 'surface': 'Corre', 'word': 1}
    # The editor's deep link needs the sentence's id, not its number.
    assert where['sentence_id']
    assert payload['summary'] == '1 field value'


def test_every_declared_tool_is_a_plan_tool_or_is_not(ws):
    names = {t['function']['name'] for t in TOOLS}
    assert WRITE_TOOLS == {'add_guideline', 'revise_guideline', 'rewrite_guideline',
                           'set_field', 'set_head', 'del_relation', 'confirm',
                           'discard_predictions', 'run_parse', 'set_words',
                           'split_sentence', 'merge_sentences', 'restore_document',
                           'replace_in_field', 'add_comment', 'set_feature'}
    assert 'read_document' in names and 'read_document' not in WRITE_TOOLS


# --- applying -------------------------------------------------------------------

def test_a_head_on_an_unannotated_word_makes_its_lemma_first(ws):
    run(ws, 'set_head', document='Viaje', ref='s2.w2', head=1, deprel='punct')
    counts = execute_plan(ws.client, ws.ops, source='service:ud:assist', label='Assistant: test',
                          stamp_mode='verified')
    assert counts == {'dependencies': 1}
    # One batch: the lemma spans first, and the relation between them names
    # them by the ids they are made under.
    [batch] = ws.client.batches
    made = [p for kind, p in batch if kind == 'spans.create']
    assert [p['args'][2] for p in made] == ['.', 'Corre']     # valued with the FORM
    kind, rel = batch[-1]
    assert kind == 'relations.create' and rel['args'][3] == 'punct'
    assert (rel['args'][1], rel['args'][2]) == (made[1]['kwargs']['id'], made[0]['kwargs']['id'])


def test_replacing_a_head_deletes_the_old_relation_in_the_same_batch(ws):
    run(ws, 'set_head', document='Viaje', ref='s1.w4', head=2, deprel='obj')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    last = ws.client.batches[-1]
    assert [kind for kind, _ in last] == ['relations.delete', 'relations.create']
    assert last[0][1] == 'r-3'


def test_applying_a_field_value_stamps_it_and_counts_it(ws):
    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='lemma', value='irse')
    counts = execute_plan(ws.client, ws.ops, source='service:ud:assist', label='l',
                          stamp_mode='verified')
    assert counts == {'field values': 1}
    assert ws.client.updates('spans')[0] == ('sp-l1', 'irse')
    patch = as_fragment(ws.client.patches('spans')[0][1])
    assert patch['prov'] == 'inferred' and patch['provConfirmed'] is True


def test_a_human_approval_writes_no_provenance(ws):
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='human')
    created = ws.client.payloads('spans.create')[0]
    assert created['args'][3] == {}


def test_summarize_reads_as_a_phrase():
    assert summarize([]) == 'no changes'
    assert summarize([{'kind': 'set_span', 'value': 'X'}, {'kind': 'set_head'}]) \
        == '1 field value, 1 dependency'


# --- the corpus queries ----------------------------------------------------------
# These pin the query GRAMMAR, which is the part that is easy to get wrong and
# silently get nothing back for. What the engine does with them is checked
# against a real treebank, not here.

def test_a_span_is_joined_to_its_word_by_covers(ws):
    from plaid_agent.ud.corpus import Corpus
    c = Corpus(ws)
    where = [c.word('?t'), c.field('upos', '?u'), c.on('?u')]
    assert where == [['token', '?t', {'layer': WORD_LAYER}],
                     ['span', '?u', {'layer': UPOS}],
                     ['covers', '?u', '?t']]
    # A span clause takes only doc, layer, metadata and value: joining it to a
    # token with a `tokens` key is rejected by the engine (400).
    assert set(where[1][2]) <= {'doc', 'layer', 'metadata', 'value'}


def test_the_audit_log_the_fixture_seeds_names_this_project_s_own_document(ws):
    """The fake client used to be IGT's, with a UD project passed in, so UD's
    tests read an audit log naming a document their project does not have: a
    document-scoped read found nothing and nobody noticed."""
    named = {d['id'] for e in ws.client.audit for d in e.get('documents') or []}
    assert named <= set(ws.client._documents), named
    assert [e['id'] for e in ws.client.documents.audit('ud1')] == ['g1']
    out = run(ws, 'recent_changes', document='Viaje')
    assert 'Assistant: 2 field values' in out


def test_recent_changes_prints_the_instant_after_the_change(ws):
    """A change is a whole operation of many writes. Restoring to the instant
    it BEGAN lands in the middle of it, with some writes kept and some thrown
    away, so as_of has to be the end. IGT has printed end_time since restore
    landed and this printed the start."""
    ws.client.audit = [
        {'id': 'g1', 'time': '2026-09-01T10:00:00Z', 'end_time': '2026-09-01T10:00:03Z',
         'user': {'id': 'a@b.com', 'display_name': 'Luke G'},
         'message': 'Assistant: 4 field values', 'documents': [{'id': 'ud1', 'name': 'Viaje'}],
         'ops': [{'type': 'span/update'}]},
    ]
    out = run(ws, 'recent_changes')
    assert 'as_of=2026-09-01T10:00:03Z' in out
    assert 'as_of=2026-09-01T10:00:00Z' not in out
    assert 'moment right AFTER that change' in out


def test_a_clipped_first_read_is_still_reported_after_a_second_read(ws):
    """The form tools ask twice: the surface of every token without a Form
    span, then every Form span. The flag was read after both queries had run,
    so it was the second read's own flag compared with itself and a clipped
    first half was never reported."""
    calls = {'n': 0}

    def engine(body):
        calls['n'] += 1
        return {'return': 'aggregate', 'results': [['mar', 3]], 'truncated': calls['n'] == 1}
    ws.client.query = engine
    out = run(ws, 'frequency_list', what='form')
    assert calls['n'] >= 2, 'both halves are read'
    assert 'come from part of the corpus and not all of it' in out


def test_one_tool_does_not_inherit_another_tools_clipped_read(ws):
    """The corpus helper lives as long as the turn, so a sticky flag has to be
    forgotten between tool calls or every later report carries the warning."""
    state = {'truncated': True}

    def engine(body):
        return {'return': body.get('return'), 'columns': [], 'results': [], 'count': 0,
                'truncated': state['truncated']}
    ws.client.query = engine
    assert 'part of the corpus' in run(ws, 'frequency_list', what='lemma')
    state['truncated'] = False
    assert 'part of the corpus' not in run(ws, 'frequency_list', what='lemma')


def test_an_unconfirmed_value_is_a_negated_clause(ws):
    from plaid_agent.ud.corpus import Corpus
    c = Corpus(ws)
    assert c.unconfirmed('?s') == ['not', ['span', '?s', {'metadata': {'provConfirmed': True}}]]


def test_a_literal_pattern_is_escaped_and_a_whole_match_is_anchored():
    from plaid_agent.ud.corpus import rx
    # Written out for the server: each letter in any case, no flag.
    s = '(?:(?!)' + chr(0x10FFFF) + ')?'
    assert rx('a.b') == {'regex': r'[Aa]\x2e[Bb]' + s}
    assert rx('run', whole=True, case_sensitive=True)['regex'] == r'^(?:run)\z' + s
    assert rx('a.b', regex=True, case_sensitive=True) == {'regex': r'a[^\x0a\x0d\x{85}\x{2028}\x{2029}]b' + s}


def test_search_refuses_a_column_it_cannot_search(ws):
    out = call_tool(ws, 'search', {'field': 'head', 'pattern': 'x'})
    assert 'Unknown field "head"' in out


def test_search_refuses_a_broken_regular_expression(ws):
    out = call_tool(ws, 'search', {'field': 'lemma', 'pattern': '[', 'regex': True})
    assert 'That pattern cannot be used: Unclosed [.' in out


# --- run_parse -------------------------------------------------------------------

def _parsers(*ids):
    return [{'service_id': i, 'service_name': i.title(), 'online': True, 'tasks': ['parse']}
            for i in ids]


def test_a_connected_parser_is_found_by_the_tasks_in_its_extras(ws, monkeypatch):
    """The server lists a service's tasks inside its `extras`, as the parser
    registered them, so a connected parser must be found there. Read at the
    top level, no parser was ever found and every parse was refused."""
    from plaid_agent.ud.tools import parse_services
    listed = [
        {'service_id': 'stanza-parser', 'service_name': 'Stanza parser', 'online': True,
         'extras': {'schema_version': 1, 'tasks': ['parse']}},
        {'service_id': 'old-parser', 'service_name': 'Old parser', 'online': False,
         'extras': {'tasks': ['parse']}},
        {'service_id': 'ud:assist:m', 'service_name': 'UD Assistant', 'online': True,
         'extras': {'tasks': ['assist']}},
        {'service_id': 'bare', 'service_name': 'Bare', 'online': True},
    ]
    monkeypatch.setattr('plaid_client.services.discover_services', lambda c, pid: listed)
    assert [s['service_id'] for s in parse_services(ws)] == ['stanza-parser']


def test_run_parse_refuses_when_no_parser_is_connected(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: [])
    out = call_tool(ws, 'run_parse', {'documents': ['Viaje']})
    assert 'No parser is connected' in out and not ws.ops


def test_run_parse_asks_which_parser_when_there_are_several(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('a', 'b'))
    assert 'name one in service_id' in call_tool(ws, 'run_parse', {'documents': ['Viaje']})


def test_run_parse_plans_the_whole_document(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    out = call_tool(ws, 'run_parse', {'documents': ['Viaje']})
    assert 'Planned a parse of 1 document(s)' in out
    assert 'left alone' in out            # overwrite defaults off
    op = ws.ops[0]
    assert op['kind'] == 'run_parse' and op['document_ids'] == ['ud1']
    assert op['language'] == 'es'         # the project's own language
    assert op['service_id'] == 'stanza-parser' and op['project_id'] == PID


def test_run_parse_names_documents_without_reading_them(ws, monkeypatch):
    """The label was built by loading every named document, which on a
    corpus-sized parse is a full fetch each for a string the document list
    already holds. A document named twice is also parsed once."""
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    reads = len(ws.client.reads)
    out = call_tool(ws, 'run_parse', {'documents': ['Viaje', 'ud1', 'Viaje']})
    assert 'Planned a parse of 1 document(s)' in out and '"Viaje"' in out
    assert ws.ops[0]['document_ids'] == ['ud1']
    assert len(ws.client.reads) == reads, 'no document was read'


def test_run_parse_refuses_more_documents_than_one_plan_covers(ws, monkeypatch):
    from plaid_agent.ud.tools import MAX_SCOPE_DOCS
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    monkeypatch.setattr('plaid_agent.ud.tools.Workspace.resolve_document_id',
                        lambda self, d: str(d))
    many = [f'doc-{i}' for i in range(MAX_SCOPE_DOCS + 1)]
    assert f'more than the {MAX_SCOPE_DOCS} one plan covers' in call_tool(
        ws, 'run_parse', {'documents': many, 'language': 'es'})
    assert not ws.ops


def test_a_parse_and_an_edit_of_the_same_document_cannot_share_a_plan(ws, monkeypatch):
    """A parse rewrites the document, so the edit would be thrown away. Both
    orders are refused, and validate_ops is the backstop for either."""
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s2.w1'], 'field': 'lemma',
                                'value': 'correr'})
    assert 'would be thrown away' in call_tool(ws, 'run_parse', {'documents': ['Viaje']})
    assert len(ws.ops) == 1

    ws.ops.clear()
    call_tool(ws, 'run_parse', {'documents': ['Viaje']})
    assert 'would be thrown away' in call_tool(ws, 'set_field', {
        'document': 'Viaje', 'refs': ['s2.w1'], 'field': 'lemma', 'value': 'correr'})
    assert len(ws.ops) == 1


def test_a_parse_without_a_language_anywhere_says_so(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    ws.project.language = ''
    assert 'Give language' in call_tool(ws, 'run_parse', {'documents': ['Viaje']})


def test_applying_a_parse_asks_the_service_and_counts_it(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    call_tool(ws, 'run_parse', {'documents': ['Viaje'], 'language': 'es'})
    asked = []
    monkeypatch.setattr('plaid_client.services.request_service',
                        lambda c, pid, sid, data, **kw: asked.append((pid, sid, data, kw)))
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert counts == {'parsed documents': 1}
    pid, sid, data, kw = asked[0]
    assert (pid, sid) == (PID, 'stanza-parser')
    assert data == {'document_id': 'ud1', 'language': 'es', 'overwrite': False}
    assert kw['timeout'] == 600          # silence, not elapsed time


def test_a_parser_that_goes_quiet_is_reported_as_maybe_still_running(ws, monkeypatch):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services', lambda w: _parsers('stanza-parser'))
    call_tool(ws, 'run_parse', {'documents': ['Viaje'], 'language': 'es'})

    def timeout(*a, **k):
        raise TimeoutError()

    monkeypatch.setattr('plaid_client.services.request_service', timeout)
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert counts['notes'] == ['the parser stopped reporting on "Viaje", and may still be running']


def test_a_search_spreads_its_hits_over_several_documents():
    """The engine already said how many hits each document has, most first.
    Taking documents until the limit was full showed thirty hits from one
    blog post and called it the corpus. A few from each of several is the
    sample a corpus question wants, and loading is still capped."""
    from plaid_agent.ud.corpus import RENDER_DOC_BUDGET
    from plaid_agent.ud.stats import _spread
    docs = [('a', 20), ('b', 15), ('c', 9), ('d', 1)]
    assert list(_spread(docs, 30)) == [('a', 8), ('b', 8), ('c', 8), ('d', 1)]
    assert list(_spread(docs, 2)) == [('a', 1), ('b', 1), ('c', 1), ('d', 1)]
    many = [(str(i), 50) for i in range(40)]
    picks = _spread(many, 30)
    assert len(picks) == RENDER_DOC_BUDGET
    # Spaced down the ranked list, not the top of it: the top is the largest
    # documents, which cost the most to load and are one kind of text.
    assert picks.ids == [str(i * 40 // RENDER_DOC_BUDGET) for i in range(RENDER_DOC_BUDGET)]
    # How many documents had hits at all, which is what a read says when it
    # shows fewer.
    assert picks.documents == 40
    # A document whose count the engine did not give still gets its share.
    assert list(_spread([('a', None)], 3)) == [('a', 3)]
    assert list(_spread([], 3)) == []


def test_a_read_that_does_not_fit_says_where_to_continue(ws, monkeypatch):
    """The header promised forty sentences while the text was cut off inside
    the ninth, and the model planned its paging on the promise."""
    from plaid_agent.core import tools as core_tools
    monkeypatch.setattr(core_tools, 'RENDER_BUDGET', 420)
    out = run(ws, 'read_document', document='Viaje')
    assert 'Showing sentences 1 to 1 of the 1 to 2 asked for: the rest did not fit. Continue with from_sentence=2.' in out
    assert '# sent_id = s1' in out and '# sent_id = s2' not in out and '[truncated' not in out
    out = run(ws, 'read_document', document='Viaje', sentences=['s2', 's1'])
    assert 'Showing sentences 2. Sentences 1 did not fit' in out


def test_a_hit_is_shown_in_its_context_with_the_word_bracketed(ws):
    out = run(ws, 'search', field='upos', pattern='NOUN', document='Viaje')
    assert 's1.w4  NOUN   Vamos al [mar].' in out


def test_reading_a_document_names_it_the_way_the_user_would(ws):
    """A corpus-wide tool passes an id, and "Reading 019ed0b8-…" tells a
    watcher nothing."""
    said = []
    ws.on_progress = said.append
    ws.doc('ud1')
    assert said == ['Reading "Viaje"…']


# --- reshaping a token -----------------------------------------------------------

def test_set_words_makes_a_multi_word_token(ws):
    out = call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's2.w1',
                                      'forms': ['co', 'rre']})
    assert 'Planned "Corre" in s2 as 2 words: "co", "rre".' == out
    op = ws.ops[0]
    assert op['kind'] == 'set_words' and op['forms'] == ['co', 'rre']
    assert op['existing_word_ids'] == ['uw-5'] and op['surface'] == 'Corre'
    assert op['ref'] == 's2.w1'


def test_set_words_collapses_one_back(ws):
    out = call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w2-3', 'forms': ['al']})
    assert 'as one word' in out
    assert ws.ops[0]['existing_word_ids'] == ['uw-2a', 'uw-2b']


def test_set_words_says_what_it_discards(ws):
    """The words are deleted and remade, which cascades everything on them.
    A user approving this has to see how much goes."""
    # "Vamos" is the root (r-1) and the head of both r-3 and r-4. All three
    # hang off its lemma span and all three go, so all three are named.
    out = call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w1', 'forms': ['va', 'mos']})
    assert 'discards 3 annotation value(s) and 3 dependencies' in out


def test_a_word_reference_reaches_its_token(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w2', 'forms': ['al']})
    assert ws.ops[0]['token_id'] == 'ut-2'      # the token, not the word


def test_reshaping_and_annotating_the_same_token_cannot_share_a_plan(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w1', 'forms': ['va', 'mos']})
    out = call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma',
                                      'value': 'ir'})
    assert 'writes to one of its words' in out and len(ws.ops) == 1
    from plaid_agent.ud.plan import validate_ops
    with pytest.raises(ValueError, match='reshapes a token and annotates'):
        validate_ops(ws.ops + [{'kind': 'set_span', 'layer_id': 'l', 'token_id': 'uw-1'}])


def test_the_reshape_refusal_is_the_funnels_and_reads_the_same_in_both_orders(ws):
    """One rule, one writer. It used to have two: a pair of functions in
    tools.py that fired as the words were resolved, beside the certain-delete
    check in BaseWorkspace.add_op, so the two orders of the same plan were
    refused in different words and a tool that reached a word another way
    reached only one of them. The funnel finds the pair now and asks UD for the
    wording.
    """
    from plaid_agent.core.tools import ToolError

    run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    after = run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='NOUN')
    ws.ops.clear()
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='NOUN')
    before = run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    assert before == after
    assert 'both reshapes a token and writes to one of its words' in after

    # Straight through the funnel, with no tool in the way: the same words.
    ws.ops.clear()
    run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    with pytest.raises(ToolError, match='writes to one of its words'):
        ws.add_op({'kind': 'set_span', 'layer_id': LEMMA, 'token_id': 'uw-3', 'value': 'mare',
                   'document_id': 'ud1', 'label': 'lemma = "mare"'})


def test_the_reshape_guards_read_the_registry_not_a_kind_name(ws, monkeypatch):
    """A second kind that deletes a token's words joins every reshape guard by
    being DECLARED: `deletes_tokens` puts it in front of the certain-delete
    funnel, and the WORD_SHAPE tag puts it in front of the two refusals a
    reshape owes that name no word. Both staging guards once tested
    `kind == 'set_words'` by hand, so such a kind was refused only after the
    user had approved the plan."""
    from plaid_agent.core.opkind import OpKind
    from plaid_agent.ud import plan, tools

    monkeypatch.setitem(plan.KIND, 'recut_token', OpKind(
        'recut_token', ('recut token', 'recut tokens'), shape=plan.WORD_SHAPE,
        deletes_tokens=lambda op: list(op.get('existing_word_ids') or [])))
    monkeypatch.setattr(tools, 'RESHAPES_TOKEN', tools.RESHAPES_TOKEN + ('recut_token',))
    recut = {'kind': 'recut_token', 'document_id': 'ud1', 'token_id': 'ut-1',
             'existing_word_ids': ['uw-1'], 'label': 'recut'}

    # Annotating a word the other kind deletes.
    ws.ops.append(dict(recut))
    assert 'writes to one of its words' in call_tool(
        ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'ir'})
    assert len(ws.ops) == 1

    # And the other way round: reshaping a token the other kind already recuts.
    assert 'already reshapes this token' in call_tool(
        ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w1', 'forms': ['va', 'mos']})
    assert len(ws.ops) == 1

    # And a whole-document review of a document it recuts.
    assert 'changes every matching word' in call_tool(ws, 'confirm', {'document': 'Viaje'})
    assert len(ws.ops) == 1


def test_the_boundary_guard_reads_the_registry_table_too(ws, monkeypatch):
    """`_no_boundary_moved` listed split_sentence and merge_sentences by hand
    where RESHAPES_DOCUMENT already answers."""
    from plaid_agent.ud import tools

    monkeypatch.setattr(tools, 'RESHAPES_DOCUMENT', tools.RESHAPES_DOCUMENT + ('recut_sentences',))
    ws.ops.append({'kind': 'recut_sentences', 'document_id': 'ud1', 'label': 'recut'})
    assert 'moves a sentence boundary' in call_tool(
        ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'ir'})
    assert len(ws.ops) == 1


def test_applying_a_reshape_remakes_the_words_then_their_spans(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['co', 'rre']})
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert counts == {'reshaped tokens': 1}
    [batch] = ws.client.batches
    kinds = [kind for kind, _ in batch]
    assert kinds[:3] == ['tokens.bulk_delete', 'tokens.bulk_create', 'tokens.patch_metadata']
    # The multi-word token records its own surface, the way the editor does.
    assert batch[2][1][1] == [{'op': 'set', 'path': ['form'], 'value': 'Corre'}]
    # Then a Form and a Lemma span per word, in the same batch, each naming its
    # word by the id it is made under.
    assert kinds[3:] == ['spans.bulk_create'] * 4
    words = [row['id'] for row in batch[1][1]]
    assert [p[0]['tokens'] for _, p in batch[3:]] == [[words[k]] for k in (0, 0, 1, 1)]


def test_collapsing_to_one_word_drops_the_tokens_form(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w2-3', 'forms': ['al']})
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    patch = ws.client.patches('tokens')[0][1]
    assert patch == [{'op': 'delete', 'path': ['form']}]
    # One word spelled like its token needs no Form span, only a lemma.
    [batch] = ws.client.batches
    assert [kind for kind, _ in batch].count('spans.bulk_create') == 1


def test_a_read_can_name_the_sentences_it_wants(ws):
    """The failure this fixes: asked to plan lemmas for words a search had
    already located, the model paged a 112-sentence document nine times and ran
    out of steps before it staged anything. Naming the sentences is one call."""
    out = run(ws, 'read_document', document='Viaje', sentences=['s2'])
    assert 'Showing sentences 2.' in out
    assert 'Corre' in out and 'Vamos' not in out


def test_a_read_accepts_every_shape_a_reference_comes_in(ws):
    """A search returns "s2.w1", a read prints "2", and a person writes "s2".
    All three name the same sentence, and mixing them is not an error."""
    same = [run(ws, 'read_document', document='Viaje', sentences=s)
            for s in (['s2'], [2], ['2'], ['s2.w1'])]
    assert len(set(same)) == 1, 'the same sentence read four ways differed'
    # Duplicates collapse rather than printing the sentence twice.
    once = run(ws, 'read_document', document='Viaje', sentences=['s2', 's2.w1', 2])
    assert once == same[0]


def test_naming_a_sentence_that_is_not_one_says_so(ws):
    assert 'does not name a sentence' in run(ws, 'read_document', document='Viaje',
                                             sentences=['the second one'])


def test_naming_a_sentence_beyond_the_document_is_not_an_error(ws):
    """A model working from a stale count should get an answer, not a failure:
    the ones that exist are shown and the rest are simply absent."""
    out = run(ws, 'read_document', document='Viaje', sentences=['s1', 's99'])
    assert 'Showing sentences 1.' in out
    assert 'None of those' in run(ws, 'read_document', document='Viaje', sentences=['s99'])


def test_the_worklist_names_the_words_when_it_is_given_a_document(ws):
    """Counting is the wrong answer to "which words have no lemma". Both models
    that were asked this called worklist first, got "10 words, in this
    document", and then had no way to find the 10: one paged the document nine
    times, the other ran nine blind searches, and neither staged anything."""
    out = run(ws, 'worklist', kind='missing', field='lemma', document='Viaje')
    # A reference the plan tools accept, and the word itself so it can be read.
    assert 's2.w1' in out or 's1.w1' in out
    assert 'word(s) with none in "Viaje"' in out or 'none missing' in out

def test_the_worklist_names_the_words_for_the_review_kinds_too(ws):
    """Only `missing` listed them. Asked which values in a named document were
    unconfirmed, the answer was "1 value, in 1 document" and the name of the
    document the model had just given, which is nothing to act on."""
    out = run(ws, 'worklist', kind='unverified', field='upos', document='Viaje')
    assert 's1.w4' in out, out
    assert 'in 1 document(s)' not in out


def test_setting_a_lemma_and_a_head_together_makes_ONE_lemma_span(ws):
    """A head hangs off a lemma span, so a word with none gets one seeded from
    its form. If the same plan also SETS that word's lemma there must not be
    two: spans are read last-wins, so the second create won and the value the
    user approved became invisible to every tool, with the word reading back as
    its own form. This is the ordinary "annotate a fresh sentence" flow."""
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    run(ws, 'set_head', document='Viaje', ref='s2.w1', head=0, deprel='root')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')

    made = [p['args'] for p in ws.client.payloads('spans.create') if p['args'][0] == LEMMA]
    assert len(made) == 1, f'{len(made)} lemma spans for one word: {made}'
    assert made[0][2] == 'correr', 'the approved lemma is the one that exists'


def test_a_lemma_seeded_from_the_form_is_the_rules_not_the_approvers(ws):
    """The lemma a head needs, copied from the word's form, is stamped as the
    editor stamps it (rule:lemma-from-form), so a parse may replace it. With
    the approval's own stamp it read as verified, and a parse kept it."""
    run(ws, 'set_head', document='Viaje', ref='s2.w1', head=0, deprel='root')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    [made] = [p['args'] for p in ws.client.payloads('spans.create') if p['args'][0] == LEMMA]
    assert made[3] == {'prov': 'inferred', 'provSource': 'rule:lemma-from-form'}


def test_the_lemmas_of_new_words_are_the_rules_too(ws):
    run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified',
                 project=ws.project)
    lemmas = [e for p in ws.client.payloads('spans.bulk_create') for e in p
              if e['span_layer_id'] == LEMMA]
    assert [e['value'] for e in lemmas] == ['ma', 'r']
    assert all(e['metadata'] == {'prov': 'inferred', 'provSource': 'rule:lemma-from-form'}
               for e in lemmas)


def test_a_failed_parse_does_not_claim_that_nothing_was_written(ws, monkeypatch):
    """A plan may write to one document and parse another, so by the time the
    parser answers, earlier batches stand committed. The count was hardcoded to
    zero, and the user was told "Nothing was written" over changes that were
    in the database."""
    import plaid_client.services as services
    from plaid_agent.core.plan import PlanError

    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='lemma', value='ir')
    # A parse of a DIFFERENT document, which is the combination the tools allow.
    ws.ops.append({'kind': 'run_parse', 'document_ids': ['ud-other'], 'project_id': PID,
                   'service_id': 'stanza-parser', 'language': 'es',
                   'label': 'parse another document'})

    def refuse(*a, **kw):
        raise RuntimeError('the parser is not configured for es')

    monkeypatch.setattr(services, 'request_service', refuse)
    with pytest.raises(PlanError) as e:
        execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert e.value.applied > 0, 'the lemma batch had already committed'
    assert e.value.total == len(ws.ops)


# The corpus-wide branch of worklist goes through the query engine, which the
# fake client does not have. tests/test_live_corpus.py covers that side.


def test_a_document_with_nothing_waiting_is_told_so(ws):
    """Every field appended a "none waiting" line before the `if not out`
    check, so the check was dead and a clean document got four such lines plus
    an invitation to confirm things that are not there."""
    out = run(ws, 'worklist', kind='contributed', document='Viaje')
    assert 'Nothing is waiting for review' in out, out
    assert 'confirm marks these as reviewed' not in out


def test_clearing_a_lemma_keeps_its_span_so_the_arcs_on_it_survive(ws):
    # sp-l3 is the lemma of "mar", and three relations a person drew hang off
    # it: r-2a and r-2b with it as their head, r-3 with it as the dependent.
    # Deleting the span cascades all three. The editor nulls it instead.
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='lemma', value='')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert ws.client.payloads('spans.delete') == []
    assert ws.client.updates('spans')[0] == ('sp-l3', None)


def test_clearing_any_other_column_still_deletes_its_span(ws):
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert ws.client.payloads('spans.delete')[0] == 'sp-u3'
    assert ws.client.updates('spans') == []


def _span(obj, span_id):
    """The raw span dict with this id, wherever it sits in the document."""
    if isinstance(obj, dict):
        if obj.get('id') == span_id and 'tokens' in obj:
            return obj
        for v in obj.values():
            hit = _span(v, span_id)
            if hit:
                return hit
    elif isinstance(obj, list):
        for v in obj:
            hit = _span(v, span_id)
            if hit:
                return hit
    return None


def test_a_discard_leaves_a_machine_lemma_that_a_vouched_arc_hangs_on():
    from ud_fixtures import FakeClient, document_raw, project_raw
    raw = document_raw()
    # The parser guessed "mar", and a person then drew the three arcs that hang
    # off its lemma span. The editor leaves such a lemma alone: they were
    # reading it when they drew them.
    _span(raw, 'sp-l3')['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = FakeClient(project=project_raw(), documents={'ud1': raw})
    ws = Workspace(client, load_project(client, PID))

    out = run(ws, 'discard_predictions', document='Viaje', field='lemma')
    assert out == 'Nothing to discard: 1 machine lemma(s) here anchor arcs a person drew.'
    assert ws.ops == []


def test_a_head_or_an_index_that_is_not_a_number_reads_as_english(ws):
    # `isdigit` is true of "²" and of the digits inside "--1", so int() got
    # them and answered the model with its own error text.
    for bad in ('--1', '²', '1.0', 1.5):
        out = run(ws, 'set_head', document='Viaje', ref='s1.w4', head=bad, deprel='obj')
        assert 'is not a head' in out and 'invalid literal' not in out
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    assert 'whole numbers' in run(ws, 'drop_planned', indexes=['a'])
    # A fraction is refused, not truncated onto change 1.
    assert 'whole numbers' in run(ws, 'drop_planned', indexes=[1.5])
    assert len(ws.ops) == 1


# --- corpus-wide changes -----------------------------------------------------------

def test_the_documents_a_constraint_hits_come_back_most_first():
    """UD overrode the shared helper with a copy that dropped the sort, while
    its own docstring and both its callers said "most hits first": `_spread`
    samples evenly down a RANKED list, and worklist prints the top documents by
    count. Both were reading whatever order the engine returned."""
    from ud_fixtures import ud_client
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    ws.client.query = lambda body: {'return': 'aggregate',
                                    'results': [['low', 1], ['high', 9], ['mid', 4]]}
    assert ws.corpus.documents_with([['token', '?t', {}]], '?t') == [('high', 9), ('mid', 4), ('low', 1)]


def _engine_rows(ws, spans):
    """A fake engine answering a replace_in_field query: one span row per
    (span id, value, document, token id), the way entities come back."""
    def engine(body):
        find = body.get('find') or []
        if body.get('return') == 'entities' and find and find[0] == '?r':
            return {'return': 'entities', 'results': [[{'id': i, 'value': v, 'document': d, 'source': 'x', 'target': 'y'}]
                                                       for i, v, d, _t in spans]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [[{'id': i, 'value': v, 'document': d, 'layer': LEMMA, 'tokens': [t]},
                                                        {'id': t, 'document': d, 'begin': 0, 'end': 1}]
                                                       for i, v, d, t in spans]}
        return {'return': 'aggregate', 'results': []}
    ws.client.query = engine


def test_a_field_wide_replacement_is_one_planned_change_resolved_at_approval():
    from ud_fixtures import FakeClient, document_raw, project_raw
    other = {**document_raw(), 'id': 'other', 'name': 'Otro', 'version': 9}
    client = FakeClient(project=project_raw(), documents={'ud1': document_raw(), 'other': other})
    ws = Workspace(client, load_project(client, PID))
    _engine_rows(ws, [('sp-l1', 'ir', 'ud1', 'uw-1'), ('sp-l3', 'mar', 'ud1', 'uw-3'), ('sp-x', 'Mar', 'other', 'uw-x')])
    out = run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='mare')
    assert out.startswith('Planned 2 lemma change(s) in 2 document(s), as one planned change.')
    assert '"Viaje": lemma "mar" → "mare"' in out
    op = ws.ops[0]
    assert op['kind'] == 'replace_scope' and op['count'] == 2 and op['documents'] == ['other', 'ud1']
    # Rows with no provenance are a person's values, counted as the change is
    # staged since the scope is found again only at approval.
    assert op['label'] == ('lemma: replace "mar" with "mare" on 2 value(s) in 2 document(s), '
                           '2 of them replace accepted work')
    assert summarize(ws.ops) == '2 field values'
    # The document the preview matched without reading is pinned by version too.
    payload = ws.plan_payload()
    assert [(d['id'], d['version']) for d in payload['documents']] == [('other', 9), ('ud1', 3)]
    assert payload['changes'][0]['where'] is None
    counts = execute_plan(ws.client, payload['ops'], source='s', label='l', project=ws.project)
    assert counts == {'field values': 2}
    assert ws.client.updates('spans') == [('sp-l3', 'mare'), ('sp-x', 'mare')]


def test_a_replacement_the_pattern_leaves_unchanged_plans_nothing(ws):
    # Case is ignored by default, like search, so "MAR" matches "mar"; the
    # replacement then writes "mar" back, which is no change at all.
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3')])
    out = run(ws, 'replace_in_field', field='lemma', pattern='MAR', replacement='mar')
    assert out.startswith('Nothing to change: 1 lemma value(s) match')
    assert ws.ops == []
    out = run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='MAR')
    assert 'Planned 1 lemma change' in out


def test_a_literal_replacement_may_hold_a_backslash(ws):
    """The same cases IGT raised on, kept here so the two apps are compared
    rather than each tested against itself."""
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3')])
    assert 'Planned 1 lemma change' in run(ws, 'replace_in_field', field='lemma', pattern='mar',
                                           replacement='back\\slash')
    assert ws.ops[0]['replacement'] == 'back\\slash'
    ws.ops.clear()
    assert 'Planned 1 lemma change' in run(ws, 'replace_in_field', field='lemma', pattern='mar',
                                           replacement='x\\1y')
    ws.ops.clear()
    out = run(ws, 'replace_in_field', field='lemma', pattern='(m)(ar)', replacement=r'\2\1',
              regex=True, whole=True)
    assert 'Planned 1 lemma change' in out and '"mar" → "arm"' in out


def test_a_closed_list_refuses_what_a_replacement_would_write():
    ws = _closed_ws(['VERB', 'NOUN', 'ADP', 'DET', 'PUNCT'])
    _engine_rows(ws, [('sp-u3', 'NOUN', 'ud1', 'uw-3')])
    out = run(ws, 'replace_in_field', field='upos', pattern='NOUN', replacement='NOMEN')
    assert '"NOMEN" is not on the list upos is held to' in out and ws.ops == []


def test_a_deprel_replacement_relabels_the_relations(ws):
    _engine_rows(ws, [('r-3', 'obl', 'ud1', None)])
    out = run(ws, 'replace_in_field', field='deprel', pattern='obl', replacement='obl:arg', whole=True)
    assert 'Planned 1 deprel change' in out
    assert summarize(ws.ops) == '1 relabeled dependency'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'relabeled dependencies': 1}
    [(kind, [item])] = ws.client.batches[0]
    assert kind == 'relations.bulk_update' and (item['id'], item['value']) == ('r-3', 'obl:arg') and item['metadata']
    assert 'empty label' in run(ws, 'replace_in_field', field='deprel', pattern='obl', replacement='')


def test_a_replacement_and_a_reshape_of_a_document_it_reaches_cannot_share_a_plan(ws):
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3')])
    run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='mare')
    assert 'changes every matching word' not in run(ws, 'plan_status')
    assert 'changes every matching word' in run(ws, 'set_words', document='Viaje', ref='s1.w2-3',
                                                forms=['al'])
    ws.ops.clear()
    run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    assert 'reshapes a token' in run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='mare')


def test_a_review_over_several_documents_is_one_scope_op_each(ws):
    out = run(ws, 'confirm', documents=['Viaje', 'ud1'])
    assert out == 'Planned confirming 1 value(s), one planned change per document. In 1 document: "Viaje" 1.'
    assert [op['kind'] for op in ws.ops] == ['confirm_scope']
    ws.ops.clear()

    def engine(body):
        return {'return': 'aggregate', 'results': [['ud1', 1]]}
    ws.client.query = engine
    assert 'In 1 document: "Viaje" 1.' in run(ws, 'discard_predictions', documents=['all'])
    assert ws.ops[0]['kind'] == 'discard_scope'
    ws.client.query = lambda body: {'return': 'aggregate', 'results': []}
    ws.ops.clear()
    assert 'Nothing is waiting for review anywhere' in run(ws, 'confirm', documents='all')


@pytest.mark.parametrize('tool', ['confirm', 'discard_predictions'])
def test_a_review_over_several_documents_stages_all_of_them_or_none(tool):
    """It ran the one-document tool per document with nothing to put back, so a
    guard firing on the second document left the first one staged behind an
    `Error:`, and the user was offered a change the model had been told it
    could not make."""
    from ud_fixtures import FakeClient, document_raw, project_raw
    other = {**document_raw(), 'id': 'other', 'name': 'Otro', 'version': 9}
    client = FakeClient(project=project_raw(), documents={'ud1': document_raw(), 'other': other})
    ws = Workspace(client, load_project(client, PID))
    ws.ops.append({'kind': 'run_parse', 'document_ids': ['other'], 'project_id': PID,
                   'service_id': 'svc', 'language': 'es', 'label': 'parse "Otro"'})
    before = list(ws.ops)
    out = run(ws, tool, documents=['Viaje', 'Otro'])
    assert 'already parses "Otro"' in out, out
    assert ws.ops == before, 'the first document was left staged'
    assert (ws.replaced, ws.reported_replaced) == (0, 0)


@pytest.mark.parametrize('tool', ['confirm', 'discard_predictions'])
def test_refs_and_documents_together_are_refused(ws, tool):
    """refs are positional inside ONE document. Given both, the refs were
    dropped and the card offered whole documents: the model asked about one
    word and the user was shown a review of everything."""
    out = run(ws, tool, documents=['Viaje'], refs=['s1.w4'])
    assert out == 'Error: refs need a document'
    assert ws.ops == []
    # refs alone, with nowhere to read them, is the same request.
    assert run(ws, tool, refs=['s1.w4']) == 'Error: refs need a document'
    assert ws.ops == []


def test_every_document_with_an_unconfirmed_head_is_found():
    """A head is a relation, not a span, and the loop that finds documents
    skipped it. So confirm(documents=["all"], field="deprel") always answered
    that nothing was waiting, whatever the trees held."""
    from ud_fixtures import FakeClient, document_raw, project_raw
    raw = document_raw()
    rel = next(r for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == LEMMA
               for rl in sl['relation_layers'] for r in rl['relations'] if r['id'] == 'r-3')
    rel['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = FakeClient(project=project_raw(), documents={'ud1': raw})
    w = Workspace(client, load_project(client, PID))
    asked = []

    def engine(body):
        asked.append(body)
        return {'return': 'aggregate', 'results': [['ud1', 1]]}
    client.query = engine
    assert 'In 1 document: "Viaje" 1.' in run(w, 'confirm', documents=['all'], field='deprel')
    assert w.ops[0]['kind'] == 'confirm_scope' and w.ops[0]['fields'] == ['deprel']
    kinds = [c[0] for body in asked for c in body['where'] if isinstance(c, list)]
    assert 'relation' in kinds, 'the heads are looked for on the relation layer'


def test_the_code_tool_is_withheld_where_code_cannot_run(ws, monkeypatch):
    """A model is never told it can run code on a machine with no worker
    binary. This lived under tests/core/, importing an app from the one
    directory that must not know about any."""
    from plaid_agent.core import sandbox
    from plaid_agent.ud import toolkit
    monkeypatch.setattr(sandbox, 'available', lambda: 'no worker here')
    names = {t['function']['name'] for t in toolkit.tools_for(ws)}
    assert 'run_code' not in names and 'code_help' not in names
    assert 'Code cannot run on this assistant' in run(ws, 'run_code', code='1')


def test_a_comment_owes_the_same_refusals_as_every_other_edit(ws, monkeypatch):
    """A comment is anchored on a sentence TOKEN, so a parse or a boundary
    move in the same plan deletes the thing it hangs on. This had one of the
    three guards its siblings share."""
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services',
                        lambda w: [{'service_id': 'p', 'service_name': 'P', 'online': True,
                                    'tasks': ['parse']}])
    run(ws, 'run_parse', documents=['Viaje'])
    out = run(ws, 'add_comment', document='Viaje', ref='s1', body='Is "al" right here?')
    assert 'would be thrown away' in out
    assert len(ws.ops) == 1


def test_the_worklist_sees_unconfirmed_dependencies(ws):
    """The four span columns were the only ones the worklist walked, so a
    document whose parser output was confirmed except for the tree said
    nothing was waiting, while confirm and discard_predictions saw the tree."""
    from ud_fixtures import FakeClient, document_raw, project_raw
    raw = document_raw()
    rel = next(r for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == LEMMA
               for rl in sl['relation_layers'] for r in rl['relations'] if r['id'] == 'r-3')
    rel['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = FakeClient(project=project_raw(), documents={'ud1': raw})
    w = Workspace(client, load_project(client, PID))
    out = run(w, 'worklist', kind='unverified', document='Viaje', field='deprel')
    assert 'deprel: 1 unconfirmed machine value(s) in "Viaje"' in out and 's1.w4  obl' in out
    out = run(w, 'worklist', kind='missing', document='Viaje', field='deprel')
    assert 'deprel: 2 word(s) with none in "Viaje"' in out  # s2.w1 and s2.w2 have no head


def test_a_comment_is_a_plan_op_on_a_sentence_or_the_document(ws):
    out = run(ws, 'add_comment', document='Viaje', ref='s1', body='Is "al" right here?')
    assert out == 'Planned a comment on s1 of "Viaje".'
    op = ws.ops[0]
    assert op['kind'] == 'add_comment' and op['entity_type'] == 'token' and op['entity_id'] == 'us-1'
    assert op['anchor_label'].startswith('s1: Vamos al mar.')
    assert 'is not a sentence' in run(ws, 'add_comment', document='Viaje', ref='s1.w2', body='x')
    run(ws, 'add_comment', document='Viaje', body='Whole document note')
    assert ws.ops[1]['entity_type'] == 'document' and ws.ops[1]['ref'] is None
    assert summarize(ws.ops) == '2 comments'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'comments': 2}
    kind, first = ws.client.batches[0][0]
    assert kind == 'comments.create' and first['args'][:2] == ('token', 'us-1')


def test_search_matches_case_only_when_asked(ws):
    assert 's1.w1' in run(ws, 'search', field='form', pattern='vamos', document='Viaje')
    assert run(ws, 'search', field='form', pattern='vamos', document='Viaje', case_sensitive=True).startswith('No form')
    assert 's1.w1' in run(ws, 'search', field='form', pattern='Vamos', document='Viaje', case_sensitive=True)



def test_set_feature_writes_the_one_span_holding_that_feature(ws):
    """Each feature is a span of its own, as the app writes them (H4-UD-3).
    s1.w1 holds Number=Plur (sp-x1) and Mood=Ind (sp-x2). The assistant wrote
    a joined bundle into whichever span it read last, so the word ended up with
    Number=Plur and Number=Sing at once."""
    out = run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Gender', value='Masc')
    assert out == 'Planned Gender=Masc on 1 word(s): s1.w1'
    assert ws.ops[0]['span_id'] is None and ws.ops[0]['value'] == 'Gender=Masc'
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Number', value='Sing')
    assert len(ws.ops) == 2
    assert ws.ops[1]['span_id'] == 'sp-x1' and ws.ops[1]['value'] == 'Number=Sing'
    # A second edit of the same feature in the turn replaces the first.
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Number', value='Dual')
    assert len(ws.ops) == 2 and ws.ops[1]['value'] == 'Number=Dual'
    assert 'already set' in run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Number', value='Dual')
    # Removing a feature only the plan adds drops the planned add.
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Gender', value='')
    assert [op['value'] for op in ws.ops] == ['Number=Dual']
    # Removing a stored one deletes its span, and leaves the others alone.
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Mood', value='')
    assert ws.ops[-1]['span_id'] == 'sp-x2' and ws.ops[-1]['value'] == ''
    assert 'Give feature' in run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Number=Sing')
    assert 'one value' in run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Number', value='Sing|Plur')
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert ws.client.updates('spans') == [('sp-x1', 'Number=Dual')]
    assert ws.client.payloads('spans.delete') == ['sp-x2']
    assert not [p for p in ws.client.payloads('spans.create')]


def test_a_read_shows_every_feature_of_a_word(ws):
    out = run(ws, 'read_document', document='Viaje')
    assert 'Mood=Ind|Number=Plur' in out


def test_set_field_on_features_writes_each_pair_as_its_own_span(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w1', 's1.w4'], field='features',
              value='Number=Plur | Case=Nom')
    assert out == 'Planned features = "Case=Nom|Number=Plur" on 2 word(s): s1.w1, s1.w4'
    by_word = {}
    for op in ws.ops:
        by_word.setdefault(op['token_id'], []).append((op['span_id'], op['value']))
    # s1.w1 keeps Number=Plur as it is, loses Mood, gains Case.
    assert sorted(by_word['uw-1'], key=str) == sorted([(None, 'Case=Nom'), ('sp-x2', '')], key=str)
    assert sorted(by_word['uw-3'], key=str) == sorted([(None, 'Case=Nom'), (None, 'Number=Plur')], key=str)
    assert 'named twice' in run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features',
                                value='Number=Plur|Number=Sing')
    assert 'not a feature' in run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features',
                                  value='Plur')
    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features', value='')
    assert sorted((op['span_id'], op['value']) for op in ws.ops if op['token_id'] == 'uw-1') \
        == [('sp-x1', ''), ('sp-x2', '')]


def test_discarding_machine_features_takes_every_one_of_them():
    """A word's two machine-made features are two spans. Named by the word
    alone, the second discard superseded the first and one stayed."""
    from ud_fixtures import document_raw
    raw = document_raw()
    feats = next(sl for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == 'u-feats')
    for sp in feats['spans']:
        sp['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = ud_client(documents={'ud1': raw})
    w = Workspace(client, load_project(client, PID))
    run(w, 'discard_predictions', document='Viaje', refs=['s1.w1'], field='features')
    assert sorted(op['span_id'] for op in w.ops) == ['sp-x1', 'sp-x2']
    client2 = ud_client(documents={'ud1': raw})
    w2 = Workspace(client2, load_project(client2, PID))
    run(w2, 'discard_predictions', document='Viaje', field='features')
    execute_plan(w2.client, w2.ops, source='s', label='l', project=w2.project)
    assert sorted(w2.client.payloads('spans.delete')) == ['sp-x1', 'sp-x2']


def _feature_engine(ws, spans, holding=()):
    """A fake engine for a replacement over Features: span rows, and the
    words already holding a feature when asked which."""
    from ud_fixtures import FEATS

    def engine(body):
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [[{'id': i, 'value': v, 'document': 'ud1', 'layer': FEATS,
                                                        'tokens': [t]},
                                                       {'id': t, 'document': 'ud1', 'begin': 0, 'end': 1}]
                                                      for i, v, t in spans]}
        return {'return': 'aggregate', 'results': [[t, 1] for t in holding]}
    ws.client.query = engine


def test_a_replacement_over_features_leaves_one_feature_per_span(ws):
    _feature_engine(ws, [('sp-x1', 'Number=Plur', 'uw-1')])
    assert 'not one feature' in run(ws, 'replace_in_field', field='features', pattern='Number=Plur',
                                    replacement='Number=Plur|Person=1')
    _feature_engine(ws, [('sp-x2', 'Mood=Ind', 'uw-1')], holding=['uw-1'])
    assert 'a second Number' in run(ws, 'replace_in_field', field='features', pattern='Mood=Ind',
                                    replacement='Number=Sing')
    _feature_engine(ws, [('sp-x1', 'Number=Plur', 'uw-1')])
    assert run(ws, 'replace_in_field', field='features', pattern='Plur', replacement='Sing').startswith('Planned 1')
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert ws.client.updates('spans') == [('sp-x1', 'Number=Sing')]


def test_feature_bundles_across_the_corpus_are_counted_by_word(ws):
    rows = [['uw-1', 'Number=Plur', 1], ['uw-1', 'Mood=Ind', 1], ['uw-9', 'Mood=Ind', 1],
            ['uw-9', 'Number=Plur', 1], ['uw-3', 'Number=Sing', 1]]
    ws.client.query = lambda body: {'return': 'aggregate', 'results': rows}
    out = run(ws, 'frequency_list', what='feature-bundles')
    assert '2  Mood=Ind|Number=Plur' in out and '1  Number=Sing' in out


def test_a_change_made_by_name_beats_a_scope_at_approval(ws):
    """A replace previews stored values, so a set_field on the same span in
    the same plan (either order) is what the user read on the card and what
    must land."""
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='lemma', value='océano')
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3'), ('sp-l1', 'ir', 'ud1', 'uw-1')])
    run(ws, 'replace_in_field', field='lemma', pattern='[a-z]+', replacement='X', regex=True)
    execute_plan(ws.client, ws.plan_payload()['ops'], source='s', label='l', project=ws.project)
    updates = ws.client.updates('spans')
    assert ('sp-l3', 'océano') in updates and ('sp-l3', 'X') not in updates and ('sp-l1', 'X') in updates


def test_a_review_counts_two_documents_of_one_name_apart():
    """The count by document was keyed by NAME, so two documents both named
    "Viaje" read as 'In 1 document: "Viaje" 2.'. Nothing forbids the shared
    name (imports make it), so they are told apart by id."""
    import copy
    from ud_fixtures import document_raw
    twin = copy.deepcopy(document_raw())
    twin['id'] = 'ud2'
    client = ud_client(documents={'ud1': document_raw(), 'ud2': twin})
    w = Workspace(client, load_project(client, PID))
    out = run(w, 'confirm', documents=['ud1', 'ud2'])
    assert 'In 2 documents: "Viaje (ud1)" 1, "Viaje (ud2)" 1.' in out, out


def test_a_head_on_a_word_whose_old_head_a_reshape_takes_is_not_deleted_twice(ws):
    """Reshaping a token deletes its words, and the relations on them go with
    them. A new head in the same plan for a word whose old relation pointed
    at the reshaped token deleted that relation by id as well, a 404 that took
    the plan down (seen live, conc-2026-09-29 W-PY2)."""
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w4', 'forms': ['a', 'b']})
    reshape = ws.ops[-1]
    # "a" (s1.w2) hangs off "mar" (s1.w4) by r-2a, which the reshape takes.
    run(ws, 'set_head', document='Viaje', ref='s1.w2', head=1, deprel='case')
    head = ws.ops[-1]
    assert head['relation_id'] == 'r-2a' and 'r-2a' in reshape['relation_ids']
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    deleted = [p for kind, p in ws.client.writes if kind == 'relations.delete']
    assert head['relation_id'] not in deleted


def _closed_ws(upos_values, deprel_values=None, acyclic=False):
    """The fixture with a value-set rule stored on UPOS (and on the tree's
    layer), as plaid-ud declares one for a closed list, and r-3 machine-made."""
    from ud_fixtures import FakeClient, document_raw, project_raw
    proj = project_raw()
    word_layer = proj['text_layers'][0]['token_layers'][2]
    for sl in word_layer['span_layers']:
        if sl['id'] == UPOS:
            sl['constraints'] = {'ud': [{'type': 'value-set', 'values': upos_values}]}
        if sl['id'] == LEMMA and deprel_values is not None:
            sl['relation_layers'][0]['constraints'] = {'ud': [
                {'type': 'value-set', 'values': deprel_values, 'delimiters': ':', 'parts': 'first'}]}
        if sl['id'] == LEMMA and acyclic:
            rl = sl['relation_layers'][0]
            rl['constraints'] = {'ud': [*(rl.get('constraints') or {}).get('ud', []),
                                        {'type': 'acyclic', 'selfLoops': True}]}
    raw = document_raw()
    rel = next(r for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == LEMMA
               for rl in sl['relation_layers'] for r in rl['relations'] if r['id'] == 'r-3')
    rel['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
    client = FakeClient(project=proj, documents={'ud1': raw})
    return Workspace(client, load_project(client, PID))


def test_confirm_leaves_a_machine_value_off_a_closed_list_and_names_it():
    """A machine value off a closed list is exempt from it only while it is
    unreviewed, so confirming it is refused, and with it the whole batch at
    approval (REV-UD-UMR F4). It is left unconfirmed and named, as the app's
    Accept does (28534191), and the rest is confirmed."""
    ws = _closed_ws(['VERB', 'ADP', 'DET', 'PUNCT'], deprel_values=['root', 'case', 'det', 'punct'])
    out = run(ws, 'confirm', document='Viaje', refs=['s1.w4'])
    assert 'Not on the list, left unconfirmed: NOUN (upos, s1.w4), obl (deprel, s1.w4).' in out
    assert 'Nothing else to confirm' in out and ws.ops == []
    # The whole document: one scope, which says what it leaves, and at
    # approval confirms nothing off the list.
    out = run(ws, 'confirm', document='Viaje')
    assert 'Not on the list, left unconfirmed: NOUN (upos, s1.w4), obl (deprel, s1.w4).' in out
    ws2 = _closed_ws(['VERB', 'ADP', 'DET', 'PUNCT'])
    out = run(ws2, 'confirm', document='Viaje')
    assert out.startswith('Planned confirming 1 value(s)') and 'NOUN (upos, s1.w4)' in out
    assert 'off the list left unconfirmed' in ws2.ops[0]['label']
    execute_plan(ws2.client, ws2.ops, source='s', label='l', project=ws2.project)
    patched = [i for i, _ in ws2.client.patches('spans')] + [i for i, _ in ws2.client.patches('relations')]
    assert 'sp-u3' not in patched and 'r-3' in patched
    # On the list, it is confirmed as before.
    ws3 = _closed_ws(['NOUN'])
    assert run(ws3, 'confirm', document='Viaje', refs=['s1.w4']) == 'Planned confirming 2 value(s).'


def test_features_read_in_the_exports_order_by_name_case_aside(ws):
    """plaid-ud's export orders FEATS by feature name, case aside, so
    Number comes before NumType (REV-AGENT F1)."""
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='NumType', value='Card')
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='features', value='NumType=Card|Number=Sing')
    assert 'features = "Number=Sing|NumType=Card"' in out
    from plaid_agent.ud.project import Span
    w = ws.doc('Viaje').sentences[0].words[0]
    w.features.append(Span('sp-n', 'NumType=Card', None, 'u-feats'))
    assert w.value('features') == 'Mood=Ind|Number=Plur|NumType=Card'
    rows = [['uw-1', 'NumType=Card', 1], ['uw-1', 'Number=Sing', 1]]
    ws.client.query = lambda body: {'return': 'aggregate', 'results': rows}
    assert '1  Number=Sing|NumType=Card' in run(ws, 'frequency_list', what='feature-bundles')


def test_putting_back_a_stored_feature_stages_nothing(ws):
    """Removing a stored feature and then setting it back to its value staged
    a write of the span's own value, which approval stamps verified
    (REV-AGENT F3)."""
    run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Mood', value='')
    assert len(ws.ops) == 1
    out = run(ws, 'set_feature', document='Viaje', refs=['s1.w1'], feature='Mood', value='Ind')
    assert ws.ops == [] and out.startswith('Planned Mood=Ind on 1 word(s)')
    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features', value='Number=Sing')
    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features', value='Mood=Ind|Number=Plur')
    assert ws.ops == []


def test_set_field_features_underscore_clears_as_a_read_prints_it(ws):
    """A read prints "_" for a word with no features (REV-AGENT F4)."""
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='features', value='_')
    assert out.startswith('Planned features cleared')
    assert sorted((op['span_id'], op['value']) for op in ws.ops) == [('sp-x1', ''), ('sp-x2', '')]


def test_a_value_copied_back_from_a_read_is_written_without_its_mark(ws):
    """The ~ and ^ a read appends are display only (F7 ruling). A value copied
    back with its mark is written without it, per pair in FEATS, and a value
    that is only a mark is refused."""
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='PROPN~')
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr^ ')
    run(ws, 'set_field', document='Viaje', refs=['s2.w2'], field='features', value='Mood=Ind~|Number=Plur^')
    run(ws, 'set_feature', document='Viaje', refs=['s1.w4'], feature='Gender', value='Masc~')
    run(ws, 'set_head', document='Viaje', ref='s2.w2', head=1, deprel='punct~')
    values = [op.get('value') or op.get('deprel') for op in ws.ops]
    assert sorted(values) == sorted(['PROPN', 'correr', 'Mood=Ind', 'Number=Plur', 'Gender=Masc', 'punct'])
    assert 'only a review mark' in run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='xpos', value='~')
    # Only a trailing mark is a read's.
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='xpos', value='a~b')
    assert ws.ops[-1]['value'] == 'a~b'
