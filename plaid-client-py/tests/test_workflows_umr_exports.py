"""Every name ``plaid_client.workflows.umr`` exports has a user outside it.

The package is shared by the assistant in plaid-agent and the bundled UMR
services, and its re-exports are the surface they reach for. A name exported
and never imported reads as part of that surface while nothing depends on it,
so this lists each export no Python file outside the package names.
"""

import pathlib
import re
import subprocess

import plaid_client.workflows.umr as umr

REPO = pathlib.Path(__file__).resolve().parents[2]
PACKAGE = 'plaid-client-py/src/plaid_client/workflows/umr/'
SUBMODULES = {'graph', 'inventory', 'layers', 'penman', 'write'}


def test_every_export_is_used_outside_the_package():
    files = subprocess.run(['git', 'ls-files', '*.py'], cwd=REPO, capture_output=True,
                           text=True, check=True).stdout.split()
    text = '\n'.join((REPO / f).read_text(encoding='utf-8') for f in files
                     if not f.startswith(PACKAGE) and (REPO / f).is_file())
    unused = [name for name in umr.__all__ if name not in SUBMODULES
              and not re.search(rf'\b{re.escape(name)}\b', text)]
    assert unused == []


def test_every_export_is_importable():
    assert [name for name in umr.__all__ if not hasattr(umr, name)] == []
