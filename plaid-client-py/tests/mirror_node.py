"""What a mirror test needs to run an app's JavaScript beside this package.

A mirror runs plaid-igt's or plaid-client-js's own modules under plain node,
and plaid-igt's reach ``@larc-iu/plaid-client`` through plaid-igt's own
node_modules. Without them node exits with an import error, which read as 16
errors in a checkout that had not run ``npm ci`` there. So a mirror skips, and
says what is missing, when node or a file it runs is not here, and never when
the two sides disagree. With ``PLAID_AGENT_REQUIRE_LIVE`` set the skip is a
failure, as for plaid-agent's mirrors.
"""

import os
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
#: What plaid-igt's domain modules import through.
IGT_MODULES = ROOT / 'plaid-igt' / 'node_modules'


def node_or_skip(*needs) -> str:
    """The node to run with, once every path in ``needs`` exists, or a skip
    naming what is missing (a failure under ``PLAID_AGENT_REQUIRE_LIVE``)."""
    exe = shutil.which('node')
    missing = ([] if exe else ['node']) + [str(p) for p in needs if not os.path.exists(p)]
    if missing:
        why = 'the mirror needs ' + ', '.join(missing)
        if os.environ.get('PLAID_AGENT_REQUIRE_LIVE'):
            raise AssertionError(f'{why} (PLAID_AGENT_REQUIRE_LIVE is set)')
        pytest.skip(why)
    return exe
