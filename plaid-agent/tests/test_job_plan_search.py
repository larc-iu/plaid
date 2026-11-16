"""A plan in sentences may be limited by a search (SF).

A real model planned a rename of one gloss (33 values in 24 of 45
documents) in sentences: every sentence of all 45 documents walked, about
five hours for 33 changes (RP2-4, RP3-4). plan_work now takes ``search``, the
search tool's own arguments: the sentences it matches are taken once, at
planning, in the planning workspace, and the walk takes only those. These
are plan_work's rules: the search matched as search matches it (a word
field, a morpheme field, a sentence field, word forms), refused with one line
for a plan that is not in sentences, for no match and past the cap, and the
size line with the search applied."""

import pytest
from job_fixtures import JobClient, NOTE, ROLE, document, fields_project, with_values

from plaid_agent.core.limits import JOB_PLAN_SEARCH_MAX_SENTENCES
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project

OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'


def _story(i, gloss, n=4):
    """Story i: ``n`` sentences, the first glossing nidr ``gloss``, the
    others nidr glossed "be", each translated."""
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', gloss if k == 1 else 'be')], 'human'),
                                                       ('ka', [('ka', 'go')], 'human')],
                                             'translation': (f'It is {k}.', 'human')} for k in range(1, n + 1)])


def _planning(client, ids):
    ws = JobWorkspace(client, load_project(client, 'p1'), mode=JobWorkspace.PLAN)
    docs = [ws.doc(d) for d in ids]
    ws.job_documents = [{'id': d.id, 'name': d.name, 'sentences': len(d.sentences), 'empty': {}} for d in docs]
    return ws


def _plan(ws, **kw):
    return toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss'], **kw})


@pytest.fixture
def stories():
    """Six stories, the old gloss in Stories 2, 3 and 5."""
    client = JobClient({f'd{i}': _story(i, OLD if i in (2, 3, 5) else 'be') for i in range(1, 7)})
    return client, [f'd{i}' for i in range(1, 7)]


def test_a_search_in_a_morpheme_field_keeps_the_sentences_it_matches(stories):
    client, ids = stories
    ws = _planning(client, ids)
    out = _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss'})
    assert out == ('The plan is kept. This plan is 3 pieces over 3 documents: 3 sentences match. '
                   'End now with a one-line reply.'), out
    plan = ws.plan_work
    assert plan['matched'] == {'d2': ['d2-s1'], 'd3': ['d3-s1'], 'd5': ['d5-s1']}
    assert plan['search'] == {'pattern': OLD, 'where': 'Morph Gloss', 'said': f'Morph Gloss "{OLD}"',
                              'sentences': 3, 'documents': 3}


def test_the_search_takes_the_arguments_search_takes(stories):
    """Its own arguments, read as search reads them: a regex, case, a
    document named, and a limit, which a plan has no use for, ignored."""
    client, ids = stories
    ws = _planning(client, ids)
    _plan(ws, search={'pattern': r'^be\.3', 'where': 'Morph Gloss', 'regex': True, 'case_sensitive': True,
                      'limit': 30})
    assert sorted(ws.plan_work['matched']) == ['d2', 'd3', 'd5']
    assert ws.plan_work['search']['said'] == r'Morph Gloss "^be\.3" (regular expression, matching case)'
    _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss', 'documents': ['Story 3', 'Story 5']})
    assert sorted(ws.plan_work['matched']) == ['d3', 'd5']
    _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss', 'document': 'Story 2'})
    assert sorted(ws.plan_work['matched']) == ['d2']


def test_a_search_of_word_forms_a_word_field_and_a_sentence_field():
    raw = {f'd{i}': with_values(document(f'd{i}', f'Story {i}', [
        {'words': ['ali', f'gam{i}'], 'translation': (f'Ali {i}.', 'human')},
        {'words': ['sa', 'ta'], 'translation': ('Nothing.', 'human')}]),
        [(ROLE, f'd{i}-s1w1', 'agent' if i == 1 else 'patient', 'human'),
         (NOTE, f'd{i}-s2', 'check me' if i == 2 else 'fine', 'human')]) for i in (1, 2)}
    client = JobClient(raw, project=fields_project())
    ws = _planning(client, ['d1', 'd2'])
    _plan(ws, search={'pattern': 'gam2'})
    assert ws.plan_work['matched'] == {'d2': ['d2-s1']}
    assert ws.plan_work['search']['said'] == 'word form "gam2"'
    _plan(ws, search={'pattern': 'agent', 'where': 'Role'})
    assert ws.plan_work['matched'] == {'d1': ['d1-s1']}
    assert ws.plan_work['search']['said'] == 'Role "agent"'
    _plan(ws, search={'pattern': 'check', 'where': 'Note'})
    assert ws.plan_work['matched'] == {'d2': ['d2-s2']}
    assert ws.plan_work['search']['said'] == 'Note "check"'


