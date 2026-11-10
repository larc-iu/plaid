"""A replacement reads one syntax in the app and the assistant (REV-BL-B-2).

igt's Bulk Edit and a vocabulary's Replace read a regex replacement as
JavaScript's String.replace does (`$1`, `$<name>`, `$&`, `$$`) and refuse a
backslash in it, and the guide says so. The assistant read the replacement as
a Python template, so `\\1` was a group and the guide's `$1` was written as
those two characters: `(o)` to `$1x` made `foo` into `f$1x$1x`. Both sides
now read plaid-igt's replacement_cases.json (replacer.test.js the app's side,
this the assistant's), the same cases with the same written strings.
"""

import json
import os

import pytest

from plaid_agent.core.replace import replacer
from plaid_agent.core.tools import ToolError

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, '..', '..', 'plaid-igt', 'src', 'domain', 'replacement_cases.json'),
          encoding='utf-8') as f:
    CASES = json.load(f)


@pytest.mark.parametrize('pattern,replacement,value,written', CASES['regex'])
def test_a_regex_replacement_reads_as_the_app_reads_it(pattern, replacement, value, written):
    # The app's regex counts case unless the pattern says (?i).
    assert replacer(pattern, replacement, True, False, True)(value) == written


@pytest.mark.parametrize('find,replacement,value,written', CASES['literal'])
def test_a_plain_replacement_is_text(find, replacement, value, written):
    assert replacer(find, replacement, False, False, False)(value) == written


@pytest.mark.parametrize('replacement,digit', CASES['refused'])
def test_a_backslash_in_a_regex_replacement_is_refused(replacement, digit):
    with pytest.raises(ToolError) as e:
        replacer('(a)', replacement, True, False, True)
    assert str(e.value) == ('A regex replacement cannot hold a backslash. Type the character itself.'
                            + (f' Write ${digit} for a group.' if digit else ''))
    assert e.value.kind == 'invalid-argument'


def test_a_group_written_back_into_a_whole_value():
    assert replacer(r'(\w+)-(\w+)', '$2-$1', True, True, True)('a-b') == 'b-a'
    assert replacer(r'(\w+)-(\w+)', '$2-$1', True, True, True)('a-b c') == 'a-b c'
