"""The harness: code runs against host functions and nothing else."""

import pytest

from live import require_sandbox
from plaid_agent.core import sandbox

pytestmark = require_sandbox()


@pytest.fixture
def run():
    """The one way code runs: in a worker held for the turn, released after.

    There used to be a second path, a fresh worker per call, which no tool
    took and only these tests did. Testing a path nothing uses proves nothing
    about the one everything uses, so these go through a session too.
    """
    session = sandbox.Session()
    try:
        yield lambda code, api=None, **kw: sandbox.run(code, api or {}, session=session, **kw)
    finally:
        session.close()


def test_code_sees_the_host_functions_and_returns_what_it_prints_and_its_value(run):
    assert run('print("hello"); double(x=4) + 1', {'double': lambda x: x * 2}) == 'hello\n=> 9'


def test_the_filesystem_and_network_are_out_of_reach(run):
    with pytest.raises(sandbox.CodeError, match='PermissionError'):
        run('open("/etc/passwd").read()')


def test_a_missing_module_names_what_the_sandbox_has(run):
    with pytest.raises(sandbox.CodeError) as e:
        run('import numpy')
    assert 'ModuleNotFoundError' in str(e.value) and 'collections' in str(e.value)


def test_an_error_carries_what_was_printed_before_it(run):
    with pytest.raises(sandbox.CodeError) as e:
        run('print("so far")\nraise ValueError("boom")')
    assert 'ValueError: boom' in str(e.value) and 'Printed before it stopped:\nso far' in str(e.value)


def test_a_host_function_that_refuses_is_an_error_the_code_can_catch(run):
    def load(name):
        raise ValueError(f'No document "{name}"')
    out = run('try:\n    load("x")\nexcept ValueError as e:\n    print("caught:", e)\n', {'load': load})
    assert 'caught: No document "x"' in out


def test_output_is_capped(run):
    out = run('for i in range(5000):\n    print("x" * 10)\n')
    assert len(out) < sandbox.OUTPUT_MAX + 200 and '[truncated' in out


def test_nothing_printed_and_no_value_says_so(run):
    assert 'printed nothing' in run('x = 1')


def test_names_persist_between_calls_in_one_turn(run):
    """What one call computed is there for the next, which is the whole
    reason a turn holds one worker."""
    run('tally = {"a": 1}')
    assert run('print(tally["a"] + 1)') == '2'


def test_the_help_names_the_budget_that_actually_applies():
    """One worker per turn means one interpreter budget, and it is the one
    the help promises. The help used to name a per-call limit that belonged
    to a path no tool took."""
    text = sandbox.help_text('')
    assert f'{sandbox.TURN_EXEC_SECONDS:.0f} seconds of computation' in text
    assert not hasattr(sandbox, 'EXEC_SECONDS')
