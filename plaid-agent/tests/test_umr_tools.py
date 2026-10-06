"""The toolkit's reads and its document-graph writes, over the fixture."""

import pytest
from plaid_client import apply_metadata_ops

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.plan import execute_plan
from plaid_agent.umr.toolkit import TOOLS, WRITE_TOOLS, call_tool


@pytest.fixture
def client():
    return umr_client()


@pytest.fixture
def ws(client):
    return umr_ws(client)


def run(ws, name, **args):
    return call_tool(ws, name, args)


# --- reads --------------------------------------------------------------------

def test_the_overview_names_the_language_the_gloss_lines_and_the_documents(ws):
    out = run(ws, 'project_overview')
    assert 'Language: en' in out
    # The FILE's name for the line, not the config key: it is what the model
    # sees under every sentence.
    assert 'Word Gloss' in out
    assert '"Story"' in out


def test_a_read_shows_the_words_the_gloss_the_graph_and_the_alignment(ws):
    out = run(ws, 'read_document', document='Story')
    assert '1=The 2=dog 3=barked 4=.' in out
    assert 'Word Gloss (en): the dog bark.PST _' in out
    assert SENTENCE_1_PENMAN in out
    assert 's1d: 2-2' in out and 's1b: 3-3' in out
    # The document-level triple is written in the block of the LATER of its two
    # sentences, which is where the file writes it.
    assert out.index('(s2t :same-entity s1d)') > out.index('# sent_id = s2')


def test_a_read_takes_a_list_of_sentences_a_node_reference_included(ws):
    out = run(ws, 'read_document', document='Story', sentences=['s2.s2t'])
    assert 'Showing sentences 2.' in out
    assert '# sent_id = s1' not in out


def test_the_document_graph_is_grouped_and_names_each_end_by_its_sentence(ws):
    out = run(ws, 'document_graph', document='Story')
    assert 'coref (1):' in out
    assert '(s2.s2t :same-entity s1.s1d)' in out
    assert 'temporal (0):' in out


def test_find_nodes_narrows_by_the_engine_and_renders_from_the_documents(ws):
    """The corpus-wide read asks the engine which documents have hits, and
    loads only those to print them."""
    asked = []

    def engine(body):
        asked.append(body)
        return {'return': 'aggregate', 'results': [['umr1', 1]]}

    ws.client.query = engine
    out = run(ws, 'find_nodes', concept='dog')
    assert '"Story" s1.s1d  (dog)' in out
    assert asked and asked[0]['where'][0][0] == 'span'
    assert asked[0]['where'][0][2]['layer'] == 'm-concept'


def test_find_nodes_by_role_names_the_relation_it_matched(ws):
    ws.client.query = lambda body: {'return': 'aggregate', 'results': [['umr1', 2]]}
    out = run(ws, 'find_nodes', role=':ARG0')
    assert 's1.s1b  (bark-01) :ARG0 s1d' in out
    assert 's2.s2r  (run-01) :ARG0 s2t' in out


def test_find_nodes_by_attribute_reads_the_metadata_the_engine_cannot(ws):
    ws.client.query = lambda body: {'return': 'aggregate', 'results': [['umr1', 4]]}
    out = run(ws, 'find_nodes', attribute=':aspect')
    assert 's1.s1b  (bark-01) :aspect performance' in out
    assert 's1d' not in out


