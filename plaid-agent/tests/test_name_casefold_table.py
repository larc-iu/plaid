"""Core folds document names by a table of Python's str.casefold
(plaid-core/resources/casefold.txt), so that two names are one exactly when
the assistant's casefold says so, and plaid-ui reads the combining marks'
names from plaid-ui/src/domain/markNames.js. Both must be what this Python
gives. If the Unicode version moved, rerun plaid-core/scripts/casefold_table.py."""
import subprocess
import sys
import unicodedata

import pytest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'plaid-core' / 'scripts' / 'casefold_table.py'


def _table_unicode():
    head = (SCRIPT.parents[1] / 'resources' / 'casefold.txt').read_text(encoding='utf-8').split('\n', 1)[0]
    return head.split('Unicode ', 1)[1].split(':', 1)[0]


def test_the_tables_are_this_pythons():
    # A Python of another Unicode version folds a few newly assigned letters
    # differently, so only a Python of the tables' own version can check them.
    if unicodedata.unidata_version != _table_unicode():
        pytest.skip(f'tables are Unicode {_table_unicode()}, this Python is {unicodedata.unidata_version}')
    r = subprocess.run([sys.executable, '-I', str(SCRIPT), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
