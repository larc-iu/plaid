"""The service-handler harness the client ships for service authors.

``plaid_client.testing`` is a public module, and the suites that use it live in
other repos (both apps' ``services/tests``), so what it promises is checked
here: a service loads from its path, a run reaches the handler on a thread of
its own and reports, and a batch that raises reaches the server with nothing.

Run: cd plaid-client-py && python -m pytest tests/ -q
"""

import sys
import types

import pytest

from plaid_client import testing
from plaid_client.service import BaseService
from plaid_client.services import ServiceCancelled


def test_a_service_loads_from_its_path_and_gives_the_stand_ins_back(tmp_path):
    # A service is a script, not an installed module, and the ones worth
    # testing import a model library at module level.
    (tmp_path / 'my_service.py').write_text(
        'import heavy_model\n\nLOADED = heavy_model.NAME\n')
    stand_in = types.ModuleType('heavy_model')
    stand_in.NAME = 'stood in'

    module = testing.load_service(tmp_path / 'my_service.py', {'heavy_model': stand_in})

    assert module.LOADED == 'stood in'
    assert 'heavy_model' not in sys.modules


class _Service(BaseService):
    """A handler with one beat and one write, and a failure on request."""

    def process_request(self, request_data, response_helper):
        response_helper.progress(50, 'Working...')
        with self.client.batched() as b:
            b.tokens.bulk_create([{'begin': 0, 'end': 1}])
            if request_data.get('fail'):
                raise ValueError('the model said no')
        response_helper.complete({'ok': True})


def _service(fails=None):
    service = _Service('svc', 'Svc', 'a service')
    service.client = testing.FakeClient([{'id': 'd1'}], fails=fails)
    return service


def test_a_run_reaches_the_handler_and_reports():
    service = _service()

    helper = testing.run(service, {'document_id': 'd1'})

    assert helper.errors == []
    assert helper.results == [{'ok': True}]
    assert helper.beats == [(50, 'Working...')]
    [(kind, ops)] = service.client.writes
    assert kind == 'tokens.bulk_create' and ops == [{'begin': 0, 'end': 1}]


def test_a_batch_that_raises_reaches_the_server_with_nothing():
    service = _service()

    helper = testing.run(service, {'document_id': 'd1', 'fail': True})

    assert service.client.writes == []
    assert len(helper.errors) == 1


def test_a_stop_is_read_at_the_next_checkpoint():
    # What ``critical()`` is for: a stop pressed during the block is held off
    # until the block ends, so half-written work is never left behind.
    helper = testing.Helper(stop_when=lambda pct, msg: pct == 50)
    with helper.critical():
        helper.progress(50, 'Working...')
        helper.raise_if_cancelled()
    assert helper.cancelled
    with pytest.raises(ServiceCancelled):
        helper.raise_if_cancelled()
