"""Text written into a document whose text is empty gets its sentences the
way igt's own save gives them (R2-RULES-1): one per line, made whole in one
bulk create on the sentence layer, which is a partition the server never takes
one token at a time. Once on the fake client, which refuses a single create on
a partitioning layer as core does, and once on a live core."""

import pytest
from fixtures import FakeClient, SENT_LAYER, TEXT_LAYER, document_raw, project_raw
from live import live_client, seed  # noqa: F401
from rule_plan_model import approve, project

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace
from plaid_client import PlaidAPIError
from test_shape import _TextServer

TEXT = 'Gam akuna.\nAli gam.'


def _empty_doc():
    doc = document_raw()
    tl = doc['text_layers'][0]
    tl['text']['body'] = ''
    for layer in tl['token_layers']:
        layer['tokens'] = []
        for sl in layer.get('span_layers') or []:
            sl['spans'] = []
        for v in layer.get('vocabs') or []:
            v['vocab_links'] = []
    return doc


def test_the_fake_refuses_a_single_token_on_the_sentence_layer():
    c = FakeClient(project=project_raw(), documents=[document_raw()])
    with pytest.raises(PlaidAPIError, match='Single token creation'):
        c.tokens.create(SENT_LAYER, 'text1', 0, 5)
    with pytest.raises(PlaidAPIError, match='Single token deletion'):
        c.tokens.delete('s-1')


def test_text_appended_to_an_empty_document_seeds_its_sentences_in_one_bulk_create():
    c = FakeClient(project=project_raw(), documents={'d1': _empty_doc()})
    ws = Workspace(c, load_project(c, 'p1'))
    call_tool(ws, 'append_text', {'document': 'Text 1', 'text': TEXT})
    _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}
    execute_plan(c, ws.ops, source='s', label='l', project=load_project(c, 'p1'))
    assert not c.payloads('tokens.create')
    [sentences] = c.payloads('tokens.bulk_create')
    assert [(t['token_layer_id'], t['begin'], t['end']) for t in sentences] == [
        (SENT_LAYER, 0, 11), (SENT_LAYER, 11, len(TEXT))]


def test_text_appended_to_an_empty_document_on_a_live_core(live_client):
    c = live_client
    s = seed(c, project(), {'d1': document_raw()}, {}, name='empty text edit')
    try:
        # A document as igt's New document leaves it: a text with no body.
        empty = c.documents.create(s.project_id, 'Empty')['id']
        c.texts.create(s.ids[TEXT_LAYER], empty, '')
        ws = Workspace(c, load_project(c, s.project_id))
        call_tool(ws, 'append_text', {'document': 'Empty', 'text': TEXT})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        raw = c.documents.get(empty, include_body=True)
        [tl] = [t for t in raw['text_layers'] if t['id'] == s.ids[TEXT_LAYER]]
        assert tl['text']['body'] == TEXT
        [sent] = [k for k in tl['token_layers'] if k['id'] == s.ids[SENT_LAYER]]
        assert sorted((t['begin'], t['end']) for t in sent['tokens']) == [(0, 11), (11, len(TEXT))]
    finally:
        s.delete()


def test_the_seeded_sentences_cover_the_body_the_server_stored(monkeypatch):
    """The seed is measured on the stored body, read again after the edit,
    not on the client's mirror of the server's composition: core refuses a
    partition that does not end at the text's length."""
    import plaid_client
    c = FakeClient(project=project_raw(), documents={'d1': _empty_doc()})
    ws = Workspace(c, load_project(c, 'p1'))
    call_tool(ws, 'append_text', {'document': 'Text 1', 'text': TEXT})
    _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}
    real = plaid_client.compose_text
    # A mirror one character off the server's composition.
    monkeypatch.setattr(plaid_client, 'compose_text',
                        lambda body, edges: (lambda b, at: (b + 'x', at))(*real(body, edges)))
    execute_plan(c, ws.ops, source='s', label='l', project=load_project(c, 'p1'))
    [sentences] = c.payloads('tokens.bulk_create')
    assert sentences[-1]['end'] == len(TEXT)
