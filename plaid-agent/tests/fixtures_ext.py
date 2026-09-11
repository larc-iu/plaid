"""Fixtures for the multi-word expression, review, comment, history, and
restore tools: variants of the fixture document, and a fake client that also
serves comments, audit windows, and restore dry runs."""

from fixtures import FakeClient, document_raw, lexicon_raw

MWE_LINK = 'l-mwe'
PHRASE_ITEM = 'vi-phrase'


def mwe_document_raw():
    """The fixture document plus a multi-word expression "gam akuna" over
    s1.w2 + s1.w3 (w2 and w3 have no link of their own)."""
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['vocabs'][0]['vocab_links'].append(
        {'id': MWE_LINK, 'vocab_item': {'id': PHRASE_ITEM, 'form': 'gam akuna'}, 'tokens': ['w-2', 'w-3']})
    return raw


def mwe_lexicon_raw():
    lex = lexicon_raw()
    lex['items'].append({'id': PHRASE_ITEM, 'form': 'gam akuna', 'metadata': {'gloss': 'see a fish', 'morphType': 'phrase'}})
    return lex


def mwe_client(machine_mwe: bool = False):
    raw = mwe_document_raw()
    if machine_mwe:
        raw['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links'][1]['metadata'] = \
            {'prov': 'inferred', 'provSource': 'service:mwe'}
    return ExtClient(documents={'d1': raw}, lexicon=mwe_lexicon_raw())


ANN = 'ann@x.com'
BOB = 'bob@x.com'


def contributed_document_raw():
    """The fixture document with work awaiting review: w1's Gloss contributed
    by ann, w1's link contributed by bob, m-1b's gloss machine-made and
    unconfirmed, m-1a's gloss contributed by ann but already verified."""
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    ann = {'prov': 'contributed', 'provSource': f'user:{ANN}'}
    bob = {'prov': 'contributed', 'provSource': f'user:{BOB}'}
    machine = {'prov': 'inferred', 'provSource': 'service:x'}
    layers[1]['span_layers'][0]['spans'][0]['metadata'] = dict(ann)                       # sp-g1 (Gloss on w-1)
    layers[1]['vocabs'][0]['vocab_links'][0]['metadata'] = dict(bob)                      # l-1 (w-1 link)
    layers[2]['span_layers'][0]['spans'][0]['metadata'] = {**ann, 'provConfirmed': True}  # sp-m1a verified
    layers[2]['span_layers'][0]['spans'][1]['metadata'] = dict(machine)                   # sp-m1b
    return raw


class ExtClient(FakeClient):
    """The fake client plus what the newer tools call: a comments resource,
    an audit log filtered by start_time (recorded, so a test can see the
    windows read), and a restore that answers a dry run with a summary."""

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
        return ExtClient._Comments(self)

    class _Projects(FakeClient._Projects):
        def audit(self, pid, start_time=None, **kw):
            self.c.audit_calls.append(start_time)
            return [e for e in self.c.audit if not start_time or (e.get('time') or '') >= start_time]

    @property
    def projects(self):
        return ExtClient._Projects(self)

    class _Documents(FakeClient._Documents):
        def restore(self, did, as_of, dry_run=False, **kw):
            self.c.log.append(('documents', 'restore', (did, as_of), {'dry_run': dry_run}))
            if self.c.restore_error:
                raise RuntimeError(self.c.restore_error)
            return self.c.restore_summary

    @property
    def documents(self):
        return ExtClient._Documents(self)
