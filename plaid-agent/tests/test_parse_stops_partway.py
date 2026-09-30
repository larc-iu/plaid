"""A UD plan whose parse stops partway is partly applied (conc-2026-09-29
REV-W-AUDIT D-4).

The parser writes with its own credentials, so none of its writes are in the
plan's batch count. With 230 of 300 sentences parsed and standing, the card
said "Failed to apply the plan: ... Nothing was written", History kept the
whole plan's label, and approving again was not refused. It now settles as
Partly applied, in the parser's own words, and History says so.

Also: the model's note leads with the count of changes, as the card does, not
of card rows ("0 of 1 changes" for a folded row of 600).
"""

import pytest

import test_stale_by_sentence as sbs
from test_lost_answers import _plan_operation, _stored

from plaid_agent.core.conversation import ConversationStore, partial_note

PARSER_SAID = 'Stanza parser: 230 of 300 sentences were parsed, each in full. HTTP 500 boom.'


def _parse_plan(monkeypatch, client, spec):
    monkeypatch.setattr('plaid_agent.ud.tools.parse_services',
                        lambda w: [{'service_id': 'stanza-parser', 'service_name': 'Stanza parser',
                                    'online': True, 'tasks': ['parse']}])
    plan, _ = sbs._plan(spec, client, ('run_parse', {'documents': ['Viaje'], 'language': 'es'}))
    assert [op['kind'] for op in plan['ops']] == ['run_parse']
    return plan


def _parser(monkeypatch, client, *, writes, error):
    def request_service(c, pid, sid, data, **kw):
        if writes:
            client._documents[data['document_id']]['version'] += 1
        raise error
    monkeypatch.setattr('plaid_client.services.request_service', request_service)


def _notes(client, spec):
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return [m['content'] for m in conv['messages'] if '(note)' in str(m.get('content'))]


def test_a_parse_that_stops_partway_is_partly_applied_in_the_parsers_words(monkeypatch):
    spec = sbs.APPS['ud']()
    client = spec['client']()
    plan = _parse_plan(monkeypatch, client, spec)
    _parser(monkeypatch, client, writes=True, error=RuntimeError(PARSER_SAID))
    relabels = []

    class Groups:
        def update(self, group_id, message):
            relabels.append((group_id, message))
    client.operation_groups = Groups()
    svc = spec['service']()
    helper = sbs._approve({**spec, 'service': lambda: svc}, client, plan)
    assert not helper.errors, helper.errors
    [done] = helper.done
    assert done['partial'] is True
    assert done['message'] == ('Partly applied: 1 of 1 changes written in part. The parser stopped '
                               f'partway through "Viaje": {PARSER_SAID}'), done['message']
    assert 'Nothing was written' not in done['message']
    item = _stored(spec, client)
    assert item['status'] == 'partial'
    assert item['outcome'] == '1 of 1 changes written in part.'
    # History names it as partly applied, not as the whole plan. Only the
    # parser wrote under the operation, and a client relabels on its own only
    # an operation it wrote under, so the relabel is sent here.
    label = f'Assistant, partly applied: part of {svc.summarize(plan["ops"])}'
    assert client.operation_labels[_plan_operation(client)] == label
    assert [m for _, m in relabels] == [label]
    [note] = _notes(client, spec)
    assert '230 of 300 sentences were parsed' in note
    assert '1 of 1 changes were written in part.' in note
    assert '(written in part)' in note


def test_a_parse_refused_before_writing_still_says_nothing_was_written(monkeypatch):
    spec = sbs.APPS['ud']()
    client = spec['client']()
    plan = _parse_plan(monkeypatch, client, spec)
    _parser(monkeypatch, client, writes=False,
            error=RuntimeError('Stanza parser: no sentence token layer.'))
    helper = sbs._approve(spec, client, plan)
    assert not helper.done
    [error] = helper.errors
    assert error.startswith('Failed to apply the plan: the parser refused "Viaje"'), error
    assert error.endswith('Nothing was written.')


def test_a_parse_whose_answer_was_lost_may_still_be_running(monkeypatch):
    """The request outlives a lost answer on the server, as it outlives a
    silence, so neither is a failure."""
    spec = sbs.APPS['ud']()
    client = spec['client']()
    plan = _parse_plan(monkeypatch, client, spec)
    lost = RuntimeError('Service closed the connection without a result')
    lost.pending = True
    _parser(monkeypatch, client, writes=True, error=lost)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    [done] = helper.done
    assert not done.get('partial')
    assert 'may still be running' in str(done), done


def test_a_later_document_of_the_same_parse_leaves_the_first_parsed(monkeypatch):
    """One row may parse several documents. The first stands when the second
    is refused, so the row is written in part."""
    from plaid_agent.core.plan import PlanError
    from plaid_agent.ud.plan import execute_plan
    spec = sbs.APPS['ud']()
    client = spec['client']()
    calls = []

    def request_service(c, pid, sid, data, **kw):
        calls.append(data['document_id'])
        if len(calls) == 2:
            raise RuntimeError('No live service')
    monkeypatch.setattr('plaid_client.services.request_service', request_service)
    ops = [{'kind': 'run_parse', 'document_ids': ['ud1', 'ud-other'], 'project_id': spec['pid'],
            'service_id': 'stanza-parser', 'language': 'es', 'label': 'parse', '_row': 0}]
    with pytest.raises(PlanError) as e:
        execute_plan(client, ops, source='s', label='l', stamp_mode='verified')
    assert e.value.partly == [0]
    assert e.value.wrote


def test_the_note_leads_with_the_changes_a_folded_row_stands_for():
    note = partial_note(['dep on 600 words'], [], False, 'HTTP 500', parts={0: (400, 600)}, sizes=[600])
    assert note.startswith('(note) Applying stopped partway (HTTP 500): 400 of 600 changes were written.'), note
    assert '0 of 1' not in note
    note = partial_note(['dep on 600 words', 'lemma of s1.w1'], [1], False, 'HTTP 500',
                        parts={0: (400, 600)}, sizes=[600, 1])
    assert '401 of 601 changes were written.' in note
