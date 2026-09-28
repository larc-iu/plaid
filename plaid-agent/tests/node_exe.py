"""The node the mirror tests run the apps' own JavaScript with.

A non-interactive shell (a hook, a cron job, an agent's shell on larc) has no
node on PATH, since nvm puts it there only in an interactive one. The mirror
tests then skipped every case, green with an "s" nobody reads, and a mirror
that does not run is not one. So node is looked for where it is installed, the
way plaid-umr's format-fixtures test looks for python, and a mirror that still
cannot run says so in the warnings summary as well as in its skip.

``PLAID_NODE`` names the node to use. Otherwise: nvm's own (``NVM_BIN``), the
one on PATH, then every nvm install under ``~/.nvm/versions/node``, newest
first, then the usual system places.
"""

import glob
import os
import shutil
import subprocess
import warnings
from typing import List, Optional

import pytest

#: The oldest node the apps' ESM modules run on.
MIN_MAJOR = 18


def _major(exe: str) -> int:
    try:
        v = subprocess.run([exe, '--version'], capture_output=True, text=True,
                           timeout=30).stdout
        return int(v.strip().lstrip('v').split('.')[0])
    except Exception:  # noqa: BLE001 - any trouble asking means do not rely on it
        return 0


def _nvm_installs() -> List[str]:
    root = os.path.join(os.environ.get('NVM_DIR') or os.path.expanduser('~/.nvm'),
                        'versions', 'node')
    found = glob.glob(os.path.join(root, 'v*', 'bin', 'node'))

    def version(path):
        name = os.path.basename(os.path.dirname(os.path.dirname(path))).lstrip('v')
        try:
            return tuple(int(p) for p in name.split('.'))
        except ValueError:
            return ()

    return sorted(found, key=version, reverse=True)


def candidates() -> List[str]:
    out = []
    if os.environ.get('PLAID_NODE'):
        return [os.environ['PLAID_NODE']]
    if os.environ.get('NVM_BIN'):
        out.append(os.path.join(os.environ['NVM_BIN'], 'node'))
    on_path = shutil.which('node')
    if on_path:
        out.append(on_path)
    out += _nvm_installs()
    out += ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node']
    seen = set()
    return [c for c in out if not (c in seen or seen.add(c))]


def find_node() -> Optional[str]:
    """A node of :data:`MIN_MAJOR` or later, or None."""
    for exe in candidates():
        if os.path.isfile(exe) and os.access(exe, os.X_OK) and _major(exe) >= MIN_MAJOR:
            return exe
    return None


def node_or_skip(why: str) -> str:
    """The node to run with, or a skip that is also a warning. ``why`` says
    what else the test needs, for the message. With ``PLAID_AGENT_REQUIRE_LIVE``
    set the skip is a failure, as for the live tests."""
    exe = find_node()
    if exe:
        return exe
    tried = ', '.join(candidates()) or 'nothing'
    message = (f'no node {MIN_MAJOR}+ found (tried {tried}). Set PLAID_NODE to one. {why}')
    if os.environ.get('PLAID_AGENT_REQUIRE_LIVE'):
        raise AssertionError(f'{message} (PLAID_AGENT_REQUIRE_LIVE is set)')
    warnings.warn(message, pytest.PytestWarning, stacklevel=2)
    pytest.skip(message)
