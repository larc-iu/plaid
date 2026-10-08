"""The ud assistant prints a sentence's stored ``sent_id`` (what the UD
export writes and a user quotes) beside its positional ref, and read_document
finds a sentence by it, so "fix sent_id a3" is not matched against s3."""

import copy

from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, SENT_LAYER, document_raw, ud_client


def _ws(numbered_from=None):
    raw = copy.deepcopy(document_raw())
    if numbered_from is not None:
        for tl in raw['text_layers']:
            for tk in tl['token_layers']:
                if tk['id'] == SENT_LAYER:
                    for i, t in enumerate(tk['tokens']):
                        t['metadata'] = {'sent_id': str(numbered_from + i)}
    client = ud_client(documents={'ud1': raw})
    return Workspace(client, load_project(client, PID))


def test_a_read_prints_the_stored_sent_id_beside_the_ref():
    out = call_tool(_ws(), 'read_document', {'document': 'Viaje'})
    assert '# sent_id = s1\n# stored sent_id = train-1\n# text = Vamos al mar.' in out
    # Sentence 2 stores none, so it gets no such line.
    assert '# sent_id = s2\n# text = Corre.' in out


def test_read_document_finds_a_sentence_by_its_stored_sent_id():
    out = call_tool(_ws(), 'read_document', {'document': 'Viaje', 'sentences': ['sent_id=train-1']})
    assert '# sent_id = s1' in out and '# sent_id = s2' not in out
    bare = call_tool(_ws(), 'read_document', {'document': 'Viaje', 'sentences': ['train-1']})
    assert '# sent_id = s1' in bare


def test_a_numeric_stored_sent_id_is_not_read_as_a_place():
    ws = _ws(numbered_from=12)
    out = call_tool(ws, 'read_document', {'document': 'Viaje', 'sentences': ['sent_id=13']})
    assert '# sent_id = s2\n# stored sent_id = 13\n' in out and '# sent_id = s1' not in out
    # Bare, a number is still a place.
    out = call_tool(ws, 'read_document', {'document': 'Viaje', 'sentences': ['2']})
    assert '# sent_id = s2' in out


def test_a_stored_sent_id_nobody_has_is_refused_with_where_to_look():
    out = call_tool(_ws(), 'read_document', {'document': 'Viaje', 'sentences': ['sent_id=a9']})
    assert 'No sentence in "Viaje" has the stored sent_id "a9"' in out
