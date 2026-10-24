"""``plaid_client.workflows.umr`` reads a stored UMR document as plaid-umr
reads it: each sentence's roots, in the app's order, and the whole sentence as
PENMAN (``sentence_penman`` against ``UmrDocument.penmanOf``), byte for byte.

The Compare report records each side's graph with ``sentence_penman`` and the
Compare tab marks a sentence "Changed since this comparison." when
``penmanOf`` no longer prints the same text. So any difference between the two,
in a part's content or only in the order of the parts, marks a sentence that
nobody edited. The first port read the roots with an older rule (a node reached
only by ``:quote`` counted as a root, fragments in anchor order rather than
largest first), and 291 of 1200 sentences in parts differed (REV2-PY,
2026-09-28).

The cases are the released sample files, imported with the app's own plan,
whole and with some edges or the file's root marks dropped, which is how a
graph looks while someone is building it, and with the edits another app
makes to the shared sentences and words (a sentence typed in before the
first, words split and deleted), which both readers read right before a UMR
write stores the answer (R3, 2026-10-24): each node's alignment and the
relations a record holds are compared too. ``umr_graph_mirror.mjs`` runs the
app's side. It skips where it cannot run (no node, or plaid-umr not beside the
agent), and says so in the warnings summary (see ``node_exe``). It does not
skip when the two disagree.
"""

import glob
import json
import os
import subprocess
import tempfile

import pytest
from live import _skip_or_fail
from node_exe import node_or_skip

from plaid_client.workflows.umr import read_document, resolve_layers, sentence_penman

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'umr_graph_mirror.mjs')
SAMPLES = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'test', 'fixtures', 'umr'))


@pytest.fixture(scope='module')
def variants():
    files = sorted(glob.glob(os.path.join(SAMPLES, '*.umr')))
    if not files:
        _skip_or_fail('needs plaid-umr beside the agent')
    node = node_or_skip("The UMR graph mirror runs the app's document model with it.")
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'files.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(files, fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's document model would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


def test_every_sentence_reads_as_the_app_reads_it(variants):
    wrong = []
    for variant in variants:
        doc = read_document(variant['raw'], resolve_layers(variant['raw']))
        assert len(doc.sentences) == len(variant['sentences']), variant['name']
        for sentence, app in zip(doc.sentences, variant['sentences']):
            roots = [r.var for r in sentence.roots]
            text = sentence_penman(doc, sentence) if sentence.nodes else app['penman']
            alignment = {n.var: [list(r) for r in n.alignment] for n in sentence.nodes}
            if roots != app['roots'] or text != app['penman']:
                wrong.append(f"{variant['name']} s{sentence.index}: roots {roots} "
                             f"against {app['roots']}")
            elif alignment != app['alignment'] or sentence.held != app['held']:
                wrong.append(f"{variant['name']} s{sentence.index}: alignment or held")
    assert not wrong, f'{len(wrong)} sentences differ, the first: ' + '; '.join(wrong[:5])


def test_the_mirror_saw_what_another_apps_edits_leave(variants):
    """The edited variants hold every kind the reader reads right before a
    UMR write stores it (plaid-umr umrSettle.js): renamed variables, nodes
    whose word went and nodes over a split word."""
    edited = [v for v in variants if v['name'].endswith(' edited')]
    assert edited
    renamed = cut = lost = 0
    for variant in edited:
        doc = read_document(variant['raw'], resolve_layers(variant['raw']))
        for node in doc.nodes_by_id.values():
            renamed += bool(node.stored_var and node.stored_var != node.var)
            cut += node.read_pieces != node.pieces
            lost += bool(not node.constant and not node.aligned and not node.sentence_token)
    assert renamed > 100 and cut > 10 and lost > 10, (renamed, cut, lost)


def test_the_mirror_saw_graphs_in_parts(variants):
    """Without this the comparison could pass on graphs that never fall into
    parts, which is the case it exists for."""
    sentences = [s for v in variants for s in v['sentences']]
    assert len(sentences) > 1000
    assert sum('\n\n' in s['penman'] for s in sentences) > 500
    assert sum(len(s['roots']) > 2 for s in sentences) > 100
