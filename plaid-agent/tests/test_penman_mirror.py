"""``plaid_client.workflows.umr.penman`` against plaid-umr's own reader, over
the corner cases the grammar turns on.

There are two readings of this notation and there is no getting away from that:
``plaid-umr/src/domain/format/penman.js`` for the canvas and the exporter, and
the Python port for the assistant and the two bundled UMR services. Both write
into the same storage and read back what the other wrote, so a disagreement
about what a text MEANS is a disagreement about what is stored: the draft
service writes a graph, the assistant reads it back to diff it, and the canvas
draws what is left. Nothing about a port announces that it has stopped
tracking, which is what the vocabulary port's mirror test was built for and
what this is.

What is compared is the whole reading: the root, the nodes, each node's concept,
each child's relation, kind and value, the tree edges, whether the text is
USABLE at all, and the text written back out. Error WORDING is deliberately not:
the two sides word a refusal for different readers, and what they must agree on
is the decision, which is that a text with errors or with no root is not one to
write from.

It skips where it cannot run (no node, or plaid-umr not beside the agent), and
says so in the warnings summary too (see ``node_exe``); it does not skip when
the two disagree.
"""

import json
import os
import subprocess
import tempfile

from live import _skip_or_fail
from node_exe import node_or_skip

import pytest

from plaid_client.workflows.umr import parse_penman, serialize_penman, tree_edges
from plaid_client.workflows.umr.penman import next_variable, value_grammar_problem

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'penman_mirror.mjs')
JS_READER = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-umr', 'src', 'domain',
                                         'format', 'penman.js'))


def _node() -> str:
    """The node to run the app's reader with, or a skip that says why.
    ``penman.js`` is ESM and imports nothing, so no node_modules are needed."""
    if not os.path.isfile(JS_READER):
        _skip_or_fail('needs plaid-umr beside the agent')
    return node_or_skip("The PENMAN mirror runs the app's reader with it.")


SIMPLE = ('(s1b / bark-01\n    :ARG0 (s1d / dog\n        :refer-number singular)'
          '\n    :aspect performance)')

#: The shapes the grammar turns on, one per line. Half of them are texts a model
#: or a person really writes: a released file's `(s6t/ thing)`, a time of day as
#: a concept, a string holding brackets, a comment inside one.
CASES = [
    # --- well formed ---------------------------------------------------------
    SIMPLE,
    '(s1p / person)',
    '(s1p / person :name "Ali (the elder)")',
    '(s1t / temperature-quantity :quant -3.5)',
    '(s1m / meet-01\n    :ARG0 (s1p / person)\n    :ARG1 s1p)',                  # re-entrancy
    '(s1m / meet-01\n    :ARG1 s1p\n    :ARG0 (s1p / person))',                  # forward reference
    '(s6t/ thing)',                                                              # no space after the variable
    '(s1t / 10:30)',                                                             # a time as a concept
    '(s1s / say-01 # a comment\n    :ARG0 (s1p / person))',
    '# a comment first\n(s1p / person)',
    '(s1p / person :name "a # not a comment")',
    '(s1ある / person)',                                                          # a non-ASCII letter run
    '(s1r / run-01\n    :ARG0 (s1p / person\n        :ARG0-of s1r))',            # a cycle back to the root
    '(s1p / person :mod "")',
    '(s1p / person :ARG0 s1p)',
    '(s1s / say-01\n    :ARG0 (s1p / person)\n    :ARG1 (s1w / want-01\n        :ARG0 s1p))',
    # A variable whose letter run is not LOWERCASE is not a variable: `\p{Ll}`
    # is the spec's, and reading `s1P` as a node reference would make a dangling
    # edge out of an atom.
    '(s1p / person :mod s1P)',
    '(s1p / person :mod s1Р)',                                                   # Cyrillic capital ER
    '(s1p / person :mod s1ρ)',                                                   # Greek small rho: a variable
    '(s1p / person :mod s1p2)',
    # --- refused -------------------------------------------------------------
    '',
    '   ',
    'person',                                                                    # no opening bracket
    '(s1p / person',                                                             # never closed
    '(s1p / person :ARG0',                                                       # ends mid relation
    '(s1p / person :name "unterminated)',
    '(s1p person)',                                                              # no slash
    '(s1p /)',                                                                   # no concept
    '(s1a / a :ARG0 ())',                                                        # an empty node
    '(s1a / a :ARG0 s1z)',                                                       # an undefined variable
    '(s1a / a :ARG0 (s1a / b))',                                                 # defined twice
    '(s1a / a : b)',                                                             # a bare colon
    '(s1a / a) trailing',
    '(s1a / a :ARG0 (s1b / b) extra)',
    # --- a time of day, the one value holding a colon, and NFC -----------------
    '(s8a / date-entity :time 15:30)',
    '(s8a / date-entity :time 15:30 :mod (s8b / thing))',
    '(s8a / date-entity :time 15:30:00)',                                        # not a time
    '(s8a / 10:30)',                                                             # a concept stops at the colon
    '(s6e\u0301 / cafe\u0301 :mod (s6x / cafe\u0301))',                           # NFD, read as NFC
]


