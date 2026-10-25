"""A retyped sentence whose new text holds a decomposed mark is split into
sentences on the text the server stored, composed by core's own rule, and not
on the assistant's guess at which token takes the mark (BH-7b). Checked on a
live core, the one reference for where the mark goes."""

from fixtures import SENT_LAYER, TEXT_LAYER, document_raw
from live import live_client, seed  # noqa: F401
from rule_plan_model import approve, project

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _sentences(c, s):
    raw = c.documents.get(s.ids['d1'], include_body=True)
    [tl] = [t for t in raw['text_layers'] if t['id'] == s.ids[TEXT_LAYER]]
    [sent] = [k for k in tl['token_layers'] if k['id'] == s.ids[SENT_LAYER]]
    body = tl['text']['body']
    return body, [body[t['begin']:t['end']] for t in sorted(sent['tokens'], key=lambda t: t['begin'])]


def test_a_mark_typed_over_the_space_after_a_word_splits_the_sentence_after_its_line(live_client):
    c = live_client
    s = seed(c, project(), {'d1': document_raw()}, {}, name='retype composed')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        # The acute is typed where the space after "Ali-di" was: the word
        # takes it, so the server composes it with the i.
        out = call_tool(ws, 'retype_sentence', {'document': 'Text 1', 'ref': 's1', 'text': 'Ali-dí\ngam akuna.'})
        assert out.startswith('Planned'), out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        body, sentences = _sentences(c, s)
        assert body == 'Ali-dí\ngam akuna. Gam-ar.'
        assert sentences[:2] == ['Ali-dí\n', 'gam akuna. ']
    finally:
        s.delete()
