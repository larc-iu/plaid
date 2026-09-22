"""The change history, comments, and restore: the tools that look at what
people did and put things back."""

import datetime

import pytest

from fixtures import scan_ws
from fixtures_ext import ExtClient

from plaid_agent.igt.plan import execute_plan, validate_ops
from plaid_agent.igt.toolkit import call_tool


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


def test_recent_changes_pages_the_log_newest_first():
    """The audit endpoint pages from the OLDEST entry unless it is asked
    otherwise, so this app used to read a WINDOW (a week, then a month, then
    six months, then everything) and sort what came back. On a long-lived
    project that fetched the whole history to print twenty lines: 2.1 s where
    the other two apps take 0.13 s. One paged read for all three now.
    """
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'limit': 1})
    assert out.startswith('1 change(s), newest first. as_of=')
    assert 'which is what restore_document takes' in out
    # One page, asked for newest first, with no window at all.
    assert c.audit_pages == [{'order': 'desc', 'start_time': None}]
    assert 'Luke G  "Text 1": Assistant: 2 field values (2 op(s))' in out
    assert f'as_of={c.audit[0]["end_time"]}' in out

    # A user filter costs no extra request: the page is filtered in hand.
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'limit': 1, 'user': 'someone'})
    assert len(c.audit_pages) == 1 and 'Someone' in out

    # Nobody by that name, and the reply says how far it looked.
    c = _client_with_audit()
    out = call_tool(scan_ws(c), 'recent_changes', {'user': 'nobody here'})
    assert 'Nothing by "nobody here" among the 3 most recent change(s).' == out

    # since= is passed to the server rather than filtered here.
    c = _client_with_audit()
    call_tool(scan_ws(c), 'recent_changes', {'since': '2026-01-01'})
    assert c.audit_pages == [{'order': 'desc', 'start_time': '2026-01-01T00:00:00Z'}]


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


def test_a_comment_on_something_the_plan_deletes_refuses_rather_than_failing_the_batch():
    """A comment outlives its anchor once it is written, but it cannot be
    written onto one that is already gone: the server resolves the anchor to
    find whose permissions apply and fails closed when there is none, which
    would refuse the whole batch after the user approved it. Either order:
    the tool stages the comment first or the delete does."""
    import pytest
    from plaid_agent.igt.plan import normalize_ops

    comment = {'kind': 'add_comment', 'entity_type': 'token', 'entity_id': 'w-9', 'body': 'x',
               'document_id': 'd1', 'label': 'a comment on w-9'}
    on_value = {'kind': 'add_comment', 'entity_type': 'span', 'entity_id': 'sp-1', 'body': 'x',
                'document_id': 'd1', 'label': 'a comment on a value'}
    delete = {'kind': 'delete_word', 'word_id': 'w-9', 'morpheme_ids': [], 'label': ''}
    clear = {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'm-1', 'span_id': 'sp-1', 'value': '', 'label': ''}
    for ops in ([comment, delete], [delete, comment], [on_value, clear]):
        with pytest.raises(ValueError, match='deleted or merged away'):
            normalize_ops(ops)
    # A comment on something the plan leaves alone stands.
    out, notes = normalize_ops([comment, clear])
    assert [o['kind'] for o in out] == ['add_comment', 'set_span'] and notes == []


def test_a_comment_and_a_delete_of_its_anchor_refuse_each_other_at_staging():
    """The refusal above is the backstop. The tools refuse the pair while the
    model can still put the two in separate turns, whichever it stages first."""
    w = scan_ws(ExtClient())
    assert 'Planned' in call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w2', 'body': 'fish or net?'})
    out = call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'writes to something this plan deletes' in out
    assert [o['kind'] for o in w.ops] == ['add_comment']
    w2 = scan_ws(ExtClient())
    assert 'Planned' in call_tool(w2, 'delete_word', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'writes to something this plan deletes' in call_tool(
        w2, 'add_comment', {'document': 'd1', 'ref': 's1.w2', 'body': 'fish or net?'})
    assert [o['kind'] for o in w2.ops] == ['delete_word']


def test_a_comment_and_a_retype_over_it_are_refused_rather_than_one_being_dropped():
    """A retype names every word of the sentence as deleted, but the edit
    goes through the server's diffing update and an unchanged word keeps its
    token, so the deletion is a guess. The drop above turned that guess into
    a comment silently missing from a plan the user had approved, in both
    orders. Every other guard over a text edit treats its word ids as
    deleted, so this pair is refused where the model can still split it."""
    c = ExtClient()
    w = scan_ws(c)
    call_tool(w, 'add_comment', {'document': 'd1', 'ref': 's1.w1', 'body': 'check this'})
    assert 'rewrites the text over a word it also comments on' in call_tool(
        w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    assert [o['kind'] for o in w.ops] == ['add_comment']

    w2 = scan_ws(ExtClient())
    call_tool(w2, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    assert 'rewrites the text over a word it also comments on' in call_tool(
        w2, 'add_comment', {'document': 'd1', 'ref': 's1.w1', 'body': 'check this'})
    # A morpheme of a retyped word counts too: the retype names those as well.
    assert 'rewrites the text over a word it also comments on' in call_tool(
        w2, 'add_comment', {'document': 'd1', 'ref': 's1.w1.m2', 'body': 'x'})
    assert [o['kind'] for o in w2.ops] == ['edit_text']

    # A word the retype does not name, and an append, which names none.
    w3 = scan_ws(ExtClient())
    call_tool(w3, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    call_tool(w3, 'add_comment', {'document': 'd1', 'ref': 's2.w1', 'body': 'ok'})
    call_tool(w3, 'append_text', {'document': 'd1', 'text': 'Gam ar.'})
    assert [o['kind'] for o in w3.ops] == ['edit_text', 'add_comment', 'edit_text']


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
    assert counts == {'document restores': 1}
    assert c.log[-1] == ('documents', 'restore', ('d1', '2026-09-05T18:45:49Z'), {'dry_run': False})
    assert c.operations[-1] == 'l' and c.batches == []
