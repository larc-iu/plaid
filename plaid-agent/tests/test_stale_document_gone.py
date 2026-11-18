"""A plan whose document was deleted before approval says so (H2-4-2).

Core answers 403 for an id it does not know, on purpose, so a deleted document
reads like one the requester may not read. The out-of-date reason names
neither a privilege nor an HTTP status: it says the document is gone or out of
reach. Any other failure still says what went wrong."""

from plaid_client.http import PlaidAPIError

from plaid_agent.core.staleness import stale_documents


class _Client:
    def __init__(self, error):
        self.error = error
        self.documents = self

    def get(self, _id):
        raise self.error


def _reason(error):
    [reason] = stale_documents(_Client(error), [{'id': 'd1', 'version': 'v1', 'name': 'Story A'}])
    return reason


GONE = ('document "Story A" no longer exists or can no longer be read '
        '(deleted, or access removed, since the plan was made)')


def test_a_deleted_document_is_named_gone_without_a_status_or_a_privilege():
    for status in (403, 404):
        error = PlaidAPIError('HTTP %d User a@b.com lacks sufficient privileges to read the project' % status,
                              status=status)
        assert _reason(error) == GONE


def test_a_failure_of_another_kind_still_says_what_it_was():
    reason = _reason(PlaidAPIError('Connection refused', status=0))
    assert reason.startswith('document "Story A" could not be read (')
