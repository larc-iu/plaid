"""The igt model services name who asked for a run, in the History label and
on every stamp they write (umr-collab-service-requester). The run harness is
the one the model-down tests use.

Run: pytest plaid-igt/services/tests"""

import types

import pytest
from plaid_client import testing as servicetest
from plaid_client.service import service_version

from test_igt_model_down import SERVICES_UNDER_TEST, REQUEST, _service


def _span_stamps(client):
    """The metadata of every span the run created, alone or in a bulk create."""
    return ([call['args'][3] for kind, call in client.calls if kind == 'spans.create']
            + [entry['metadata'] for payload in client.payloads('spans.bulk_create')
               for entry in payload])


@pytest.mark.parametrize('module, cls, reply', SERVICES_UNDER_TEST)
def test_a_run_names_who_asked_in_history_and_on_what_it_writes(module, cls, reply):
    service = _service(module, cls, [reply] * 5)
    service.client.users = types.SimpleNamespace(
        get=lambda uid: {'id': uid, 'display_name': 'second'})
    servicetest.run(service, {**REQUEST, 'requester_id': 'second@x.com'})

    [label] = service.client.operations
    assert label.endswith(', requested by second'), label
    # Both write each gloss or translation as a span, its metadata the fourth argument.
    stamped = _span_stamps(service.client)
    assert stamped, "nothing was written"
    for meta in stamped:
        assert meta['provDetail']['requestedBy'] == 'second@x.com'


@pytest.mark.parametrize('module, cls, reply', SERVICES_UNDER_TEST)
def test_every_stamp_names_the_model_and_this_files_version(module, cls, reply):
    service = _service(module, cls, [reply] * 5)
    servicetest.run(service, REQUEST)

    stamped = _span_stamps(service.client)
    assert stamped, "nothing was written"
    for meta in stamped:
        assert meta['provDetail']['model'] == 'fake/m'
        assert meta['provDetail']['version'] == service_version(module.__file__)
