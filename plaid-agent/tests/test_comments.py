"""One comment reader for the three assistants, core's.

igt kept its own when ud and umr moved to core, so igt could read the whole
project's comments and a comment on one value, and the other two could read
only one document's. Core's read the server's rows by keys it does not send
(``user`` and ``time``), so every ud and umr comment was by "?" at no date.
What an app owns is what a reference names and where a comment's anchor sits
(the workspace's comment_target and comment_ref); the rest is shared.
"""

import sys

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.core import history  # noqa: E402


def _row(cid, did, etype, eid, label, body, day):
    return {'id': cid, 'project_id': 'p1', 'document_id': did, 'entity_type': etype, 'entity_id': eid,
            'anchor_label': label, 'author_id': 'ann@x.com', 'body': body,
            'created_at': f'2026-09-0{day}T10:00:00Z', 'updated_at': f'2026-09-0{day}T10:00:00Z',
            'edited': False}


def _ws(app, rows):
    if app == 'igt':
        from fixtures import scan_ws
        from fixtures_ext import ExtClient
        from plaid_agent.igt.toolkit import call_tool, _IMPL
        return scan_ws(ExtClient(comments=rows)), call_tool, _IMPL, 'Text 1'
    if app == 'ud':
        from ud_fixtures import PID, ExtClient
        from plaid_agent.ud.project import load_project
        from plaid_agent.ud.tools import Workspace
        from plaid_agent.ud.toolkit import call_tool, _IMPL
        c = ExtClient(comments=rows)
        return Workspace(c, load_project(c, PID)), call_tool, _IMPL, 'Viaje'
    from umr_fixtures import PID, ExtClient
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.tools import Workspace
    from plaid_agent.umr.toolkit import call_tool, _IMPL
    c = ExtClient(comments=rows)
    return Workspace(c, load_project(c, PID)), call_tool, _IMPL, 'Story'


APPS = {'igt': ('d1', 's-2'), 'ud': ('ud1', 'us-2'), 'umr': ('umr1', 'ms-2')}


@pytest.mark.parametrize('app', sorted(APPS))
def test_every_app_reads_the_whole_projects_comments_with_their_authors(app):
    did, s2 = APPS[app]
    rows = [_row('c2', did, 'token', s2, 'Sentence 2', 'Check the verb.', 2),
            _row('c1', did, 'document', did, 'The text', 'Whole text read.', 1),
            _row('c3', did, 'token', 'gone', 'Sentence 9', 'Old note.', 3)]
    ws, call_tool, impl, name = _ws(app, rows)
    assert impl['comments'].__module__ == history.__name__
    out = call_tool(ws, 'comments', {})
    assert out.split('\n') == [
        '3 comments in the project, oldest first:',
        '  2026-09-01 10:00  ann@x.com  @ (the document): Whole text read.',
        '  2026-09-02 10:00  ann@x.com  @ s2: Check the verb.',
        '  2026-09-03 10:00  ann@x.com  @ Sentence 9 [outdated]: Old note.']
    out = call_tool(ws, 'comments', {'document': name, 'ref': 's2'})
    assert out.startswith(f'1 comment on {name} s2, oldest first:') and 'Check the verb.' in out
    assert call_tool(ws, 'comments', {'document': name}).startswith(f'3 comments in {name}, oldest first:')
    assert call_tool(ws, 'comments', {'document': name, 'ref': 's1'}) == f'No comments on {name} s1.'
    assert 'ref needs a document' in call_tool(ws, 'comments', {'ref': 's1'})


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_the_comments_schema_says_a_document_is_optional(app):
    # umr's table (umr/toolkit.py) still declares document required and says
    # "on a document or one of its sentences": its owner changes it.
    import importlib
    tools = importlib.import_module(f'plaid_agent.{app}.toolkit').TOOLS
    spec = next(t['function'] for t in tools if t['function']['name'] == 'comments')
    assert spec['parameters']['required'] == []
    assert 'whole project' in spec['description'].lower()


@pytest.mark.parametrize('app', ['ud', 'umr'])
def test_a_comment_there_sits_on_a_sentence_or_the_document(app):
    ws, call_tool, _, name = _ws(app, [])
    ref = {'ud': 's1.w1', 'umr': 's1.s1d'}[app]
    assert 'is not a sentence' in call_tool(ws, 'comments', {'document': name, 'ref': ref})
    if app == 'ud':   # umr's assistant writes no comments
        assert 'is not a sentence' in call_tool(ws, 'add_comment', {'document': name, 'ref': ref, 'body': 'x'})


def test_igt_reads_a_comment_on_one_value_through_core():
    ws, call_tool, _, _ = _ws('igt', [_row('c1', 'd1', 'span', 'sp-m1b', 'Morph Gloss of di', 'ERG?', 1)])
    out = call_tool(ws, 'comments', {'document': 'd1', 'ref': 's1.w1.m2', 'field': 'Morph Gloss'})
    assert out.startswith('1 comment on Text 1 s1.w1.m2 Morph Gloss, oldest first:')
    assert '@ s1.w1.m2 Morph Gloss of di: ERG?' in out
    assert 'field needs a ref' in call_tool(ws, 'comments', {'document': 'd1', 'field': 'Morph Gloss'})


def test_a_project_wide_listing_names_the_document_and_loads_only_a_few():
    """A comment in a project of many documents says which one it is in, and
    reading the project's comments does not fetch every document to say where
    each one sits: past the budget a comment is shown by its label."""
    import copy
    from fixtures import document_raw, scan_ws
    from fixtures_ext import ExtClient
    from plaid_agent.igt.toolkit import call_tool
    docs = {}
    for i in range(history.COMMENT_DOC_BUDGET + 2):
        d = copy.deepcopy(document_raw())
        d['id'], d['name'] = f'd{i}', f'Text {i}'
        docs[d['id']] = d
    rows = [_row(f'c{i}', f'd{i}', 'token', 's-2', f'Sentence 2 of Text {i}', 'Note.', 1)
            for i in range(len(docs))]
    c = ExtClient(documents=docs, comments=rows)
    ws = scan_ws(c)
    out = call_tool(ws, 'comments', {'limit': 200})
    assert '@ "Text 0" s2: Note.' in out
    last = len(docs) - 1
    assert f'@ "Text {last}" Sentence 2 of Text {last}: Note.' in out
    assert '[outdated]' not in out
    assert len(ws._docs) == history.COMMENT_DOC_BUDGET
