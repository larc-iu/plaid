"""The limits the query help tells the model are read from the names the
tools enforce, never typed out again (BH-7c, R2-DICT-5's kind).

``query_help`` said "default 50, up to 500" and "stop at 1000 rows" by hand,
beside the ``READ_LIMITS`` pair and the clamp that enforce them, and a typed
number keeps reading true after the name it copied is raised. The same goes for
run_code's ``query()`` help and the Grew search's time-out message. Core's own
time limit for one query is held to core's source here, since the agent only
repeats it.
"""

import re
from pathlib import Path

from plaid_agent.core import query
from plaid_agent.core.limits import QUERY_ROWS, QUERY_SECONDS, READ_LIMITS

from test_schema_numbers import SRC, typed_numbers

HELP_MODULES = ('core/query.py', 'core/sandbox.py', 'ud/grew_search.py')
LIMIT = re.compile(r'\b(stop at|default|up to|max) \d{2,}|\b\d{2,} rows\b|\b\d+ s\b')
EXEC = (Path(__file__).resolve().parents[2] / 'plaid-core' / 'src' / 'main' / 'plaid' / 'sql' / 'query'
        / 'exec.clj')


def test_the_help_texts_type_no_limit():
    found = [f'{rel}:{line}: {LIMIT.search(text).group(0)!r}' for rel in HELP_MODULES
             for line, text in typed_numbers((SRC / rel).read_text(encoding='utf-8'), LIMIT)]
    assert not found, 'A help text types out a limit its tool reads from a name:\n' + '\n'.join(found)


def test_the_query_help_names_the_limits_it_enforces():
    shown, cap = READ_LIMITS['query']
    assert f'stop at {QUERY_ROWS} rows' in query.HELP
    assert f'default {shown}, up to {cap}. {QUERY_SECONDS} s per query.' in query.HELP


def test_a_query_asks_the_engine_for_the_rows_the_help_names():
    seen = {}

    class Client:
        def query(self, q):
            seen.update(q)
            return {'results': []}

    query.run(Client(), {'find': ['?s'], 'where': [], 'limit': 10 * QUERY_ROWS}, 'p1')
    assert seen['limit'] == QUERY_ROWS


def test_the_query_seconds_are_cores():
    text = EXEC.read_text(encoding='utf-8')
    m = re.search(r'\(def \^:dynamic \*query-timeout-ms\*\s+"(?:[^"\\]|\\.)*"\s+(\d+)\)', text)
    assert m, f'no *query-timeout-ms* in {EXEC}'
    assert int(m.group(1)) == QUERY_SECONDS * 1000
