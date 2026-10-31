"""The Python twin of plaid-umr's reading of an alignment block
(``read_alignment``) gives the same ranges as the app's ``readAlignment``,
over every alignment block of the released samples and a few made to try it.
The assistant's apply_penman anchors a mended kept graph's new nodes by it,
the way Text mode does (``keptPieces``).

``umr_alignment_mirror.mjs`` runs the app's side. It skips where it cannot
run, and says so. It does not skip when the two disagree.
"""

import json
import os
import subprocess

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_agent.umr.diff import read_alignment

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_alignment_mirror.mjs')
UMR = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src'))


@pytest.fixture(scope='module')
def cases():
    if not os.path.isdir(UMR):
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR alignment mirror runs the app's rule with it.")
    run = subprocess.run([node, RUNNER], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's alignment rule would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


def test_the_python_rule_reads_the_ranges_the_app_reads(cases):
    for case in cases:
        mine = [[var, [list(r) for r in ranges]] for var, ranges in read_alignment(case['block']).items()]
        assert mine == case['ranges'], case


def test_the_cases_are_ones_the_rule_is_for(cases):
    # The samples' blocks, several ranges on one variable, and unaligned ones.
    assert len(cases) >= 20
    ranges = [r for c in cases for _v, r in c['ranges']]
    assert any(len(r) > 1 for r in ranges)
    assert any(r == [] for r in ranges)