def test_the_search_is_said_with_its_pattern_quoted_exactly():
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [('ka', [('ka', 'a"b\tc')], 'human')]}])})
    ws = _planning(client, ['d1'])
    _plan(ws, search={'pattern': 'a"b\tc', 'where': 'Morph Gloss'})
    assert ws.plan_work['search']['said'] == 'Morph Gloss "a\\"b\\tc"'


def test_a_match_outside_the_plans_documents_is_ignored(stories):
    client, ids = stories
    ws = _planning(client, ids[:3])
    _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss'})
    assert sorted(ws.plan_work['matched']) == ['d2', 'd3']
    _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss'}, documents=['Story 1', 'Story 3'])
    assert sorted(ws.plan_work['matched']) == ['d3']


def test_a_search_that_matches_nothing_is_refused_and_no_plan_is_kept(stories):
    client, ids = stories
    ws = _planning(client, ids)
    out = _plan(ws, search={'pattern': 'nothing like it', 'where': 'Morph Gloss'})
    assert "This search matches no sentence of the job's documents." in out, out
    assert ws.plan_work is None
    out = _plan(ws, search={'pattern': OLD, 'where': 'Morph Gloss'}, documents=['Story 1'])
    assert "This search matches no sentence of the job's documents." in out, out


def test_a_search_is_only_for_a_plan_in_sentences(stories):
    client, ids = stories
    ws = _planning(client, ids)
    for pieces in ('selection', 'document'):
        out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': pieces, 'fills': ['Morph Gloss'],
                                                      'search': {'pattern': OLD, 'where': 'Morph Gloss'}})
        assert out == 'Error: search: only with pieces "sentences". Leave it out of this plan.', out
    assert ws.plan_work is None


def test_a_search_is_refused_as_search_refuses_it(stories):
    client, ids = stories
    ws = _planning(client, ids)
    assert 'Give a pattern' in _plan(ws, search={'where': 'Morph Gloss'})
    assert 'cannot be used' in _plan(ws, search={'pattern': '(', 'regex': True})
    assert 'search takes no fields' in _plan(ws, search={'pattern': 'x', 'fields': 'Gloss'})
    assert 'search is the search tool' in _plan(ws, search='be')
    assert 'lexicon' in _plan(ws, search={'pattern': 'nidr', 'where': 'lexicon'})
    assert _plan(ws, search={'pattern': 'x', 'where': 'Colour'}).startswith('Error: No field named "Colour".')
    assert 'regex takes true or false' in _plan(ws, search={'pattern': 'x', 'regex': 'yes'})
    assert ws.plan_work is None


def test_past_the_cap_the_plan_is_refused_naming_the_number(monkeypatch, stories):
    from plaid_agent.core import limits
    client, ids = stories
    monkeypatch.setattr(limits, 'JOB_PLAN_SEARCH_MAX_SENTENCES', 5)
    ws = _planning(client, ids)
    out = _plan(ws, search={'pattern': 'be', 'where': 'Morph Gloss'})
    assert out == ("Error: This search matches 24 sentences of the job's documents, past the most a plan takes, 5. "
                   'Narrow the search, or plan without it.'), out
    assert JOB_PLAN_SEARCH_MAX_SENTENCES == 900


def test_with_skip_filled_sentences_the_size_is_at_most(stories):
    client, ids = stories
    ws = _planning(client, ids)
    out = _plan(ws, search={'pattern': 'be', 'where': 'Morph Gloss'}, skip_filled_sentences=True)
    assert 'This plan is at most 6 pieces over 6 documents: 24 sentences match.' in out, out
    assert ws.plan_work['only_empty'] is True


def test_the_planner_is_told_when_to_give_a_search_and_the_selection_route_stays():
    from plaid_agent.igt.prompt import JOB_PLAN_RULES
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert ('For work that concerns only the sentences where something occurs, give search the search tool\'s '
            'arguments: only the sentences it matches are worked.' in rules), rules
    assert 'and for the same exact change wherever a known value occurs (one value for another)' in rules
    said = toolkit.PLAN_WORK['function']['description']
    assert ('search: with "sentences", the search tool\'s arguments: only the sentences it matches are worked.'
            in said), said
    assert toolkit.PLAN_WORK['function']['parameters']['properties']['search'] == {'type': 'object'}
