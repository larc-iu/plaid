"""The concept-wide attribute tool adds where missing (ruling umr-assist-where-missing).

Asked to "add :aspect where missing" on landslide-01, the tool set
``:aspect performance`` on nine nodes, five of which held a person's
``:aspect process``, and the card said one line that named none of them. Now a
node that already has the attribute is left alone unless the model passes
``overwrite``, and an overwrite says on the card what it replaces ("replacing
process on 5"). Attribute rows name the old value the way concept rows do.
"""

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.plan import resolve_scopes
from plaid_agent.umr.project import attrs_change
from plaid_agent.umr.toolkit import call_tool

# Every node of the fixture but the constants: s1b bark-01 (:aspect
# performance), s1d dog, s2r run-01, s2t thing.
EVERY = {'concept': '.', 'regex': True}


def run(ws, name, **args):
    return call_tool(ws, name, {'document': 'Story', **args})


def _resolved(client, ws):
    ops, _notes = resolve_scopes(client, ws.project, ws.plan_payload()['ops'])
    return {op['var']: op for op in ops}


def test_a_node_that_has_the_attribute_is_left_alone_by_default():
    client = umr_client()
    ws = umr_ws(client)
    out = run(ws, 'set_attribute_for_concept', rel=':aspect', value='state', **EVERY)
    assert len(ws.ops) == 1, out
    op = ws.ops[0]
    assert op['overwrite'] is False and op['count'] == 3
    assert 'replacing' not in op['label']
    # The model is told which nodes were left alone and how to change them.
    assert '1 node(s) with that concept already have :aspect' in out
    assert 's1.s1b performance' in out and 'overwrite=true' in out
    # Approval resolves the same set: s1b keeps the person's value.
    resolved = _resolved(client, ws)
    assert sorted(resolved) == ['s1d', 's2r', 's2t']


def test_an_overwrite_says_what_it_replaces_on_the_card_and_to_the_model():
    client = umr_client()
    ws = umr_ws(client)
    out = run(ws, 'set_attribute_for_concept', rel=':aspect', value='state', overwrite=True,
              **EVERY)
    op = ws.ops[0]
    assert op['overwrite'] is True and op['count'] == 4
    assert op['label'].endswith(', replacing performance on 1'), op['label']
    assert ws.plan_payload()['labels'] == [op['label']]
    assert 'replacing performance on 1' in out and 's1.s1b  (bark-01, was performance)' in out
    resolved = _resolved(client, ws)
    assert sorted(resolved) == ['s1b', 's1d', 's2r', 's2t']
    assert resolved['s1b']['attrs'] == [{'rel': ':aspect', 'value': 'state', 'order': 1}]


def test_the_replaced_values_are_counted_most_common_first():
    from plaid_agent.umr.plan import replacing_phrase

    class N:
        def __init__(self, *values):
            self.attrs = [{'rel': ':aspect', 'value': v} for v in values]

    targets = [(None, N('process'), None), (None, N('state'), None), (None, N('process'), None),
               (None, N(), None)]
    assert replacing_phrase(targets, ':aspect') == 'process on 2, state on 1'
    assert replacing_phrase([(None, N(), None)], ':aspect') == ''


def test_nothing_to_add_says_the_nodes_already_have_it():
    ws = umr_ws(umr_client())
    out = run(ws, 'set_attribute_for_concept', concept='bark-01', rel=':aspect', value='state')
    assert ws.ops == []
    assert out.startswith('Nothing to change') and 'already have :aspect' in out
    assert 'overwrite=true' in out


def test_a_removal_acts_on_the_nodes_that_have_it():
    client = umr_client()
    ws = umr_ws(client)
    run(ws, 'set_attribute_for_concept', rel=':aspect', **EVERY)
    assert ws.ops[0]['count'] == 1 and 'replacing' not in ws.ops[0]['label']
    assert sorted(_resolved(client, ws)) == ['s1b']


def test_the_tool_schema_offers_overwrite_and_says_the_default():
    from plaid_agent.umr.toolkit import TOOLS
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'set_attribute_for_concept')
    assert spec['parameters']['properties']['overwrite']['type'] == 'boolean'
    assert 'overwrite' not in spec['parameters']['required']
    assert 'keeps its value unless you pass overwrite' in spec['description']


# --- the rows name the value they replace ---------------------------------------

def test_attrs_change_names_each_attribute_that_changes():
    a = lambda rel, v: {'rel': rel, 'value': v}  # noqa: E731
    assert attrs_change([a(':aspect', 'process')], [a(':aspect', 'performance')]) \
        == ':aspect process becomes performance'
    assert attrs_change([], [a(':polarity', '-')]) == 'adds :polarity -'
    assert attrs_change([a(':mode', 'imperative')], []) == 'removes :mode imperative'
    assert attrs_change([a(':aspect', 'state'), a(':mode', 'imperative')],
                        [a(':aspect', 'activity'), a(':polarity', '-')]) \
        == ':aspect state becomes activity, adds :polarity -, removes :mode imperative'
    assert attrs_change([a(':a', '1'), a(':b', '2')], [a(':b', '2'), a(':a', '1')]) \
        == 'attributes reordered'


def test_a_single_node_row_names_the_value_it_replaces():
    ws = umr_ws(umr_client())
    run(ws, 'set_attributes', sentence=1, var='s1b', line=':aspect state')
    row = ws.plan_payload()['changes'][0]
    assert row['label'] == 's1b: :aspect performance becomes state'
    assert row['change'] == ':aspect performance becomes state'


def test_a_graph_rewrite_row_names_the_value_it_replaces():
    ws = umr_ws(umr_client())
    run(ws, 'apply_penman', sentence=1,
        text=SENTENCE_1_PENMAN.replace(':aspect performance', ':aspect state')
        .replace(':refer-number singular', ':refer-number singular\n        :polarity -'))
    labels = sorted(op['label'] for op in ws.ops)
    assert labels == ['s1b: :aspect performance becomes state', 's1d: adds :polarity -'], labels
