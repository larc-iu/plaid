"""The research extractor's pieces that need no database: how a tool's
refusal, a turn's end and an audit change are classed, and the pseudonyms.
The whole extractor runs against a real core in test_research_extract_live.py."""

import pytest

from plaid_agent.core.conversation import PROPOSED_VALUE_MAX
from plaid_agent.research.fates import change_category, prov_state, value_of
from plaid_agent.research.pseudo import VALUE_MAX, Pseudonyms, clip, load_salt
from plaid_agent.research.records import error_class, snake, turn_end, uuid7_time


@pytest.mark.parametrize('text,cls', [
    ('Error: Query rejected: HTTP 400 :find must be a list of vars', 'query_rejected'),
    ('Error: "Gloss" names several fields; say which: Gloss (Word), Gloss (Morpheme)', 'ambiguous'),
    ('Error: Several entries match "kai"; pass entry_id', 'ambiguous'),
    ('Error: No lexicon entry "kai". Use read_lexicon to look', 'not_found'),
    ('Error: s1.w2: sentence s1 has 1 words', 'not_found'),
    ("Error: lexicon_entry cannot be called with those arguments. It takes: form.", 'bad_arguments'),
    ('Error: That would bring the plan to 3163 changes, more than the 3000 one plan may hold.', 'plan_limit'),
    ('Error: Traceback (most recent call last):\n  File "x"', 'code_exception'),
    ('Error: No parser is connected to this project right now.', 'unavailable'),
    ('Error: query failed, which is a fault in the tool rather than in the request.', 'tool_fault'),
    ('Error: s1.w5 already starts sentence s1.', 'plan_conflict'),
    ('Error: s2.w3 is not a morpheme (sN.wN.mN)', 'wrong_level'),
    ('Error: s1.w1.m1 is not a word (sN.wN)', 'wrong_level'),
    ('Error: s1.w1 is not a sentence (sN)', 'wrong_level'),
    ('Error: s4 is not a sentence. A comment sits on a sentence (s3) or on the document.', 'wrong_level'),
    ('Error: s3.w2-3 names a sentence or a multi-word token. Name the WORD the new one goes after.', 'wrong_level'),
    ('Error: s3.w2-3 is a multi-word token, which carries no annotation of its own.', 'wrong_level'),
    ('Error: s1: link words (sN.wN) or morphemes (sN.wN.mN), not sentences', 'wrong_level'),
    ('Error: s1.w1.m1: discard_analysis works on words (sN.wN), not single morphemes', 'wrong_level'),
    ('Error: "Gloss" is a word field, not a morpheme field; use set_field for it', 'wrong_level'),
    ('Error: something new', 'other'),
    (None, 'unknown'),
])
def test_error_classes(text, cls):
    assert error_class(text) == cls


def test_turn_ends():
    assert turn_end({'kind': 'error', 'stopped': True}) == 'stopped'
    assert turn_end({'kind': 'error'}) == 'failed'
    assert turn_end({'kind': 'error', 'lost': True}) == 'lost'
    assert turn_end({'kind': 'assistant', 'text': 'x\n\n*(Stopped after the same step failed 3 times.)*'}) == \
        'stopped_repeat'
    assert turn_end({'kind': 'assistant', 'text': 'x\n\n*(Stopped at the step limit.)*'}) == 'step_limit'
    assert turn_end({'kind': 'assistant', 'text': '(The model returned an empty reply.)'}) == 'empty_reply'
    assert turn_end({'kind': 'assistant', 'text': "x\n\n*(The reply was cut off at the model's output limit.)*"}) \
        == 'cut_at_length'
    assert turn_end({'kind': 'assistant', 'text': 'Here.'}) == 'answered'


