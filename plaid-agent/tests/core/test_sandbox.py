"""The harness: code runs against host functions and nothing else."""

import pytest

from plaid_agent.core import sandbox

pytestmark = pytest.mark.skipif(sandbox.available() is not None, reason=sandbox.available() or '')


def test_code_sees_the_host_functions_and_returns_what_it_prints_and_its_value():
    out = sandbox.run('print("hello"); double(x=4) + 1', {'double': lambda x: x * 2})
    assert out == 'hello\n=> 9'


def test_the_filesystem_and_network_are_out_of_reach():
    with pytest.raises(sandbox.CodeError, match='PermissionError'):
        sandbox.run('open("/etc/passwd").read()', {})


def test_a_missing_module_names_what_the_sandbox_has():
    with pytest.raises(sandbox.CodeError) as e:
        sandbox.run('import numpy', {})
    assert 'ModuleNotFoundError' in str(e.value) and 'collections' in str(e.value)


def test_an_error_carries_what_was_printed_before_it():
    with pytest.raises(sandbox.CodeError) as e:
        sandbox.run('print("so far")\nraise ValueError("boom")', {})
    assert 'ValueError: boom' in str(e.value) and 'Printed before it stopped:\nso far' in str(e.value)


def test_a_host_function_that_refuses_is_an_error_the_code_can_catch():
    def load(name):
        raise ValueError(f'No document "{name}"')
    out = sandbox.run('try:\n    load("x")\nexcept ValueError as e:\n    print("caught:", e)\n', {'load': load})
    assert 'caught: No document "x"' in out


def test_output_is_capped():
    out = sandbox.run('for i in range(5000):\n    print("x" * 10)\n', {})
    assert len(out) < sandbox.OUTPUT_MAX + 200 and '[truncated' in out


def test_nothing_printed_and_no_value_says_so():
    assert 'printed nothing' in sandbox.run('x = 1', {})

