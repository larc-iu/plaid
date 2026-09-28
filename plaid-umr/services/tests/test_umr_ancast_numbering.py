"""The AnCast writer numbers a document's sentences as the app's export does.

The app writes each ``# :: snt`` line by position, unless the document goes by
its file's numbers (the first stored number is not 1, as in a released excerpt
starting at snt5). Then a stored number is written as it is, and a sentence
that stores none, or repeats one, takes its position or the next number past
the highest (``fileNumbers`` in src/domain/sentenceGraph.js, ported as
``plaid_client.workflows.umr.file_numbers``).

The writer used to write each sentence's stored number, else its position. A
sentence typed in before the first one in IGT stores nothing, so it took 1 and
the old first sentence, whose record moves with its graph, wrote its stored 1
as well: the comparison file carried ``# :: snt1`` twice, which the official
validator refuses.

``ancast_numbering_mirror.mjs`` makes the cases and the app's export of each,
and the service's whole file must match it byte for byte.
"""

import glob
import json
import os
import pathlib
import shutil
import subprocess

import pytest
from plaid_client import testing as servicetest
from plaid_client.workflows.umr import Sentence, file_numbers

HERE = pathlib.Path(__file__).resolve().parent
RUNNER = HERE / 'ancast_numbering_mirror.mjs'

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
    run = subprocess.run([node, str(RUNNER)], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f"the app's export would not run:\n{run.stderr[:2000]}")
    return {c['name']: c for c in json.loads(run.stdout)}


@pytest.mark.parametrize('name', ['prepended', 'between', 'excerpt', 'repeated', 'bom', 'separator'])
def test_the_file_is_the_one_the_app_exports(cases, name):
    case = cases[name]
    assert umr.render_umr(case['raw']) == case['expected']


def test_a_prepended_sentence_leaves_no_number_written_twice(cases):
    numbers = [line for line in umr.render_umr(cases['prepended']['raw']).split('\n')
               if line.startswith('# :: snt')]
    assert len(numbers) == 29
    assert numbers == [f'# :: snt{i}' for i in range(1, 30)]


def _sentences(*stored):
    return [Sentence(id=f't{i}', index=i, begin=0, end=0, text='', snt=snt)
            for i, snt in enumerate(stored, start=1)]


def test_file_numbers_by_hand():
    # Numbered by position: a stored 1 first, or nothing stored at all.
    assert file_numbers(_sentences(None, '1', '2')) == [1, 2, 3]
    assert file_numbers(_sentences(None, None)) == [1, 2]
    assert file_numbers([]) == []
    # Numbered by the file: stored numbers stand, a sentence with none takes
    # its position, or past the highest when that is taken.
    assert file_numbers(_sentences('5', None, '6')) == ['5', 2, '6']
    assert file_numbers(_sentences('5', '5', '7')) == ['5', 2, '7']
    assert file_numbers(_sentences('2', None, '3')) == ['2', 4, '3']
    # A stored number that is not a number is written as it is, and does not
    # count towards the highest.
    assert file_numbers(_sentences('5a', None, '2')) == ['5a', 4, '2']