def test_a_corpus_read_shows_hits_from_documents_down_the_whole_corpus():
    """The engine ranks the documents with the most hits first, and those are
    the largest documents. Taking the top of that list showed the corpus as
    its twelve biggest texts; the documents are spread down the list instead,
    and each shows a few (the fault UD's search was fixed for)."""
    from umr_fixtures import document_raw
    from plaid_agent.umr.corpus import RENDER_DOC_BUDGET
    docs = {}
    for i in range(30):
        raw = document_raw()
        raw['id'], raw['name'] = f'd{i}', f'Doc {i}'
        docs[f'd{i}'] = raw
    w = umr_ws(umr_client(documents=docs))
    w.client.query = lambda body: {'return': 'aggregate',
                                   'results': [[f'd{i}', 100 - i] for i in range(30)]}
    out = run(w, 'find_nodes', concept='dog', limit=24)
    names = {line.split('"')[1] for line in out.splitlines() if line.startswith('"')}
    assert len(names) == RENDER_DOC_BUDGET
    assert not names <= {f'Doc {i}' for i in range(RENDER_DOC_BUDGET)}, \
        'the twelve with the most hits are the twelve largest documents'
    # Each document shows its share and no more.
    assert all(sum(1 for line in out.splitlines() if line.startswith(f'"{name}"')) <= 2
               for name in names)


def test_find_nodes_refuses_a_request_that_names_nothing_to_look_for(ws):
    assert 'Give concept, role or attribute' in run(ws, 'find_nodes')


def test_frequency_list_counts_through_the_engine(ws):
    ws.client.query = lambda body: {'return': 'aggregate',
                                    'results': [[':ARG0', 2], [':place', 1]]}
    out = run(ws, 'frequency_list', what='role')
    assert '2  :ARG0' in out and '1  :place' in out


def test_frequency_list_counts_attributes_by_reading_the_documents(ws):
    ws.client.query = lambda body: {'return': 'aggregate', 'results': [['umr1', 4]]}
    out = run(ws, 'frequency_list', what='attribute')
    assert ':aspect performance' in out and ':refer-number singular' in out


# --- the document graph, planned --------------------------------------------------

def test_a_triple_between_two_nodes_is_one_planned_relation(ws):
    out = run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='s2r')
    assert 'temporal' in out
    assert [op['kind'] for op in ws.ops] == ['create_triple']
    op = ws.ops[0]
    assert (op['source_span_id'], op['target_span_id']) == ('mc-b', 'mc-r')
    assert op['group'] == 'temporal'


def test_a_constant_no_triple_has_used_yet_is_made_with_it(client, ws):
    run(ws, 'add_triple', document='Story', a='author', rel=':full-affirmative', b='s1b')
    assert [op['kind'] for op in ws.ops] == ['create_node', 'create_triple']
    execute_plan(client, ws.plan_payload()['ops'], source='t', label='L', project=ws.project,
                 stamp_mode='human', contributor=None)
    made = client.payloads('spans.create')[0]
    span = made['args']
    assert span[2] == 'author'
    assert span[3]['umr'] == {'var': 'author', 'attrs': [], 'constant': True}
    relation = client.payloads('relations.create')[0]['args']
    # The span made beside it in the same batch, named by its id.
    assert relation[1] == made['kwargs']['id'] and relation[2] == 'mc-b'
    assert len(client.batches) == 1


def test_a_triple_between_two_constants_says_whose_block_writes_it(ws):
    """A constant belongs to no sentence, so a triple between two of them is
    written in the block of a sentence that names it. Without that the app has
    nowhere to draw it and the export has nowhere to write it."""
    run(ws, 'add_triple', document='Story', a='author', rel=':before',
        b='document-creation-time', sentence=2)
    op = ws.ops[-1]
    assert op['kind'] == 'create_triple'
    assert op['record_id'] == 'mr-2' and op['ref'] == 's2'
    assert 'sentences' not in op


def test_a_triple_that_is_already_there_plans_nothing(ws):
    out = run(ws, 'add_triple', document='Story', a='s2t', rel=':same-entity', b='s1d')
    assert 'Nothing to change' in out
    assert ws.ops == []


def test_an_end_that_is_neither_a_node_nor_a_constant_is_refused(ws):
    out = run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='nope')
    assert 'No node "nope"' in out
    assert ws.ops == []


def test_a_relation_without_its_colon_is_refused(ws):
    assert 'starts with a colon' in run(ws, 'add_triple', document='Story', a='s1b',
                                        rel='before', b='s2r')


