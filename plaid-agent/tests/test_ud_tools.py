"""The UD tools, over the Spanish fixture: what they read, and what they plan."""

import pytest

from plaid_agent.ud.plan import execute_plan, summarize
from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import TOOLS, WRITE_TOOLS, Workspace, call_tool
from ud_fixtures import DEPREL, LEMMA, PID, UPOS, WORD_LAYER, ud_client


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


def test_setting_the_same_field_twice_replaces_the_first_plan(ws):
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='NOUN')
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VERB')
    assert len(ws.ops) == 1 and ws.ops[0]['value'] == 'VERB' and ws.replaced == 1


def test_a_closed_vocabulary_refuses_a_value_it_does_not_list(ws):
    out = run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='upos', value='VRB')
    assert 'not in this project\'s upos vocabulary, which is closed' in out and not ws.ops


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
    had approved it."""
    assert 'cleared' in run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='')
    assert 'confirming 1' in run(ws, 'confirm', document='Viaje')
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    calls = [(r, m, a) for r, m, a, k in ws.client.batches[0]]
    assert calls == [('spans', 'delete', ('sp-u3',))]
    assert 'the plan deletes what it confirms' in ' '.join(counts.get('notes') or [])


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
    assert ws.ops[0] == {'kind': 'confirm', 'span_id': 'sp-u3', 'relation_id': None, 'document_id': 'ud1',
                         'label': 'confirm upos on s1.w4', 'ref': 's1.w4'}


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
    calls = [(r, m, a) for r, m, a, k in ws.client.batches[0]]
    assert calls == [('spans', 'patch_metadata', ('sp-u3', {'provConfirmed': True}))]


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
    assert 'reviews every word' in run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    ws.ops.clear()
    run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    assert 'reshapes the token' in run(ws, 'confirm', document='Viaje')
    # The backstop, for a plan that reached the executor anyway.
    with pytest.raises(ValueError, match='reshapes a token and'):
        execute_plan(ws.client, ws.ops + [{'kind': 'confirm_scope', 'document_id': 'ud1', 'fields': ['upos']}],
                     source='s', label='l', project=ws.project)


def test_the_plan_refuses_to_grow_past_what_a_record_holds(ws, monkeypatch):
    from plaid_agent.ud import tools
    monkeypatch.setattr(tools, 'PLAN_MAX_OPS', 3)
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
    calls = [(m, a) for r, m, a, k in ws.client.batches[0]]
    assert [a[1] for m, a in calls if m == 'create'] == [['uw-1'], ['uw-2a'], ['uw-2b']]
    assert ('update', ('sp-l3', 'punto')) in calls  # s1.w4 "mar" already had a lemma span


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
    assert counts == {'field values': 1}
    calls = [(r, m, a) for r, m, a, k in ws.client.batches[0]]
    assert calls == [('spans', 'delete', ('sp-u3',))]


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
    assert payload['documents'] == [{'id': 'ud1', 'name': 'Viaje', 'version': 3}]
    where = payload['changes'][0]['where']
    assert {k: v for k, v in where.items() if k != 'sentence_id'} == {
        'kind': 'token', 'document_id': 'ud1', 'document_name': 'Viaje', 'ref': 's2.w1',
        'sentence': 2, 'surface': 'Corre', 'word': 1}
    # The editor's deep link needs the sentence's id, not its number.
    assert where['sentence_id']
    assert payload['summary'] == '1 field value'


def test_every_declared_tool_is_a_plan_tool_or_is_not(ws):
    names = {t['function']['name'] for t in TOOLS}
    assert WRITE_TOOLS == {'set_field', 'set_head', 'del_relation', 'confirm',
                           'discard_predictions', 'run_parse', 'set_words',
                           'split_sentence', 'merge_sentences', 'restore_document',
                           'replace_in_field', 'add_comment'}
    assert 'read_document' in names and 'read_document' not in WRITE_TOOLS


# --- applying -------------------------------------------------------------------

def test_a_head_on_an_unannotated_word_makes_its_lemma_first(ws):
    run(ws, 'set_head', document='Viaje', ref='s2.w2', head=1, deprel='punct')
    counts = execute_plan(ws.client, ws.ops, source='service:ud:assist', label='Assistant: test',
                          stamp_mode='verified')
    assert counts == {'dependencies': 1}
    # Two batches: the lemma spans first, because a relation cannot point at an
    # id made in the same batch.
    assert len(ws.client.batches) == 2
    made = [e for e in ws.client.batches[0] if e[0] == 'spans' and e[1] == 'create']
    assert [e[2][2] for e in made] == ['.', 'Corre']     # valued with the FORM
    rel = ws.client.batches[1][-1]
    assert rel[0] == 'relations' and rel[1] == 'create' and rel[2][3] == 'punct'


def test_replacing_a_head_deletes_the_old_relation_in_the_same_batch(ws):
    run(ws, 'set_head', document='Viaje', ref='s1.w4', head=1, deprel='obj')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    last = ws.client.batches[-1]
    assert [(e[0], e[1]) for e in last] == [('relations', 'delete'), ('relations', 'create')]
    assert last[0][2] == ('r-3',)


def test_applying_a_field_value_stamps_it_and_counts_it(ws):
    run(ws, 'set_field', document='Viaje', refs=['s1.w1'], field='lemma', value='irse')
    counts = execute_plan(ws.client, ws.ops, source='service:ud:assist', label='l',
                          stamp_mode='verified')
    assert counts == {'field values': 1}
    updates = ws.client.calls('spans', 'update')
    assert updates[0][2] == ('sp-l1', 'irse')
    patch = ws.client.calls('spans', 'patch_metadata')[0][2][1]
    assert patch['prov'] == 'inferred' and patch['provConfirmed'] is True


def test_a_human_approval_writes_no_provenance(ws):
    run(ws, 'set_field', document='Viaje', refs=['s2.w1'], field='lemma', value='correr')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='human')
    created = ws.client.calls('spans', 'create')[0]
    assert created[2][3] == {}


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


def test_an_unconfirmed_value_is_a_negated_clause(ws):
    from plaid_agent.ud.corpus import Corpus
    c = Corpus(ws)
    assert c.unconfirmed('?s') == ['not', ['span', '?s', {'metadata': {'provConfirmed': True}}]]


def test_a_literal_pattern_is_escaped_and_a_whole_match_is_anchored():
    from plaid_agent.ud.corpus import rx
    assert rx('a.b') == {'regex': r'a\.b', 'flags': 'i'}
    assert rx('run', whole=True)['regex'] == '^(?:run)$'
    assert rx('a.b', regex=True, case_sensitive=True) == {'regex': 'a.b'}


def test_search_refuses_a_column_it_cannot_search(ws):
    out = call_tool(ws, 'search', {'field': 'head', 'pattern': 'x'})
    assert 'Unknown field "head"' in out


def test_search_refuses_a_broken_regular_expression(ws):
    out = call_tool(ws, 'search', {'field': 'lemma', 'pattern': '[', 'regex': True})
    assert 'not a valid regular expression' in out


# --- run_parse -------------------------------------------------------------------

def _parsers(*ids):
    return [{'service_id': i, 'service_name': i.title(), 'online': True, 'tasks': ['parse']}
            for i in ids]


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
    assert counts['notes'] == ['the parser stopped reporting on ud1; it may still be running']


def test_a_search_spreads_its_hits_over_several_documents():
    """The engine already said how many hits each document has, most first.
    Taking documents until the limit was full showed thirty hits from one
    blog post and called it the corpus. A few from each of several is the
    sample a corpus question wants, and loading is still capped."""
    from plaid_agent.ud.corpus import DOCS_PER_SEARCH
    from plaid_agent.ud.stats import _spread
    docs = [('a', 20), ('b', 15), ('c', 9), ('d', 1)]
    assert _spread(docs, 30) == [('a', 8), ('b', 8), ('c', 8), ('d', 1)]
    assert _spread(docs, 2) == [('a', 1), ('b', 1), ('c', 1), ('d', 1)]
    many = [(str(i), 50) for i in range(40)]
    picks = _spread(many, 30)
    assert len(picks) == DOCS_PER_SEARCH
    # Spaced down the ranked list, not the top of it: the top is the largest
    # documents, which cost the most to load and are one kind of text.
    assert [d for d, _ in picks] == [str(i * 40 // DOCS_PER_SEARCH) for i in range(DOCS_PER_SEARCH)]
    # A document whose count the engine did not give still gets its share.
    assert _spread([('a', None)], 3) == [('a', 3)]
    assert _spread([], 3) == []


def test_a_read_that_does_not_fit_says_where_to_continue(ws, monkeypatch):
    """The header promised forty sentences while the text was cut off inside
    the ninth, and the model planned its paging on the promise."""
    from plaid_agent.ud import tools
    monkeypatch.setattr(tools, 'MAX_RESULT_CHARS', 420)
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
    assert 'already reshapes the token' in out and len(ws.ops) == 1
    from plaid_agent.ud.plan import validate_ops
    with pytest.raises(ValueError, match='reshapes a token and annotates'):
        validate_ops(ws.ops + [{'kind': 'set_span', 'layer_id': 'l', 'token_id': 'uw-1'}])


def test_applying_a_reshape_remakes_the_words_then_their_spans(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['co', 'rre']})
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert counts == {'reshaped tokens': 1}
    first, second = ws.client.batches
    kinds = [(e[0], e[1]) for e in first]
    assert kinds == [('tokens', 'bulk_delete'), ('tokens', 'bulk_create'),
                     ('tokens', 'patch_metadata')]
    # The multi-word token records its own surface, the way the editor does.
    assert first[2][2][1] == {'form': 'Corre'}
    # Then a Form and a Lemma span per word, which could not be in the first
    # batch: they name ids that batch made.
    assert [(e[0], e[1]) for e in second] == [('spans', 'bulk_create')] * 4


def test_collapsing_to_one_word_drops_the_tokens_form(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w2-3', 'forms': ['al']})
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    patch = ws.client.calls('tokens', 'patch_metadata')[0][2][1]
    assert patch == {'form': None}
    # One word spelled like its token needs no Form span, only a lemma.
    assert len(ws.client.batches[1]) == 1


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

    made = [e for e in ws.client.log
            if e[0] == 'spans' and e[1] == 'create' and e[2][0] == LEMMA]
    assert len(made) == 1, f'{len(made)} lemma spans for one word: {made}'
    assert made[0][2][2] == 'correr', 'the approved lemma is the one that exists'


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
    assert ws.client.calls('spans', 'delete') == []
    assert ws.client.calls('spans', 'update')[0][2] == ('sp-l3', None)


def test_clearing_any_other_column_still_deletes_its_span(ws):
    run(ws, 'set_field', document='Viaje', refs=['s1.w4'], field='upos', value='')
    execute_plan(ws.client, ws.ops, source='s', label='l', stamp_mode='verified')
    assert ws.client.calls('spans', 'delete')[0][2] == ('sp-u3',)
    assert ws.client.calls('spans', 'update') == []


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
    assert op['label'] == 'lemma: replace "mar" with "mare" on 2 value(s) in 2 document(s)'
    assert summarize(ws.ops) == '2 field values'
    # The document the preview matched without reading is pinned by version too.
    payload = ws.plan_payload()
    assert [(d['id'], d['version']) for d in payload['documents']] == [('other', 9), ('ud1', 3)]
    assert payload['changes'][0]['where'] is None
    counts = execute_plan(ws.client, payload['ops'], source='s', label='l', project=ws.project)
    assert counts == {'field values': 2}
    updates = [a for r, m, a, k in ws.client.batches[0] if m == 'update']
    assert updates == [('sp-l3', 'mare'), ('sp-x', 'mare')]


def test_a_replacement_the_pattern_leaves_unchanged_plans_nothing(ws):
    # Case is ignored by default, like search, so "MAR" matches "mar"; the
    # replacement then writes "mar" back, which is no change at all.
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3')])
    out = run(ws, 'replace_in_field', field='lemma', pattern='MAR', replacement='mar')
    assert out.startswith('Nothing to change: 1 lemma value(s) match')
    assert ws.ops == []
    out = run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='MAR')
    assert 'Planned 1 lemma change' in out


def test_a_closed_vocabulary_refuses_what_a_replacement_would_write(ws):
    _engine_rows(ws, [('sp-u3', 'NOUN', 'ud1', 'uw-3')])
    out = run(ws, 'replace_in_field', field='upos', pattern='NOUN', replacement='NOMEN')
    assert 'not in this project\'s upos vocabulary' in out and ws.ops == []


def test_a_deprel_replacement_relabels_the_relations(ws):
    _engine_rows(ws, [('r-3', 'obl', 'ud1', None)])
    out = run(ws, 'replace_in_field', field='deprel', pattern='obl', replacement='obl:arg', whole=True)
    assert 'Planned 1 deprel change' in out
    assert summarize(ws.ops) == '1 relabeled dependency'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'relabeled dependencies': 1}
    calls = [(m, a[:2]) for r, m, a, k in ws.client.batches[0]]
    assert calls[0] == ('update', ('r-3', 'obl:arg')) and calls[1][0] == 'patch_metadata'
    assert 'empty label' in run(ws, 'replace_in_field', field='deprel', pattern='obl', replacement='')


def test_a_replacement_and_a_reshape_of_a_document_it_reaches_cannot_share_a_plan(ws):
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3')])
    run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='mare')
    assert 'changes every matching word' not in run(ws, 'plan_status')
    assert 'reaches' in run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al']) or \
        'reviews every word' in run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    ws.ops.clear()
    run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['al'])
    assert 'reshapes a token' in run(ws, 'replace_in_field', field='lemma', pattern='mar', replacement='mare')


def test_a_review_over_several_documents_is_one_scope_op_each(ws):
    out = run(ws, 'confirm', documents=['Viaje', 'ud1'])
    assert out == 'Planned confirming 1 value(s) across 1 document(s), one planned change each: "Viaje".'
    assert [op['kind'] for op in ws.ops] == ['confirm_scope']
    ws.ops.clear()

    def engine(body):
        return {'return': 'aggregate', 'results': [['ud1', 1]]}
    ws.client.query = engine
    assert 'across 1 document(s)' in run(ws, 'discard_predictions', documents=['all'])
    assert ws.ops[0]['kind'] == 'discard_scope'
    ws.client.query = lambda body: {'return': 'aggregate', 'results': []}
    ws.ops.clear()
    assert 'Nothing is waiting for review anywhere' in run(ws, 'confirm', documents='all')


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
    from fixtures import Recorder
    ws.client.comments = Recorder(ws.client.log, 'comments')
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'comments': 2}
    calls = [(m, a) for r, m, a, k in ws.client.batches[0]]
    assert calls[0][0] == 'create' and calls[0][1][:2] == ('token', 'us-1')


def test_search_matches_case_only_when_asked(ws):
    assert 's1.w1' in run(ws, 'search', field='form', pattern='vamos', document='Viaje')
    assert run(ws, 'search', field='form', pattern='vamos', document='Viaje', case_sensitive=True).startswith('No form')
    assert 's1.w1' in run(ws, 'search', field='form', pattern='Vamos', document='Viaje', case_sensitive=True)
