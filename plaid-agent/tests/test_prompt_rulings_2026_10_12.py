"""The prompt and note lines the 2026-10-12 survey of real conversations
asked for."""
from fixtures import FakeClient

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.files import file_key
from plaid_agent.core.prompt import find_first
from plaid_agent.igt.prompt import SYSTEM as IGT_SYSTEM
from plaid_agent.igt.workspace import Workspace as IgtWorkspace
from plaid_agent.ud.service import AssistantService as UdService
from test_service_flow import Helper, _request, _seed, _service


def test_a_convention_question_is_asked_before_planning():
    said = find_first('item', '"the word ka"')
    assert 'differ only by convention (dots, spaces, underscores, case), ask which form is the convention' in said
    assert 'plan only the fields and levels the user named' in said


def test_examples_of_a_planned_change_cite_what_it_writes():
    assert 'cite the item it writes: sN.wN.mN for a morpheme\'s field' in IGT_SYSTEM


def test_an_attached_table_of_entries_is_sent_to_bulk_add(monkeypatch):
    client = FakeClient()
    store = _seed(client, text='Add these to the lexicon')
    text = 'form,gloss\naq\'a,water\nnis,milk\n'
    client.user_data.put('u@x', f'{file_key("igt", "p1", "c1", "f1")}:part:0', text)
    conv, meta = store.load('c1')
    conv['display'][-1]['files'] = [{'id': 'f1', 'name': 'words.csv',
                                     'bytes': len(text.encode()), 'lines': 3, 'chunks': 1}]
    store.save('c1', conv, meta)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['stamp'] = transcript[-1]['content']
        return TurnResult('ok', [{'role': 'assistant', 'content': 'ok'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(client), Helper())
    assert IgtWorkspace.FILE_ROUTES in seen['stamp']
    assert 'Bulk Add' in IgtWorkspace.FILE_ROUTES and 'save_file' in IgtWorkspace.FILE_ROUTES
    # Apps never name each other's screens.
    assert UdService.WORKSPACE.FILE_ROUTES == ''
