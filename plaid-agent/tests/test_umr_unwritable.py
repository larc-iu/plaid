"""A concept, relation or value the .umr file cannot hold is refused on every
route a plan takes into the graph, as plaid-umr's editors refuse it. Stored
anyway, the app's export refuses the whole document (ruled 2026-09-27). The
set-attribute-for-concept tool used to check only that the relation began with
a colon and never looked at the value."""

import pytest

from umr_fixtures import document_raw, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr import (attr_value_problem, concept_problem,
                                        relation_form_problem, variable_form_problem)


def run(ws, name, **args):
    return call_tool(ws, name, {'document': 'Story', **args})


@pytest.fixture
def ws():
    return umr_ws(umr_client())


#: What set_attribute_for_concept would store as the value, each read back
#: from the file as something else.
BAD_VALUES = ['very big', '1) (s1z / evil', 'x\n    :ARG0 (s1x / injected)', '"open',
              'a"b', '"a\nb"']


@pytest.mark.parametrize('value', BAD_VALUES)
def test_a_value_the_file_cannot_hold_is_refused(ws, value):
    out = run(ws, 'set_attribute_for_concept', concept='dog', rel=':refer-number', value=value)
    assert ws.ops == [], out
    assert 'value' in out, out


@pytest.mark.parametrize('rel', [':mod (s1e / evil) :x', ':refer number', ':'])
def test_a_relation_the_file_cannot_hold_is_refused(ws, rel):
    out = run(ws, 'set_attribute_for_concept', concept='dog', rel=rel, value='plural')
    assert ws.ops == [], out
    assert 'relation' in out.lower(), out


def test_a_quoted_value_and_a_plain_one_are_planned(ws):
    run(ws, 'set_attribute_for_concept', concept='dog', rel=':refer-number', value='plural')
    assert len(ws.ops) == 1
    w = umr_ws(umr_client())
    run(w, 'set_attribute_for_concept', concept='dog', rel=':wiki', value='"Rex (the dog)"')
    assert len(w.ops) == 1


def test_an_attribute_edit_keeps_a_bad_value_already_stored_on_that_node():
    """The app keeps a stored value as it keeps a stored relation, so an edit
    of the node's other attributes is not refused for a value it did not
    write. The export still lists it."""
    raw = document_raw()
    dog = next(s for tl in raw['text_layers'][0]['token_layers']
               for sl in tl.get('span_layers', []) for s in sl['spans'] if s['id'] == 'mc-d')
    dog['metadata']['umr']['attrs'].append({'rel': ':mod', 'value': 'very big', 'order': 1})
    w = umr_ws(umr_client(documents={'umr1': raw}))
    node = w.doc('Story').node_named('s1d')
    assert (':mod', 'very big') in {(a['rel'], a['value']) for a in node.attrs}, 'fixture'
    from plaid_agent.umr.project import place_attributes
    attrs = place_attributes(node, [{'rel': ':refer-number', 'value': 'plural'},
                                    {'rel': ':mod', 'value': 'very big'}])
    op = {'kind': 'set_attrs', 'document_id': w.doc('Story').id, 'span_id': node.id,
          'var': 's1d', 'attrs': attrs}
    w.refuse_unwritable(op)  # no ToolError
    op['attrs'] = [{'rel': ':mod', 'value': 'even bigger', 'order': 1}]
    with pytest.raises(Exception, match='cannot hold spaces'):
        w.refuse_unwritable(op)


def test_the_checks_match_the_apps():
    assert concept_problem('big dog') and concept_problem('10:30') and concept_problem('')
    assert concept_problem('eat-01') is None and concept_problem('带-02') is None
    assert relation_form_problem('ARG0') and relation_form_problem(':ARG0 ')
    assert relation_form_problem(':ARG0-of') is None
    assert attr_value_problem('"a b: (c)"') is None and attr_value_problem('-') is None
    assert variable_form_problem('s1x2y') and variable_form_problem('a/b')
    assert variable_form_problem('x1') is None and variable_form_problem('s12ab3') is None


def test_the_checks_refuse_what_the_app_refuses():
    """Review of the port (2026-09-27): a byte order mark ends a token for the
    app's reader, and a bare value shaped like a variable reads back as an
    edge. Both passed here while the app's export refused them."""
    assert concept_problem('a﻿b') and attr_value_problem('a﻿b')
    assert variable_form_problem('s1﻿x')
    assert attr_value_problem('s2x') and attr_value_problem('s1d')
    assert attr_value_problem('"s2x"') is None and attr_value_problem('S2x') is None


def test_a_value_shaped_like_a_variable_is_refused(ws):
    out = run(ws, 'set_attribute_for_concept', concept='dog', rel=':mod', value='s2x')
    assert ws.ops == [], out
    assert 'variable' in out, out