def test_deleting_a_triple_names_the_relation_it_found(client, ws):
    out = run(ws, 'delete_triple', document='Story', a='s2t', rel=':same-entity', b='s1d')
    assert ':same-entity' in out
    assert ws.ops[0]['relation_id'] == 'md-1'
    execute_plan(client, ws.plan_payload()['ops'], source='t', label='L', project=ws.project,
                 stamp_mode='verified', contributor=None)
    assert 'md-1' in client.payloads('relations.delete')


def test_removing_a_triple_the_plan_already_cascades_is_refused_either_way(ws):
    """Deleting a node cascades the document-level triples on it, and a
    single relation delete of an id already gone is a 404 that takes the whole
    approved batch with it. The pair staged happily before, and which of the
    two orders failed was not something the model could know."""
    drop_s1d = {'document': 'Story', 'sentence': 1,
                'text': '(s1b / bark-01\n    :aspect performance)'}
    triple = {'document': 'Story', 'a': 's2t', 'rel': ':same-entity', 'b': 's1d'}
    call_tool(ws, 'apply_penman', drop_s1d)
    graph_ops = len(ws.ops)
    out = run(ws, 'delete_triple', **triple)
    assert 'this plan deletes' in out
    assert len(ws.ops) == graph_ops, 'the refused call stages nothing'

    ws.ops.clear()
    run(ws, 'delete_triple', **triple)
    out = call_tool(ws, 'apply_penman', drop_s1d)
    assert 'this plan deletes' in out
    assert len(ws.ops) == 1, 'and neither does the refused call in the other order'


def test_a_plan_built_some_other_way_still_refuses_a_doubly_deleted_relation():
    """The backstop under the staging guard, asked directly. It reads what the
    OTHER ops of the plan remove: subtracting an op's OWN removals from the
    whole-plan set instead took the relation id out of the comparison
    altogether, so the pair the guard exists for went through here in both
    orders."""
    from plaid_agent.umr.plan import validate_ops
    node = {'kind': 'delete_node', 'span_id': 'mc-d', 'token_ids': ['tk-d'],
            'relation_ids': ['md-1'], 'label': 'remove a node'}
    triple = {'kind': 'delete_triple', 'relation_id': 'md-1', 'label': 'remove a triple'}
    for ops in ([node, triple], [triple, node]):
        with pytest.raises(ValueError) as e:
            validate_ops(ops)
        assert 'this plan deletes what it writes to' in str(e.value)
    # Two single deletes of one relation are the same pair without the node:
    # the second is a 404 that takes the whole approved batch with it.
    with pytest.raises(ValueError):
        validate_ops([triple, {**triple, 'label': 'remove it again'}])
    # Each on its own stands: an op never clashes with its own deletion.
    validate_ops([node])
    validate_ops([triple])


# --- attributes -------------------------------------------------------------------

def test_set_attributes_replaces_the_whole_line_and_keeps_places(ws):
    run(ws, 'set_attributes', document='Story', sentence=1, var='s1b',
        line=':aspect state :polarity -')
    op = ws.ops[0]
    # :aspect was already there, so it keeps its place among the children; the
    # new one goes after everything.
    assert [(a['rel'], a['value'], a['order']) for a in op['attrs']] == [
        (':aspect', 'state', 1), (':polarity', '-', 2)]


def test_set_attributes_with_an_empty_line_removes_them_all(ws):
    run(ws, 'set_attributes', document='Story', sentence=1, var='s1d', line='')
    assert ws.ops[0]['umr_set'] == {'attrs': []}


