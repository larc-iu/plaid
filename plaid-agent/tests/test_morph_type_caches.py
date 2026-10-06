"""A plan that changes the type an entry goes by writes it on every morpheme of
the project linked to that entry or to a sense under it, as the app does
(morphTypeCaches.js). Nothing writes it on a later open."""

from fixtures import FakeClient, VOCAB, document_raw, lexicon_raw

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project


def _client(head_type):
    """vi-head is a headword typed `head_type` as the server holds it once the
    plan's own write stands, vi-sense a sense under it with no type of its
    own, linked to m-1b, which caches `suffix`."""
    doc = document_raw()
    morphs = doc['text_layers'][0]['token_layers'][2]
    morphs['vocabs'][0]['vocab_links'] = [
        {'id': 'l-2', 'vocab_item': {'id': 'vi-sense', 'form': '-di'}, 'tokens': ['m-1b']},
        {'id': 'l-3', 'vocab_item': {'id': 'vi-head', 'form': '-di'}, 'tokens': ['m-4b']}]
    lex = lexicon_raw()
    lex['items'] += [
        {'id': 'vi-head', 'form': '-di', 'metadata': {'morphType': head_type} if head_type else {}},
        {'id': 'vi-sense', 'form': '-di', 'metadata': {'parent': 'vi-head', 'gloss': 'ERG'}}]
    return FakeClient(documents={'d1': doc}, lexicon=lex)


def _written(c):
    return [(e['id'], e['metadata']) for body in c.payloads('tokens.bulk_update') for e in body
            if any(op.get('path') == ['morphType'] for op in e['metadata'])]


def test_a_headwords_new_type_is_written_on_its_senses_morphemes():
    c = _client('enclitic')
    execute_plan(c, [{'kind': 'set_entry_field', 'item_id': 'vi-head', 'field': 'morphType',
                      'value': 'enclitic', 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'))
    # m-1b (the sense's, caching suffix) and m-4b (the headword's, enclitic
    # already) take what each goes by: only m-1b is written.
    assert _written(c) == [('m-1b', [{'op': 'set', 'path': ['morphType'], 'value': 'enclitic'}])]


def test_a_sense_moved_under_another_headword_takes_its_type():
    c = _client('prefix')
    execute_plan(c, [{'kind': 'set_entry_metadata', 'item_id': 'vi-sense',
                      'patch': {'parent': 'vi-head'}, 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'))
    assert ('m-1b', [{'op': 'set', 'path': ['morphType'], 'value': 'prefix'}]) in _written(c)


def test_a_cleared_type_that_leaves_none_writes_nothing():
    c = _client(None)
    execute_plan(c, [{'kind': 'set_entry_field', 'item_id': 'vi-head', 'field': 'morphType',
                      'value': None, 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'))
    assert _written(c) == []


def test_a_plan_that_types_no_entry_reads_nothing_for_it():
    c = _client('enclitic')
    execute_plan(c, [{'kind': 'set_entry_field', 'item_id': 'vi-head', 'field': 'gloss',
                      'value': 'x', 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'))
    assert not any('morphType' in str(q) for q in c.queries)
    assert VOCAB  # the fixture's lexicon id, for the reader


def test_other_projects_using_the_lexicon_are_written_where_the_requester_writes():
    """The app writes the type in every project the writer can write that uses
    the lexicon (morphTypeCaches.js ``cacheProjectIds``), and so does the
    assistant. A project the requester only reads keeps what it holds."""
    from multi_fixtures import other_project

    c0 = _client('enclitic')
    home = c0.project
    docs = {'d1': c0._documents['d1']}
    writes = other_project(home, docs, 'px2', 'Writes')
    writes['project']['writers'] = ['u@x']
    reads = other_project(home, docs, 'px3', 'Reads')
    reads['project']['readers'] = ['u@x']
    elsewhere = other_project(home, docs, 'px4', 'Other lexicon')
    elsewhere['project']['writers'] = ['u@x']
    elsewhere['project']['vocabs'] = [{'id': 'v-other', 'name': 'Other'}]
    c = FakeClient(documents=docs, lexicon=c0._lexicon,
                   projects={'px2': writes, 'px3': reads, 'px4': elsewhere})
    execute_plan(c, [{'kind': 'set_entry_field', 'item_id': 'vi-head', 'field': 'morphType',
                      'value': 'enclitic', 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'), requester='u@x')
    asked = [q['scope']['project_ids'][0] for q in c.queries if 'morphType' in str(q)]
    assert asked == ['p1', 'px2']
    # m-1b once in this project and once in px2, the copy of its document.
    assert [m for m, _ in _written(c)] == ['m-1b', 'm-1b']


def test_an_answer_too_long_is_asked_for_in_halves():
    c = _client('enclitic')
    real = c.query
    asked = []

    def query(body):
        items = body['where'][0][2]['item']
        asked.append(list(items))
        if len(items) > 1:
            return {'results': [], 'truncated': True}
        return real(body)
    c.query = query
    execute_plan(c, [{'kind': 'set_entry_field', 'item_id': 'vi-head', 'field': 'morphType',
                      'value': 'enclitic', 'label': ''}],
                 source='s', label='l', project=load_project(c, 'p1'))
    assert asked == [['vi-head', 'vi-sense'], ['vi-head'], ['vi-sense']]
    assert _written(c) == [('m-1b', [{'op': 'set', 'path': ['morphType'], 'value': 'enclitic'}])]
