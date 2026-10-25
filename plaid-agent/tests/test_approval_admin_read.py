"""An approval asks the server whether its approver is an administrator, and
a read that fails refuses it (REV-W2-AGENT F3). The answer decides the stamp:
an administrator with no role of their own in a project that reviews
maintainers' work is reviewed, and counted as nobody they would stamp their
work verified where it is contributed. The tool checks, which refuse what a
non-administrator may not do, still answer no on a failed read."""

import pytest

from plaid_client.http import PlaidAPIError

import test_stale_by_sentence as sbs

from plaid_agent.core.provenance import Requester


class _Unreadable:
    def get(self, id):
        raise PlaidAPIError('HTTP 500: users read failed', status=500, method='GET')


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_an_approval_whose_admin_read_fails_writes_nothing(app):
    spec = sbs.APPS[app]()
    client = spec['client']()
    plan, store = sbs._plan(spec, client)
    client.users = _Unreadable()
    sent = len(client.batches)
    helper = sbs._approve(spec, client, plan)
    assert len(helper.errors) == 1, helper.errors
    assert helper.errors[0].startswith(
        "Nothing was written. The project's review settings could not be read: "), helper.errors
    assert helper.done == []
    assert len(client.batches) == sent


def test_a_tool_check_counts_a_failed_admin_read_as_no():
    spec = sbs.APPS['igt']()
    client = spec['client']()
    client.users = _Unreadable()
    assert Requester(client, 'u@x').is_admin() is False
    with pytest.raises(PlaidAPIError):
        Requester(client, 'u@x', strict=True).is_admin()