def test_set_attributes_keeps_the_rest_of_the_node_when_it_is_applied(client, ws):
    """The op sets the attributes alone, so applying it leaves the variable,
    the root mark and the sentence record where they were. Restating the
    namespace from a stale read was how the node came out with none of them."""
    run(ws, 'set_attributes', document='Story', sentence=1, var='s1b', line=':polarity -')
    placed = ws.ops[0]['attrs']
    execute_plan(client, ws.plan_payload()['ops'], source='t', label='L', project=ws.project,
                 stamp_mode='verified', contributor=None)
    patched, ops = client.patches('spans')[0]
    assert patched == 'mc-b'
    assert [o for o in ops if o['path'][0] == 'umr'] == [
        {'op': 'set', 'path': ['umr', 'attrs'], 'value': placed}]
    before = ws.doc('Story').nodes_by_id['mc-b'].metadata
    assert apply_metadata_ops(before, ops)['umr'] == {'var': 's1b', 'root': True, 'attrs': placed}


def test_set_attributes_on_a_node_that_is_not_there_names_the_ones_that_are(ws):
    out = run(ws, 'set_attributes', document='Story', sentence=1, var='s9z', line=':aspect state')
    assert 'has no node "s9z"' in out and 's1d' in out


def test_set_attributes_plans_nothing_when_the_line_is_already_stored(ws):
    out = run(ws, 'set_attributes', document='Story', sentence=1, var='s1d',
              line=':refer-number singular')
    assert 'Nothing to change' in out
    assert ws.ops == []


def test_an_attribute_change_is_refused_on_a_sentence_the_plan_rewrites(ws):
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': SENTENCE_1_PENMAN.replace('bark-01', 'bark-02')})
    out = run(ws, 'set_attributes', document='Story', sentence=1, var='s1d', line=':polarity -')
    assert 'already replaces the graph of s1' in out
    assert len(ws.ops) == 1


def test_a_graph_is_refused_on_a_sentence_the_plan_already_changes(ws):
    """The other order of the same pair. It staged both, so the same two
    changes were a refusal one way round and a plan the other, and the graph
    had been worked out against attributes the plan was about to rewrite."""
    run(ws, 'set_attributes', document='Story', sentence=1, var='s1d', line=':polarity -')
    out = call_tool(ws, 'apply_penman',
                    {'document': 'Story', 'sentence': 1,
                     'text': SENTENCE_1_PENMAN.replace('bark-01', 'bark-02')})
    assert 'already changes s1 in "Story"' in out
    assert len(ws.ops) == 1, 'and the refused call stages none of its own changes'


# --- the plan itself ---------------------------------------------------------------

def test_the_plan_can_be_read_back_and_trimmed(ws):
    run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='s2r')
    run(ws, 'set_attributes', document='Story', sentence=1, var='s1b', line=':aspect state')
    assert '2 change(s) planned' in run(ws, 'plan_status')
    assert 'Dropped 1' in run(ws, 'drop_planned', indexes=[1])
    assert len(ws.ops) == 1
    assert 'Discarded 1' in run(ws, 'discard_plan')


def test_the_plan_card_places_every_change(ws):
    run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='s2r')
    run(ws, 'set_attributes', document='Story', sentence=2, var='s2r', line=':aspect process')
    rows = ws.plan_payload()['changes']
    assert [r['where']['kind'] for r in rows] == ['token', 'token']
    # A cross-sentence triple is filed under the LATER sentence, whose block
    # the app writes it in, not under its source's.
    assert rows[0]['where']['sentence'] == 2 and rows[0]['where']['ref'] == 's2.s2r'
    assert rows[1]['where']['surface'] == 's2r'
    assert rows[1]['where']['ref'] == 's2.s2r'


def test_a_node_row_does_not_name_its_node_twice(ws):
    """The row's place already names the node, so the change beside it drops
    the variable its label opens with. The label stays whole for the export."""
    run(ws, 'set_attributes', document='Story', sentence=2, var='s2r', line=':aspect process')
    row = ws.plan_payload()['changes'][0]
    assert row['label'] == 's2r: adds :aspect process'
    assert row['change'] == 'adds :aspect process'


def test_a_row_that_is_a_phrase_of_its_own_is_shown_whole(ws):
    run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='s2r')
    row = ws.plan_payload()['changes'][0]
    assert row['change'] is None and row['label'] == '(s1b :before s2r)'