def test_changes_are_classed_on_folded_images():
    span = {'id': 's', 'value': '"kai"', 'tokens': ['t1'], 'metadata': {'prov': 'inferred', 'provSource': 'x'}}
    assert change_category('spans', span, {**span, 'value': '"kae"'})[0] == 'value'
    assert change_category('spans', span, {**span, 'metadata': {**span['metadata'], 'note': 'n'}})[0] == 'metadata'
    assert change_category('spans', span, {**span, 'tokens': ['t2']})[0] == 'extent'
    confirmed = {**span, 'metadata': {**span['metadata'], 'provConfirmed': True}}
    assert change_category('spans', span, confirmed) == ('provenance', ['metadata.provConfirmed'])
    assert change_category('spans', span, dict(span))[0] == 'none'
    assert value_of('spans', span) == 'kai'
    assert value_of('tokens', {'metadata': {'form': '-ar'}}) == '-ar'


def test_a_value_written_again_in_its_other_spelling_is_no_change():
    # a core before 2026-10-09 stored дом and a/b with escapes, one now
    # stores the letters, and the audit log keeps both images
    old = {'id': 's', 'value': '"\\u0434\\u043e\\u043c"', 'tokens': ['t1'], 'metadata': {}}
    assert change_category('spans', old, {**old, 'value': '"дом"'}) == ('none', [])
    rel = {'id': 'r', 'value': '"a\\/b"', 'source_span_id': 'a', 'target_span_id': 'b', 'metadata': {}}
    assert change_category('relations', rel, {**rel, 'value': '"a/b"'}) == ('none', [])
    assert change_category('relations', rel, {**rel, 'value': '"a/c"'})[0] == 'value'


def test_provenance_states():
    assert prov_state(None) == 'human'
    assert prov_state({'prov': 'inferred'}) == 'machine'
    assert prov_state({'prov': 'inferred', 'provConfirmed': True}) == 'verified'
    assert prov_state({'prov': 'contributed'}) == 'contributed'
    assert prov_state({'prov': 'something-else'}) == 'machine'


def test_clip_matches_the_plan_record():
    assert VALUE_MAX == PROPOSED_VALUE_MAX
    assert clip('x' * 30) == 'x' * 23 + '…' and clip('short') == 'short' and clip(3) == 3 and clip({}) is None


def test_record_keys_and_ids():
    assert snake({'op-count': 1, 'plan': {'proposed-count': 2}}) == {'op_count': 1, 'plan': {'proposed_count': 2}}
    assert uuid7_time('01999c3e-8a40-7000-8000-000000000000').startswith('2025-')
    assert uuid7_time('3fbfaf98e4974effa862e603e248db3f') is None


def test_pseudonyms_and_the_salt(tmp_path):
    out = tmp_path / 'out'
    with pytest.raises(SystemExit):
        load_salt(out / 'salt', out)
    salt = load_salt(tmp_path / 'salt', out)
    assert load_salt(tmp_path / 'salt', out) == salt
    p = Pseudonyms(salt)
    assert p.user('a@b.com') == p.user('a@b.com') != Pseudonyms(b'x' * 32).user('a@b.com')
    assert 'a@b.com' not in p.user('a@b.com') and p.source('user:a@b.com').startswith('user:u-')
    assert p.source('service:polygloss') == 'service:polygloss'


def test_a_failed_turns_calls_are_read_off_its_own_item():
    from plaid_agent.research.records import Conversations, arg_names
    conv = Conversations(Pseudonyms(b'k' * 32))
    record = {'messages': [{'role': 'user', 'content': 'q'}], 'display': [
        {'kind': 'user', 'text': 'q', 'created-at': '2026-10-06T01:00:00.000Z'},
        {'kind': 'error', 'text': 'failed', 'created-at': '2026-10-06T01:00:09.000Z',
         'steps': [{'id': 'c1', 'name': 'search', 'kind': 'read', 'label': 'Searched'},
                   {'id': 'c2', 'name': 'read_lexicon', 'kind': 'read', 'label': 'Read', 'failed': True}],
         'calls': [{'id': 'c1', 'name': 'search', 'arguments': '{"pattern": "x"}', 'result': '1 hit'},
                   {'id': 'c2', 'name': 'read_lexicon', 'arguments': '{"form": "x"}',
                    'result': 'Error: read_lexicon cannot be called with those arguments.'}]}]}
    conv.add('u@x', 'igt', 'p1', 'c1', record, None, 10, None)
    turn = conv.turns[0]
    assert turn['end'] == 'failed' and turn['n_steps'] == 2 and turn['n_failed_steps'] == 1
    assert turn['asked_at'] == '2026-10-06T01:00:00.000Z' and turn['created_at'] == '2026-10-06T01:00:09.000Z'
    first, second = conv.tool_calls
    assert first['result_kept'] and not first['failed'] and first['arg_names'] == ['pattern']
    assert second['error_class'] == 'bad_arguments' and second['arg_names'] == ['form']
    assert {c['turn_end'] for c in conv.tool_calls} == {'failed'}
    assert arg_names(None) is None and arg_names('not json') == ['(not an object)']
    assert arg_names({'x' * 40: 1}) == ['x' * 23 + '…']


