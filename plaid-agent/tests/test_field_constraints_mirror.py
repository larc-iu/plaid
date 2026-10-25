"""The rules the assistant predicts igt declares on a field, against igt's own
(A4-9).

``plaid_client.workflows.igt.tagsets.field_constraints`` is a copy of
plaid-igt's ``domain/igtConstraints.js`` ``fieldConstraints``, and the
assistant reads it to warn the model that core will refuse an approval
(``igt/tagsets.py``). If igt changed what a closed or mixed field declares,
that warning would go wrong with every test of the copy still green. This
runs igt's module over one case table and compares every answer. It skips
only where node cannot run.
"""

import json
import os
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_client.workflows.igt.tagsets import field_constraints

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'field_constraints_mirror.mjs')


def _field(tagset):
    return {'igt': {'tagset': tagset}}


def _project(**tagsets):
    return {'igt': {'tagsets': tagsets}}


GLOSSES = {'mode': 'closed', 'delimiters': '.-', 'values': [{'value': 'PL'}, {'value': 'SG'}]}
CASES = [
    # no tagset, and one the project no longer has
    [None, None],
    [{}, _project(g=GLOSSES)],
    [_field('gone'), _project(g=GLOSSES)],
    [_field(''), _project(g=GLOSSES)],
    [_field('  '), _project(**{'': GLOSSES})],
    # each mode, and one nobody knows
    [_field('g'), _project(g=GLOSSES)],
    [_field('g'), _project(g={**GLOSSES, 'mode': 'mixed'})],
    [_field('g'), _project(g={**GLOSSES, 'mode': 'suggest'})],
    [_field('g'), _project(g={**GLOSSES, 'mode': 'CLOSED'})],
    [_field('g'), _project(g={**GLOSSES, 'mode': None})],
    [_field('g'), _project(g={'values': GLOSSES['values']})],
    # the name read trimmed on both sides
    [_field(' g '), _project(**{' g': GLOSSES})],
    # values: trimmed, the first of a duplicate kept, a blank or non-string
    # one dropped, a record's other keys kept out of the rule
    [_field('g'), _project(g={'mode': 'closed', 'values': [
        {'value': ' PL '}, {'value': 'PL', 'description': 'plural'}, {'value': ''}, {'value': '  '},
        {'value': 3}, {'value': None}, {}, 'PL', None, {'value': 'SG', 'description': 'singular'}]})],
    [_field('g'), _project(g={'mode': 'closed', 'values': []})],
    [_field('g'), _project(g={'mode': 'closed', 'values': None})],
    [_field('g'), _project(g={'mode': 'closed', 'values': {'value': 'PL'}})],
    [_field('g'), _project(g={'mode': 'closed', 'values': [{'value': 'PL'}], 'ordered': True})],
    # delimiters: whitespace is never one
    [_field('g'), _project(g={**GLOSSES, 'delimiters': ' . : > '})],
    [_field('g'), _project(g={**GLOSSES, 'delimiters': '.\t-\n='})],
    [_field('g'), _project(g={**GLOSSES, 'delimiters': None})],
    [_field('g'), _project(g={**GLOSSES, 'delimiters': 5})],
    # the stored shapes no app writes
    [_field('g'), _project(g=None)],
    [_field('g'), _project(g=['closed'])],
    [_field('g'), {'igt': {'tagsets': ['g']}}],
    [_field('g'), {'igt': None}],
    [{'igt': {'tagset': 7}}, _project(**{'7': GLOSSES})],
]


@pytest.fixture(scope='module')
def app(tmp_path_factory):
    node = node_or_skip('the field rules mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_field_constraints_declares_what_igt_declares(app):
    assert len(app) == len(CASES)
    for (layer, project), expected in zip(CASES, app):
        assert field_constraints(layer, project) == expected, (layer, project)
