"""Core and plaid-ui fold document names by a table of Python's str.casefold
(plaid-core/resources/casefold.txt, plaid-ui/src/lib/caseFoldTable.js), so that
two names are one exactly when the assistant's casefold says so. Both tables
must be what this Python's casefold gives. If the Unicode version moved, rerun
plaid-core/scripts/casefold_table.py."""
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'plaid-core' / 'scripts' / 'casefold_table.py'


def test_both_tables_are_python_casefold():
    r = subprocess.run([sys.executable, '-I', str(SCRIPT), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