def test_a_retried_turn_keeps_the_attempt_that_did_not_finish():
    # Luke, 2026-10-06: Retry keeps the failed attempt in the record and sends
    # the question again as a new item marked `retry` (plaid-ui resume.js).
    from plaid_agent.research.records import Conversations
    conv = Conversations(Pseudonyms(b'k' * 32))
    record = {'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}], 'display': [
        {'kind': 'user', 'text': 'q'},
        {'kind': 'error', 'text': 'boom'},
        {'kind': 'user', 'text': 'q', 'retry': True},
        {'kind': 'error', 'lost': True, 'text': 'No answer came back for this message.'},
        {'kind': 'user', 'text': 'q', 'retry': True},
        {'kind': 'assistant', 'text': 'a'}]}
    conv.add('u@x', 'igt', 'p1', 'c1', record, None, 10, None)
    assert [(t['turn'], t['end'], t['retry']) for t in conv.turns] == [
        (1, 'failed', False), (2, 'lost', True), (3, 'answered', True)]


def test_an_old_database_reads_no_credential():
    import sqlite3
    from plaid_agent.research.fates import credential_column
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE operations (id TEXT, token_id TEXT)')
    assert credential_column(db) == 'NULL'
    db.execute('ALTER TABLE operations ADD COLUMN credential TEXT')
    assert credential_column(db) == 'o.credential'


def test_a_turn_names_the_other_projects_it_read():
    # A4-CROSS-5: a turn that read another project looked like a home-only one.
    from plaid_agent.research.records import Conversations
    p = Pseudonyms(b'k' * 32)
    conv = Conversations(p)
    record = {'messages': [], 'display': [
        {'kind': 'user', 'text': 'q', 'projects': [{'id': 'p2', 'name': 'Lamkang'}, {'id': 'p3', 'name': 'Gone'}]},
        {'kind': 'assistant', 'text': 'a', 'unavailable-projects': [{'id': 'p3', 'name': 'Gone'}]},
        {'kind': 'user', 'text': 'q2'},
        {'kind': 'assistant', 'text': 'a2'}]}
    conv.add('u@x', 'igt', 'p1', 'c1', record, None, 10, None)
    first, second = conv.turns
    assert first['other_project_ids'] == ['p2'] and first['other_projects'] == [p.project('p2')]
    assert first['unavailable_projects'] == 1
    assert second['other_project_ids'] == [] and second['other_projects'] == []
    assert 'Lamkang' not in repr(conv.turns), 'names are not written'


def test_units_by_credential_counts_units():
    # A4-CROSS-6: one applied plan of four delegated rows read `delegated: 4`.
    from plaid_agent.research.extract import summarize
    from plaid_agent.research.fates import Fates
    from plaid_agent.research.records import Conversations
    units = [{'kind': 'assistant-plan', 'credentials': {'delegated': 4}, 'plan_record': 'found'},
             {'kind': 'service-run', 'credentials': {'service': 2, 'login': 1}, 'plan_record': None}]
    fates = Fates.__new__(Fates)
    fates.writes = []
    s = summarize(Conversations(Pseudonyms(b'k' * 32)), fates, units,
                  {'never_used': [], 'not_in_inventory': []}, [])
    assert s['units_by_credential'] == {'delegated': 1, 'service': 1, 'login': 1}
    assert s['writes_by_credential'] == {'delegated': 4, 'service': 2, 'login': 1}


