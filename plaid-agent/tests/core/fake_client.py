"""A fake Plaid client that knows the API and nothing about any app.

It answers the resources every assistant reads (projects, documents and their
layers, the user's private store, the audit log) and records every write with
the real client's batch and operation surface, so a test reads back exactly
what would have been sent.

What it does NOT carry is a project: an app's fixtures subclass it and supply
their own shapes, their own documents and their own audit entries. It used to
be IGT's client with a UD project passed in, which left UD's tests reading an
audit log naming a document their project did not have.
"""

import copy
import fnmatch
from contextlib import contextmanager

from plaid_client.http import PlaidAPIError
from plaid_agent.core.conversation import now_iso


class Recorder:
    """A resource stand-in: any method call is recorded as (resource, method, args, kwargs).

    A ``bulk_update`` is recorded as what it stands for, one ``update`` and
    one ``patch_metadata`` entry per item as the executors once sent them,
    so a test reads the same writes whichever way they travelled; the raw
    bulk call goes to ``bulk_calls`` for a test about the batching itself."""

    def __init__(self, log, name, bulk_calls=None):
        self._log, self._name, self._bulk = log, name, bulk_calls

    def __getattr__(self, method):
        def call(*args, **kwargs):
            if method == 'bulk_update':
                if self._bulk is not None:
                    self._bulk.append((self._name, list(args[0])))
                for item in args[0]:
                    if 'value' in item:
                        self._log.append((self._name, 'update', (item['id'], item['value']), {}))
                    if item.get('metadata'):
                        self._log.append((self._name, 'patch_metadata', (item['id'], item['metadata']), {}))
                return {'count': len(args[0])}
            self._log.append((self._name, method, args, kwargs))
            return {'id': f'{self._name}-{method}-{len(self._log)}'}
        return call


# The resources a write travels through, all of them API-level: what the
# entities mean is the app's business, not this file's.
RESOURCES = ('tokens', 'spans', 'relations', 'vocab_links', 'vocab_items', 'texts')


class _Batch:
    """What ``client.batch()`` returns and ``client.batched()`` yields: a view
    of the client with the same resources, queuing what is written on it until
    ``submit`` sends the queue as one atomic request. A write made on the
    client itself is never touched by an open batch, so it reaches the log at
    once.

    Everything the batch does not have itself is the client's, which is how a
    read made on a batch answers from the fixture.
    """

    def __init__(self, client):
        self.client = client
        self.log = []      # what this batch has queued, in order
        self.results = []
        self.open = True
        for name in RESOURCES:
            setattr(self, name, Recorder(self.log, name, client.bulk_calls))

    def __getattr__(self, name):
        return getattr(self.client, name)

    def _queueing(self, name):
        """The client's own resource, rebound to this batch: its writes queue,
        its reads still reach the fixture."""
        resource = getattr(self.client, name)
        if isinstance(resource, Recorder):
            return Recorder(self.log, name, self.client.bulk_calls)
        return resource.__class__(self)

    @property
    def documents(self):
        return self._queueing('documents')

    @property
    def comments(self):
        return self._queueing('comments')

    def submit(self):
        assert self.open, 'this batch was already submitted or aborted'
        self.open = False
        entries, self.log = self.log, []
        self.client.batches.append(entries)
        self.client.log.extend(entries)
        # Result per op, like the server: created things carry an id, and a
        # bulk create carries `ids`, one per item, in input order.
        self.results = []
        for i, e in enumerate(entries):
            body = {'id': f'new-{e[0]}-{i}'}
            if e[1].startswith('bulk_create'):
                n = len(e[2][0]) if e[2] and isinstance(e[2][0], list) else 1
                body['ids'] = [f'new-{e[0]}-{i}-{k}' for k in range(n)]
            self.results.append({'status': 201, 'body': body})
        return self.results

    def abort(self):
        # Nothing it queued reaches the log.
        self.open = False
        self.log = []


