"""A small IGT project, document and lexicon in the live API's shape, and the
app-neutral fake client (``tests/core/fake_client.py``) carrying them."""

from core.fake_client import BaseFakeClient

PID = 'p1'
TEXT_LAYER, SENT_LAYER, WORD_LAYER, MORPH_LAYER = 'tl', 'tk-sent', 'tk-word', 'tk-morph'
TRANS, GLOSS, MGLOSS = 'sl-trans', 'sl-gloss', 'sl-mgloss'
VOCAB = 'v1'
TEXT_ID = 'text1'


def project_raw():
    return {
        'id': PID, 'name': 'Demo',
        'config': {'igt': {'initialized': True, 'documentMetadata': [{'name': 'Date'}],
                           'tagsets': {'Leipzig': {'delimiters': '.:', 'mode': 'mixed',
                                                   'values': [{'value': 'PL', 'description': 'plural'},
                                                              {'value': 'ERG'}]}}}},
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
                 'span_layers': [{'id': MGLOSS, 'name': 'Morph Gloss',
                                  'config': {'igt': {'scope': 'Morpheme', 'tagset': 'Leipzig'}}}]},
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
                    {'id': 's-1', 'begin': 0, 'end': 17},
                    {'id': 's-2', 'begin': 18, 'end': 25}],
                 'span_layers': [{'id': TRANS, 'spans': [{'id': 'sp-t1', 'value': 'Ali saw a fish.', 'tokens': ['s-1']}]}]},
                {'id': WORD_LAYER, 'tokens': [
                    {'id': 'w-1', 'begin': 0, 'end': 6, 'metadata': {'orthog:IPA': 'alidi'}},
                    {'id': 'w-2', 'begin': 7, 'end': 10},
                    {'id': 'w-3', 'begin': 11, 'end': 16},
                    {'id': 'w-p', 'begin': 16, 'end': 17},
                    {'id': 'w-4', 'begin': 18, 'end': 24},
                    {'id': 'w-p2', 'begin': 24, 'end': 25}],
                 'span_layers': [{'id': GLOSS, 'spans': [{'id': 'sp-g1', 'value': 'Ali', 'tokens': ['w-1']}]}],
                 'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'vocab_links': [
                     {'id': 'l-1', 'vocab_item': {'id': 'vi-ali', 'form': 'Ali'}, 'tokens': ['w-1']}]}]},
                {'id': MORPH_LAYER, 'tokens': [
                    {'id': 'm-1a', 'begin': 0, 'end': 6, 'precedence': 1, 'metadata': {'form': 'Ali'}},
                    {'id': 'm-1b', 'begin': 0, 'end': 6, 'precedence': 2,
                     'metadata': {'form': 'di', 'morphType': 'suffix'}},
                    {'id': 'm-2', 'begin': 7, 'end': 10, 'precedence': 1},
                    {'id': 'm-4a', 'begin': 18, 'end': 24, 'precedence': 1, 'metadata': {'form': 'Gam'}},
                    {'id': 'm-4b', 'begin': 18, 'end': 24, 'precedence': 2,
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


def audit_raw():
    """Two entries, naming this project's own document."""
    return [
        {'id': 'g1', 'time': '2026-08-29T18:51:47Z', 'user': {'id': 'a@b.com', 'display_name': 'Luke G'},
         'message': 'Assistant: 2 field values', 'documents': [{'id': 'd1', 'name': 'Text 1'}],
         'ops': [{'type': 'span/create', 'description': 'Create span'},
                 {'type': 'span/update', 'description': 'Update span'}]},
        {'id': 'o2', 'time': '2026-08-28T10:00:00Z', 'user': {'id': 'x@y.z', 'display_name': 'Someone'},
         'documents': [], 'ops': [{'type': 'project/create', 'description': 'Create project "Demo"'}]},
    ]


def guidelines_raw():
    """The project's annotation manual: one pinned, one not, one with an empty
    body (a guideline titled now and written later)."""
    return [
        {'id': 'gl1', 'title': 'Glossing', 'pinned': True,
         'summary': 'Leipzig, with this project\'s own exceptions.',
         'body': 'Loanwords are **not** segmented. Gloss them whole.'},
        {'id': 'gl2', 'title': 'Translations', 'pinned': False,
         'summary': 'What a free translation should look like here.',
         'body': 'Idiomatic English, not a word-by-word rendering.'},
        {'id': 'gl3', 'title': 'Orthography', 'pinned': False,
         'summary': 'Nothing decided yet.', 'body': ''},
    ]


class FakeClient(BaseFakeClient):
    """The app-neutral fake client with this app's project, document, lexicon
    and audit log."""

    def __init__(self, project=None, documents=None, lexicon=None, audit=None, guidelines=None):
        super().__init__(project or project_raw(),
                         documents if documents is not None else {'d1': document_raw()},
                         audit if audit is not None else audit_raw(),
                         guidelines if guidelines is not None else guidelines_raw())
        self._lexicon = lexicon or lexicon_raw()

    class _VocabLayers:
        def __init__(self, c):
            self.c = c

        def get(self, vid, include_items=None, **kw):
            by_id = getattr(self.c, '_lexicons_by_id', None)
            return by_id[vid] if by_id else self.c._lexicon

    @property
    def vocab_layers(self):
        return FakeClient._VocabLayers(self)


# --- an unconventionally shaped project -------------------------------------------
# No morpheme layer, fields not called Gloss (and the gloss-like one is NOT first),
# a lexicon whose schema names its fields "meaning" and "category", another with
# no schema at all. Everything the agent infers about roles must come from config.

ODD_CAT, ODD_MEAN, ODD_FREE = 'sl-cat', 'sl-mean', 'sl-free'
ODD_VOCAB, ODD_VOCAB2 = 'v-odd', 'v-plain'


def odd_project_raw():
    return {
        'id': PID, 'name': 'Odd', 'config': {'igt': {'initialized': True, 'documentMetadata': []}},
        'vocabs': [{'id': ODD_VOCAB, 'name': 'Wordlist', 'config': {'igt': {'fields': {'meaning': {}, 'category': {}}}}},
                   {'id': ODD_VOCAB2, 'name': 'Plain', 'config': {}}],
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'config': {'plaid': {'role': 'baseline'}},
            'token_layers': [
                {'id': SENT_LAYER, 'name': 'Lines', 'config': {'plaid': {'role': 'sentence'}},
                 'span_layers': [{'id': ODD_FREE, 'name': 'Free translation', 'config': {'igt': {'scope': 'Sentence'}}}]},
                {'id': WORD_LAYER, 'name': 'Tokens',
                 'config': {'plaid': {'role': 'word'}, 'igt': {'orthographies': [], 'ignoredTokens': {'type': 'blacklist', 'blacklist': ['.']}}},
                 'span_layers': [{'id': ODD_CAT, 'name': 'Category', 'config': {'igt': {'scope': 'Word'}}},
                                 {'id': ODD_MEAN, 'name': 'Meaning', 'config': {'igt': {'scope': 'Word'}}}]},
            ]}],
    }


def odd_document_raw():
    return {
        'id': 'd1', 'name': 'Odd text', 'version': 1, 'metadata': {},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': BODY},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': [
                    {'id': 's-1', 'begin': 0, 'end': 17},
                    {'id': 's-2', 'begin': 18, 'end': 25}],
                 'span_layers': [{'id': ODD_FREE, 'spans': [{'id': 'sp-f1', 'value': 'Ali saw a fish.', 'tokens': ['s-1']}]}]},
                {'id': WORD_LAYER, 'tokens': [
                    {'id': 'w-1', 'begin': 0, 'end': 6},
                    {'id': 'w-2', 'begin': 7, 'end': 10},
                    {'id': 'w-3', 'begin': 11, 'end': 16},
                    {'id': 'w-p', 'begin': 16, 'end': 17},
                    {'id': 'w-4', 'begin': 18, 'end': 24},
                    {'id': 'w-p2', 'begin': 24, 'end': 25}],
                 'span_layers': [{'id': ODD_CAT, 'spans': [{'id': 'sp-c1', 'value': 'N', 'tokens': ['w-1']},
                                                           {'id': 'sp-c2', 'value': 'N', 'tokens': ['w-2']}]},
                                 {'id': ODD_MEAN, 'spans': [{'id': 'sp-m1', 'value': 'Ali.ERG', 'tokens': ['w-1']},
                                                            {'id': 'sp-m2', 'value': 'fish', 'tokens': ['w-2']}]}],
                 'vocabs': [{'id': ODD_VOCAB, 'name': 'Wordlist', 'vocab_links': [
                     {'id': 'l-1', 'vocab_item': {'id': 'oi-gam', 'form': 'gam'}, 'tokens': ['w-2']},
                     {'id': 'l-2', 'vocab_item': {'id': 'oi-gam2', 'form': 'gam'}, 'tokens': ['w-4']}]}]},
            ]}],
    }


def odd_lexicons():
    return {ODD_VOCAB: {'id': ODD_VOCAB, 'name': 'Wordlist', 'items': [
                {'id': 'oi-gam', 'form': 'gam', 'metadata': {'meaning': 'net', 'category': 'n'}},
                {'id': 'oi-gam2', 'form': 'gam', 'metadata': {'meaning': 'net'}},
                {'id': 'oi-ali', 'form': 'Ali', 'metadata': {'category': 'pn'}}]},
            ODD_VOCAB2: {'id': ODD_VOCAB2, 'name': 'Plain', 'items': [
                {'id': 'pi-1', 'form': 'akuna', 'metadata': {'gloss': 'see', 'note': 'x'}}]}}


def odd_client():
    c = FakeClient(project=odd_project_raw(), documents={'d1': odd_document_raw()})
    c._lexicons_by_id = odd_lexicons()
    return c


def scan_ws(client, project_id='p1'):
    """A workspace over the fake client: it has no query engine, so every
    corpus-wide tool takes the scan path (the query path is tested live)."""
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    w = Workspace(client, load_project(client, project_id))
    w.prefer_scan = True
    return w
