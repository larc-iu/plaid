"""Tests for the tokenization workflow's document rewrite.

The 500 lines that every tokenize service runs had no test of their own. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import contextlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.tokenization import (  # noqa: E402
    TokenProcessor, TokenSpan, helpers, tokenizer_model,
)


class _Helper:
    """A response helper that remembers every terminal report, so a test can
    see a request reported twice."""

    def __init__(self):
        self.errors = []
        self.done = []

    def progress(self, percent, msg='', **extra):
        pass

    def complete(self, data=None):
        self.done.append(data)

    def error(self, err):
        self.errors.append(str(err))

    @contextlib.contextmanager
    def critical(self):
        yield


class _Batch:
    """What ``batched()`` yields: the client's resources bound to this batch,
    so a write made on it queues until ``submit``. Everything the batch does
    not have itself is the client's."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.documents = client._Documents(self)
        self.tokens = client._Tokens(self)

    def __getattr__(self, name):
        return getattr(self.client, name)

    def _record(self, call):
        self.queued.append(call)

    def submit(self):
        queued, self.queued = self.queued, []
        self.client.calls.extend(queued)
        self.client.batches.append(queued)
        self.results = [{'body': {'id': f'new-{i}'}} for i in range(len(queued))]
        return self.results

    def abort(self):
        self.queued = []


class _FakeClient:
    """Enough of PlaidClient to drive TokenProcessor: a document to read back,
    and a log of every write it is asked to make. A write made on the CLIENT
    goes out at once whatever batches are open; one made on a batch queues
    until it submits, and an aborted batch writes nothing."""

    # strict mode, as the real client keeps it
    strict_mode_document_id = None

    def enter_strict_mode(self, document_id):
        self.strict_mode_document_id = document_id

    def __init__(self, document):
        self.document_versions = {}
        self.document = document
        self.calls = []
        self.locked_documents = []
        self.batches = []
        self.documents = self._Documents(self)
        self.tokens = self._Tokens(self)

    def _record(self, call):
        self.calls.append(call)

    def batch(self):
        return _Batch(self)

    @contextlib.contextmanager
    def batched(self):
        batch = _Batch(self)
        try:
            yield batch
        except BaseException:
            batch.abort()
            raise
        batch.submit()

    class _Documents:
        def __init__(self, owner):
            self._owner = owner

        def get(self, document_id, include_body=None):
            return self._owner.document

        @contextlib.contextmanager
        def locked(self, document_id):
            self._owner.locked_documents.append(document_id)
            self._owner._record(('lock', document_id))
            try:
                yield
            finally:
                self._owner._record(('unlock', document_id))

    class _Tokens:
        def __init__(self, owner):
            self._owner = owner

        def bulk_create(self, ops):
            self._owner._record(('bulk_create', list(ops)))

        def bulk_delete(self, ids):
            self._owner._record(('bulk_delete', list(ids)))

        def delete(self, token_id):
            self._owner._record(('delete', token_id))