class BaseFakeClient:
    base_url = 'http://plaid.test'
    token = 't'
    no_doc_cache = True  # fixtures reuse document ids with different content

    def __init__(self, project, documents, audit=None, guidelines=None):
        self.log = []
        self.doc_reads = []  # (document id, layers asked for) per body read
        self.batches = []  # each: list of log entries submitted together
        self.operations = []
        self._project = project
        self._documents = documents
        self.audit = list(audit or [])
        self._guidelines = list(guidelines or [])
        self.bulk_calls = []  # (resource, items) per bulk_update, for tests about the batching
        for name in RESOURCES:
            setattr(self, name, Recorder(self.log, name, self.bulk_calls))

    class _Projects:
        def __init__(self, c):
            self.c = c

        def get(self, pid):
            return self.c._project

        def audit(self, pid, **kw):
            return self.c.audit

        def audit_page(self, pid, *, order=None, limit=None, cursor=None, start_time=None, **kw):
            entries = [e for e in self.c.audit if not start_time or (e.get('time') or '') >= start_time]
            entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=(order == 'desc'))
            return {'entries': entries[:limit] if limit else entries, 'next_cursor': None}

        def list_documents(self, pid):
            return [{'id': k, 'name': v.get('name'), 'version': v.get('version'), 'time_modified': v.get('time_modified')}
                    for k, v in self.c._documents.items()]

    class _Documents:
        def __init__(self, c):
            self.c = c

        def get(self, did, include_body=None, layers=None, **kw):
            # Recorded so a test can pin WHICH layers a read asked for. The
            # fake returns the whole fixture either way: what ?layers= drops
            # is the server's business, and the app's business is naming the
            # layers it parses.
            self.c.doc_reads.append((did, tuple(layers) if layers else None))
            return self.c._documents[did]

        def create(self, project_id, name, metadata=None, **kw):
            self.c.log.append(('documents', 'create', (project_id, name, metadata), {}))
            return {'id': 'new-doc'}

        def patch_metadata(self, did, body, **kw):
            self.c.log.append(('documents', 'patch_metadata', (did, body), {}))
            return {'id': did}

        def update(self, did, name, **kw):
            self.c.log.append(('documents', 'update', (did, name), {}))
            return {'id': did}

        def audit(self, did, **kw):
            return [e for e in self.c.audit if any(d['id'] == did for d in e.get('documents', []))]

        def audit_page(self, did, *, order=None, limit=None, cursor=None, start_time=None, **kw):
            entries = [e for e in self.audit(did) if not start_time or (e.get('time') or '') >= start_time]
            entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=(order == 'desc'))
            return {'entries': entries[:limit] if limit else entries, 'next_cursor': None}

        def restore(self, did, as_of, dry_run=False, **kw):
            """The server's restore. A dry run answers with what WOULD change,
            which is what a plan shows instead of promising."""
            if not dry_run:
                self.c.log.append(('documents', 'restore', (did, as_of), {}))
                return {'id': did}
            return {'total': 3, 'texts': {'updated': 1},
                    'tokens': {'by_layer': [{'layer_id': 'sent-layer', 'inserted': 1}]},
                    'relations': {'deleted': 1}}

    class _UserData:
        """The user's private key/value store, in memory: what the assistant
        keeps conversations in."""

        def __init__(self, c):
            self.store = {}

        def get(self, user_id, key):
            if (user_id, key) not in self.store:
                raise PlaidAPIError(f'No entry {key}', status=404)
            return {'key': key, 'value': copy.deepcopy(self.store[(user_id, key)])}

        def put(self, user_id, key, value):
            self.store[(user_id, key)] = copy.deepcopy(value)
            return {'key': key, 'updated_at': now_iso()}

        def delete(self, user_id, key):
            self.store.pop((user_id, key), None)

        def _entries(self, user_id, prefix, pattern, include_values):
            """Every matching entry, ordered by key like the server's listing."""
            rows = [{'key': k, **({'value': copy.deepcopy(v)} if include_values else {})}
                    for (u, k), v in self.store.items()
                    if u == user_id
                    and (not prefix or k.startswith(prefix))
                    and (not pattern or fnmatch.fnmatchcase(k, pattern))]
            rows.sort(key=lambda r: r['key'])
            return rows

        def list(self, user_id, *, prefix=None, pattern=None, include_values=False,
                 page_size=100):
            """The full flat list, as the real client's auto-paginating list.

            ``pattern`` is a GLOB over the whole key (``*`` any run, ``?`` one
            character), which is how the assistant asks for a segment in the
            middle of its ``<app>:assistant:<project>:<kind>:<id>`` keys.
            ``page_size`` only sets how many entries a request carries, so
            here it is accepted and unused.
            """
            return self._entries(user_id, prefix, pattern, include_values)

        def list_page(self, user_id, *, prefix=None, pattern=None, include_values=False,
                      limit=None, cursor=None):
            """One page, as the envelope the real client hands back.

            The cursor is opaque to a caller, so it is the last key of the page
            it came from.
            """
            rows = self._entries(user_id, prefix, pattern, include_values)
            if cursor is not None:
                rows = [r for r in rows if r['key'] > cursor]
            page, rest = rows[:limit or 100], rows[limit or 100:]
            return {'entries': page,
                    'next_cursor': page[-1]['key'] if rest else None}

    class _Guidelines:
        """The project's annotation manual. App-neutral, like everything here:
        a guideline has the same shape whatever the project annotates."""

        def __init__(self, c):
            self.c = c

        def list(self, pid, *, include_bodies=None, **kw):
            rows = list(getattr(self.c, '_guidelines', None) or [])
            if include_bodies:
                return [dict(r) for r in rows]
            return [{k: v for k, v in r.items() if k != 'body'} | {'body_chars': len(r.get('body') or '')}
                    for r in rows]

        def get(self, gid):
            for r in getattr(self.c, '_guidelines', None) or []:
                if r.get('id') == gid:
                    return dict(r)
            raise PlaidAPIError('Guideline not found', status_code=404)

    @property
    def guidelines(self):
        return BaseFakeClient._Guidelines(self)

    @property
    def projects(self):
        return BaseFakeClient._Projects(self)

    @property
    def documents(self):
        return BaseFakeClient._Documents(self)

    @property
    def user_data(self):
        if not hasattr(self, '_user_data'):
            self._user_data = self._UserData(self)
        return self._user_data

    # batch surface
    def batch(self):
        return _Batch(self)

    @contextmanager
    def batched(self):
        batch = _Batch(self)
        try:
            yield batch
        except BaseException:
            batch.abort()
            raise
        batch.submit()

    @contextmanager
    def operation(self, message):
        self.operations.append(message)
        yield self

    def calls(self, resource=None, method=None):
        return [e for e in self.log if (resource is None or e[0] == resource) and (method is None or e[1] == method)]


