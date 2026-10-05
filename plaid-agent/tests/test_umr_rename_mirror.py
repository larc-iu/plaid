"""The assistant reads a variable typed over as a rename exactly as plaid-umr's
Text mode does (``_rename_in`` against ``UmrDocument._renameIn``): exactly one
variable goes and one arrives, and they are plainly the same node.

A node with a ``:quote`` edge to itself names itself as a parent, under the
old name in the store and the new one in the text. Both readers once compared
those names, so the rename read as a delete plus a create: the node lost its
words and its document-level relations.

``umr_rename_mirror.mjs`` runs the app's side over every sentence of the
released samples, with and without self-loops. It skips where it cannot run,
and says so. It does not skip when the two disagree.
"""

import json
import os
import subprocess

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_agent.umr.diff import _rename_in
from plaid_client.workflows.umr import reachable_from_root, read_document, resolve_layers
from plaid_client.workflows.umr.penman import parse_penman

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_rename_mirror.mjs')
UMR = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src'))


@pytest.fixture(scope='module')
def documents():
    if not os.path.isdir(UMR):
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR rename mirror runs the app's Text mode reading with it.")
    run = subprocess.run([node, RUNNER], capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        pytest.fail(f"the app's Text mode reading would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


def _python_rename(doc, index, text):
    sentence = doc.sentences[index - 1]
    node, to = _rename_in(doc, sentence, parse_penman(text), reachable_from_root(doc, sentence))
    return [node.var, to] if node is not None else None


def test_the_assistant_reads_a_rename_where_the_app_does(documents):
    for document in documents:
        doc = read_document(document['raw'], resolve_layers(document['raw']))
        for case in document['cases']:
            got = _python_rename(doc, case['sentence'], case['text'])
            assert got == case['rename'], (document['name'], case['text'])


def test_the_cases_are_the_ones_the_rule_is_for(documents):
    """Without this the comparison could pass on cases where the rule never
    comes into play."""
    looped = [d for d in documents if d['name'].endswith('self-loops')]
    assert len(looped) >= 5
    self_renamed = 0
    for document in looped:
        for case in document['cases']:
            if not case['rename']:
                continue
            new = case['rename'][1]
            if f':quote {new})' in case['text'] or f':quote {new}\n' in case['text']:
                if f'({new} /' in case['text']:
                    self_renamed += 1
    # A node renamed while it quotes itself, read as a rename by the app.
    assert self_renamed >= 5
    # And the ones that are no rename: a concept changed, two at once.
    assert any(c['rename'] is None for d in documents for c in d['cases'])
