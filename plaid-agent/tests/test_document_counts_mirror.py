"""The report's documents as read_job and the final context count them
(``igt.job.document_counts``) against the job page's own (plaid-igt
jobText.js ``documentCounts``), over one table of reports (REV-RPF3-4):
read_job said "documents done 3" where the page said "Documents done 1",
and "not reached" where it said "Stopped
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
     'documents': [_doc('done', 2), _doc('done', 20, {'one_step': True, 'changes': 2}),
                   _doc('done', 20, {'one_step': True, 'not_all_read': True})]},
    {'totals': {'documents_done': 1, 'documents_not_reached': 3},
     'documents': [_doc('done', 4), _doc('not-reached', 5), _doc('not-reached', 0, {'changes': 1}),
                   _doc('not-reached', 0, {'changes': 0})]},
    {'totals': {'documents_done': 2}, 'documents': [_doc('done', 2, skipped=2), _doc('done', 3, skipped=1)]},
    # D11: sentences too long for a job were never targets, and done does
    # not count them: a document whose every target was worked is done.
    {'totals': {'documents_done': 2},
     'documents': [{**_doc('done', 3, {'too_long_more': 1}),
                    'skipped': [{'sentence': f's{i}', 'sentence_id': f't{i}', 'reason': 'too-long'} for i in range(3)]},
                   {**_doc('done', 2, {'skipped_more': 1, 'too_long_more': 4}),
                    'skipped': [{'sentence': 's9', 'sentence_id': 'x9', 'reason': 'failed'}]}]},
    # D22: documents the plan left out are no documents not reached.
    {'totals': {'documents_done': 1, 'documents_not_reached': 3},
     'plan': {'left_out': [{'document_id': 'l1', 'name': 'L1'}, {'document_id': 'l2', 'name': 'L2'}]},
     'documents': [_doc('done', 2), {**_doc('not-reached', 0), 'document_id': 'l1'},
                   {**_doc('not-reached', 0), 'document_id': 'l2'}, {**_doc('not-reached', 0), 'document_id': 'n1'}]},
    {'totals': {'documents_done': 1, 'documents_not_reached': 3},
     'plan': {'left_out': [{'document_id': 'l1', 'name': 'L1'}], 'left_out_more': 1}},
    # REV-JR2-3: a document the server never answered for is counted apart.
    {'totals': {'documents_done': 1, 'documents_not_reached': 2},
     'documents': [_doc('done', 2), _doc('not-reached', 0, {'unanswered': True}), _doc('not-reached', 0)]},
    {'totals': {'documents_done': 1, 'documents_not_reached': 4}},
    # A plan limited by a search (SF): two documents it matched nothing in,
    # one it matched and worked, one it matched and was not reached.
    {'totals': {'documents_done': 3, 'documents_not_reached': 1},
     'documents': [_doc('done', 0, {'matched': 0}), _doc('done', 0, {'matched': 0}), _doc('done', 2, {'matched': 2}),
                   _doc('not-reached', 0, {'matched': 3})]},
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
    camel = {'stopped_partway': 'stoppedPartway', 'not_reached': 'notReached',
             'with_nothing_found_by_the_search': 'withNothingFoundByTheSearch', 'left_out': 'leftOut'}
    assert len(page) == len(CASES)
    for report, said in zip(CASES, page):
        mine = document_counts(report)
        assert {camel.get(k, k): v for k, v in mine.items()} == said, report


def test_read_job_and_the_final_context_count_the_one_step_and_stopped_partway():
    """A whole-selection job's documents are done (RP4-4 finding 1:
    "Documents done 0" beside 45 rows reading Done) and those it changed are
    counted; no raw key reaches the model."""
    checked = CASES[1]
    assert document_counts(checked)['done'] == 3 and document_counts(checked)['changed'] == 1
    assert 'documents done 3, documents changed 1' in _totals(checked), _totals(checked)
    stopped = CASES[2]
    said = _totals(stopped)
    assert 'documents stopped partway 2' in said and 'documents not reached 1' in said, said
    message = summary_message(checked)
    assert 'documents done 3' in message and 'documents changed 1' in message
    assert 'one_step' not in message and 'not read through' not in message, message


def test_read_job_says_the_one_step_in_the_top_line():
    """read_job says what the page's top line says, the worker's line, or for
    core's own report (no notice) the same line from its rows."""
    from plaid_agent.igt.jobread import summary
    core_report = {**CASES[1], 'state': 'cancelled'}
    lines = summary({'id': 'j', 'state': 'cancelled', 'instructions': 'x', 'report': core_report})
    assert any('The job worked on 2 of its 3 documents in one step and changed 1 of them. It did not read every '
               'sentence.' in line for line in lines), lines


def test_documents_with_no_matching_sentence_are_counted_apart_from_done(page):
    """SF: a document a plan limited by a search ended with no sentence of it
    matched is neither done nor unread, on the page and to the model."""
    said = page[-1]
    assert (said['done'], said['withNothingFoundByTheSearch'], said['notReached']) == (1, 2, 1), said
    assert 'documents done 1, documents with nothing found by the search 2' in _totals(CASES[-1]), _totals(CASES[-1])
