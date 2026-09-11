"""The change history, comments, and restore: the tools that look at what
people did and put things back."""

import datetime

import pytest

from fixtures import scan_ws
from fixtures_ext import ExtClient

from plaid_agent.igt.plan import execute_plan, validate_ops
from plaid_agent.igt.tools import call_tool, AUDIT_WINDOWS_DAYS


def _ago(days):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')


def _client_with_audit():
    c = ExtClient()
    c.audit = [
        {'id': 'a', 'time': _ago(2), 'end_time': _ago(2), 'user': {'id': 'a@b.com', 'display_name': 'Luke G'},
         'message': 'Assistant: 2 field values', 'documents': [{'id': 'd1', 'name': 'Text 1'}], 'ops': [{'type': 'span/create'}, {'type': 'span/update'}]},
        {'id': 'b', 'time': _ago(100), 'user': {'id': 'x@y.z', 'display_name': 'Someone'}, 'documents': [],
         'ops': [{'type': 'project/create', 'description': 'Create project "Demo"'}]},
        {'id': 'c', 'time': _ago(1000), 'user': {'id': 'x@y.z', 'display_name': 'Someone'}, 'documents': [],
         'ops': [{'type': 'document/create', 'description': 'Create document'}]},
    ]
    return c


def test_recent_changes_reads_recent_windows_first_and_widens():
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'limit': 1})
    assert out.startswith('1 most recent change (newest first; as_of=')
    assert c.audit_calls == [c.audit_calls[0]] and c.audit_calls[0] >= _ago(8)  # one window, a week
    assert f'Luke G: Assistant: 2 field values  ["Text 1"]  (2 ops)  as_of={c.audit[0]["end_time"]}' in out
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'limit': 2})
    assert len(c.audit_calls) == 3 and c.audit_calls[2] <= _ago(179)  # widened to 180 days
    assert '2 most recent changes' in out and 'Create project "Demo"' in out
    c = _client_with_audit()
    call_tool(scan_ws(c), 'recent_changes', {'limit': 5})
    assert len(c.audit_calls) == len(AUDIT_WINDOWS_DAYS) and c.audit_calls[-1] is None  # the whole log, last
    # A user filter widens until enough of THAT person's entries are in hand.
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'limit': 1, 'user': 'someone'})
    assert len(c.audit_calls) == 3 and '1 most recent change by "someone"' in out
    # since= reads exactly that window.
    c = _client_with_audit()
    call_tool(scan_ws(c), 'recent_changes', {'since': '2026-01-01'})
    assert c.audit_calls == ['2026-01-01T00:00:00Z']


def _comments():
    return [
        {'id': 'c1', 'project_id': 'p1', 'document_id': 'd1', 'entity_type': 'token', 'entity_id': 'w-2',
         'anchor_label': 'gam, sentence 1', 'author_id': 'ann@x.com', 'body': 'Is this really a fish?',
         'created_at': '2026-09-01T10:00:00Z', 'updated_at': '2026-09-01T10:00:00Z', 'edited': False},
        {'id': 'c2', 'project_id': 'p1', 'document_id': 'd1', 'entity_type': 'span', 'entity_id': 'sp-m1b',
         'anchor_label': 'Morph Gloss of di, in Ali-di, sentence 1', 'author_id': 'bob@x.com', 'body': 'ERG, not OBL',
         'created_at': '2026-09-02T10:00:00Z', 'updated_at': '2026-09-03T10:00:00Z', 'edited': True},
        {'id': 'c3', 'project_id': 'p1', 'document_id': 'd1', 'entity_type': 'token', 'entity_id': 'w-gone',
         'anchor_label': 'zzz, sentence 9', 'author_id': 'ann@x.com', 'body': 'Old note.',
         'created_at': '2026-08-01T10:00:00Z', 'updated_at': '2026-08-01T10:00:00Z', 'edited': False},
        {'id': 'c4', 'project_id': 'p1', 'document_id': 'd1', 'entity_type': 'document', 'entity_id': 'd1',
         'anchor_label': 'Text 1', 'author_id': 'ann@x.com', 'body': 'Whole text checked.',
         'created_at': '2026-09-04T10:00:00Z', 'updated_at': '2026-09-04T10:00:00Z', 'edited': False},
    ]


def test_comments_resolve_anchors_to_references():
    c = ExtClient(comments=_comments())
    w = scan_ws(c)
    out = call_tool(w, 'comments', {})
    lines = out.split('\n')
    assert lines[0] == '4 comments in the project, oldest first:'
    assert lines[1] == '  2026-08-01 10:00  ann@x.com  @ zzz, sentence 9 [outdated]: Old note.'
    assert lines[2] == '  2026-09-01 10:00  ann@x.com  @ s1.w2: Is this really a fish?'
    assert lines[3] == '  2026-09-02 10:00  bob@x.com  @ s1.w1.m2 Morph Gloss of di, in Ali-di, sentence 1: ERG, not OBL (edited)'
    assert lines[4] == '  2026-09-04 10:00  ann@x.com  @ (the document): Whole text checked.'
    out = call_tool(w, 'comments', {'document': 'd1', 'ref': 's1.w2'})
    assert out.startswith('1 comment on Text 1 s1.w2, oldest first:') and 'fish' in out
    out = call_tool(w, 'comments', {'document': 'd1', 'ref': 's1.w1.m2', 'field': 'Morph Gloss'})
    assert out.startswith('1 comment on Text 1 s1.w1.m2 Morph Gloss')
    assert call_tool(w, 'comments', {'document': 'd1', 'ref': 's2'}) == 'No comments on Text 1 s2.'
    assert call_tool(w, 'comments', {'limit': 1}).startswith('4 comments in the project (newest 1 shown)')
    assert 'ref needs a document' in call_tool(w, 'comments', {'ref': 's1'})


