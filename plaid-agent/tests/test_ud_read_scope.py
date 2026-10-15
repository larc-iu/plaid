"""The UD reads' documents scope, and frequency_list's where and ngram, the
shapes igt's reads take (survey item 8, igt/scope.py): "focus on these two
documents", "lemmas of the plural nouns", "which tags follow which" for
word-order questions. Each is grouped reads in a real core."""

import copy

import pytest

from live import live_client, seed  # noqa: F401 - fixture
from plaid_agent.core.tools import ToolError
from plaid_agent.ud.project import load_project
from plaid_agent.ud.stats import t_frequency_list
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from plaid_agent.ud.trace import describe_step
from ud_fixtures import DEPREL, LEMMA, UPOS, document_raw, project_raw


def _copy(prefix, name, upos=None):
    doc = copy.deepcopy(document_raw())
    doc['id'], doc['name'] = prefix + doc['id'], name
    for tl in doc['text_layers']:
        tl['text']['id'] = prefix + tl['text']['id']
        for tk in tl['token_layers']:
            for t in tk.get('tokens') or []:
                t['id'] = prefix + t['id']
            for sl in tk.get('span_layers') or []:
                for sp in sl.get('spans') or []:
                    if sl['id'] == UPOS and sp['id'] in (upos or {}):
                        sp['value'] = upos[sp['id']]
                    sp['id'] = prefix + sp['id']
                    sp['tokens'] = [prefix + x for x in sp['tokens']]
                for rl in sl.get('relation_layers') or []:
                    for r in rl['relations']:
                        r['id'], r['source'], r['target'] = (prefix + r['id'], prefix + r['source'],
                                                             prefix + r['target'])
    return doc


DOCS = {'a-ud1': _copy('a-', 'Uno'), 'b-ud1': _copy('b-', 'Dos'),
        'c-ud1': _copy('c-', 'Tres', {'sp-u4': 'SYM'})}


@pytest.fixture(scope='module')
def ws(live_client):
    """Three copies of "Vamos al mar. Corre.", with their trees. In "Tres"
    the first "." is SYM."""
    from live import Seeded
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    s = seed(live_client, raw, DOCS, {}, name='ud-agent read scope test')
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    with live_client.batched() as b:
        b.token_layers.set_config(s.ids[words['id']], 'plaid', 'role', 'syntactic-word')
        for rl in lemma['relation_layers']:
            rid = s._mint(rl['id'])
            b.relation_layers.create(s.ids[LEMMA], rl['name'], id=rid)
            Seeded._configs(b.relation_layers, rid, rl.get('config'))
        for doc in DOCS.values():
            dep = doc['text_layers'][0]['token_layers'][2]['span_layers'][1]['relation_layers'][0]
            assert dep['id'] == DEPREL
            for r in dep['relations']:
                b.relations.create(s.ids[DEPREL], s.ids[r['source']], s.ids[r['target']], r['value'],
                                   id=s._mint(r['id']))
    yield Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


def _rows(out):
    return [line.split() for line in out.splitlines() if line.startswith('  ') and line.strip()[0].isdigit()]


def test_documents_hold_a_count_to_the_ones_named(ws):
    out = call_tool(ws, 'frequency_list', {'what': 'upos', 'documents': ['Uno', 'Tres']})
    assert out.startswith('In 2 documents: "Uno", "Tres".\nupos by frequency: 6 distinct value(s), 10 in all.')
    assert ['1', 'SYM'] in _rows(out) and ['1', 'PUNCT'] in _rows(out) and ['2', 'VERB'] in _rows(out)
    one = call_tool(ws, 'frequency_list', {'what': 'upos', 'documents': ['Tres']})
    assert one.startswith('upos by frequency in "Tres": 5 distinct value(s), 5 in all.')
    whole = call_tool(ws, 'frequency_list', {'what': 'upos'})
    assert 'across the project' in whole and ['3', 'VERB'] in _rows(whole)
    assert 'not both' in call_tool(ws, 'frequency_list', {'what': 'upos', 'document': 'Uno', 'documents': ['Dos']})


@pytest.mark.parametrize('tool, args, says', [
    ('search', {'field': 'upos', 'pattern': 'SYM'}, '1 match(es) for upos "SYM" in 1 document(s)'),
    ('grew_search', {'pattern': 'pattern { X [upos=VERB] }'}, '2 matches in 2 sentences, 2 documents.'),
    ('worklist', {'kind': 'unverified', 'field': 'upos'}, 'upos: 2 unconfirmed machine value(s), in 2 document(s)'),
    ('check_consistency', {'kind': 'form-upos'}, "'.': PUNCT x1 (50%), SYM x1"),
])
def test_every_read_that_takes_a_document_takes_several(ws, tool, args, says):
    out = call_tool(ws, tool, {**args, 'documents': ['Uno', 'Tres']})
    assert out.startswith('In 2 documents: "Uno", "Tres".\n') and says in out, out


