"""The agent's prediction of where token edges fall once a text edit is
saved, against plaid-igt's own (B4-7).

``plaid_agent.igt.plan._edges_after_gaps`` (with ``_cut_after``) is a copy of
plaid-igt's ``domain/textEdits.js`` ``edgesAfterGaps`` (with ``cutAfter``). Both
predict the cuts the server composes an edited body by, and the agent places
a retyped sentence's boundaries on the body that prediction composes. Reading
the stored body back instead is not the same: an appended mark that composes
with the letter before it would start the region one character early. So the
copy stays, and this runs the app's module over one case table and compares
every answer. It skips only where node cannot run.
"""

import json
import os
import random
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.igt import plan as igt_plan

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'text_edges_mirror.mjs')

# Typed values hold marks, a Hangul jamo pair and a character past the BMP,
# where a UTF-16 length would differ from a code-point one.
LETTERS = ['a', 'b', ' ', '\n', '́', 'ᄀ', 'ᅡ', '\U0001d465']


def _random_case(rng):
    n = rng.randint(0, 12)
    cuts = sorted({rng.randint(0, n) for _ in range(rng.randint(0, 6))} | ({0, n} if n else set()))
    tokens = [{'begin': b, 'end': e} for b, e in zip(cuts, cuts[1:])]
    # Zero-width tokens and tokens sharing an edge, as a partition and its
    # words give them.
    tokens += [{'begin': c, 'end': c} for c in cuts if rng.random() < 0.15]
    gaps, at = [], 0
    while at <= n and len(gaps) < 3:
        start = rng.randint(at, n)
        end = rng.randint(start, min(n, start + 3))
        value = ''.join(rng.choice(LETTERS) for _ in range(rng.randint(0, 3)))
        if start == end and not value:
            break
        gaps.append({'start': start, 'end': end, 'value': value})
        at = end + 1
    return {'tokens': tokens, 'gaps': gaps}


CASES = [
    # the cases of test_composed_text
    {'tokens': [{'begin': 0, 'end': 2}, {'begin': 2, 'end': 3}, {'begin': 4, 'end': 6}],
     'gaps': [{'start': 6, 'end': 6, 'value': ' tres'}]},
    {'tokens': [{'begin': 0, 'end': 2}, {'begin': 2, 'end': 3}, {'begin': 4, 'end': 6}],
     'gaps': [{'start': 6, 'end': 6, 'value': '́'}]},
    {'tokens': [{'begin': 0, 'end': 2}, {'begin': 3, 'end': 4}], 'gaps': [{'start': 2, 'end': 3, 'value': ''}]},
    # typed over a token's start and its end, and an insert where one token
    # ends and the next begins
    {'tokens': [{'begin': 0, 'end': 3}, {'begin': 3, 'end': 6}],
     'gaps': [{'start': 1, 'end': 2, 'value': 'xyz'}, {'start': 3, 'end': 3, 'value': 'q'},
              {'start': 4, 'end': 6, 'value': ''}]},
] + [_random_case(random.Random(seed)) for seed in range(3000)]


@pytest.fixture(scope='module')
def app(tmp_path_factory):
    node = node_or_skip('the text edges mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_edges_after_gaps_answers_as_the_app_does(app):
    assert len(app) == len(CASES)
    for case, expected in zip(CASES, app):
        assert sorted(igt_plan._edges_after_gaps(case['tokens'], case['gaps'])) == expected, case
