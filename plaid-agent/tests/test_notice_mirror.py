"""The worker's fixed top line of a job's report (``core.job.notice``, the
owner's R4) against the job page's own (plaid-igt jobText.js ``noticeText``).

Core's own report, for a job no worker finished, carries the counts but no
``notice``, so the page builds the same line from them (REV-RPF-W-3). If one
side changed its wording the other would drift with every test of each still
green. This runs the page's function over one table of totals and compares
every line. It skips only where node cannot run.
"""

import json
import os
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.core.job import notice
from plaid_agent.igt.job import IgtRunner

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'notice_mirror.mjs')

CASES = [
    {},
    {'peoples_values_changed': 0, 'words_added': 0, 'tokens_changed': 0, 'text_changes': 0},
    {'peoples_values_changed': 1},
    {'peoples_values_changed': 33},
    {'peoples_values_changed': 1234},
    {'words_added': 1},
    {'words_added': 25, 'tokens_changed': 2},
    {'tokens_changed': 1},
    {'tokens_changed': 1, 'text_changes': 1},
    {'text_changes': 3},
    {'text_changes': 1},
    {'peoples_values_changed': 2, 'words_added': 1, 'tokens_changed': 1, 'text_changes': 1},
    {'peoples_values_changed': 5, 'text_changes': 2},
    {'peoples_values_changed': None, 'words_added': None, 'text_changes': None},
    # Documents the job's first step did not open (RPF3 round 3).
    {'documents_not_read_through': 1},
    {'documents_not_read_through': 42, 'peoples_values_changed': 33},
]


def test_the_top_line_says_the_documents_not_read_through():
    assert notice({'documents_not_read_through': 1}) == (
        "1 document was not read through: the job's first step worked on the whole selection and did not open it.")
    assert notice({'documents_not_read_through': 2}) == (
        "2 documents were not read through: the job's first step worked on the whole selection and did not open "
        'them.')


@pytest.fixture(scope='module')
def page(tmp_path_factory):
    node = node_or_skip('the report notice mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_the_page_builds_the_workers_top_line_from_the_same_counts(page):
    assert len(page) == len(CASES)
    for totals, line in zip(CASES, page):
        assert notice(totals, IgtRunner.PEOPLE_NOUNS) == line, totals
