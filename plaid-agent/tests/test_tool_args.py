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
from plaid_agent.umr.toolkit import call_tool as umr_call  # noqa: E402

# Enough of each tool's other arguments to reach the integer.
IGT_ARGS = {'document': 'Text 1', 'pattern': 'gam', 'field': 'Gloss', 'ref': 's1', 'refs': ['s1.w1'],
            'sequence': [{'Gloss': 'ERG'}], 'entry_form': 'gam', 'entry_id': 'vi-gam',
            'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}
UD_ARGS = {'document': 'Viaje', 'pattern': 'mar', 'field': 'lemma', 'ref': 's1.w1', 'refs': ['s1.w1'],
           'what': 'lemma', 'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}
# Where one name means something else to one tool: `pattern` is a document
# NAME to list_documents and a value to search for everywhere else, and a
# pattern that matches nothing answers "no documents" without reading a
# number.
# `query` is a Plaid query object to the query tool and a phrase to the web.
OVERRIDES = {'igt': {'list_documents': {'pattern': 'Text'}, 'web_search': {'query': 'ergative alignment'}},
             'ud': {'list_documents': {'pattern': 'Viaje'}, 'web_search': {'query': 'ergative alignment'}}}

# What a Python exception looks like when it reaches the model instead of a
# refusal. None of these may appear in any answer below.
PYTHON_LEAKS = ('invalid literal', 'base 10', 'could not convert', 'not supported between',
                'unsupported operand', 'Traceback', 'argument has the wrong type')

NOT_A_NUMBER = 'not-a-number'


def _types(spec):
    types = spec.get('type')
    return types if isinstance(types, list) else [types]


def _int_params(tools):
    out = []
    for t in tools:
        f = t['function']
        props = (f.get('parameters') or {}).get('properties') or {}
        for name, spec in props.items():
            if 'integer' in _types(spec) or 'number' in _types(spec):
                out.append((f['name'], name, props))
    return out


IGT_INTS = _int_params(IGT_TOOLS)
UD_INTS = _int_params(UD_TOOLS)


class NoWeb:
    """A web session that finds nothing.

    The web tools are withheld where the operator configured no backend, so
    without one `web_search` refused before it read its limit and the sweep
    below was green on an answer that said nothing about the number.
    """

    def search(self, query, limit):
        return []


def _igt_ws():
    from fixtures import project_raw, document_raw, lexicon_raw
    from fixtures_ext import ExtClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = ExtClient(project=project_raw(), documents={'d1': document_raw()}, lexicon=lexicon_raw())
    w = Workspace(c, load_project(c, 'p1'))
    w.prefer_scan = True
    w.web = NoWeb()
    return w


def _ud_ws():
    # This app's own fake client. It read IGT's, whose audit log names IGT's
    # documents, so a UD tool reading one document's history read entries from
    # the other app's project.
    from ud_fixtures import PID, ExtClient, project_raw, document_raw
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'ud1': document_raw()})
    w = Workspace(c, load_project(c, PID))
    w.web = NoWeb()
    return w


def _umr_ws():
    from umr_fixtures import PID, ExtClient, project_raw, document_raw
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'umr1': document_raw()})
    w = Workspace(c, load_project(c, PID))
    w.web = NoWeb()
    return w


def _args(props, values, param, bad=True):
    """Every argument the tool declares, filled with something it accepts, and
    the swept one filled with something that is not a number (or left out, to
    see what the tool answers without it).

    Only the REQUIRED arguments used to be filled, so a tool that needs an
    optional one refused before it read the number at all: three of the
    thirty-one swept arguments answered exactly the same with and without the
    bad value, which is a case proving nothing.
    """
    args = {}
    for name, spec in props.items():
        if name == param:
            continue
        if name in values:
            args[name] = values[name]
        elif 'integer' in _types(spec) or 'number' in _types(spec):
            args[name] = 1
        elif 'boolean' in _types(spec):
            args[name] = False
    if bad:
        args[param] = NOT_A_NUMBER
    return args


def _check(answer, tool, param):
    assert isinstance(answer, str), f'{tool}.{param} answered with {type(answer).__name__}'
    for leak in PYTHON_LEAKS:
        assert leak not in answer, f'{tool}.{param} handed the model Python\'s own words: {answer!r}'
    assert answer.strip(), f'{tool}.{param} answered with nothing'


