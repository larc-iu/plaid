"""The client's own fake (``plaid_client.testing.FakeClient``) as every
assistant's fixtures use it: a project and its documents by id, and each app's
fixture module subclassing it with that app's project, documents and audit log."""

import copy

from plaid_client import testing
from plaid_client.http import PlaidAPIError


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


# --- one user's client over several projects -----------------------------------
#
# plaid-agent's own stand-in for a client that reads several projects, until
# the client's fake answers per project itself (MULTI design, step 1). Each
# project is one app fake client, and every read that names a project or a
# document is answered by the fake that holds it. A project in none of them is
# the 403 the server gives a user who is not a reader there.


def _forbidden(what):
    return PlaidAPIError(f'HTTP 403 Forbidden: not a reader of {what}', status=403,
                         url=f'http://plaid.internal:8085/api/v1/projects/{what}', method='GET',
                         response_data={'error': 'Forbidden'})


def other_project(project, documents, pid, name, guidelines=None):
    """A second project shaped like ``project``, with its own id and name, and
    its documents under ids of their own (names kept, so a document named the
    same in two projects is told apart by the project)."""
    p = copy.deepcopy(project)
    p['id'], p['name'] = pid, name
    docs = {}
    for did, doc in documents.items():
        d = copy.deepcopy(doc)
        d['id'] = f'{pid}-{did}'
        if 'project' in d:
            d['project'] = pid
        docs[d['id']] = d
    return p, docs, guidelines


class MultiProjectClient:
    """A requester's client over several projects' fakes. ``home`` is the fake
    of the conversation's own project and answers everything this does not
    route (user data, writes, the query engine). ``others`` is ``{pid: fake}``.
    ``services`` is ``{pid: [service entries]}`` for discovery."""

    no_doc_cache = True

    def __init__(self, home, others, services=None):
        self.home = home
        self.others = dict(others)
        self.services = dict(services or {})
        self.projects = _MultiProjects(self)
        self.documents = _MultiDocuments(self)
        self.guidelines = _MultiGuidelines(self)
        self.comments = _MultiComments(self)
        self.messages = _MultiMessages(self)

    def __getattr__(self, name):
        return getattr(self.home, name)

    def fake_of(self, pid):
        if pid == self.home.project['id']:
            return self.home
        if pid in self.others:
            return self.others[pid]
        raise _forbidden(pid)

    def fake_of_document(self, document_id):
        for fake in self.others.values():
            if isinstance(fake._documents, dict) and document_id in fake._documents:
                return fake
        return self.home


class _MultiProjects:
    def __init__(self, c):
        self.c = c

    def get(self, id, **kw):
        return self.c.fake_of(id).projects.get(id, **kw)

    def list(self, **kw):
        return [self.c.home.project, *(f.project for f in self.c.others.values())]

    def list_documents(self, id):
        return self.c.fake_of(id).projects.list_documents(id)

    def audit(self, project_id, **kw):
        return self.c.fake_of(project_id).projects.audit(project_id, **kw)

    def audit_page(self, project_id, **kw):
        return self.c.fake_of(project_id).projects.audit_page(project_id, **kw)


class _MultiDocuments:
    def __init__(self, c):
        self.c = c

    def get(self, document_id, **kw):
        return self.c.fake_of_document(document_id).documents.get(document_id, **kw)

    def __getattr__(self, name):
        return getattr(self.c.home.documents, name)


class _MultiGuidelines:
    def __init__(self, c):
        self.c = c

    def list(self, project_id, **kw):
        return self.c.fake_of(project_id).guidelines.list(project_id, **kw)

    def __getattr__(self, name):
        return getattr(self.c.home.guidelines, name)


class _MultiComments:
    def __init__(self, c):
        self.c = c

    def list(self, project_id, **kw):
        return self.c.fake_of(project_id).comments.list(project_id, **kw)

    def __getattr__(self, name):
        return getattr(self.c.home.comments, name)


class _MultiMessages:
    def __init__(self, c):
        self.c = c

    def discover_services(self, project_id):
        self.c.fake_of(project_id)
        return [dict(s) for s in self.c.services.get(project_id, [])]
