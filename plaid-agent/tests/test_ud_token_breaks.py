"""A token whose text holds a line break (2026-10-12 survey): set_words does
not make its pieces one multi-word token, and a read prints the break as a
visible mark so the CoNLL-U table stays one line per token."""
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, document_raw, ud_client


def _ws():
    raw = document_raw()
    # "Corre" (14-19) as two lines, the same length.
    raw['text_layers'][0]['text']['body'] = 'Vamos al mar. Co\nre.'
    client = ud_client(documents={'ud1': raw})
    return Workspace(client, load_project(client, PID))


def test_set_words_over_a_token_with_whitespace_is_refused():
    w = _ws()
    out = call_tool(w, 'set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['Co', 're']})
    assert out.startswith('Error: "Co\\nre" in s2 holds whitespace')
    assert 'ONE multi-word token of 2 words, not 2 tokens' in out and 'Edit text' in out
    assert w.ops == []


def test_a_read_prints_a_line_break_as_a_mark():
    out = call_tool(_ws(), 'read_document', {'document': 'Viaje', 'sentences': ['s2']})
    rows = [line for line in out.split('\n') if line.startswith('1\t')]
    assert len(rows) == 1 and rows[0].split('\t')[1] == 'Co\\nre'
    assert not any(line.startswith('re') for line in out.split('\n'))
