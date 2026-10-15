"""Several documents in place of one on every read that takes a document,
``where`` on frequency_list, and frequency_list(ngram=...) (survey item 8:
453d5450, 9fdebcc2, 3f573b0f, 061da0f0). Against the real engine."""

import copy

import pytest

import fixtures as igt_fx
from fixtures import FakeClient, fake_ws

from plaid_agent.core.bidi import for_model
from plaid_agent.igt.toolkit import SCOPED_READS, call_tool, _IMPL
from plaid_agent.igt.trace import describe_step


def _copy_of(raw, did, name, prefix):
    """``raw`` as another document: its own ids for the text, tokens, spans
    and links, the layers and lexicon entries shared."""
    d = copy.deepcopy(raw)
    d['id'], d['name'] = did, name
    tl = d['text_layers'][0]
    tl['text']['id'] = prefix + tl['text']['id']
    for layer in tl['token_layers']:
        for t in layer['tokens']:
            t['id'] = prefix + t['id']
        for sl in layer.get('span_layers') or []:
            for sp in sl['spans']:
                sp['id'] = prefix + sp['id']
                sp['tokens'] = [prefix + t for t in sp['tokens']]
        for v in layer.get('vocabs') or []:
            for ln in v.get('vocab_links') or []:
                ln['id'] = prefix + ln['id']
                ln['tokens'] = [prefix + t for t in ln['tokens']]
    return d


def _ws():
    client = FakeClient()
    raw = client._documents['d1']
    client._documents['d2'] = _copy_of(raw, 'd2', 'Text 2', 'b-')
    client._documents['d3'] = _copy_of(raw, 'd3', 'Text 3', 'c-')
    return fake_ws(client)


def _row(out, form):
    """The count column of ``form``'s row in a frequency list."""
    for line in out.splitlines():
        cells = line.strip().split('\t')
        if len(cells) == 3 and cells[2] == form:
            return int(cells[0]), int(cells[1])
    return None


def test_documents_holds_a_read_to_the_documents_named():
    w = _ws()
    assert _row(call_tool(w, 'frequency_list', {}), 'gam') == (3, 3)
    out = call_tool(w, 'frequency_list', {'documents': ['Text 1', 'Text 3']})
    assert out.startswith('In 2 documents: "Text 1", "Text 3".'), out
    assert _row(out, 'gam') == (2, 2)
    # One document named is that document.
    one = call_tool(w, 'frequency_list', {'documents': ['Text 2']})
    assert one == call_tool(w, 'frequency_list', {'document': 'Text 2'})


def test_every_read_that_takes_a_document_takes_documents():
    w = _ws()
    args = {'search': {'pattern': 'gam'}, 'concordance': {'pattern': 'di'}, 'analyses_of': {'form': 'gam'},
            'check_consistency': {'field': 'Morph Gloss'}, 'corpus_stats': {'by': 'document'},
            'frequency_list': {}, 'worklist': {}, 'check_integrity': {},
            'sequence_search': {'sequence': [{'form': 'gam'}, {'form': 'akuna'}]}}
    assert set(args) == set(SCOPED_READS)
    for name, a in args.items():
        out = for_model(call_tool(w, name, {**a, 'documents': ['Text 1', 'Text 2']}))
        assert out.startswith('In 2 documents: "Text 1", "Text 2".'), (name, out)
        assert 'Text 3' not in out.split('\n', 1)[1], (name, out)
    # The per-document table lists only the documents named.
    out = call_tool(w, 'corpus_stats', {'by': 'document', 'documents': ['Text 1', 'Text 2']})
    assert 'Text 1' in out and 'Text 2' in out


def test_document_and_documents_together_or_a_bad_name_are_refused():
    w = _ws()
    out = call_tool(w, 'search', {'pattern': 'gam', 'document': 'Text 1', 'documents': ['Text 2']})
    assert out == 'Error: Give document or documents, not both.'
    assert 'No document "Nope"' in call_tool(w, 'search', {'pattern': 'gam', 'documents': ['Text 1', 'Nope']})
    assert 'documents is a list' in call_tool(w, 'search', {'pattern': 'gam', 'documents': [3]})


