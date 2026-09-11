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
    assert '2-3  al' in out and 'NOUN~' in out


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


def test_del_relation_says_when_there_is_no_head_to_remove(ws):
    assert 'already have no head' in run(ws, 'del_relation', document='Viaje', refs=['s2.w1'])
    assert not ws.ops


# --- review ---------------------------------------------------------------------

def test_confirm_finds_the_one_unconfirmed_value(ws):
    out = run(ws, 'confirm', document='Viaje')
    assert out == 'Planned confirming 1 value(s).'
    assert ws.ops[0] == {'kind': 'confirm', 'span_id': 'sp-u3', 'document_id': 'ud1',
                         'label': 'confirm upos on s1.w4', 'ref': 's1.w4'}


def test_confirm_says_so_when_nothing_is_waiting(ws):
    assert 'Nothing in "Viaje" is waiting for review' in run(ws, 'confirm', document='Viaje',
                                                             field='lemma')


def test_discard_predictions_clears_the_machine_value_only(ws):
    out = run(ws, 'discard_predictions', document='Viaje')
    assert out == 'Planned discarding 1 unconfirmed machine value(s).'
    assert ws.ops[0]['value'] == '' and ws.ops[0]['span_id'] == 'sp-u3'


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
    assert payload['changes'][0]['where'] == {'document_id': 'ud1', 'document': 'Viaje',
                                              'ref': 's2.w1', 'sentence': 2}
    assert payload['summary'] == '1 field value'


def test_every_declared_tool_is_a_plan_tool_or_is_not(ws):
    names = {t['function']['name'] for t in TOOLS}
    assert WRITE_TOOLS == {'set_field', 'set_head', 'del_relation', 'confirm',
                           'discard_predictions', 'run_parse', 'set_words'}
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


def test_a_search_loads_only_the_documents_its_limit_can_need():
    """The engine already said how many hits each document has. Loading one is
    a round trip over the whole document, so taking twelve to print thirty
    hits is what made a corpus-wide question take minutes against EWT."""
    from plaid_agent.ud.stats import _enough_for
    docs = [('a', 20), ('b', 15), ('c', 9), ('d', 1)]
    assert _enough_for(docs, 30) == [('a', 20), ('b', 15)]
    assert _enough_for(docs, 5) == [('a', 20)]
    assert _enough_for(docs, 100) == docs
    # A document whose count the engine did not give still counts for one, so
    # an unknown count cannot make this loop forever over the corpus.
    assert _enough_for([('a', None)] * 50, 3) == [('a', None)] * 3


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
    out = call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w1', 'forms': ['va', 'mos']})
    assert 'discards 3 annotation value(s) and 1 dependency' in out


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