def test_where_counts_only_the_words_meeting_it(ws):
    out = t_frequency_list(ws, what='lemma', where={'upos': 'NOUN'})
    assert out.splitlines()[0] == ('lemma by frequency of the words with upos=NOUN across the project: '
                                   '1 distinct value(s), 3 in all.')
    assert _rows(t_frequency_list(ws, what='lemma', where={'Number': 'Plur'})) == [['3', 'ir']]
    assert _rows(t_frequency_list(ws, what='upos', where={'deprel': 'obl'})) == [['3', 'NOUN']]
    # A form is its Form span where it has one: "el" is half of "al".
    assert _rows(t_frequency_list(ws, what='upos', where={'form': 'el'})) == [['3', 'DET']]
    assert _rows(t_frequency_list(ws, what='deprel', where={'form': 'Vamos', 'upos': 'VERB'})) == [['3', 'root']]
    assert t_frequency_list(ws, what='lemma', where={'upos': 'INTJ'}) == \
        'No word with upos=INTJ has a lemma across the project.'


def test_ngrams_are_runs_of_adjacent_words_inside_a_sentence(ws):
    out = t_frequency_list(ws, what='form', ngram=2, document='Uno')
    assert sorted(tuple(r[1:]) for r in _rows(out)) == [
        ('a', 'el'), ('corre', '.'), ('el', 'mar'), ('mar', '.'), ('vamos', 'a')]
    assert out.splitlines()[0] == 'form bigrams, case folded, by frequency in "Uno": 5 distinct value(s), 5 in all.'
    tags = t_frequency_list(ws, what='upos', ngram=2)
    assert ['3', 'VERB', 'ADP'] in _rows(tags) and ['2', 'NOUN', 'PUNCT'] in _rows(tags)
    assert ['1', 'NOUN', 'SYM'] in _rows(tags)
    assert ['3', 'VERB', 'ADP', 'DET'] in _rows(t_frequency_list(ws, what='upos', ngram=3))


@pytest.mark.parametrize('args, said', [
    ({'what': 'upos', 'ngram': 4}, 'ngram is at most 3'),
    ({'what': 'features', 'ngram': 2}, 'ngram counts runs of words by one column'),
    ({'what': 'upos', 'ngram': 2, 'where': {'upos': 'NOUN'}}, 'where and ngram do not combine'),
    ({'what': 'lemma', 'where': {'Number': 'Plur|Sing'}}, '"Number" is not a column or a feature'),
    ({'what': 'lemma', 'where': {'upos': ''}}, 'where is one word\'s conditions'),
])
def test_what_cannot_be_counted_is_refused_with_the_choices(ws, args, said):
    with pytest.raises(ToolError, match=said):
        t_frequency_list(ws, **args)


def test_the_trace_says_the_scope_and_the_kind_of_count():
    assert describe_step('frequency_list', {'what': 'upos', 'ngram': 2, 'documents': ['Uno', 'Dos']}) == \
        'Ranked upos bigrams by frequency in 2 documents'
    assert describe_step('frequency_list', {'what': 'lemma', 'where': {'upos': 'NOUN'}}) == \
        'Ranked lemmas by frequency of words with upos=NOUN'
    assert describe_step('worklist', {'kind': 'missing', 'documents': ['Uno']}) == \
        'Listed missing work in “Uno”'


@pytest.mark.parametrize('args, line', [
    # H16-UD-TOOLS-3: a name given twice is one document to the read.
    ({'what': 'upos', 'documents': ['Uno', 'Uno']}, 'Ranked UPOS tags by frequency in “Uno”'),
    ({'what': 'upos', 'documents': ['Uno', ' uno', 'Dos']}, 'Ranked UPOS tags by frequency in 2 documents'),
    # The column in the plural, never "uposs" or "featuress".
    ({'what': 'features'}, 'Ranked features by frequency'),
    ({'what': 'feature-bundles'}, 'Ranked feature bundles by frequency'),
    ({'what': 'xpos'}, 'Ranked XPOS tags by frequency'),
    ({'what': 'deprel'}, 'Ranked deprels by frequency'),
    ({'what': 'form'}, 'Ranked forms by frequency'),
    ({}, 'Ranked lemmas by frequency'),
    # ngram as the tool reads it: "2" is bigrams.
    ({'what': 'upos', 'ngram': '2'}, 'Ranked upos bigrams by frequency'),
    ({'what': 'form', 'ngram': 3}, 'Ranked form 3-grams by frequency'),
    ({'what': 'form', 'ngram': 1}, 'Ranked forms by frequency'),
])
def test_the_trace_counts_documents_and_names_the_column_as_the_read_does(args, line):
    assert describe_step('frequency_list', args) == line


def test_grew_search_counts_a_doubled_name_once():
    assert describe_step('grew_search', {'pattern': 'X', 'documents': ['French 1', 'French 1']}) == \
        'Searched with Grew for “X” in “French 1”'