def _document(body, *, sentences=(), words=(), sentence_spans=(), sentence_links=()):
    """A document body shaped the way ``documents.get(include_body=True)``
    returns one: one text layer, a word layer, a sentence layer."""
    return {
        'text_layers': [{
            'id': 'text-layer',
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                {'id': 'word-layer', 'name': 'Words',
                 'tokens': [{'id': f'w{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(words)]},
                {'id': 'sentence-layer', 'name': 'Sentences',
                 'tokens': [{'id': f's{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(sentences)],
                 'span_layers': [{'id': 'note-layer', 'name': 'Note',
                                  'spans': list(sentence_spans)}],
                 'vocabs': [{'id': 'v1', 'vocab_links': list(sentence_links)}]},
            ],
        }],
    }


def _spans(text):
    return [TokenSpan(text=text, start=0, end=len(text))]


def _two_sentences():
    """'Hello there.' read as two sentences, so the one the document has is
    reset (a sentence found unchanged is left standing)."""
    return [TokenSpan(text='Hello', start=0, end=5), TokenSpan(text='there.', start=6, end=12)]


def test_a_refused_run_raises_instead_of_reporting_over_its_caller():
    # The sentence reset would cascade away a human-made annotation. The
    # refusal must reach the caller as an exception: reporting it here and
    # returning zero counts let the caller's own `complete` land on top of the
    # error, so the requester was told the run both failed and succeeded.
    human_span = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    doc = _document('Hello there.', sentences=[(0, 12)], words=[],
                    sentence_spans=[human_span])
    client = _FakeClient(doc)
    helper = _Helper()
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(
            client, 'd1', _two_sentences(),
            [TokenSpan(text='Hello', start=0, end=5)],
            'word-layer', 'sentence-layer', helper,
            text_layer_id='text-layer')
    assert 'human-made or human-verified' in str(caught.value)
    assert helper.errors == [] and helper.done == []
    # Nothing was written, and the lock it took was given back.
    assert [c for c in client.calls if c[0] in ('bulk_create', 'bulk_delete', 'delete')] == []
    assert client.calls[0] == ('lock', 'd1') and client.calls[-1] == ('unlock', 'd1')


def test_a_machine_annotation_is_not_in_the_way():
    machine = {'id': 'sp1', 'tokens': ['s0'], 'value': 'guess',
               'metadata': {'prov': 'inferred', 'provSource': 'service:x'}}
    doc = _document('Hello there.', sentences=[(0, 12)], words=[],
                    sentence_spans=[machine])
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', _two_sentences(),
        [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer')
    assert counts['sentences_created'] == 2


def test_an_empty_document_is_refused_in_words_not_in_zeroes():
    client = _FakeClient(_document('   ', sentences=[], words=[]))
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(client, 'd1', [], [], 'word-layer',
                                        'sentence-layer', _Helper(),
                                        text_layer_id='text-layer')
    assert 'no text' in str(caught.value)


def test_a_missing_word_layer_is_refused():
    client = _FakeClient(_document('Hello.', sentences=[(0, 6)]))
    with pytest.raises(ValueError):
        TokenProcessor().process_tokens(client, 'd1', _spans('Hello.'),
                                        [TokenSpan(text='Hello', start=0, end=5)],
                                        'no-such-layer', 'sentence-layer', _Helper(),
                                        text_layer_id='text-layer')


def test_split_tokens_are_deleted_in_one_op_however_many_there_are():
    # Two existing sentences, so the partition is left alone and the words that
    # straddle the boundary are deleted individually. One op per token put an
    # unbounded number of sub-ops in a single batch (the server caps it at
    # 1000) and made the whole batch fail on any id that had already gone.
    body = 'ab cd ef gh'
    crossing = [(0, 5), (3, 8), (6, 11)]
    doc = _document(body, sentences=[(0, 6), (6, 11)], words=crossing)
    client = _FakeClient(doc)
    TokenProcessor().process_tokens(
        client, 'd1', _spans(body),
        [TokenSpan(text='ab', start=0, end=2)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer')
    deletes = [c for c in client.calls if c[0] == 'delete']
    bulk = [c for c in client.calls if c[0] == 'bulk_delete']
    assert deletes == []
    # Only the token that really straddles the boundary goes. w2 sits inside
    # the second sentence and merely contains a piece w1 was cut into, which
    # used to be read as "w2 was split too".
    assert bulk == [('bulk_delete', ['w1'])]


def test_a_document_edited_since_it_was_read_is_not_tokenized():
    # The text was read, and tokenized, before the lock was taken. An edit in
    # between moved every offset, so the run is refused rather than cutting the
    # text in the places the old string had.
    doc = _document('Hello there.', sentences=[(0, 12)], words=[])
    doc['version'] = 59
    client = _FakeClient(doc)
    helper = _Helper()
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(
            client, 'd1', _spans('Hello there.'),
            [TokenSpan(text='Hello', start=0, end=5)],
            'word-layer', 'sentence-layer', helper,
            text_layer_id='text-layer', expect_version=58)
    assert 'changed while this run was working' in str(caught.value)
    assert helper.errors == [] and helper.done == []
    assert [c for c in client.calls if c[0] in ('bulk_create', 'bulk_delete')] == []


def test_the_same_document_is_tokenized():
    doc = _document('Hello there.', sentences=[(0, 12)], words=[])
    doc['version'] = 58
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', _two_sentences(),
        [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer', expect_version=58)
    assert counts['sentences_created'] == 2


def test_a_run_stamps_what_it_creates_with_the_detail_it_is_given():
    """A service passes who asked (``requester.detail()``) as ``prov_detail``,
    and every token the run creates carries it (umr-collab-service-requester)."""
    doc = _document('Hello there.', sentences=[(0, 12)], words=[])
    client = _FakeClient(doc)
    TokenProcessor().process_tokens(
        client, 'd1', _spans('Hello there.'),
        [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(), text_layer_id='text-layer',
        prov_source='service:punkt', prov_detail={'requestedBy': 'second@x.com'})
    created = [op for call in client.calls if call[0] == 'bulk_create' for op in call[1]]
    assert created
    for op in created:
        assert op['metadata'] == {'prov': 'inferred', 'provSource': 'service:punkt',
                                  'provDetail': {'requestedBy': 'second@x.com'}}


# --- the converters a service author builds on -------------------------------
# helpers is in the package's __all__, so these are public surface. Nothing in
# this repo calls four of them, which is exactly why they need a test: a break
# would otherwise first be noticed by somebody writing their own service.

class _SpacyToken:
    def __init__(self, text, idx, is_space=False):
        self.text = text
        self.idx = idx
        self.is_space = is_space
        self.pos_ = 'NOUN'
        self.lemma_ = text.lower()
        self.is_alpha = text.isalpha()
        self.is_punct = not text.isalnum()


class _SpacySent:
    def __init__(self, text, start_char, end_char):
        self.text = text
        self.start_char = start_char
        self.end_char = end_char


class _SpacyDoc:
    def __init__(self, sents, tokens):
        self.sents = sents
        self._tokens = tokens

    def __iter__(self):
        return iter(self._tokens)


def test_spans_from_spacy_doc_keeps_character_positions_and_skips_whitespace():
    text = 'Dogs bark. Cats nap.'
    doc = _SpacyDoc(
        [_SpacySent('Dogs bark.', 0, 10), _SpacySent('Cats nap.', 11, 20)],
        [_SpacyToken('Dogs', 0), _SpacyToken(' ', 4, is_space=True),
         _SpacyToken('bark', 5), _SpacyToken('.', 9), _SpacyToken('Cats', 11)])
    sentences, words = helpers.spans_from_spacy_doc(doc)
    assert [(s.start, s.end) for s in sentences] == [(0, 10), (11, 20)]
    assert [(w.text, w.start, w.end) for w in words] == [
        ('Dogs', 0, 4), ('bark', 5, 9), ('.', 9, 10), ('Cats', 11, 15)]
    assert words[0].metadata['lemma'] == 'dogs' and words[0].metadata['pos'] == 'NOUN'


class _Encoding:
    def __init__(self, offset_mapping, input_ids):
        self.offset_mapping = offset_mapping
        self.input_ids = input_ids
        self.attention_mask = [1] * len(input_ids)


class _HfTokenizer:
    """Shaped like a fast HuggingFace tokenizer: callable, with an offset
    mapping whose special tokens are zero-width."""

    def __init__(self, offsets, ids, pieces=()):
        self._offsets = offsets
        self._ids = ids
        self._pieces = list(pieces)

    def __call__(self, text, return_offsets_mapping=True):
        return _Encoding(self._offsets, self._ids)

    def tokenize(self, text):
        return self._pieces


def test_spans_from_transformers_tokenizer_reads_the_offset_mapping():
    text = 'unhappy dog'
    tok = _HfTokenizer([(0, 0), (0, 2), (2, 7), (8, 11), (0, 0)],
                       [101, 5, 6, 7, 102])
    spans = helpers.spans_from_transformers_tokenizer(text, tok)
    # The zero-width special tokens at either end are not spans.
    assert [(s.text, s.start, s.end) for s in spans] == [
        ('un', 0, 2), ('happy', 2, 7), ('dog', 8, 11)]
    assert spans[0].metadata['token_id'] == 5


def test_a_tokenizer_without_offsets_falls_back_to_finding_the_strings():
    text = 'unhappy dog'
    tok = _HfTokenizer([], [], pieces=['un', 'happy', 'dog'])
    spans = helpers.spans_from_transformers_tokenizer(text, tok, return_offsets_mapping=False)
    assert [(s.text, s.start, s.end) for s in spans] == [
        ('un', 0, 2), ('happy', 2, 7), ('dog', 8, 11)]


def test_spans_from_whitespace_splits_sentences_on_newlines_and_words_on_space():
    text = 'one two\n\nthree four\nfive'
    sentences, words = helpers.spans_from_whitespace(text)
    assert [s.text for s in sentences] == ['one two', 'three four', 'five']
    assert [(w.text, w.start) for w in words] == [
        ('one', 0), ('two', 4), ('three', 9), ('four', 15), ('five', 20)]
    # Text with no newline at all is one sentence covering all of it.
    only, _ = helpers.spans_from_whitespace('just this')
    assert [(s.start, s.end) for s in only] == [(0, 9)]


def test_spans_from_tokens_walks_forward_and_drops_what_it_cannot_place():
    text = 'the cat sat on the mat'
    spans = helpers.spans_from_tokens(text, ['the', 'cat', ' ', 'sat', 'zebra', 'the'])
    assert [(s.text, s.start) for s in spans] == [
        ('the', 0), ('cat', 4), ('sat', 8), ('the', 15)]
    # The second "the" is the later one: positions only ever move forward, so a
    # repeated token cannot land back on the first occurrence.
    assert spans[-1].start > spans[0].start


def test_spans_from_nltk_spans_drops_empty_and_whitespace_only_ranges():
    text = 'ab  cd'
    spans = tokenizer_model.spans_from_nltk_spans(text, [(0, 2), (2, 4), (4, 6), (6, 6)])
    assert [(s.text, s.start, s.end) for s in spans] == [('ab', 0, 2), ('cd', 4, 6)]


class _FakePunkt:
    """A Punkt model stands for its span_tokenize, which is all the converter
    asks it for. The Treebank word tokenizer beneath it is the real one."""

    def __init__(self, spans):
        self._spans = spans

    def span_tokenize(self, text):
        return list(self._spans)


def test_spans_from_nltk_punkt_makes_the_sentences_tile_the_whole_text():
    # The helper's word tokenizer is nltk's; the package does not depend on it.
    pytest.importorskip('nltk')
    # The sentence layer is partitioning, so the converter that feeds it must
    # leave no gap: the first sentence is pulled back to 0, each one runs to
    # where the next begins, and the last runs to the end of the text.
    text = '  Dogs bark. Cats nap.  '
    sentences, words = helpers.spans_from_nltk_punkt(text, _FakePunkt([(2, 12), (13, 22)]))
    assert [(s.start, s.end) for s in sentences] == [(0, 13), (13, len(text))]
    assert sentences[0].end == sentences[1].start
    assert [w.text for w in words] == ['Dogs', 'bark', '.', 'Cats', 'nap', '.']
    # Word positions are absolute, not relative to their sentence.
    assert all(text[w.start:w.end] == w.text for w in words)


def test_text_punkt_finds_no_sentence_in_is_one_sentence():
    # The helper's word tokenizer is nltk's; the package does not depend on it.
    pytest.importorskip('nltk')
    text = 'no boundaries here'
    sentences, words = helpers.spans_from_nltk_punkt(text, _FakePunkt([]))
    assert [(s.start, s.end) for s in sentences] == [(0, len(text))]
    assert [w.text for w in words] == ['no', 'boundaries', 'here']


def test_the_words_of_a_long_document_go_in_batches_the_server_takes():
    """One batch of every word of a long document passed the server's JSON
    body cap and was refused whole with a 413 (conc-2026-09-29 W-PY2, the
    Stanza parse's R1 in the tokenizer). The words ride beside the new
    sentence partition as far as the cap allows, and the rest follow."""
    import types
    words = [(i * 5, i * 5 + 4) for i in range(200)]
    body = ' '.join(['word'] * 200)
    doc = _document(body, sentences=[(0, len(body))], words=[])
    client = _FakeClient(doc)
    client.server = types.SimpleNamespace(limits=lambda: {'json_body_bytes': 8000})
    TokenProcessor().process_tokens(
        client, 'd1', [TokenSpan(text=body[:499], start=0, end=499),
                       TokenSpan(text=body[500:], start=500, end=len(body))],
        [TokenSpan(text='word', start=b, end=e) for b, e in words],
        'word-layer', 'sentence-layer', _Helper(), text_layer_id='text-layer',
        prov_source='service:punkt')
    assert len(client.batches) > 2
    first = client.batches[0]
    assert [call[0] for call in first] == ['bulk_delete', 'bulk_create', 'bulk_create']
    assert all([call[0] for call in b] == ['bulk_create'] for b in client.batches[1:])
    for b in client.batches:
        assert len(json.dumps([call[1] for call in b])) <= 8000 * 0.5 + 200
    made = [(op['begin'], op['end']) for b in client.batches for call in b if call[0] == 'bulk_create'
            for op in call[1] if op['token_layer_id'] == 'word-layer']
    assert made == words


def test_a_failure_in_a_later_word_batch_says_what_was_written():
    """The first batch (the new sentences and the first words) stands when a
    later one fails, and the requester was told only "HTTP 500" (conc-2026-09-29
    REV-W-PY2)."""
    import types
    from plaid_client.http import PlaidAPIError
    words = [(i * 5, i * 5 + 4) for i in range(200)]
    body = ' '.join(['word'] * 200)
    doc = _document(body, sentences=[(0, len(body))], words=[])
    client = _FakeClient(doc)
    client.server = types.SimpleNamespace(limits=lambda: {'json_body_bytes': 8000})
    real = client.batched
    opened = []

    @contextlib.contextmanager
    def batched():
        opened.append(1)
        if len(opened) == 3:
            raise PlaidAPIError('HTTP 500 boom', status=500, method='POST',
                                url='http://plaid.internal:8085/api/v1/batch')
        with real() as b:
            yield b

    client.batched = batched
    with pytest.raises(RuntimeError) as caught:
        TokenProcessor().process_tokens(
            client, 'd1', [TokenSpan(text=body[:499], start=0, end=499),
                           TokenSpan(text=body[500:], start=500, end=len(body))],
            [TokenSpan(text='word', start=b, end=e) for b, e in words],
            'word-layer', 'sentence-layer', _Helper(), text_layer_id='text-layer',
            prov_source='service:punkt')
    made = [op for b in client.batches for call in b if call[0] == 'bulk_create'
            for op in call[1] if op['token_layer_id'] == 'word-layer']
    assert len(client.batches) == 2 and 0 < len(made) < 200
    assert str(caught.value).startswith(f'The 2 sentences were written, and {len(made)} of 200 words. '
                                        'Run the tokenizer again to finish. ')
    assert 'plaid.internal' not in str(caught.value)


# --- a one-sentence document (H26-SERVICES-4) -----------------------------------
# A sentence reset bulk-deletes the one sentence, and the server takes every
# word under it, every morpheme under those, and every span, relation and
# lexicon link on any of them. Rosetano holds one proverb per document.

BODY = 'Mimme i Rinuzza. Dorme.'
HUMAN = {}
MACHINE_MADE = {'prov': 'inferred', 'provSource': 'service:x'}


def _analyzed(*, word_spans=(), word_meta=None, morph_meta=None, morph_spans=(), morph_links=(),
              relations=(), sentences=((0, len(BODY)),)):
    """Words Mimme, i, Rinuzza, '.', Dorme, '.' under the given sentences, and
    a morpheme for Mimme. Nesting as plaid-igt sets it up: words under the
    sentences, morphemes under the words."""
    words = [(0, 5), (6, 7), (8, 15), (15, 16), (17, 22), (22, 23)]
    return {'version': 7, 'text_layers': [{
        'id': 'text-layer', 'text': {'id': 'text-1', 'body': BODY},
        'token_layers': [
            {'id': 'sentence-layer', 'name': 'Sentences',
             'tokens': [{'id': f's{i}', 'begin': b, 'end': e} for i, (b, e) in enumerate(sentences)],
             'span_layers': [], 'vocabs': []},
            {'id': 'word-layer', 'name': 'Words', 'parent_token_layer': 'sentence-layer',
             'tokens': [{'id': f'w{i}', 'begin': b, 'end': e,
                         **({'metadata': word_meta} if i == 0 and word_meta is not None else {})}
                        for i, (b, e) in enumerate(words)],
             'span_layers': [{'id': 'wg', 'name': 'Word Gloss', 'spans': list(word_spans)}],
             'vocabs': []},
            {'id': 'morph-layer', 'name': 'Morphemes', 'parent_token_layer': 'word-layer',
             'tokens': [{'id': 'm0', 'begin': 0, 'end': 5, 'metadata': morph_meta or {}}],
             'span_layers': [{'id': 'mg', 'name': 'Gloss', 'spans': list(morph_spans),
                              'relation_layers': [{'id': 'rl', 'name': 'Dep',
                                                   'relations': list(relations)}]}],
             'vocabs': [{'id': 'v1', 'vocab_links': list(morph_links)}]},
        ]}]}


def _punkt_words():
    return [TokenSpan(text=BODY[b:e], start=b, end=e)
            for b, e in [(0, 5), (6, 7), (8, 15), (15, 16), (17, 22), (22, 23)]]


def _run(doc, sentences, *, overwrite=False):
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', sentences, _punkt_words(), 'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer', expect_version=7, overwrite=overwrite)
    return client, counts


def _writes(client):
    return [c for c in client.calls if c[0] in ('bulk_create', 'bulk_delete', 'delete')]


ONE = [TokenSpan(text=BODY, start=0, end=len(BODY))]
TWO = [TokenSpan(text=BODY[:16], start=0, end=16), TokenSpan(text=BODY[17:], start=17, end=len(BODY))]


def test_a_sentence_punkt_finds_unchanged_is_left_standing_with_everything_on_it():
    """Punkt found the one sentence the document already had. The run deleted
    it and made it again, and the delete took every word, morpheme, gloss and
    link with it, with Overwrite off and a result saying 0 deleted."""
    gloss = {'id': 'g1', 'tokens': ['m0'], 'value': 'Mimmo', 'metadata': HUMAN}
    doc = _analyzed(morph_spans=[gloss], morph_meta={'form': 'Mimme'})
    # the document lacks one word Punkt finds
    doc['text_layers'][0]['token_layers'][1]['tokens'].pop()
    client, counts = _run(doc, ONE)
    assert not [c for c in client.calls if c[0] in ('bulk_delete', 'delete')]
    assert _writes(client) == [('bulk_create', [{'token_layer_id': 'word-layer', 'text': 'text-1',
                                                 'begin': 22, 'end': 23}])]
    assert counts == {'tokens_created': 1, 'tokens_deleted': 0, 'sentences_created': 0}


@pytest.mark.parametrize('what, doc', [
    ('a word gloss', lambda: _analyzed(word_spans=[{'id': 'g', 'tokens': ['w0'], 'metadata': HUMAN}])),
    ('an orthography line', lambda: _analyzed(word_meta={'orthog:Translit': 'Mimme'})),
    ('a segmentation alone', lambda: _analyzed(morph_meta={'form': 'Mimm', 'morphType': 'stem'})),
    ('a morpheme gloss', lambda: _analyzed(morph_spans=[{'id': 'g', 'tokens': ['m0'], 'metadata': HUMAN}])),
    ('a verified gloss', lambda: _analyzed(morph_spans=[{'id': 'g', 'tokens': ['m0'],
                                                         'metadata': {**MACHINE_MADE, 'provConfirmed': True}}])),
    ('a lexicon link', lambda: _analyzed(morph_links=[{'id': 'l', 'tokens': ['m0'], 'metadata': HUMAN}])),
    ('a relation', lambda: _analyzed(
        morph_spans=[{'id': 'g', 'tokens': ['m0'], 'metadata': MACHINE_MADE}],
        relations=[{'id': 'r', 'source': 'g', 'target': 'g', 'metadata': HUMAN}])),
])
def test_a_sentence_reset_refuses_over_any_persons_work_it_would_take(what, doc):
    """The refusal counted only the sentence's own spans and links, so a
    reset took a person's words, morphemes, glosses and links without one."""
    with pytest.raises(ValueError) as caught:
        _run(doc(), TWO)
    assert 'human-made or human-verified' in str(caught.value), what


def test_a_sentence_reset_over_machine_work_goes_ahead_and_counts_what_it_deletes():
    doc = _analyzed(morph_meta={'form': 'Mimm', **MACHINE_MADE},
                    morph_spans=[{'id': 'g', 'tokens': ['m0'], 'metadata': MACHINE_MADE}],
                    morph_links=[{'id': 'l', 'tokens': ['m0'], 'metadata': MACHINE_MADE}])
    client, counts = _run(doc, TWO)
    assert ('bulk_delete', ['s0']) in client.calls
    # six words and the morpheme go with the sentence, and six words come back
    assert counts == {'tokens_created': 6, 'tokens_deleted': 7, 'sentences_created': 2}


def test_overwrite_lets_a_sentence_reset_take_a_persons_work_and_counts_it():
    doc = _analyzed(morph_spans=[{'id': 'g', 'tokens': ['m0'], 'metadata': HUMAN}])
    client, counts = _run(doc, TWO, overwrite=True)
    assert ('bulk_delete', ['s0']) in client.calls
    assert counts['tokens_deleted'] == 7 and counts['sentences_created'] == 2


def test_a_sentences_own_timing_is_a_persons_work_a_reset_refuses_over():
    doc = _analyzed()
    doc['text_layers'][0]['token_layers'][0]['tokens'][0]['metadata'] = {'timeBegin': 1.5}
    with pytest.raises(ValueError):
        _run(doc, TWO)


def test_a_word_split_at_a_sentence_boundary_takes_nothing_of_a_persons_without_overwrite():
    """The word-only path deletes a word that crosses a sentence boundary
    (only possible where words are not nested in sentences), and its
    morphemes and glosses go with it. It refused nothing."""
    gloss = {'id': 'g', 'tokens': ['m0'], 'metadata': HUMAN}
    doc = _analyzed(morph_spans=[gloss], sentences=((0, 3), (3, len(BODY))))
    doc['text_layers'][0]['token_layers'][1].pop('parent_token_layer')
    with pytest.raises(ValueError) as caught:
        _run(doc, ONE)
    assert 'human-made or human-verified' in str(caught.value)
    client, counts = _run(doc, ONE, overwrite=True)
    assert ('bulk_delete', ['w0']) in client.calls
    assert counts['tokens_deleted'] == 2  # the word and its morpheme


@pytest.mark.parametrize('layer, meta', [
    (0, {**MACHINE_MADE, 'provConfirmed': True}),  # a person merged two sentences into one
    (1, {**MACHINE_MADE, 'provConfirmed': True}),  # a person split a word
    (1, {'prov': 'contributed', 'provSource': 'user:b@x.com'}),
])
def test_a_persons_reshape_of_stamped_substrate_is_refused_over(layer, meta):
    """REV-SVC-2. A person's merge or split of a machine tokenizer's token
    leaves it with provenance keys only, verified or contributed."""
    doc = _analyzed()
    doc['text_layers'][0]['token_layers'][layer]['tokens'][0]['metadata'] = meta
    with pytest.raises(ValueError):
        _run(doc, TWO)


def test_a_machine_stamped_token_alone_is_not_in_the_way():
    doc = _analyzed()
    doc['text_layers'][0]['token_layers'][1]['tokens'][0]['metadata'] = dict(MACHINE_MADE)
    _, counts = _run(doc, TWO)
    assert counts['sentences_created'] == 2


def _with_graph(doc, edge_metadata, *, keeps_within=True):
    """``doc`` with another app's graph: a root layer of nodes over 'Hello'
    and 'there', and an edge between them, kept inside one sentence by
    ``same-ancestor`` over the sentence layer (or not)."""
    rules = {'umr': [{'type': 'same-ancestor', 'token_layer': 'sentence-layer'}]} if keeps_within else {}
    doc['text_layers'][0]['token_layers'].append({
        'id': 'node-layer', 'name': 'Nodes', 'parent_token_layer': None,
        'tokens': [{'id': 'n0', 'begin': 0, 'end': 5}, {'id': 'n1', 'begin': 6, 'end': 11}],
        'span_layers': [{'id': 'concept-layer', 'spans': [
            {'id': 'c0', 'tokens': ['n0'], 'value': 'hello'},
            {'id': 'c1', 'tokens': ['n1'], 'value': 'there'}],
            'relation_layers': [{'id': 'edge-layer', 'constraints': rules, 'relations': [
                {'id': 'e1', 'source': 'c0', 'target': 'c1', 'value': ':ARG0',
                 'metadata': edge_metadata}]}]}],
    })
    return doc


def _reset(doc):
    client = _FakeClient(doc)
    TokenProcessor().process_tokens(
        client, 'd1', _two_sentences(), [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(), text_layer_id='text-layer')
    return client


def test_a_reset_refuses_to_cut_a_human_edge_across_its_new_break():
    # The nodes are nested in no sentence, so the reset does not delete them.
    # Core's same-ancestor rule deletes the edge between them once the new
    # break leaves its ends in two sentences, in the reset's own transaction.
    # A real core lost it with nothing asked (D7-FAKES).
    doc = _with_graph(_document('Hello there.', sentences=[(0, 12)], words=[]), {})
    with pytest.raises(ValueError) as caught:
        _reset(doc)
    assert 'Re-tokenizing would delete 1 human-made' in str(caught.value)


def test_a_machine_edge_across_the_break_is_not_in_the_way():
    doc = _with_graph(_document('Hello there.', sentences=[(0, 12)], words=[]),
                      {'prov': 'inferred', 'provSource': 'service:x'})
    client = _reset(doc)
    assert any(c[0] == 'bulk_delete' for c in client.calls)


def test_an_edge_no_rule_keeps_in_one_sentence_is_not_counted():
    doc = _with_graph(_document('Hello there.', sentences=[(0, 12)], words=[]), {},
                      keeps_within=False)
    client = _reset(doc)
    assert any(c[0] == 'bulk_delete' for c in client.calls)



# REV-D7-FAKES R2: a document with no sentences (one just typed, or one whose
# tokens were cleared) took the word-only path, and the server refused every
# word for lying in no sentence. It gets its sentences, which delete nothing,
# though their breaks can still cut an edge kept inside one sentence.
def test_a_document_with_no_sentences_gets_them():
    client = _reset(_document('Hello there.', sentences=[], words=[]))
    created = [c[1] for c in client.calls if c[0] == 'bulk_create']
    assert [(op['begin'], op['end']) for op in created[0]] == [(0, 6), (6, 12)]
    assert not any(c[0] == 'bulk_delete' for c in client.calls)


def test_new_sentences_refuse_to_cut_a_human_edge_without_overwrite():
    doc = _with_graph(_document('Hello there.', sentences=[], words=[]), {})
    with pytest.raises(ValueError) as caught:
        _reset(doc)
    assert 'Re-tokenizing would delete 1 human-made' in str(caught.value)
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', _two_sentences(), [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(), text_layer_id='text-layer',
        overwrite=True)
    assert counts['sentences_created'] == 2
