"""Tests for the 503 "Database busy" retry.

Plaid serializes writers on a single SQLite write lock. A writer that cannot
get it within the server's busy_timeout is refused with 503, and that refusal
is definitive — the transaction never opened, or was rolled back whole — so
repeating the request is safe. Without this retry a long-running service dies
the moment anyone else writes.
"""

import pytest

from plaid_client.client import PlaidClient
from plaid_client.http import (
    BUSY_RETRIES, DEFAULT_BATCH_TIMEOUT_S, DEFAULT_TIMEOUT_S,
    PlaidAPIError, retry_while_busy,
)


def busy():
    return PlaidAPIError('Database busy', status=503)


# base_delay=0 keeps these instant: the backoff is what we bound, not measure.
FAST = {'base_delay': 0}


def test_success_is_not_retried():
    calls = []

    def attempt():
        calls.append(1)
        return 'ok'

    assert retry_while_busy(attempt, **FAST) == 'ok'
    assert len(calls) == 1


def test_503_is_retried_until_it_succeeds():
    calls = []

    def attempt():
        calls.append(1)
        if len(calls) < 3:
            raise busy()
        return 'ok'

    assert retry_while_busy(attempt, **FAST) == 'ok'
    assert len(calls) == 3


def test_persistent_503_gives_up_after_the_budget():
    calls = []

    def attempt():
        calls.append(1)
        raise busy()

    with pytest.raises(PlaidAPIError) as excinfo:
        retry_while_busy(attempt, **FAST)
    assert excinfo.value.status == 503
    assert len(calls) == BUSY_RETRIES + 1, 'one initial attempt plus the budget'


@pytest.mark.parametrize('status', [400, 401, 403, 404, 409, 500, 0])
def test_other_failures_are_raised_immediately(status):
    calls = []

    def attempt():
        calls.append(1)
        raise PlaidAPIError(f'HTTP {status}', status=status)

    with pytest.raises(PlaidAPIError) as excinfo:
        retry_while_busy(attempt, **FAST)
    assert excinfo.value.status == status
    assert len(calls) == 1, f'status {status} must not be retried'


def test_non_api_errors_propagate_untouched():
    def attempt():
        raise ValueError('not an API error')

    with pytest.raises(ValueError):
        retry_while_busy(attempt, **FAST)


def test_batch_submissions_get_their_own_longer_timeout():
    # Aborting a batch does not stop the server's transaction, so the batch
    # budget must not be the short per-request one.
    default = PlaidClient('http://localhost:0', 't')
    assert default.timeout == DEFAULT_TIMEOUT_S
    assert default.batch_timeout == DEFAULT_BATCH_TIMEOUT_S
    assert default.batch_timeout > default.timeout

    # An explicit `timeout` still governs both unless batch_timeout is given.
    explicit = PlaidClient('http://localhost:0', 't', timeout=5.0)
    assert explicit.batch_timeout == 5.0

    both = PlaidClient('http://localhost:0', 't', timeout=5.0, batch_timeout=60.0)
    assert both.batch_timeout == 60.0
