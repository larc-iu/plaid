"""``:li`` in the Python relation inventory, against plaid-umr's
``inventory.js``: an attribute that takes a whole number (decided 2026-09-28,
as in AMR, ``-1`` for the last item). The sets are compared whole by
``test_umr_inventory_mirror.py``. This compares the whole-number attributes,
which it does not read, and pins what the mirror's checks say."""

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
console.log(JSON.stringify(m.INTEGER_ATTRIBUTES));
"""


def test_the_whole_number_attributes_are_the_apps():
    if not os.path.isfile(JS_INVENTORY):
        _skip_or_fail('needs plaid-umr beside the agent')
    exe = node_or_skip("The relation inventory mirror reads the app's inventory with it.")
    out = subprocess.run([exe, '--input-type=module', '-e', SCRIPT], capture_output=True,
                         text=True, timeout=60, check=True).stdout
    assert inventory.INTEGER_ATTRIBUTES == frozenset(json.loads(out))


def test_li_is_an_attribute_not_a_role():
    assert ':li' in inventory.ATTRIBUTE_RELATIONS
    assert ':li' not in inventory.NODE_ROLES
    assert not inventory.edge_only(':li', 'rice')


@pytest.mark.parametrize('value', ['1', '-1', '3'])
def test_a_whole_number_under_li_is_taken(value):
    assert inventory.attribute_value_problem(':li', value) is None


@pytest.mark.parametrize('value', ['first', '"(a)"', '1.5'])
def test_anything_else_under_li_is_refused(value):
    assert 'not a whole number' in inventory.attribute_value_problem(':li', value)
