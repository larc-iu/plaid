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


def test_an_argument_of_the_wrong_json_type_is_an_invalid_argument(capsys):
    # HUNT-recent 20: a list where the schema says string failed inside the
    # tool (.strip() on a list) and read as a fault of the tool.
    schema = {'type': 'object', 'properties': {'form': {'type': 'string'}, 'n': {'type': 'integer'}}}

    def tool(ws, form=None, n=None):
        return form.strip()

    out = run_tool(_Ws(), 'read_thing', tool, {'form': ['a', 'b']}, schema=schema)
    assert isinstance(out, Refusal) and out.kind == 'invalid-argument', out
    assert 'form' in str(out) and 'string' in str(out) and 'list' in str(out), out
    # A bug with every argument of its declared type is still the tool's.
    out = run_tool(_Ws(), 'read_thing', lambda ws, form=None: form.nope, {'form': 'a'}, schema=schema)
    assert out.kind == 'tool-fault'
    # So is a type the tool takes anyway: the type is only read once it failed.
    assert run_tool(_Ws(), 'read_thing', lambda ws, n=None: str(int(n) + 1), {'n': '2'}, schema=schema) == '3'


def test_every_app_hands_run_tool_the_schema_it_declared():
    from plaid_agent.core.tools import Refusal as R
    from plaid_agent.igt.toolkit import call_tool
    from fixtures import FakeClient, fake_ws
    out = call_tool(fake_ws(FakeClient()), 'add_comment', {'document': 'Text 1', 'ref': 's1', 'body': 5})
    assert isinstance(out, R) and out.kind == 'invalid-argument', out


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


# REV-W3-REST A1 to A6: one cause, one kind, in every app.

@pytest.mark.parametrize('status,kind', [(400, 'query-refused'), (422, 'query-refused'), (500, 'unavailable'),
                                         (0, 'unavailable'), (423, 'conflict'), (408, 'too-large')])
def test_a_query_the_server_answered_is_query_refused_only_when_the_engine_refused_it(status, kind):
    from plaid_agent.core.corpus import query_refused
    from plaid_agent.core.query import QueryRefused, run

    assert query_refused(_HttpError(status)).kind == kind

    class Client:
        def query(self, q):
            raise _HttpError(status)
    with pytest.raises(QueryRefused) as e:
        run(Client(), {'where': [], 'find': ['?x']}, 'p1')
    assert e.value.kind == kind


def test_a_query_refused_before_it_is_sent_is_query_refused():
    from plaid_agent.core.query import QueryRefused
    assert QueryRefused('query must be a JSON object').kind == 'query-refused'


@pytest.mark.parametrize('status,kind', [(423, 'conflict'), (408, 'too-large')])
def test_a_held_document_and_a_query_timeout_have_their_own_kinds(status, kind):
    from plaid_agent.core.tools import kind_of_status
    assert kind_of_status(_HttpError(status)) == kind


@pytest.mark.parametrize('code,reason,kind', [('', None, 'invalid-argument'), (5, None, 'invalid-argument'),
                                              ('1', 'not installed', 'unavailable')])
def test_run_code_refusals_take_the_kind_of_their_cause(code, reason, kind, monkeypatch):
    from plaid_agent.core import sandbox
    monkeypatch.setattr(sandbox, 'available', lambda: reason)
    with pytest.raises(sandbox.CodeError) as e:
        sandbox.run(code, {}, session=None)
    assert e.value.kind == kind
    assert sandbox.CodeError('x').kind == 'code-failed'
    assert kind_of(sandbox.CodeError('x', kind='too-large'), 'code-failed') == 'too-large'


def test_a_value_off_a_closed_list_is_an_invalid_argument_in_igt_and_ud():
    from plaid_agent.core.workspace import BaseWorkspace
    from plaid_agent.ud.tools import _check_feature

    class Held:
        def value_rules(self, layer_id):
            return 'Gloss', [{'values': ['a', 'b']}]
    with pytest.raises(ToolError) as e:
        BaseWorkspace.refuse_value(Held(), 'l1', 'c')
    assert e.value.kind == 'invalid-argument'

    class Project:
        vocab = {'feats': {'Number': ['Sing', 'Plur']}}
        modes = {'feats': 'closed'}

    class UdWs:
        project = Project()
    for feature, value in (('Case', 'Nom'), ('Number', 'Dual')):
        with pytest.raises(ToolError) as e:
            _check_feature(UdWs(), feature, value)
        assert e.value.kind == 'invalid-argument'
