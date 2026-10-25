"""Discovery says who runs each connected service and whether it would take the
caller's requests, recased like every other key (the JS twin is
plaid-client-js/test/discoverRunner.test.js)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.testing import recording_session

_BODY = [{
    'service-id': 'igt:assistant',
    'service-name': 'Assistant',
    'description': '',
    'extras': {'delegation': True},
    'online': True,
    'runner-name': 'Ana',
    'run-by-you': False,
    'serves-you': True,
}]


def test_discover_services_hands_back_runner_name_run_by_you_and_serves_you():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([(200, _BODY)])
    found = client.messages.discover_services('p1')
    assert found[0]['runner_name'] == 'Ana'
    assert found[0]['run_by_you'] is False
    assert found[0]['serves_you'] is True
