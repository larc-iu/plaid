"""A number a tool schema promises the model is read from the name the tool
uses, never typed out again (R2-DICT-5).

``core.tools.limit_arg`` was written because a schema said 30 where the tool
answered with a hundred rows. The snapshot test cannot catch that drift, since
the snapshot is regenerated from the stale text. So every string in the
modules that declare schemas that says "default N", "up to N" or "max N" must
be an f-string, which is where the number comes from a name. "default 1" is
the first sentence or line, a position rather than a limit, and stays.
"""

import ast
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / 'src' / 'plaid_agent'
SCHEMA_MODULES = ('core/toolkit.py', 'core/webtools.py', 'core/filetools.py',
                  'igt/toolkit.py', 'ud/toolkit.py', 'umr/toolkit.py')
NUMBER = re.compile(r'\b(default|up to|max) (?!1\b)\d')


def typed_numbers(source: str):
    tree = ast.parse(source)
    formatted = {id(n) for f in ast.walk(tree) if isinstance(f, ast.JoinedStr) for n in ast.walk(f)}
    return [(n.lineno, n.value) for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in formatted
            and NUMBER.search(n.value)]


def test_schema_numbers_come_from_names():
    found = [f'{rel}:{line}: {text!r}' for rel in SCHEMA_MODULES
             for line, text in typed_numbers((SRC / rel).read_text(encoding='utf-8'))]
    assert not found, 'A schema types out a number its tool reads from a name:\n' + '\n'.join(found)


def test_the_check_sees_a_typed_number():
    source = 'x = {"description": "Max entries (default 80)."}\ny = f"Max entries (default {N})."\n'
    assert [line for line, _ in typed_numbers(source)] == [1]
