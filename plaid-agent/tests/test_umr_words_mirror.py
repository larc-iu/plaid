"""The Python twin of plaid-umr's rule for the words a node records
(``words_under``) gives the same ids as the app's ``wordsUnder``, over every
aligned node of the released samples and a few anchors made to try it. The
Draft and skeleton services record ``umr.words`` by it, the way the canvas,
Text mode and the import do, and an open cuts a node's anchor only where a
word it records was split.

``umr_words_mirror.mjs`` runs the app's side. It skips where it cannot run,
and says so. It does not skip when the two disagree.
"""

import json
import os
import subprocess
from types import SimpleNamespace

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_client.workflows.umr import words_under

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_words_mirror.mjs')
UMR = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src'))


@pytest.fixture(scope='module')
def cases():
    if not os.path.isdir(UMR):
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR words mirror runs the app's rule with it.")
    run = subprocess.run([node, RUNNER], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's words rule would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


def test_the_python_rule_records_the_words_the_app_records(cases):
    for case in cases:
        words = [SimpleNamespace(**w) for w in case['words']]
        assert words_under(case['pieces'], words) == case['ids'], case


def test_the_cases_are_ones_the_rule_is_for(cases):
    # The samples' nodes over several words, and the made-up ones.
    assert sum(1 for c in cases if len(c['ids']) > 1) >= 20
    assert any(c['ids'] == [] for c in cases)
    assert any(c['ids'] == ['a', 'b', 'c'] for c in cases)