def _sweep(app, ws_of, call, values, tool, param, props):
    values = {**values, **OVERRIDES.get(app, {}).get(tool, {})}
    answer = call(ws_of(), tool, _args(props, values, param))
    _check(answer, tool, param)
    # The bad value has to be what the answer is ABOUT. A tool that refused
    # for some other reason (an argument it was never given, a capability it
    # does not have) answers the same either way and proves nothing.
    without = call(ws_of(), tool, _args(props, values, param, bad=False))
    assert answer != without, f'{tool}.{param}: the same answer without the bad value, so nothing read it'


@pytest.mark.parametrize('tool,param,props', IGT_INTS, ids=[f'{t}.{p}' for t, p, _ in IGT_INTS])
def test_igt_integer_arguments_refuse_in_words(tool, param, props):
    _sweep('igt', _igt_ws, igt_call, IGT_ARGS, tool, param, props)


@pytest.mark.parametrize('tool,param,props', UD_INTS, ids=[f'{t}.{p}' for t, p, _ in UD_INTS])
def test_ud_integer_arguments_refuse_in_words(tool, param, props):
    _sweep('ud', _ud_ws, ud_call, UD_ARGS, tool, param, props)


def test_the_sweep_actually_found_the_integers():
    """Without this the two tests above are green on an empty case list."""
    assert len(IGT_INTS) >= 15 and len(UD_INTS) >= 10
    assert ('read_document', 'from_sentence') in [(t, p) for t, p, _ in IGT_INTS]
    assert ('read_document', 'from_sentence') in [(t, p) for t, p, _ in UD_INTS]


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_a_sentence_range_takes_the_references_a_read_prints(app):
    """The model reads "s3" out of a rendered document and writes it back, so
    a sentence argument arrives written that way as often as as a bare number.
    UD's `sentences` has always accepted it; the range did not, in either app."""
    if app == 'igt':
        ws, call, doc = _igt_ws(), igt_call, 'Text 1'
    elif app == 'ud':
        ws, call, doc = _ud_ws(), ud_call, 'Viaje'
    else:
        ws, call, doc = _umr_ws(), umr_call, 'Story'
    plain = call(ws, 'read_document', {'document': doc, 'from_sentence': 2})
    assert plain == call(ws, 'read_document', {'document': doc, 'from_sentence': 's2'})
    assert plain == call(ws, 'read_document', {'document': doc, 'from_sentence': '2'})


# A number a model wrote that is not a whole one. `int()` cuts 2.7 down to 2
# and acts on a position nobody named, which is worse than a refusal: the
# change is made, described, and approved. Every argument naming a POSITION
# goes through `core.args.whole`, which refuses a fraction. The cases are the
# arguments that used to read their own numbers by hand.
FRACTIONS = [
    ('igt', 'split_word', {'document': 'Text 1', 'ref': 's1.w1', 'at': 2.5}, 'split_word'),
    ('igt', 'split_sentence', {'document': 'Text 1', 'ref': 's1', 'before_word': 2.5}, 'split_sentence'),
    ('ud', 'set_head', {'document': 'Viaje', 'ref': 's1.w3', 'head': 2.5, 'deprel': 'obj'}, 'set_head'),
]


@pytest.mark.parametrize('app,tool,args,kind', FRACTIONS, ids=[f'{a}.{t}' for a, t, _, _ in FRACTIONS])
def test_a_position_is_never_truncated_to_a_whole_number(app, tool, args, kind):
    ws, call = (_igt_ws(), igt_call) if app == 'igt' else (_ud_ws(), ud_call)
    answer = call(ws, tool, args)
    _check(answer, tool, list(args)[-1])
    assert answer.startswith('Error:'), f'{tool} accepted a fraction: {answer!r}'
    assert not any(op.get('kind') == kind for op in ws.ops), f'{tool} staged a change for a fraction'


@pytest.mark.parametrize('app,tool,args,kind', FRACTIONS, ids=[f'{a}.{t}' for a, t, _, _ in FRACTIONS])
def test_true_is_not_the_number_one(app, tool, args, kind):
    """`int(True)` is 1, so a boolean used to name the first word, the first
    example, or the root."""
    ws, call = (_igt_ws(), igt_call) if app == 'igt' else (_ud_ws(), ud_call)
    args = {**args, list(args)[-1]: True}
    answer = call(ws, tool, args)
    _check(answer, tool, list(args)[-1])
    assert answer.startswith('Error:'), f'{tool} read True as a number: {answer!r}'
