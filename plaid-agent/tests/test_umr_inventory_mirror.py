"""``plaid_client.workflows.umr.inventory`` against plaid-umr's ``inventory.js``.

The app refuses a relation outside its closed sets on every editor path, and
the assistant and the bundled services refuse the same from a Python copy of
those sets. A copy drifts silently: a relation added to the app would be one
the assistant refuses, or the other way round. This runs the app's module and
compares the sets whole.

It skips where it cannot run (no node, or plaid-umr not beside the agent), and
says so in the warnings summary too (see ``node_exe``); it does not skip when
the two disagree.
"""

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

# inventory.js imports nothing, so no node_modules are needed.
SCRIPT = f"""
const m = await import({json.dumps('file://' + JS_INVENTORY)});
console.log(JSON.stringify({{
  known: Object.keys(m.KNOWN_RELATIONS),
  attributes: Object.entries(m.KNOWN_RELATIONS).filter(([, v]) => v.type === 'attribute')
    .map(([k]) => k),
  values: Object.fromEntries(Object.entries(m.ATTRIBUTES).map(([k, v]) => [k, v.validator])
    .filter(([, v]) => v.length)),
  doc: Object.fromEntries(Object.entries(m.DOC_RELATIONS).map(([g, v]) => [g, v.validator])),
  constants: m.DOC_CONSTANTS,
}}));
"""


@pytest.fixture(scope='module')
def js():
    if not os.path.isfile(JS_INVENTORY):
        _skip_or_fail('needs plaid-umr beside the agent')
    exe = node_or_skip("The relation inventory mirror reads the app's inventory with it.")
    out = subprocess.run([exe, '--input-type=module', '-e', SCRIPT], capture_output=True,
                         text=True, timeout=60, check=True).stdout
    return json.loads(out)


def test_the_sentence_level_relations_are_the_apps(js):
    assert inventory.KNOWN_RELATIONS == frozenset(js['known'])


def test_the_document_level_relations_are_the_apps_group_by_group(js):
    assert {g: list(v) for g, v in inventory.DOC_RELATIONS.items()} == js['doc']


def test_the_constants_are_the_apps(js):
    assert list(inventory.DOC_CONSTANTS) == js['constants']


def test_the_attributes_are_the_apps(js):
    assert inventory.ATTRIBUTE_RELATIONS == frozenset(js['attributes'])


def test_the_closed_attribute_values_are_the_apps(js):
    assert {k: list(v) for k, v in inventory.ATTRIBUTE_VALUES.items()} == js['values']


def test_the_node_roles_are_the_apps_roles_that_are_not_attributes(js):
    """What the draft service and the skeleton refuse a value under."""
    roles = set(js['known']) - set(js['attributes'])
    assert inventory.NODE_ROLES == frozenset(r for r in roles if not inventory.ARG_ROLE.match(r))
    assert all(inventory.edge_only(r, 'see-01') for r in roles)
    assert not any(inventory.edge_only(r, 'see-01') for r in js['attributes'])
