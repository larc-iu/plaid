"""One change is counted one way, whichever tool made it (REV-DAY-P-6,
P-7): a value written on a morpheme the word already held counts in its
field's values, whether set_field or an analysis that keeps the word's
morphemes staged it, and only a segmentation the job wrote counts as a word
analysed. A translation counts once, as a translation, never also as a
value of its field."""

from collections import Counter

from fixtures import MGLOSS, TRANS
from job_fixtures import JobClient, document

from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import Stretch
from plaid_agent.igt.project import load_project, parse_document
from plaid_agent.igt.tools import ANALYSIS_OF

J = 'JCO'


def _write(ops):
    client = JobClient({'d1': document('d1', 'Story', [
        {'words': [('gam', [('gam', 'fish')], 'human'), 'ka']}])})
    project = load_project(client, 'p1')
    doc = parse_document(client.documents.get('d1', include_body=True), project)
    st = Stretch(doc, project, doc.sentences, J)
    return igt_job.Write('d1', '', st, [s.id for s in doc.sentences], ops, Counter(), doc)


IN_PLACE = {'kind': 'set_span', 'layer_id': MGLOSS, 'token_id': 'd1-s1w1m1', 'span_id': 'sp-d1-s1w1m1',
            'value': 'net', ANALYSIS_OF: 'd1-s1w1'}
SET_FIELD = {k: v for k, v in IN_PLACE.items() if k != ANALYSIS_OF}
SEGMENT = {'kind': 'set_analysis', 'word_id': 'd1-s1w2', 'morphemes': [{'form': 'ka', 'fields': []}]}
TRANSLATE = {'kind': 'set_span', 'layer_id': TRANS, 'token_id': 'd1-s1', 'span_id': None, 'value': 'Fish.'}


def test_a_value_changed_in_place_counts_as_its_fields_value_whichever_tool_staged_it():
    by_analysis, by_field = _write([IN_PLACE]), _write([SET_FIELD])
    assert by_analysis.fields_of([IN_PLACE]) == by_field.fields_of([SET_FIELD]) == {MGLOSS: 1}
    assert by_analysis.words_of([IN_PLACE]) == by_field.words_of([SET_FIELD]) == []


def test_only_a_segmentation_the_job_wrote_counts_as_a_word_analysed():
    w = _write([SEGMENT, IN_PLACE])
    assert w.words_of([SEGMENT, IN_PLACE]) == [igt_job.word_tag('d1-s1w2')]


def test_a_translation_counts_once_as_a_translation():
    w = _write([TRANSLATE])
    assert w.counts_of([TRANSLATE])['translations'] == 1
    assert w.fields_of([TRANSLATE]) == {}


ANALYSE = {'kind': 'set_analysis', 'word_id': 'd1-s1w2', 'morphemes': [
    {'form': 'ka', 'fields': [{'layer_id': MGLOSS, 'value': 'go'}]},
    {'form': 'ni', 'fields': [{'layer_id': MGLOSS, 'value': 'PST'}]},
    {'form': 'x', 'fields': [{'layer_id': MGLOSS, 'value': ''}]}]}


def test_the_values_an_analysis_carries_count_under_their_field_and_say_so():
    """REV-RPF-W-5: a job that glossed 8 morphemes, 7 of them through an
    analysis, read "Morph Gloss 1 value". Each value written counts under its
    field, on its own or carried by an analysis, and the field's row says how
    many of them an analysis carried (``in_analyses``). The changes still
    count the analysis once, its values part of it, so nothing is counted
    twice in the changes."""
    w = _write([ANALYSE, SET_FIELD])
    assert w.fields_of([ANALYSE, SET_FIELD]) == {MGLOSS: 3}
    row = w._sentence_row('d1-s1', 'seed', [ANALYSE, SET_FIELD], None)
    assert [(f['id'], f['values'], f.get('in_analyses')) for f in row['fields']] == [(MGLOSS, 3, 2)]
    assert row['parts'] == {'analyses': 1, 'values': 1, 'analyses_morphemes': 3, 'analyses_values': 2}
    assert row['counts']['changes'] == 2


def test_a_fields_line_says_how_many_of_its_values_analyses_carried():
    from plaid_agent.core.job import field_counts, fields_text
    rows = [{'field': 'Morph Gloss', 'id': MGLOSS, 'values': 3, 'in_analyses': 2},
            {'field': 'Morph Gloss', 'id': MGLOSS, 'values': 5, 'in_analyses': 5},
            {'field': 'Gloss', 'id': 'g', 'values': 1}]
    summed = field_counts(rows)
    assert summed == [{'field': 'Gloss', 'id': 'g', 'values': 1},
                      {'field': 'Morph Gloss', 'id': MGLOSS, 'values': 8, 'in_analyses': 7}]
    assert fields_text(summed) == 'Gloss 1 value, Morph Gloss 8 values (7 in word analyses)'
