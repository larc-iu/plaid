"""Every integer a model can write, fed something that is not a number.

The model writes the arguments, so "20 or so", "s34" and "all" arrive where a
number was declared. `int()` answers those with a message about base 10 from a
module whose whole contract is that a refusal is a sentence the model can act
on, and it reached the model from fourteen arguments after three of them were
fixed. The cases come from the tool schemas, so an integer added tomorrow is
covered the day it is added.
"""

import sys

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.igt.toolkit import TOOLS as IGT_TOOLS, call_tool as igt_call  # noqa: E402
from plaid_agent.ud.toolkit import TOOLS as UD_TOOLS, call_tool as ud_call  # noqa: E402

# Enough of each tool's other arguments to reach the integer.
IGT_ARGS = {'document': 'Text 1', 'pattern': 'gam', 'field': 'Gloss', 'ref': 's1', 'refs': ['s1.w1'],
            'sequence': [{'Gloss': 'ERG'}], 'entry_form': 'gam', 'entry_id': 'vi-gam',
            'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}
UD_ARGS = {'document': 'Viaje', 'pattern': 'mar', 'field': 'lemma', 'ref': 's1.w1', 'refs': ['s1.w1'],
           'what': 'lemma', 'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}

# What a Python exception looks like when it reaches the model instead of a
# refusal. None of these may appear in any answer below.
PYTHON_LEAKS = ('invalid literal', 'base 10', 'could not convert', 'not supported between',
                'unsupported operand', 'Traceback', 'argument has the wrong type')

NOT_A_NUMBER = 'not-a-number'


def _int_params(tools):
    out = []
    for t in tools:
        f = t['function']
        params = f.get('parameters') or {}
        props = params.get('properties') or {}
        for name, spec in props.items():
            types = spec.get('type')
            types = types if isinstance(types, list) else [types]
            if 'integer' in types or 'number' in types:
                out.append((f['name'], name, list(params.get('required') or [])))
    return out


IGT_INTS = _int_params(IGT_TOOLS)
UD_INTS = _int_params(UD_TOOLS)


def _igt_ws():
    from fixtures import project_raw, document_raw, lexicon_raw
    from fixtures_ext import ExtClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = ExtClient(project=project_raw(), documents={'d1': document_raw()}, lexicon=lexicon_raw())
    w = Workspace(c, load_project(c, 'p1'))
    w.prefer_scan = True
    return w


def _ud_ws():
    from fixtures_ext import ExtClient
    from ud_fixtures import project_raw, document_raw
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'ud1': document_raw()})
    return Workspace(c, load_project(c, 'p1'))


def _args(required, values, param):
    args = {k: values[k] for k in required if k in values and k != param}
    args[param] = NOT_A_NUMBER
    return args


def _check(answer, tool, param):
    assert isinstance(answer, str), f'{tool}.{param} answered with {type(answer).__name__}'
    for leak in PYTHON_LEAKS:
        assert leak not in answer, f'{tool}.{param} handed the model Python\'s own words: {answer!r}'
    assert answer.strip(), f'{tool}.{param} answered with nothing'


@pytest.mark.parametrize('tool,param,required', IGT_INTS, ids=[f'{t}.{p}' for t, p, _ in IGT_INTS])
def test_igt_integer_arguments_refuse_in_words(tool, param, required):
    _check(igt_call(_igt_ws(), tool, _args(required, IGT_ARGS, param)), tool, param)


@pytest.mark.parametrize('tool,param,required', UD_INTS, ids=[f'{t}.{p}' for t, p, _ in UD_INTS])
def test_ud_integer_arguments_refuse_in_words(tool, param, required):
    _check(ud_call(_ud_ws(), tool, _args(required, UD_ARGS, param)), tool, param)


def test_the_sweep_actually_found_the_integers():
    """Without this the two tests above are green on an empty case list."""
    assert len(IGT_INTS) >= 15 and len(UD_INTS) >= 10
    assert ('read_document', 'from_sentence') in [(t, p) for t, p, _ in IGT_INTS]
    assert ('read_document', 'from_sentence') in [(t, p) for t, p, _ in UD_INTS]


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_a_sentence_range_takes_the_references_a_read_prints(app):
    """The model reads "s3" out of a rendered document and writes it back, so
    a sentence argument arrives written that way as often as as a bare number.
    UD's `sentences` has always accepted it; the range did not, in either app."""
    if app == 'igt':
        ws, call, doc = _igt_ws(), igt_call, 'Text 1'
    else:
        ws, call, doc = _ud_ws(), ud_call, 'Viaje'
    plain = call(ws, 'read_document', {'document': doc, 'from_sentence': 2})
    assert plain == call(ws, 'read_document', {'document': doc, 'from_sentence': 's2'})
    assert plain == call(ws, 'read_document', {'document': doc, 'from_sentence': '2'})
