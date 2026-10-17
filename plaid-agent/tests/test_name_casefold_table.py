"""Core folds document names by a table of Python's str.casefold
(plaid-core/resources/casefold.txt), so that two names are one exactly when
the assistant's casefold says so, and plaid-ui reads the combining marks'
names from plaid-ui/src/domain/markNames.js. Both must be what this Python
gives. If the Unicode version moved, rerun plaid-core/scripts/casefold_table.py."""
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'plaid-core' / 'scripts' / 'casefold_table.py'


def test_the_tables_are_this_pythons():
    r = subprocess.run([sys.executable, '-I', str(SCRIPT), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