def test_a_stale_plan_the_reader_discarded_says_so_and_stays_stale():
    from plaid_agent.research.records import Conversations
    rows = Conversations(Pseudonyms(b'salt'))
    plan = {'id': '01a10fc5-61d6-7000-8588-500000000001', 'summary': 'x', 'ops': []}
    conv = {'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}],
            'display': [{'kind': 'user', 'text': 'q'},
                        {'kind': 'assistant', 'text': 'a', 'plan': plan, 'status': 'stale',
                         'dismissed': True, 'dismissed-at': '2026-10-06T06:00:00Z'},
                        {'kind': 'assistant', 'text': 'b', 'status': 'stale',
                         'plan': {**plan, 'id': '01a10fc5-61d6-7000-8588-500000000002'}}]}
    rows.add('u@x', 'igt', 'p1', 'c1', conv, {}, 10, None)
    first, second = rows.plans
    assert (first['status'], first['dismissed'], first['dismissed_at']) == ('stale', True, '2026-10-06T06:00:00Z')
    assert (second['dismissed'], second['dismissed_at']) == (False, None)


def test_a_plan_with_no_labels_counts_its_rows_from_its_changes():
    """A plan made since rules (core/rules.py) writes no `labels`, and a rule's
    row kept past a settled plan's cap counts once among them."""
    from plaid_agent.research.records import Conversations
    rows = Conversations(Pseudonyms(b'salt'))
    changes = [{'label': f'r{i}'} for i in range(200)] + [{'label': 'rule', 'rule': {'total': 900}, 'row': 230}]
    plan = {'id': '01a10fc5-61d6-7000-8588-500000000003', 'summary': 'x', 'changes': changes,
            'omitted': {'count': 30}, 'op_count': 231}
    conv = {'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a'}],
            'display': [{'kind': 'user', 'text': 'q'},
                        {'kind': 'assistant', 'text': 'a', 'plan': plan, 'status': 'discarded'}]}
    rows.add('u@x', 'igt', 'p1', 'c1', conv, {}, 10, None)
    [got] = rows.plans
    assert got['rows'] == 231


def _fate_rows():
    """A service run writes a gloss NFD, a person edits a second gloss, then a
    conversion (an operation of kind repair, run as the admin) composes both
    to NFC. Row columns as fates.ROW_SQL reads them."""
    import json as _json

    def row(ts, target, value, op, user, group, kind, prov=None):
        image = {'id': target, 'value': _json.dumps(value, ensure_ascii=False), 'tokens': ['t1'],
                 'metadata': {'prov': prov, 'provSource': 'service:x'} if prov else {}}
        return (ts, 0, 'spans', target, 'update' if op != 'o1' else 'insert', _json.dumps(image), 'd1', None,
                op, user, None, None, group, None, 'p1', kind, None, None, user, ts)
    nfd, nfc = 'bé', 'bé'
    return [
        row('2026-10-01T00:00:01Z', 's1', nfd, 'o1', 'svc@x', 'g1', 'service-run', prov='inferred'),
        row('2026-10-01T00:00:02Z', 's2', nfd, 'o1', 'svc@x', 'g1', 'service-run', prov='inferred'),
        row('2026-10-02T00:00:00Z', 's2', 'house', 'o2', 'b@x', None, None),
        row('2026-10-09T00:00:00Z', 's1', nfc, 'o3', 'admin@x', 'g3', 'repair', prov='inferred'),
        row('2026-10-09T00:00:01Z', 's2', 'house', 'o3', 'admin@x', 'g3', 'repair'),
    ]


def test_a_repair_is_neither_a_persons_nor_a_machines_edit():
    from plaid_agent.research.fates import Fates
    fates = Fates(Pseudonyms(b'k' * 32), '2026-10-10T00:00:00Z')
    fates.stream(_fate_rows())
    by = {w['target_id']: w for w in fates.writes}
    # the run's gloss the conversion composed is unchanged, and still its value
    assert by['s1']['fate'] == 'unchanged'
    assert by['s1']['first_event'] is None and by['s1']['first_edit'] is None
    assert by['s1']['final_value_same'] is True
    assert by['s1']['later_by'] == {'repair.value': 1}
    # the person's edit stays the person's
    assert by['s2']['fate'] == 'edited_by_person'
    assert by['s2']['first_edit']['actor'] == Pseudonyms(b'k' * 32).user('b@x')
    assert by['s2']['later_by'] == {'person.value': 1}
    # the repair is no unit of its own unless asked for
    assert {u['kind'] for u in fates.unit_rows()} == {'service-run'}


