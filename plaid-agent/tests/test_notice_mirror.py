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
    # The whole-selection step (the lead's ruling after RP4-5).
    {'documents_in_one_step': 1, 'documents_changed_in_one_step': 1, 'documents_not_all_read': 1},
    {'documents_in_one_step': 1, 'documents_changed_in_one_step': 0, 'documents_not_all_read': 0},
    {'documents_in_one_step': 45, 'documents_changed_in_one_step': 24, 'documents_not_all_read': 45,
     'peoples_values_changed': 33},
    {'documents_in_one_step': 2, 'documents_changed_in_one_step': 0, 'documents_not_all_read': 0},
    {'documents_in_one_step': 1234, 'documents_changed_in_one_step': 1001, 'documents_not_all_read': 3},
    # REV-SF2-2: fewer than the job's documents ended in the step.
    {'documents_in_one_step': 2, 'documents_in_job': 3, 'documents_changed_in_one_step': 1},
    {'documents_in_one_step': 1, 'documents_in_job': 2, 'documents_changed_in_one_step': 1},
    {'documents_in_one_step': 1, 'documents_in_job': 2, 'documents_changed_in_one_step': 0,
     'documents_not_all_read': 1},
    {'documents_in_one_step': 3, 'documents_in_job': 6, 'documents_changed_in_one_step': 0},
    {'documents_in_one_step': 45, 'documents_in_job': 45, 'documents_changed_in_one_step': 24},
]


def test_the_top_line_says_what_the_one_step_did():
    assert notice({'documents_in_one_step': 45, 'documents_changed_in_one_step': 24,
                   'documents_not_all_read': 45}) == (
        'The job worked on all 45 documents in one step and changed 24 of them. It did not read every sentence.')
    assert notice({'documents_in_one_step': 2, 'documents_changed_in_one_step': 0}) == (
        'The job worked on all 2 documents in one step and changed none of them.')
    assert notice({'documents_in_one_step': 1, 'documents_changed_in_one_step': 1}) == (
        'The job worked on its one document in one step and changed it.')
    assert notice({'documents_in_one_step': 1}) == 'The job worked on its one document in one step and did not change it.'
    assert 'not read through' not in str(CASES)


def test_the_top_line_says_all_only_when_it_is_all():
    """REV-SF2-2: a write put off, a document deleted or a job stopped
    between the ends leaves fewer documents ended in the step."""
    assert notice({'documents_in_one_step': 2, 'documents_in_job': 3, 'documents_changed_in_one_step': 1}) == (
        'The job worked on 2 of its 3 documents in one step and changed 1 of them.')
    assert notice({'documents_in_one_step': 1, 'documents_in_job': 2, 'documents_changed_in_one_step': 1}) == (
        'The job worked on 1 of its 2 documents in one step and changed it.')
    assert notice({'documents_in_one_step': 3, 'documents_in_job': 6}) == (
        'The job worked on 3 of its 6 documents in one step and changed none of them.')
    assert notice({'documents_in_one_step': 45, 'documents_in_job': 45, 'documents_changed_in_one_step': 24}) == (
        'The job worked on all 45 documents in one step and changed 24 of them.')


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


def test_the_counts_name_the_jobs_documents_beside_those_the_step_ended():
    from plaid_agent.core.job import one_step_totals
    docs = [{'state': 'done', 'counts': {'one_step': True, 'changes': 1}},
            {'state': 'done', 'counts': {'one_step': True}},
            {'state': 'gone', 'counts': {}}]
    assert one_step_totals(docs) == {'documents_in_one_step': 2, 'documents_in_job': 3,
                                     'documents_changed_in_one_step': 1, 'documents_not_all_read': 0}
