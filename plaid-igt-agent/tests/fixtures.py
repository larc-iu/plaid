"""A small IGT project and document in the live API's shape, plus a fake
client that records writes with the real client's batch/operation surface."""

from contextlib import contextmanager

PID = 'p1'
TEXT_LAYER, SENT_LAYER, WORD_LAYER, MORPH_LAYER = 'tl', 'tk-sent', 'tk-word', 'tk-morph'
TRANS, GLOSS, MGLOSS = 'sl-trans', 'sl-gloss', 'sl-mgloss'
VOCAB = 'v1'
TEXT_ID = 'text1'


def project_raw():
    return {
        'id': PID, 'name': 'Demo', 'config': {'igt': {'initialized': True, 'documentMetadata': [{'name': 'Date'}]}},
        'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'config': {}}],
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'config': {'plaid': {'role': 'baseline'}},
            'token_layers': [
                {'id': SENT_LAYER, 'name': 'Sentences', 'config': {'plaid': {'role': 'sentence'}},
                 'span_layers': [{'id': TRANS, 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}}}]},
                {'id': WORD_LAYER, 'name': 'Words',
                 'config': {'plaid': {'role': 'word'},
                            'igt': {'orthographies': [{'name': 'IPA'}],
                                    'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}},
                 'span_layers': [{'id': GLOSS, 'name': 'Gloss', 'config': {'igt': {'scope': 'Word'}}}]},
                {'id': MORPH_LAYER, 'name': 'Morphemes', 'config': {'plaid': {'role': 'morpheme'}},
                 'span_layers': [{'id': MGLOSS, 'name': 'Morph Gloss', 'config': {'igt': {'scope': 'Morpheme'}}}]},
            ]}],
    }


BODY = 'Ali-di gam akuna. Gam-ar.'
# offsets: Ali-di 0-6, gam 7-10, akuna 11-16, . 16-17 | Gam-ar 18-24, . 24-25


def document_raw():
    return {
        'id': 'd1', 'name': 'Text 1', 'version': 7, 'metadata': {'Date': '2020'},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': BODY},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': [
                    {'id': 's-1', 'text': TEXT_ID, 'begin': 0, 'end': 17},
                    {'id': 's-2', 'text': TEXT_ID, 'begin': 18, 'end': 25}],
                 'span_layers': [{'id': TRANS, 'spans': [{'id': 'sp-t1', 'value': 'Ali saw a fish.', 'tokens': ['s-1']}]}]},
                {'id': WORD_LAYER, 'tokens': [
                    {'id': 'w-1', 'text': TEXT_ID, 'begin': 0, 'end': 6, 'metadata': {'orthog:IPA': 'alidi'}},
                    {'id': 'w-2', 'text': TEXT_ID, 'begin': 7, 'end': 10},
                    {'id': 'w-3', 'text': TEXT_ID, 'begin': 11, 'end': 16},
                    {'id': 'w-p', 'text': TEXT_ID, 'begin': 16, 'end': 17},
                    {'id': 'w-4', 'text': TEXT_ID, 'begin': 18, 'end': 24},
                    {'id': 'w-p2', 'text': TEXT_ID, 'begin': 24, 'end': 25}],
                 'span_layers': [{'id': GLOSS, 'spans': [{'id': 'sp-g1', 'value': 'Ali', 'tokens': ['w-1']}]}],
                 'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'vocab_links': [
                     {'id': 'l-1', 'vocab_item': {'id': 'vi-ali', 'form': 'Ali'}, 'tokens': ['w-1']}]}]},
                {'id': MORPH_LAYER, 'tokens': [
                    {'id': 'm-1a', 'text': TEXT_ID, 'begin': 0, 'end': 6, 'precedence': 1, 'metadata': {'form': 'Ali'}},
                    {'id': 'm-1b', 'text': TEXT_ID, 'begin': 0, 'end': 6, 'precedence': 2,
                     'metadata': {'form': 'di', 'morphType': 'suffix'}},
                    {'id': 'm-2', 'text': TEXT_ID, 'begin': 7, 'end': 10, 'precedence': 1},
                    {'id': 'm-4a', 'text': TEXT_ID, 'begin': 18, 'end': 24, 'precedence': 1, 'metadata': {'form': 'Gam'}},
                    {'id': 'm-4b', 'text': TEXT_ID, 'begin': 18, 'end': 24, 'precedence': 2,
                     'metadata': {'form': 'ar', 'morphType': 'enclitic'}}],
                 'span_layers': [{'id': MGLOSS, 'spans': [
                     {'id': 'sp-m1a', 'value': 'Ali', 'tokens': ['m-1a']},
                     {'id': 'sp-m1b', 'value': 'ERG', 'tokens': ['m-1b']}]}],
                 'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'vocab_links': [
                     {'id': 'l-2', 'vocab_item': {'id': 'vi-erg', 'form': '-di'}, 'tokens': ['m-1b']}]}]},
            ]}],
    }