class ExtFakeClient(BaseFakeClient):
    """The fake client plus what the newer tools call: a comments resource, an
    audit log filtered by start_time (recorded, so a test can see the windows
    read), and a restore that answers a dry run with a summary.

    App-neutral like the base, and mixed in FRONT of an app's own fake client
    (``class ExtClient(ExtFakeClient, FakeClient)``), so each app's extended
    client carries that app's project, documents and audit log. One app's
    version of this used to serve both, which left the other reading an audit
    log that named a document its project did not have.
    """

    def __init__(self, *args, comments=None, restore_summary=None, restore_error=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.comment_rows = list(comments or [])
        self.restore_summary = restore_summary
        self.restore_error = restore_error
        self.audit_calls = []

    class _Comments:
        def __init__(self, c):
            self.c = c

        def list(self, project_id, document_id=None, entity_type=None, entity_id=None, **kw):
            rows = self.c.comment_rows
            if document_id:
                rows = [r for r in rows if r.get('document_id') == document_id]
            if entity_id:
                rows = [r for r in rows if r.get('entity_type') == entity_type and r.get('entity_id') == entity_id]
            return list(rows)

        def create(self, entity_type, entity_id, body, anchor_label=None, **kw):
            self.c.log.append(('comments', 'create', (entity_type, entity_id, body), {'anchor_label': anchor_label}))
            return {'id': 'c-new'}

    @property
    def comments(self):
        return ExtFakeClient._Comments(self)

    class _Projects(BaseFakeClient._Projects):
        def audit(self, pid, start_time=None, **kw):
            self.c.audit_calls.append(start_time)
            return [e for e in self.c.audit if not start_time or (e.get('time') or '') >= start_time]

    @property
    def projects(self):
        return ExtFakeClient._Projects(self)

    class _Documents(BaseFakeClient._Documents):
        def restore(self, did, as_of, dry_run=False, **kw):
            self.c.log.append(('documents', 'restore', (did, as_of), {'dry_run': dry_run}))
            if self.c.restore_error:
                raise RuntimeError(self.c.restore_error)
            return self.c.restore_summary

    @property
    def documents(self):
        return ExtFakeClient._Documents(self)
