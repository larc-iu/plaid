"""A service whose request ended under it says so in its log
(conc-2026-09-29 REV-W-AUDIT).

The server lets a service write into the operation it was handed only while
the request runs. When the service's channel drops mid-run the server fails
the request, and when the server restarts it forgets it, so the service's
later writes are refused. The log said "Operation group ... was started by
another user or token", which is never why for a group the service was
handed.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.http import PlaidAPIError  # noqa: E402
from plaid_client.service import BaseService  # noqa: E402
from plaid_client.service_schema import TASKS  # noqa: E402


class _Helper:
    def __init__(self):
        self.errors = []

    def progress(self, percent, msg=''):
        pass

    def complete(self, data=None):
        pass

    def error(self, err):
        self.errors.append(str(err))


class _Client:
    base_url = 'http://plaid.test'

    def begin_operation(self, message, **kw):
        pass

    def end_operation(self):
        pass


def _run(said, status=403):
    class Writer(BaseService):
        def process_request(self, request_data, response_helper):
            try:
                raise PlaidAPIError(f'HTTP {status} {said}', status=status,
                                    response_data={'error': said})
            except PlaidAPIError as e:
                # A service that wraps the failure in its own words, as the
                # parser does ("230 of 300 sentences were parsed").
                raise RuntimeError('230 of 300 sentences were parsed, each in full.') from e

    svc = Writer('tok:x', 'Writer', 'x', tasks=[TASKS.TOKENIZE])
    svc.client = _Client()
    helper = _Helper()
    svc.handle_service_request({'operation_group': {'id': 'g1'}}, helper).join(5)
    return helper


def test_a_refusal_because_the_request_ended_is_logged_as_that(capsys):
    helper = _run('Operation group g1 was handed to this service by a request that has ended, '
                  'so this write cannot join it.')
    out = capsys.readouterr().out
    assert 'the request had already ended when this service wrote' in out
    assert 'Traceback' not in out
    assert helper.errors, 'the requester side is still answered'


def test_after_a_restart_the_same_refusal_is_not_blamed_on_another_user(capsys):
    _run('Operation group g1 was started by another user or token, so this write cannot join it.')
    out = capsys.readouterr().out
    assert 'the request had already ended when this service wrote' in out
    assert 'another user' not in out


def test_a_refusal_for_another_project_is_logged_as_it_stands(capsys):
    _run('Operation group g1 was handed to this service by a request in project p, so a write '
         'in project q cannot join it.')
    out = capsys.readouterr().out
    assert 'Error during Writer processing' in out
    assert 'had already ended' not in out


def test_another_group_or_status_is_logged_as_it_stands(capsys):
    _run('Operation group g2 was started by another user or token, so this write cannot join it.')
    assert 'had already ended' not in capsys.readouterr().out
    _run('Operation group g1 was started by another user or token.', status=500)
    assert 'had already ended' not in capsys.readouterr().out
