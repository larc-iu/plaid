"""Reading a number a model wrote, and refusing one in words.

Every refusal a tool makes is a sentence the model can act on. The readers
here exist because `int()` is the one that is not, so a reader of theirs that
raises something other than a sentence puts the problem back where it started.
"""

import pytest

from plaid_agent.core.args import clamp_limit, read_int, whole
from plaid_agent.core.tools import run_tool


class Ws:
    """What `run_tool` touches of a workspace."""

    def forget_clipping(self):
        pass


@pytest.mark.parametrize('value', [2.5, True, 'twenty', '²', 's3', '', None])
def test_a_position_that_is_not_a_whole_number_refuses_in_a_sentence(value):
    """It used to raise the VALUE: an uncaught caller answered the model
    "Error: 2.5", which says nothing about what was wrong or which argument
    it was about."""
    with pytest.raises(ValueError) as e:
        whole(value, 'at')
    said = str(e.value)
    assert said.startswith('"at" has to be a whole number'), said
    assert said != str(value) and said.endswith('.')


def test_a_whole_number_is_read_however_it_was_written():
    assert whole(3) == 3 and whole(3.0) == 3 and whole(' 3 ') == 3 and whole('-3') == -3


def test_an_uncaught_position_reaches_the_model_as_the_tools_own_words():
    """Most callers catch this and say what the argument is for in their own
    words. The next one to forget answers with a sentence all the same."""
    def t_pick(ws, at=None):
        return f'picked {whole(at, "at")}'

    assert run_tool(Ws(), 'pick', t_pick, {'at': 2}) == 'picked 2'
    assert run_tool(Ws(), 'pick', t_pick, {'at': 2.5}) == 'Error: "at" has to be a whole number, not 2.5.'


def test_the_other_readers_already_answer_in_sentences():
    """`whole` was the odd one out: its siblings name the argument."""
    with pytest.raises(ValueError, match='"limit" has to be a number'):
        clamp_limit('lots', 30, 200)
    with pytest.raises(ValueError, match='"offset" has to be a number'):
        read_int('lots', 'offset', 0)