def test_a_conversation_row_has_the_size_the_service_wrote_and_no_holding_tab():
    """The service is the record's only writer (design/SINGLE-WRITER.md): it
    writes the record's size on the sidebar entry, and the tab that holds the
    conversation, which is not exported. A user message's request id is not
    either."""
    from plaid_agent.research.records import Conversations
    conv = Conversations(Pseudonyms(b'k' * 32))
    record = {'messages': [{'role': 'user', 'content': 'q'}], 'display': [
        {'kind': 'user', 'text': 'q', 'request-id': '0192-r1'}]}
    meta = {'id': 'c1', 'title': 't', 'about': {'document-id': 'd1', 'document-name': 'Text 1'},
            'holder': {'tab': 'tab-uuid', 'at': '2026-10-09T00:00:00.000Z'},
            'size': {'bytes': 123, 'cap': 1000}, 'pending': None}
    conv.add('u@x', 'igt', 'p1', 'c1', record, meta, 10, None)
    [row] = conv.conversations
    assert row['size_bytes'] == 123 and row['about_document'] == 'd1'
    flat = repr([conv.conversations, conv.turns, conv.private])
    assert 'tab-uuid' not in flat and '0192-r1' not in flat


def test_a_turns_calls_are_read_off_its_rounds_with_what_they_read():
    # From 2026-10-09 a call's arguments and output are in the round its step
    # names, which holds what prune dropped from the record (Luke's D3).
    import json as _json
    from plaid_agent.research.records import DROPPED, Conversations, iter_records
    record = {'messages': [{'role': 'user', 'content': 'q'},
                           {'role': 'tool', 'tool-call-id': 'c1', 'content': DROPPED}],
              'display': [
        {'kind': 'user', 'text': 'q'},
        {'kind': 'assistant', 'text': 'a', 'steps': [
            {'id': 'c1', 'name': 'read_document', 'kind': 'document', 'document': 'T', 'round': 'r1',
             'said': 'Looking.', 'saw': [{'n': 5, 'unit': 'sentence', 'of': 9, 'which': '1–5'}]}]}]}
    rnd = {'id': 'r1', 'n': 1, 'calls': [{'id': 'c1', 'name': 'read_document', 'arguments': '{"document": "T"}',
                                         'result': 'five sentences', 'chars': 14, 'cut': True}]}
    rows = [('u@x', 'igt:assistant:p1:conv:c1', _json.dumps(record), 't'),
            ('u@x', 'igt:assistant:p1:round:c1:r1', _json.dumps(rnd), 't')]
    [(user, app, pid, cid, c, meta, nbytes, updated, rounds, rbytes)] = list(iter_records(rows))
    assert set(rounds) == {'r1'} and rbytes > 0
    plain = Conversations(Pseudonyms(b'k' * 32))
    plain.add(user, app, pid, cid, c, meta, nbytes, updated, rounds, rbytes)
    [call] = plain.tool_calls
    assert call['result_kept'] and call['round_stored'] and call['cut'] and call['result_chars'] == 14
    assert call['said'] == 'Looking.' and call['saw'] == [{'n': 5, 'unit': 'sentence', 'of': 9, 'which': '1–5'}]
    assert call['arg_names'] == ['document'] and 'arguments' not in call and 'result' not in call
    assert plain.conversations[0]['rounds'] == 1 and not plain.round_calls
    full = Conversations(Pseudonyms(b'k' * 32), include_rounds=True)
    full.add(user, app, pid, cid, c, meta, nbytes, updated, rounds, rbytes)
    assert full.round_calls[0]['result'] == 'five sentences'