def test_a_triple_is_placed_in_its_later_sentence_whichever_end_comes_first(ws):
    run(ws, 'add_triple', document='Story', a='s2r', rel=':after', b='s1b')
    run(ws, 'delete_triple', document='Story', a='s2t', rel=':same-entity', b='s1d')
    assert [(op['sentence'], op['ref']) for op in ws.ops] == [(2, 's2.s2r'), (2, 's2.s2t')]


def test_a_folded_group_says_what_it_does_and_names_each_node():
    """Twenty deletions used to fold into "20 changes to the graph (s3.s3a2,
    ...)", which never said they were removals or named a concept."""
    from plaid_agent.core.opkind import compact_spec
    from plaid_agent.core.plan import compact_ops
    from plaid_agent.umr.plan import KIND

    def node(i):
        return {'kind': 'delete_node', 'document_id': 'd1', 'ref': f's3.s3x{i}', 'span_id': f'sp{i}',
                'var': f's3x{i}', 'token_ids': [f't{i}'], 'relation_ids': [],
                'label': f'remove (s3x{i} / thing-{i})'}

    def concept(i):
        return {'kind': 'set_concept', 'document_id': 'd1', 'ref': f's3.s3x{i}', 'span_id': f'sp{i}',
                'var': f's3x{i}', 'concept': 'go-02', 'label': f's3x{i}: go-01 becomes go-02'}

    spec = compact_spec(KIND)
    [removed] = compact_ops([node(i) for i in range(20)], spec)
    assert removed['label'] == ('remove 20 nodes: (s3x0 / thing-0), (s3x1 / thing-1), (s3x2 / thing-2), '
                                '(s3x3 / thing-3), (s3x4 / thing-4), (s3x5 / thing-5), (s3x6 / thing-6), '
                                '(s3x7 / thing-7), … 12 more')
    [changed] = compact_ops([concept(i) for i in range(13)], spec)
    assert changed['label'].startswith('change 13 concepts: s3x0: go-01 becomes go-02, ')

    # The document-level relations a node's delete cascades are a loss the
    # canvas does not show, so the group says so once, and each node is named
    # without them. No total: a relation between two deleted nodes is on both
    # of their lines.
    cascading = [node(i) for i in range(13)]
    cascading[0]['label'] += ' and 2 document-level relations'
    cascading[5]['label'] += ' and 1 document-level relation'
    [removed] = compact_ops(cascading, spec)
    assert removed['label'].startswith('remove 13 nodes and their document-level relations: '
                                       '(s3x0 / thing-0), (s3x1 / thing-1), ')
    assert removed['label'].count('document-level') == 1


def test_what_run_code_sees_speaks_the_same_references_as_the_tools(ws):
    """Plain data, no ids: the code reaches the project through four host
    functions and can write nothing but a plan."""
    from plaid_agent.umr.sandbox import api, view

    v = view(ws.doc('Story'), ws.project)
    s = v['sentences'][0]
    assert s['ref'] == 's1' and s['words'] == ['The', 'dog', 'barked', '.']
    assert s['lines'][0]['header'] == 'Word Gloss'
    assert [n['ref'] for n in s['nodes']] == ['s1.s1d', 's1.s1b']
    assert s['relations'] == [{'source': 's1b', 'role': ':ARG0', 'target': 's1d'}]
    assert v['sentences'][1]['triples'] == [
        {'source': 's2t', 'rel': ':same-entity', 'target': 's1d', 'group': 'coref'}]
    assert sorted(api(ws)) == ['documents', 'load', 'plan', 'query']


def test_every_tool_that_plans_says_so_in_its_first_word():
    """What makes a tool a plan tool is its own description, so there is no
    second list to keep in step with the table."""
    assert 'apply_penman' in WRITE_TOOLS
    assert 'read_document' not in WRITE_TOOLS
    for t in TOOLS:
        name = t['function']['name']
        plans = t['function']['description'].startswith('PLAN:')
        assert plans == (name in WRITE_TOOLS), name
