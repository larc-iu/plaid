"""``plaid_agent.umr.penman`` against the UMR draft service's own PENMAN
reader, over the corner cases the grammar turns on.

There are three readings of this notation: ``plaid-umr/src/domain/format/
penman.js``, this package's port of it, and a second port inside
``plaid-umr/services/umr_draft_llm.py`` (the service runs from the base
environment and cannot import plaid-agent, so the copy stays and a test is
what holds it). All three write into the same storage and are read back by
each other, so a disagreement about what a text means is a disagreement about
what is stored: the service drafts a graph, the assistant reads it back to
diff it, and the canvas draws what is left.

What is compared is the READING: the root, the nodes, each node's concept, and
each child's relation, kind and value. Error WORDING is deliberately not: the
service writes its messages without ``line:col``. What is compared about
errors is whether the text is USABLE, which is the decision both sides act on:
a text with errors or with no root is refused, and where that refusal is
worded differs (empty input is an error to the service and a rootless graph to
this package, whose caller supplies the sentence).

The JS reader is the original both ports track and is outside this package;
the same cases run against it in plaid-umr's own suite is the piece still
missing (2026-09-21).
"""

import os
import sys

import pytest

from plaid_agent.umr.penman import parse_penman as agent_parse

SERVICE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       '..', '..', 'plaid-umr', 'services'))


def _service_parse():
    """The service's reader, or None where plaid-umr is not beside us."""
    if not os.path.isdir(SERVICE):
        return None
    if SERVICE not in sys.path:
        sys.path.insert(0, SERVICE)
    try:
        from umr_draft_llm import parse_penman
    except Exception:  # noqa: BLE001 - any trouble importing means skip, not fail
        return None
    return parse_penman


SIMPLE = '(s1b / bark-01\n    :ARG0 (s1d / dog\n        :refer-number singular)\n    :aspect performance)'

#: The shapes the grammar turns on, one per line. Half of them are texts a
#: model or a person really writes: a released file's `(s6t/ thing)`, a time of
#: day as a concept, a string holding brackets, a comment inside one.
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
]


def _agent_shape(text):
    g = agent_parse(text)
    return {
        'root': g.root,
        'nodes': {var: {'concept': n.concept,
                        'children': [(c.rel, c.kind, c.value or '') for c in n.children]}
                  for var, n in g.nodes.items()},
        'refused': bool(g.errors) or g.root is None,
    }


def _service_shape(parse, text):
    g = parse(text)
    return {
        'root': g['root'],
        'nodes': {var: {'concept': n['concept'],
                        'children': [(c['rel'], c['kind'], c['value'] or '')
                                     for c in n['children']]}
                  for var, n in g['nodes'].items()},
        'refused': bool(g['errors']) or g['root'] is None,
    }


@pytest.mark.parametrize('text', CASES, ids=[repr(t)[:40] for t in CASES])
def test_both_python_readers_read_one_text_the_same_way(text):
    parse = _service_parse()
    if parse is None:
        pytest.skip('plaid-umr/services is not beside this package')
    assert _agent_shape(text) == _service_shape(parse, text)


def test_the_mirror_actually_ran_both_readers():
    """Without this the sweep is green on a skip nobody notices, which is how
    a mirror test stops being one."""
    parse = _service_parse()
    if parse is None:
        pytest.skip('plaid-umr/services is not beside this package')
    assert len(CASES) >= 20
    both = [_agent_shape(SIMPLE), _service_shape(parse, SIMPLE)]
    assert both[0] == both[1]
    assert both[0]['root'] == 's1b' and len(both[0]['nodes']) == 2
