"""The AnCast writer's file is the app's export, on every released sample.

The Compare tab scores the `.umr` text this service writes, so that text must
be the file the Export tab gives for the same document: the same nodes (what
the first root reaches), the same alignment lines, the same document-level
relations (those whose two ends the file writes) and the relations held on a
graph kept as text, written back while the names they use are in the file.

The writer once wrote every node of a sentence, so a fragment, or a second
graph in a sentence two were joined into in IGT, added alignment lines and
relations the export leaves out. It also dropped the held relations, so a
sentence kept as text lost its document-level block. Scored against the
export, a joined document's coreference came out at 0.76.

``ancast_parity_mirror.mjs`` makes each case, every sample in
``test/fixtures/umr`` as imported, with a fragment, a self-loop, two
sentences joined, one split and two words joined into one, and the app's
export of each, the gloss lines taken off first (this writer writes Index and
Words only). The service's whole file must match it byte for byte.
"""

import glob
import json
import os
import pathlib
import shutil
import subprocess

import pytest
from plaid_client import testing as servicetest

HERE = pathlib.Path(__file__).resolve().parent
RUNNER = HERE / 'ancast_parity_mirror.mjs'
SAMPLES = sorted(p.stem for p in (HERE.parent.parent / 'test' / 'fixtures' / 'umr').glob('*.umr'))
CHANGES = ['imported', 'fragment', 'selfloop', 'joined', 'split', 'words']

umr = servicetest.load_service(HERE.parent / 'umr_ancast.py')


def _node():
    """A node for the app's side: PLAID_NODE, the one on PATH, else the
    newest nvm install, since a non-interactive shell has none on PATH."""
    named = os.environ.get('PLAID_NODE') or shutil.which('node')
    if named:
        return named
    found = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v*/bin/node')),
                   key=lambda p: [int(x) for x in p.split('/v')[-1].split('/')[0].split('.')])
    return found[-1] if found else None


@pytest.fixture(scope='module')
def cases():
    node = _node()
    if node is None:
        pytest.skip('needs node to run the app\'s export')
    run = subprocess.run([node, str(RUNNER)], capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        pytest.fail(f"the app's export would not run:\n{run.stderr[:2000]}")
    return {c['name']: c for c in json.loads(run.stdout)}


@pytest.mark.parametrize('sample', SAMPLES)
@pytest.mark.parametrize('change', CHANGES)
def test_the_file_is_the_one_the_app_exports(cases, sample, change):
    case = cases.get(f'{sample}/{change}')
    if case is None:
        # A sample with no graph to change (the Portuguese one has none).
        pytest.skip(f'{sample} has nothing to make a {change} of')
    assert umr.render_umr(case['raw']) == case['expected']


def test_every_change_is_made_on_most_samples(cases):
    # The cases the parity rests on are there: a mirror that made none would
    # pass every test above by skipping it.
    for change in CHANGES:
        made = [s for s in SAMPLES if f'{s}/{change}' in cases]
        assert len(made) >= len(SAMPLES) - 1, (change, made)


def test_a_joined_sentence_writes_the_first_graph_alone(cases):
    # English, sentences 1 and 2 joined: the second graph's nodes have no
    # alignment line and no relation into them is written.
    text = umr.render_umr(cases['english_umr-0001/joined']['raw'])
    first = text.split('#' * 80)[1]
    assert 's1' in first
    assert 's2' not in first.split('# alignment:')[1]


def test_a_graph_kept_as_text_keeps_its_held_relations(cases):
    # Sanapana snt37 holds an unclosed quote, so the import keeps its graph as
    # text, with the relations its block wrote held on it. Both come back.
    expected = cases['sanapana_umr-0001/imported']['expected']
    block = next(b for b in expected.split('#' * 80) if '# :: snt37\n' in b)
    held = block.split('# document level annotation:')[1]
    assert '(s37e :overlap s37i2)' in held and ':coref' in held
    assert block in umr.render_umr(cases['sanapana_umr-0001/imported']['raw'])
