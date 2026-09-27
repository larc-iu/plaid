"""The client's own fake (``plaid_client.testing.FakeClient``) as every
assistant's fixtures use it: a project and its documents by id, and each app's
fixture module subclassing it with that app's project, documents and audit log."""

from plaid_client import testing


def _counts(inserted=0, updated=0, deleted=0, by_layer=None):
    out = {'inserted': inserted, 'updated': updated, 'deleted': deleted}
    return out if by_layer is None else {**out, 'by_layer': by_layer}


# What a restore answers with, done or dry, unless a test names its own: every
# key a real summary carries (plaid-core history/restore.clj `summarize`).
RESTORE_SUMMARY = {
    'name': False, 'document_metadata': False,
    'texts': _counts(updated=1),
    'tokens': _counts(inserted=1, by_layer=[{'layer_id': 'sent-layer', 'inserted': 1,
                                             'updated': 0, 'deleted': 0}]),
    'spans': _counts(by_layer=[]),
    'relations': _counts(deleted=1, by_layer=[{'layer_id': 'rel-layer', 'inserted': 0,
                                               'updated': 0, 'deleted': 1}]),
    'vocab_links': _counts(),
    'skipped': [],
    'total': 3,
}


class AgentFakeClient(testing.FakeClient):
    """The client's fake with a project's documents by id, and what the
    assistants read that no service does: ``no_doc_cache``, since fixtures
    reuse document ids with different content."""

    no_doc_cache = True

    def __init__(self, project, documents, audit=None, guidelines=None, comments=None,
                 restore_summary=RESTORE_SUMMARY, fails=None):
        super().__init__(documents, fails, project=project, audit=audit, guidelines=guidelines,
                         comments=comments, restore_summary=restore_summary)
