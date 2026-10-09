"""set_attributes given a role refuses it by saying a role goes through
apply_penman. The local model wrote ":actor s1a" into it several times a
run in the FX13 live check, and the answer was only "Variable 's1a' is not
defined", which says nothing about what to do instead."""

import pytest

from umr_fixtures import umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool


def _set(line):
    ws = umr_ws(umr_client())
    return ws, call_tool(ws, 'set_attributes', {'document': 'Story', 'sentence': 1, 'var': 's1d', 'line': line})


@pytest.mark.parametrize('line', [':actor s1b', ':aspect state :actor s1b', ':ARG0 s1b', ':actor-of s1b',
                                  ':possessor s9z'])
def test_a_role_is_refused_with_where_it_goes(line):
    ws, out = _set(line)
    assert ws.ops == [] and 'is a role, which joins two nodes' in out
    assert 'Nothing was planned. A role goes through apply_penman' in out


def test_an_attribute_pointing_at_a_node_says_so():
    ws, out = _set(':mod s1b')
    assert ws.ops == [] and ':mod s1b points at the node s1b' in out and 'apply_penman' in out


@pytest.mark.parametrize('line', [':polarity -', ':refer-number singular :mod "s1b"', ':mod big-one',
                                  ':possessor 3'])
def test_attributes_are_still_planned(line):
    ws, out = _set(line)
    assert ws.ops, out