def lexicon_raw():
    return {'id': VOCAB, 'name': 'Lexicon', 'items': [
        {'id': 'vi-ali', 'form': 'Ali', 'metadata': {'gloss': 'Ali', 'pos': 'N'}},
        {'id': 'vi-erg', 'form': '-di', 'metadata': {'gloss': 'ERG', 'morphType': 'suffix'}},
        {'id': 'vi-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
        {'id': 'vi-gam2', 'form': 'gam', 'metadata': {'gloss': 'net'}},
    ]}


class Recorder:
    """A resource stand-in: any method call is recorded as (resource, method, args, kwargs)."""

    def __init__(self, log, name):
        self._log, self._name = log, name

    def __getattr__(self, method):
        def call(*args, **kwargs):
            self._log.append((self._name, method, args, kwargs))
            return {'id': f'{self._name}-{method}-{len(self._log)}'}
        return call


class FakeClient:
    base_url = 'http://plaid.test'
    token = 't'

    def __init__(self, project=None, documents=None, lexicon=None):
        self.log = []
        self.batches = []  # each: list of log entries submitted together
        self.operations = []
        self._batch_start = None
        self._project = project or project_raw()
        self._documents = documents or {'d1': document_raw()}
        self._lexicon = lexicon or lexicon_raw()
        self.audit = [
            {'id': 'g1', 'time': '2026-08-29T18:51:47Z', 'user': {'id': 'a@b.com', 'display_name': 'Luke G'},
             'message': 'Assistant: 2 field values', 'documents': [{'id': 'd1', 'name': 'Text 1'}],
             'ops': [{'type': 'span/create', 'description': 'Create span'}, {'type': 'span/update', 'description': 'Update span'}]},
            {'id': 'o2', 'time': '2026-08-28T10:00:00Z', 'user': {'id': 'x@y.z', 'display_name': 'Someone'},
             'documents': [], 'ops': [{'type': 'project/create', 'description': 'Create project "Demo"'}]},
        ]
        for name in ('tokens', 'spans', 'vocab_links', 'vocab_items', 'texts'):
            setattr(self, name, Recorder(self.log, name))

    class _Projects:
        def __init__(self, c):
            self.c = c

        def get(self, pid):
            return self.c._project

        def audit(self, pid, **kw):
            return self.c.audit

        def list_documents(self, pid):
            return [{'id': d['id'], 'name': d['name']} for d in self.c._documents.values()]

    class _Documents:
        def __init__(self, c):
            self.c = c

        def get(self, did, include_body=None, **kw):
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

    class _VocabLayers:
        def __init__(self, c):
            self.c = c

        def get(self, vid, include_items=None, **kw):
            return self.c._lexicon

    @property
    def projects(self):
        return FakeClient._Projects(self)

    @property
    def documents(self):
        return FakeClient._Documents(self)

    @property
    def vocab_layers(self):
        return FakeClient._VocabLayers(self)

    # batch surface
    def begin_batch(self):
        assert self._batch_start is None, 'nested batch'
        self._batch_start = len(self.log)

    def is_batch_mode(self):
        return self._batch_start is not None

    def abort_batch(self):
        self._batch_start = None

    def submit_batch(self):
        entries = self.log[self._batch_start:]
        self.batches.append(entries)
        self._batch_start = None
        # Result per op, like the server: created things carry an id.
        return [{'status': 201, 'body': {'id': f'new-{e[0]}-{i}'}} for i, e in enumerate(entries)]

    @contextmanager
    def operation(self, message):
        self.operations.append(message)
        yield self

    def calls(self, resource=None, method=None):
        return [e for e in self.log if (resource is None or e[0] == resource) and (method is None or e[1] == method)]
