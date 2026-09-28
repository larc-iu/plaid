"""The igt model services name who asked for a run, in the History label and
on every stamp they write (umr-collab-service-requester). The run harness is
the one the model-down tests use.

Run: pytest plaid-igt/services/tests"""

import types

import pytest
from plaid_client import testing as servicetest

from test_igt_model_down import SERVICES_UNDER_TEST, REQUEST, _service


@pytest.mark.parametrize('module, cls, reply', SERVICES_UNDER_TEST)
def test_a_run_names_who_asked_in_history_and_on_what_it_writes(module, cls, reply):
    service = _service(module, cls, [reply] * 5)
    service.client.users = types.SimpleNamespace(
        get=lambda uid: {'id': uid, 'display_name': 'second'})
    servicetest.run(service, {**REQUEST, 'requester_id': 'second@x.com'})

    [label] = service.client.operations
    assert label.endswith(', requested by second'), label
    # Both write each gloss or translation as a span, its metadata the fourth argument.
    stamped = [call['args'][3] for kind, call in service.client.calls if kind == 'spans.create']
    assert stamped, "nothing was written"
    for meta in stamped:
        assert meta['provDetail']['requestedBy'] == 'second@x.com'