def test_where_holds_a_frequency_list_to_the_words_meeting_it():
    w = _ws()
    out = call_tool(w, 'frequency_list', {'where': {'Morph Gloss': 'ERG'}, 'document': 'Text 1'})
    assert out.startswith('1 wordforms, case folded, where Morph Gloss is "ERG", 1 tokens'), out
    assert _row(out, 'ali-di') == (1, 1)
    out = call_tool(w, 'frequency_list', {'what': 'Morph Gloss', 'where': {'form': 'Ali-di'}})
    assert _row(out, 'ERG') == (3, 3) and _row(out, 'Ali') == (3, 3)
    out = call_tool(w, 'frequency_list', {'what': 'morpheme', 'where': {'form': 'gam'}})
    assert _row(out, 'gam') == (3, 3) and _row(out, 'ar') is None


def test_ngram_counts_adjacent_words_inside_a_sentence():
    w = _ws()
    out = call_tool(w, 'frequency_list', {'ngram': 2})
    # Ali-di gam akuna . | Gam-ar . : no pair across punctuation or sentences.
    assert out.startswith('2 word bigrams, case folded, 6 occurrences'), out
    assert _row(out, 'ali-di gam') == (3, 3) and _row(out, 'gam akuna') == (3, 3)
    out = call_tool(w, 'frequency_list', {'ngram': 3, 'document': 'Text 1'})
    assert _row(out, 'ali-di gam akuna') == (1, 1)
    # A word field's values: only Ali-di holds a Gloss, so no pair.
    assert call_tool(w, 'frequency_list', {'ngram': 2, 'what': 'Gloss'}).startswith('0 Gloss bigrams')


@pytest.mark.parametrize('args, says', [
    ({'ngram': 2, 'what': 'morpheme'}, 'ngram counts sequences of words'),
    ({'ngram': 2, 'what': 'Morph Gloss'}, 'ngram counts sequences of words'),
    ({'ngram': 2, 'where': {'form': 'gam'}}, 'where and ngram do not combine'),
    ({'ngram': 4}, 'ngram is at most 3'),
])
def test_ngram_refusals_say_what_it_takes(args, says):
    assert says in call_tool(_ws(), 'frequency_list', args)


def test_the_trace_says_how_many_documents_and_the_ngram():
    def text(name, a):
        line = describe_step(name, a)
        return line['text'] if isinstance(line, dict) else str(line)
    assert text('search', {'pattern': 'gam', 'documents': ['A', 'B']}) == 'Searched the baseline for “gam” in 2 documents'
    assert text('frequency_list', {'what': 'POS', 'ngram': 2}) == 'Ranked POS bigrams by frequency'
    assert text('frequency_list', {'where': {'POS': 'dem'}}) == 'Ranked wordforms by frequency where POS is “dem”'


def test_the_wrapped_reads_keep_their_own_arguments():
    import inspect
    for name in SCOPED_READS:
        params = inspect.signature(_IMPL[name]).parameters
        assert 'document' in params and 'documents' in params, name


def test_ngrams_never_pair_across_punctuation_in_the_text_between_words():
    """H16-IGT-TOOLS-4: a FLEx import and text typed in the app keep
    punctuation between the word tokens, not in a token of its own."""
    w = _ws()
    for did in ('d1', 'd2'):
        text = w.client._documents[did]['text_layers'][0]['text']
        # "Ali-di,gam akuna." in two documents: the comma is no token.
        text['body'] = text['body'][:6] + ',' + text['body'][7:]
    out = call_tool(w, 'frequency_list', {'ngram': 2})
    assert _row(out, 'ali-di gam') == (1, 1) and _row(out, 'gam akuna') == (3, 3), out
    out = call_tool(w, 'frequency_list', {'ngram': 3})
    assert _row(out, 'ali-di gam akuna') == (1, 1), out
    # The project calls a character a letter: it joins words as a letter does.
    w.project.ignored_cfg = {'type': 'unicodePunctuation', 'whitelist': [',']}
    assert _row(call_tool(w, 'frequency_list', {'ngram': 2}), 'ali-di gam') == (3, 3)
