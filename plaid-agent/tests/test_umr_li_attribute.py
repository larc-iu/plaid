"""``:li`` and ``:list-item`` in the Python relation inventory, against
plaid-umr's ``inventory.js``: attributes whose value is the item's place in a
list as a whole number (AMR, ``-1`` for the last) or its label as a quoted
string (the UMR guidelines' ``:li "(a)"``). Decided 2026-09-28. The sets are
compared whole by ``test_umr_inventory_mirror.py``. This compares the list-item
attributes, which it does not read, and pins what the mirror's checks and the
assistant's guard say."""

import json
import os
import subprocess

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_client.workflows.umr import inventory

HERE = os.path.dirname(os.path.abspath(__file__))
JS_INVENTORY = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src', 'domain',
                                            'format', 'inventory.js'))

SCRIPT = f"""
const m = await import({json.dumps('file://' + JS_INVENTORY)});
console.log(JSON.stringify(m.LIST_ITEM_ATTRIBUTES));
"""


def test_the_list_item_attributes_are_the_apps():
    if not os.path.isfile(JS_INVENTORY):
        _skip_or_fail('needs plaid-umr beside the agent')
    exe = node_or_skip("The relation inventory mirror reads the app's inventory with it.")
    out = subprocess.run([exe, '--input-type=module', '-e', SCRIPT], capture_output=True,
                         text=True, timeout=60, check=True).stdout
    assert inventory.LIST_ITEM_ATTRIBUTES == frozenset(json.loads(out))


@pytest.mark.parametrize('rel', [':li', ':list-item'])
def test_li_and_list_item_are_attributes_not_roles(rel):
    assert rel in inventory.ATTRIBUTE_RELATIONS
    assert rel not in inventory.NODE_ROLES
    assert not inventory.edge_only(rel, 'rice')


@pytest.mark.parametrize('rel,value', [(':li', '1'), (':li', '-1'), (':li', '3'),
                                       (':li', '"(a)"'), (':list-item', '"1"'),
                                       (':list-item', '7'), ('li', '2')])
def test_a_number_or_a_quoted_label_is_taken(rel, value):
    assert inventory.attribute_value_problem(rel, value) is None
    assert inventory.list_item_problem(rel, value) is None


@pytest.mark.parametrize('rel,value', [(':li', 'first'), (':li', '1.5'),
                                       (':list-item', 'last')])
def test_anything_else_is_refused(rel, value):
    assert 'neither a number nor a quoted label' in inventory.attribute_value_problem(rel, value)


def test_other_attributes_are_not_held_to_it():
    assert inventory.list_item_problem(':mod', 'first') is None


# The assistant's guard refuses what the app's editors refuse.

from umr_fixtures import umr_client, umr_ws  # noqa: E402

from plaid_agent.umr.toolkit import call_tool  # noqa: E402


def _set(value, rel=':li'):
    ws = umr_ws(umr_client())
    out = call_tool(ws, 'set_attribute_for_concept',
                    {'document': 'Story', 'concept': 'dog', 'rel': rel, 'value': value})
    return ws, out


@pytest.mark.parametrize('value', ['1', '-1', '"(a)"'])
def test_the_assistant_plans_a_number_or_a_quoted_label_under_li(value):
    ws, out = _set(value)
    assert len(ws.ops) == 1, out


@pytest.mark.parametrize('rel,value', [(':li', 'first'), (':list-item', '1.5')])
def test_the_assistant_refuses_anything_else(rel, value):
    ws, out = _set(value, rel)
    assert ws.ops == [], out
    assert 'neither a number nor a quoted label' in out, out