#: Attribute values as stored, each with the relation it stands under or None,
#: for ``value_grammar_problem`` against the app's ``valueGrammarProblem``
#: (umr-export-value-grammar): code and message must agree.
VALUES = [
    ['imperative', ':mode'], ['15:30', None], ['3.5', ':quant'], ['12', None], ['-', None],
    ['+', None], ['3rd', None], ['"Caf\u00e9 Noir"', ':wiki'], ['"Q76"', None],
    ['Imperative', ':mode'], ['big_one', None], ['caf\u00e9', ':mod'], ['.5', None],
    ['-1.5', None], ['a/b', None], ['""', ':wiki'], ['"O\\"Brien"', None], ['"a\nb"', ':wiki'],
    ['"a\u2028b"', None], ['"unclosed', None], ['s2x', None], ['s1x-b', ':mod'],
    ['s1\u03c1', None], ['s1P', None], ['', None], ['caf\u0065\u0301', None],
    # The text-mode cases a hunter typed (U6).
    ['" "', ':op1'], ['"C#"', None], ['"a (b): c/d"', None], ['"back\\\\"', None],
    ['\u6771\u4eac', ':op1'], ["o'brien", None], ['a\\b', None], ['new_york', ':op1'],
    ['s1y', ':mod'], ['"\u0627\u0644\u0642\u0627\u0647\u0631\u0629"', None],
]

#: Concepts a service names a node for, with the sentence and the names taken,
#: for ``next_variable`` against the app's ``nextVariable``: the letter is a to z
#: only (umr-export-non-ascii-variables), an accented one its base letter.
VARIABLES = [
    [4, 'ébrio', []], [4, 'Ébrio', []], [4, 'e\u0301brio', []], [1, 'dog', ['s1d']],
    [2, 'İstanbul', []], [2, 'ñandú', ['s2n']], [3, 'ß', []], [3, 'øre', []], [3, 'æble', []],
    [3, '生活-01', []], [3, 'ǅemal', []], [3, '\u212aelvin', []], [3, '𝐀bc', []],
    [3, '\ufb01le', []], [3, 'σοφία', []], [3, '-91', []], [3, '', []], [5, 'çocuk', ['s5c']],
]

#: The one place the two readings differ, named rather than papered over: the
#: value of a child the reader could not read at all. Both REFUSE the text (the
#: comparison below still holds them to that), and nothing serializes a graph it
#: has refused, so what the two would write is text no caller ever asks for.
EXEMPT = {
    '(s1a / a :ARG0 ())': ('text', "an unreadable child's value is null in JS and '' here, so "
                                   "the refused text writes back as ':ARG0 null' or ':ARG0 '"),
}


def _python_shape(text):
    g = parse_penman(text)
    return {
        'root': g.root,
        'nodes': {var: {'concept': n.concept,
                        'children': [[c.rel, c.kind, c.value or ''] for c in n.children]}
                  for var, n in g.nodes.items()},
        'refused': bool(g.errors) or g.root is None,
        'text': serialize_penman(g),
        'treeEdges': sorted([parent, index] for parent, index in tree_edges(g)),
    }


@pytest.fixture(scope='module')
def compared():
    node = _node()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'cases.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'texts': CASES, 'values': VALUES, 'variables': VARIABLES}, fh,
                      ensure_ascii=False)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=120)
    if run.returncode != 0:
        pytest.fail(f"the app's PENMAN reader would not run:\n{run.stderr[:2000]}")
    return json.loads(run.stdout)


@pytest.mark.parametrize('index', range(len(CASES)), ids=[repr(t)[:40] for t in CASES])
def test_both_readers_read_one_text_the_same_way(compared, index):
    text = CASES[index]
    mine, theirs = _python_shape(text), compared['texts'][index]
    exempt = EXEMPT.get(text)
    if exempt:
        key, reason = exempt
        assert mine.pop(key) != theirs.pop(key), (
            f'{text!r} no longer differs in {key}: drop the exemption ({reason})')
        assert mine['refused'] and theirs['refused'], (
            f'{text!r} is exempt only because both readers refuse it')
    assert mine == theirs, f'on {text!r}'


def test_the_mirror_actually_ran_the_app_s_reader(compared):
    """Without this the sweep is green on a skip nobody notices, which is how a
    mirror test stops being one."""
    assert len(compared['texts']) == len(CASES) >= 20
    assert len(compared['values']) == len(VALUES)
    assert compared['variables'][:2] == ['s4e', 's4e']
    assert compared['values'][VALUES.index(['Imperative', ':mode'])]['code'] == 'value-wrong-chars'
    shape = compared['texts'][0]
    assert shape['root'] == 's1b' and len(shape['nodes']) == 2
    assert shape['text'] == SIMPLE


@pytest.mark.parametrize('index', range(len(VALUES)), ids=[repr(v)[:30] for v in VALUES])
def test_both_value_grammars_judge_one_value_the_same_way(compared, index):
    value, rel = VALUES[index]
    assert value_grammar_problem(value, rel) == compared['values'][index], f'on {value!r}'


@pytest.mark.parametrize('index', range(len(VARIABLES)), ids=[repr(v)[:30] for v in VARIABLES])
def test_both_name_a_new_node_the_same_way(compared, index):
    sentence, concept, taken = VARIABLES[index]
    mine = next_variable(sentence, concept, set(taken))
    assert mine == compared['variables'][index], f'on {concept!r}'
    assert mine.isascii(), f'on {concept!r}'
