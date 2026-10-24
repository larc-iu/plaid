import importlib.util
from pathlib import Path

import pytest

# The suite tests the packages of the repo it sits in, never an installed copy
# from another checkout: `bb test` sets PYTHONPATH to this repo's sources, and a
# run that would import plaid_client or plaid_agent from anywhere else stops
# here, before a test passes against the wrong code.
REPO = Path(__file__).resolve().parents[2]
for _name in ('plaid_client', 'plaid_agent'):
    _spec = importlib.util.find_spec(_name)
    if _spec is not None and not Path(_spec.origin).resolve().is_relative_to(REPO):
        raise pytest.UsageError(
            f'{_name} is imported from {_spec.origin}, outside {REPO}. Run this suite with '
            f'PYTHONPATH={REPO}/plaid-client-py/src:{REPO}/plaid-agent/src, as `bb test` does.'
        )