def test_add_comment_plans_with_the_editors_captions_and_posts_on_approval():
    c = ExtClient()
    w = scan_ws(c)
    call_tool(w, 'add_comment', {'document': 'd1', 'body': 'Check with the speaker.'})
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1', 'body': 'Odd word order.'})
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w2', 'body': 'fish or net?'})
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w1.m2', 'body': 'ergative'})
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w1.m2', 'field': 'Morph Gloss', 'body': 'ERG is right'})
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1', 'field': 'Translation', 'body': 'free translation ok'})
    ops = w.ops
    assert [(o['entity_type'], o['entity_id'], o['anchor_label']) for o in ops] == [
        ('document', 'd1', 'Text 1'), ('token', 's-1', 'Sentence 1'), ('token', 'w-2', 'gam, sentence 1'),
        ('token', 'm-1b', 'di, in Ali-di, sentence 1'), ('span', 'sp-m1b', 'Morph Gloss of di, in Ali-di, sentence 1'),
        ('span', 'sp-t1', 'Translation of sentence 1')]
    assert ops[0]['label'] == '"Text 1": comment "Check with the speaker."'
    assert ops[2]['label'] == 'Text 1 s1.w2 "gam": comment "fish or net?"'
    assert ops[4]['label'] == 'Text 1 s1.w1.m2 "di": comment "ERG is right" (on Morph Gloss)'
    assert all(o['document_id'] == 'd1' for o in ops) and len(ops) == 6  # comments never replace one another
    assert 'has no Gloss value' in call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w2', 'field': 'Gloss', 'body': 'x'})
    assert 'must not be empty' in call_tool(w, 'add_comment', {'document': 'd1', 'body': '  '})
    assert [d['id'] for d in w.plan_payload()['documents']] == ['d1']
    counts = execute_plan(c, ops[:3], source='s', label='l')
    assert counts == {'comments': 3}
    assert ('comments', 'create', ('token', 'w-2', 'fish or net?'), {'anchor_label': 'gam, sentence 1'}) in c.log


SUMMARY = {'name': False, 'document_metadata': True, 'total': 7,
           'texts': {'inserted': 0, 'updated': 1, 'deleted': 0},
           'tokens': {'inserted': 2, 'updated': 0, 'deleted': 1, 'by_layer': [
               {'layer_id': 'tk-word', 'inserted': 2, 'updated': 0, 'deleted': 0},
               {'layer_id': 'tk-morph', 'inserted': 0, 'updated': 0, 'deleted': 1}]},
           'spans': {'inserted': 0, 'updated': 2, 'deleted': 0, 'by_layer': [
               {'layer_id': 'sl-mgloss', 'inserted': 0, 'updated': 2, 'deleted': 0}]},
           'relations': {'inserted': 0, 'updated': 0, 'deleted': 0, 'by_layer': []},
           'vocab_links': {'inserted': 0, 'updated': 0, 'deleted': 0},
           'skipped': [{'kind': 'vocab-link', 'count': 1, 'reason': 'item-gone'}]}


def test_restore_document_plans_from_the_dry_run_and_stands_alone():
    c = ExtClient(restore_summary=SUMMARY)
    w = scan_ws(c)
    assert 'ISO-8601' in call_tool(w, 'restore_document', {'document': 'd1', 'as_of': 'yesterday'})
    out = call_tool(w, 'restore_document', {'document': 'd1', 'as_of': '2026-09-05T18:45:49Z'})
    assert 'Planned 1 change' in out and 'What changes (from the server\'s dry run): the text, 2 words, 1 morpheme, ' \
                                        '2 Morph Gloss values, the document metadata, 1 vocab-link(s) cannot come back (item-gone).' in out
    assert c.log[-1] == ('documents', 'restore', ('d1', '2026-09-05T18:45:49Z'), {'dry_run': True})
    op = w.ops[0]
    assert op['kind'] == 'restore_document' and op['document_id'] == 'd1' and op['doc'] == 'd1'
    assert op['label'].startswith('Text 1: restore to 2026-09-05T18:45:49Z (7 changes: the text, 2 words,')
    assert [d['id'] for d in w.plan_payload()['documents']] == ['d1']
    # Nothing else joins a restore, before or after it.
    assert 'holds a restore' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    w2 = scan_ws(ExtClient(restore_summary=SUMMARY))
    call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    assert 'plan of its own' in call_tool(w2, 'restore_document', {'document': 'd1', 'as_of': '2026-09-05T18:45:49Z'})
    with pytest.raises(ValueError, match='only op'):
        validate_ops([w2.ops[0], op])
    # Nothing to do, and no access.
    w3 = scan_ws(ExtClient(restore_summary={**SUMMARY, 'total': 0}))
    assert call_tool(w3, 'restore_document', {'document': 'd1', 'as_of': '2026-09-05T18:45:49Z'}).startswith('Nothing to restore')
    w4 = scan_ws(ExtClient(restore_error='HTTP 403 Forbidden'))
    assert 'maintainer access' in call_tool(w4, 'restore_document', {'document': 'd1', 'as_of': '2026-09-05T18:45:49Z'})
    # Approval runs the server's restore once, as the plan's one write.
    counts = execute_plan(c, [op], source='s', label='l')
    assert counts == {'restored documents': 1}
    assert c.log[-1] == ('documents', 'restore', ('d1', '2026-09-05T18:45:49Z'), {'dry_run': False})
    assert c.operations[-1] == 'l' and c.batches == []
