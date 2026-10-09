"""A query written in a shape that has one reading is taken in that shape,
and one that has several is refused with the shape the language wants. The
cases are the benchmark's rejected queries of 2026-10-08: find as a string,
find naming fields, where as an object, a predicate with its operator
second, and a group of "or" that is one clause."""

import pytest

from plaid_agent.core.query import QueryRefused, parse_query


def test_one_variable_as_a_string_is_a_find_of_one():
    q = parse_query({'find': '?w', 'where': [['token', '?w', {'layer': 'Word'}]]})
    assert q['find'] == ['?w']


@pytest.mark.parametrize('find', ['morpheme', 'word', ['doc', 'ref', 'form'], '?a ?b', 3])
def test_a_find_that_names_no_variable_is_refused_with_the_shape(find):
    with pytest.raises(QueryRefused) as e:
        parse_query({'find': find, 'where': [['token', '?w', {}]]})
    assert '"find": ["?w"]' in str(e.value) and 'Got ' in str(e.value)


def test_one_clause_written_alone_is_a_where_of_one():
    clause = ['span', '?g', {'layer': 'Gloss'}]
    assert parse_query({'find': ['?g'], 'where': clause})['where'] == [clause]


def test_an_object_naming_one_entity_and_its_variable_is_that_clause():
    q = parse_query({'find': ['?s'], 'where': [{'span': '?s', 'layer': 'Gloss', 'value': 'ERG'}]})
    assert q['where'] == [['span', '?s', {'layer': 'Gloss', 'value': 'ERG'}]]
    q = parse_query({'find': ['?s'], 'where': {'span': '?s', 'layer': 'Gloss'}})
    assert q['where'] == [['span', '?s', {'layer': 'Gloss'}]]


@pytest.mark.parametrize('where', [
    [{'lemma': 'быть', 'upos': 'VERB'}],
    {'lemma_link': 'ди'},
    {'and': [{'eq': 'быть', 'layer': 'lemma'}, {'eq': 'VERB', 'layer': 'upos'}]},
    [{'span': '?s', 'token': '?t'}],
])
def test_an_object_with_more_than_one_reading_is_refused_with_the_clause_shape(where):
    with pytest.raises(QueryRefused) as e:
        parse_query({'find': ['?w'], 'where': where})
    assert 'not an object' in str(e.value) and '["span", "?s"' in str(e.value)


def test_a_predicate_with_its_operator_second_is_refused():
    with pytest.raises(QueryRefused, match='operator first'):
        parse_query({'find': ['?e'], 'where': [['?e.value', '=', 'SUBR']]})


def test_an_or_group_that_is_one_clause_is_refused_and_a_right_one_passes():
    with pytest.raises(QueryRefused, match='"or" takes groups'):
        parse_query({'find': ['?e'], 'where': [['or', ['?e.value', '=', 'A'], ['?e.value', '=', 'B']]]})
    q = parse_query({'find': ['?g'], 'where': [['span', '?g', {}],
                                              ['or', [['=', '?g.value', 'A']], [{'span': '?g', 'value': 'B'}]]]})
    assert q['where'][1] == ['or', [['=', '?g.value', 'A']], [['span', '?g', {'value': 'B'}]]]


def test_a_well_formed_query_is_unchanged():
    q = {'find': ['?w', '?g'], 'where': [['token', '?w', {'layer': 'Word'}], ['covers', '?g', '?w'],
                                         ['not', ['span', '?x', {'value': 'A'}]],
                                         ['seq', {'layer': 'Word'}, ['span', {'layer': 'G'}, 'as', '?a']]],
         'return': 'entities', 'limit': 5}
    assert parse_query(q) == q


def test_tuples_built_in_code_read_as_lists():
    # run_code hands query() a tuple as a tuple, and the wire always took one.
    q = parse_query({'find': ('?w',), 'where': [('token', '?w', {'layer': 'Word'}),
                                                ('or', (('=', '?w.value', 'a'),), [{'token': '?w'}])]})
    assert q == {'find': ['?w'], 'where': [['token', '?w', {'layer': 'Word'}],
                                           ['or', [['=', '?w.value', 'a']], [['token', '?w', {}]]]]}


def test_an_or_written_with_a_colon_is_checked_as_an_or():
    with pytest.raises(QueryRefused, match='"or" takes groups'):
        parse_query({'find': ['?e'], 'where': [[':or', ['=', '?e.value', 'A']]]})
    q = parse_query({'find': ['?e'], 'where': [[':not', {'span': '?e', 'value': 'A'}]]})
    assert q['where'] == [[':not', ['span', '?e', {'value': 'A'}]]]
