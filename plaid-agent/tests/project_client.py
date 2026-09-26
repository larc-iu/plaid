"""The client's own fake (``plaid_client.testing.FakeClient``) as every
assistant's fixtures use it: a project and its documents by id, and each app's
fixture module subclassing it with that app's project, documents and audit log."""

from plaid_client import testing

# What a dry-run restore answers with, unless a test names its own.
RESTORE_SUMMARY = {'total': 3, 'texts': {'updated': 1},
                   'tokens': {'by_layer': [{'layer_id': 'sent-layer', 'inserted': 1}]},
                   'relations': {'deleted': 1}}


class AgentFakeClient(testing.FakeClient):
    """The client's fake with a project's documents by id, and what the
    assistants read that no service does: ``no_doc_cache``, since fixtures
    reuse document ids with different content."""

    no_doc_cache = True

    def __init__(self, project, documents, audit=None, guidelines=None, comments=None,
                 restore_summary=RESTORE_SUMMARY, fails=None):
        super().__init__(documents, fails, project=project, audit=audit, guidelines=guidelines,
                         comments=comments, restore_summary=restore_summary)
