"""``plaid_client.workflows.umr`` places nodes and reads sentence records as
plaid-umr's reader does, over a document IGT changed and the app has not yet
healed: the sentence each node is in, and each sentence's stored ``snt``
number, gloss and metadata lines, kept graph and block triples.

The Python reader placed a node by where its anchor begins, and nothing else.
The app reads an unaligned node in the sentence it records while that token is
alive, unless the anchor begins in a LATER sentence (``f1a9aecf``), and reads
a sentence's record, and a triple between constants, with the graph it
describes after IGT's split left them on new text typed in before it. So the
services and the assistant saw the old first sentence's number and gloss lines
on the new text until someone opened the document.

``umr_sentence_mirror.mjs`` builds the cases and runs the app's side. It skips
where it cannot run (no node, or plaid-umr not beside the agent), and says so
in the warnings summary (see ``node_exe``). It does not skip when the two
disagree.
"""

import json
import os
import subprocess

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_client.workflows.umr import read_document, resolve_layers

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_sentence_mirror.mjs')
UMR = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src'))


@pytest.fixture(scope='module')
def cases():
    if not os.path.isdir(UMR):
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR sentence mirror runs the app's document model with it.")
    run = subprocess.run([node, RUNNER], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's document model would not run:\n{run.stderr[:2000]}")
    return {c['name']: c for c in json.loads(run.stdout)}


def _python_side(case):
    doc = read_document(case['raw'], resolve_layers(case['raw']))
    nodes = {n.var: n.sentence for n in doc.nodes_by_id.values() if not n.constant}
    sentences = [{
        'snt': s.snt, 'text': s.text, 'ilg': [line.get('header') for line in s.stored_ilg],
        'meta': s.meta, 'rawGraph': s.raw_graph,
        'triples': sorted(t.rel for t in s.triples),
    } for s in doc.sentences]
    return nodes, sentences


@pytest.mark.parametrize('name', ['prepend', 'excerpt', 'between', 'later', 'outside', 'gone',
                                  'bareExcerpt', 'bareShifted'])
def test_the_document_reads_as_the_app_reads_it(cases, name):
    case = cases[name]
    nodes, sentences = _python_side(case)
    assert nodes == case['nodes']
    assert sentences == case['sentences']


def test_the_cases_are_the_ones_the_rules_are_for(cases):
    """Without this the comparison could pass on cases where the rules never
    come into play."""
    prepend = cases['prepend']
    # The old first sentence's unaligned node records the new text's token,
    # and is read in the sentence its anchor and tree are in.
    assert prepend['nodes']['s1n'] == 2
    # Its record is read there too, and the new text reads as new.
    assert [s['snt'] for s in prepend['sentences']] == [None, 1, 2]
    assert prepend['sentences'][0]['triples'] == []
    assert prepend['sentences'][1]['ilg'] == ['Gloss']
    # A triple between constants follows its sentences past a new one.
    assert [s['triples'] for s in cases['between']['sentences']] == [
        [':modal'], [], [':modal'], [':modal']]
    # A boundary moved later leaves the record winning.
    assert cases['later']['nodes']['s2n'] == 2
    assert cases['outside']['nodes']['s2n'] == 2
    assert cases['gone']['nodes']['s2n'] == 2
    assert [s['snt'] for s in cases['excerpt']['sentences']] == [None, 5, 6]
    # A bare sentence's record stays on it when the sentence after it was
    # added in IGT and named by its own position, or by a number the bare
    # sentence's position and stored number do not both give.
    assert [s['snt'] for s in cases['bareExcerpt']['sentences']] == [2, None]
    assert [s['snt'] for s in cases['bareShifted']['sentences']] == [None, 1, 2, None]
