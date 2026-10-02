"""The Python twin of plaid-umr's cycle rule (``cycle_edges``) finds the same
edges as the app's ``cycleEdges``, over every sentence graph of the released
samples and a few made to break it. The Draft service and the assistant
refuse a sentence by it, the way the canvas and Text mode refuse an edge.

``umr_cycle_mirror.mjs`` runs the app's side. It skips where it cannot run,
and says so; it does not skip when the two disagree.
"""

import json
import os
import subprocess

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_client.workflows.umr import cycle_edges
from plaid_client.workflows.umr.penman import parse_penman

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_cycle_mirror.mjs')
UMR = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src'))


@pytest.fixture(scope='module')
def cases():
    if not os.path.isdir(UMR):
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR cycle mirror runs the app's cycle rule with it.")
    run = subprocess.run([node, RUNNER], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's cycle rule would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


def test_the_python_rule_finds_the_edges_the_app_finds(cases):
    for case in cases:
        got = [list(e) for e in cycle_edges(parse_penman(case['text']))]
        assert got == case['edges'], case['text']


def test_the_cases_are_ones_the_rule_is_for(cases):
    found = [c for c in cases if c['edges']]
    # The made-up breaking graphs, and the samples' inverse-role cycles.
    assert len(found) >= 5
    assert any(c['text'].startswith('(s1a / a :quote') and not c['edges'] for c in cases)
