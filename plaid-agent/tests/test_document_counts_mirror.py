"""The report's documents as read_job and the final context count them
(``igt.job.document_counts``) against the job page's own (plaid-igt
jobText.js ``documentCounts``), over one table of reports (REV-RPF3-4):
read_job said "documents done 3" where the page said "Documents done 1,
Documents not read through 2", and "not reached" where it said "Stopped
partway". It skips only where node cannot run."""

import json
import os
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.igt.job import document_counts, summary_message
from plaid_agent.igt.jobread import _totals

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'document_counts_mirror.mjs')


def _doc(state, done=0, counts=None, skipped=0):
    return {'name': 'D', 'state': state, 'done': done, 'targets': 20, 'counts': counts or {},
            'skipped': [{'sentence': f's{i}', 'sentence_id': f'x{i}', 'reason': 'failed'} for i in range(skipped)]}


CASES = [
    {'totals': {'documents_done': 0}, 'documents': []},
    {'totals': {'documents_done': 3},
     'documents': [_doc('done', 2), _doc('done', 20, {'not_walked': True}), _doc('done', 20, {'not_walked': True})]},
    {'totals': {'documents_done': 1, 'documents_not_reached': 3},
     'documents': [_doc('done', 4), _doc('not-reached', 5), _doc('not-reached', 0, {'changes': 1}),
                   _doc('not-reached', 0, {'changes': 0})]},
    {'totals': {'documents_done': 2}, 'documents': [_doc('done', 2, skipped=2), _doc('done', 3, skipped=1)]},
    {'totals': {'documents_done': 1, 'documents_not_reached': 4}},
]


@pytest.fixture(scope='module')
def page(tmp_path_factory):
    node = node_or_skip('the report document counts mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_read_job_counts_the_documents_as_the_page_does(page):
    camel = {'not_read_through': 'notReadThrough', 'stopped_partway': 'stoppedPartway', 'not_reached': 'notReached'}
    assert len(page) == len(CASES)
    for report, said in zip(CASES, page):
        mine = document_counts(report)
        assert {camel.get(k, k): v for k, v in mine.items()} == said, report


def test_read_job_and_the_final_context_say_not_read_through_and_stopped_partway():
    """The reviewer's a2 and a7, and no raw key reaches the model."""
    checked = CASES[1]
    assert 'documents done 1, documents not read through 2' in _totals(checked), _totals(checked)
    stopped = CASES[2]
    said = _totals(stopped)
    assert 'documents stopped partway 2' in said and 'documents not reached 1' in said, said
    message = summary_message(checked)
    assert 'documents done 1' in message and 'documents not read through 2' in message
    assert 'not_walked' not in message, message
