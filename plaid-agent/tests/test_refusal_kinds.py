"""Every refusal a tool gives names its kind, the loop stores it on the step,
and the research extractor reads it (Luke, R19, 2026-10-24).

The extractor used to class a refusal by matching its words, so a reworded
refusal moved between classes and nothing failed. The kind is now written
where the refusal is, from one closed list (``core.tools.REFUSAL_KINDS``).
"""

import ast
import pathlib

import pytest

from plaid_agent.core.tools import (REFUSAL_KINDS, Refusal, ToolError, ValueRefusal, kind_of, refused,
                                    run_tool, server_refused)

SRC = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'plaid_agent'
RAISERS = {'ToolError', 'ValueRefusal'}


def _calls():
    for path in sorted(SRC.rglob('*.py')):
        name = path.relative_to(SRC).as_posix()
        tree = ast.parse(path.read_text())
        # `refused` is core.tools' only where a module imports it from there
        # (core/service.py has its own, for an op turned down).
        own_refused = name == 'core/tools.py' or any(
            isinstance(n, ast.ImportFrom) and (n.module or '').endswith('tools') and n.level
            and any(a.name == 'refused' for a in n.names) for n in ast.walk(tree))
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call):
                continue
            f = n.func.id if isinstance(n.func, ast.Name) else n.func.attr if isinstance(n.func, ast.Attribute) else None
            if f in RAISERS or (f == 'refused' and own_refused):
                yield name, n, f


def test_every_refusal_names_its_kind_from_the_closed_list():
    missing, unknown, seen = [], [], 0
    for name, call, f in _calls():
        seen += 1
        kw = next((k.value for k in call.keywords if k.arg == 'kind'), None)
        if kw is None and f == 'refused' and len(call.args) > 1:
            kw = call.args[1]
        if kw is None:
            missing.append(f'{name}:{call.lineno}')
        elif isinstance(kw, ast.Constant) and kw.value not in REFUSAL_KINDS:
            unknown.append(f'{name}:{call.lineno} {kw.value!r}')
    assert seen > 300, 'the walk found the raise sites'
    assert not missing, f'a refusal with no kind: {missing}'
    assert not unknown, f'a kind outside REFUSAL_KINDS: {unknown}'


def test_a_kind_is_required_and_checked():
    with pytest.raises(TypeError):
        ToolError('No such word.')
    with pytest.raises(ValueError):
        ToolError('No such word.', kind='not_found')
    assert ToolError('x', kind='conflict').kind == 'conflict'
    v = ValueRefusal('No field named "x".', kind='not-found')
    assert isinstance(v, ValueError) and v.kind == 'not-found'
    assert kind_of(v, 'invalid-argument') == 'not-found' and kind_of(ValueError('x'), 'ambiguous') == 'ambiguous'


class _Ws:
    def forget_clipping(self):
        pass


@pytest.mark.parametrize('raised,kind', [
    (ToolError('This plan already respells it.', kind='conflict'), 'conflict'),
    (ValueRefusal('"Gloss" names several fields.', kind='ambiguous'), 'ambiguous'),
    (ValueError('a lookup that names no kind'), 'invalid-argument'),
    (RuntimeError('a bug'), 'tool-fault'),
])
def test_run_tool_answers_with_the_kind_of_what_was_raised(raised, kind, capsys):
    def tool(ws):
        raise raised
    out = run_tool(_Ws(), 'read_thing', tool, {})
    assert isinstance(out, Refusal) and out.kind == kind


def test_a_call_with_arguments_the_tool_does_not_take_is_an_invalid_argument():
    out = run_tool(_Ws(), 'read_thing', lambda ws, form: form, {'lemma': 'x'})
    assert isinstance(out, Refusal) and out.kind == 'invalid-argument'
    assert refused('No word.', 'not-found').kind == 'not-found'


class _HttpError(Exception):
    def __init__(self, status):
        super().__init__(f'HTTP {status}')
        self.status = status


@pytest.mark.parametrize('status,kind', [(403, 'not-allowed'), (404, 'not-found'), (409, 'conflict'),
                                         (413, 'too-large'), (500, 'unavailable'), (0, 'unavailable')])
def test_a_read_the_server_refused_takes_its_kind_from_the_status(status, kind):
    assert server_refused('The comments', _HttpError(status)).kind == kind


def test_the_extractor_reads_the_stored_kind_and_the_words_only_without_it():
    from plaid_agent.research.pseudo import Pseudonyms
    from plaid_agent.research.records import DROPPED, Conversations
    conv = Conversations(Pseudonyms(b'k' * 32))
    # A refusal whose words the regex would class otherwise ("already"), a
    # pruned one that stored its kind, and an old one with no kind.
    steps = [{'id': 'c1', 'name': 'set_field', 'kind': 'plan', 'label': 'x', 'failed': True,
              'error_kind': 'not-allowed'},
             {'id': 'c2', 'name': 'search', 'kind': 'read', 'label': 'x', 'failed': True, 'error_kind': 'not-found'},
             {'id': 'c3', 'name': 'search', 'kind': 'read', 'label': 'x', 'failed': True},
             {'id': 'c4', 'name': 'search', 'kind': 'read', 'label': 'x', 'failed': True}]
    calls = [{'id': 'c1', 'name': 'set_field', 'arguments': '{}', 'result': 'Error: already closed to you.'},
             {'id': 'c2', 'name': 'search', 'arguments': '{}', 'result': DROPPED},
             {'id': 'c3', 'name': 'search', 'arguments': '{}', 'result': 'Error: No word "x".'},
             {'id': 'c4', 'name': 'search', 'arguments': '{}', 'result': DROPPED}]
    record = {'messages': [{'role': 'user', 'content': 'q'}], 'display': [
        {'kind': 'user', 'text': 'q'}, {'kind': 'assistant', 'text': 'Done.', 'steps': steps, 'calls': calls}]}
    conv.add('u@x', 'igt', 'p1', 'c1', record, None, 10, None)
    got = [(r['error_class'], r['error_class_from']) for r in conv.tool_calls]
    assert got == [('not-allowed', 'step'), ('not-found', 'step'), ('not-found', 'text'), ('unknown', None)]


def test_the_words_are_classed_in_the_same_kinds_as_the_steps_store():
    from plaid_agent.research.records import ERROR_CLASSES
    assert {name for name, _ in ERROR_CLASSES} <= set(REFUSAL_KINDS)
