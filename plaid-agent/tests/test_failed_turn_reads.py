"""A failed turn's tool results stay in the model transcript for the next
message (SVA A1, `agent.failed_turn_messages`), so what it read of each
sentence stays too (REV-SVB-13): a number the model read in a turn that then
failed is held to the sentence as that turn read it, as after a reply. A
stopped turn keeps no steps and so no reads."""

from plaid_agent.core import agent
from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import TurnCancelled
from plaid_agent.core.conversation import build_meta, user_item
from test_moved_sentence_refs import MOVED, READ_S1, Conversation, _gloss, _insert_word
from test_service_flow import Helper, _request, _service

litellm = agent.litellm


def _turn_that_fails(c, error, *calls):
    """One turn of ``c`` whose model makes ``calls`` and then fails with
    ``error``, the calls and their results kept on it as `run_turn` keeps
    them."""
    c.n += 1
    text = f'message {c.n}'
    if c.n == 1:
        conv, meta = {'messages': [], 'display': []}, None
    else:
        conv, meta = c.store.load('c1')
    conv['messages'].append({'role': 'user', 'content': text})
    conv['display'].append(user_item(text))
    rid = f'r{c.n}'
    c.store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                        pending={'kind': 'turn', 'request_id': rid}))

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        kept = []
        for i, (name, args) in enumerate(calls):
            out = kit.call_tool(ws, name, args)
            kept += [{'role': 'assistant', 'content': None,
                      'tool_calls': [{'id': f'c{i}', 'type': 'function',
                                      'function': {'name': name, 'arguments': '{}'}}]},
                     {'role': 'tool', 'tool_call_id': f'c{i}', 'content': out}]
        error.turn_steps, error.turn_partial, error.turn_reply_round = [], '', None
        error.turn_messages = kept
        raise error

    c.monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(c.client), Helper(request_id=rid))


def test_a_number_read_in_a_failed_turn_is_held_to_that_read(monkeypatch):
    c = Conversation(monkeypatch)
    _turn_that_fails(c, litellm.InternalServerError('down', model='x', llm_provider='openai'), READ_S1)
    item = c.last_item()
    assert item['kind'] == 'error' and set(item['read']['d1']) == {'1'}
    c.edit(_insert_word)
    (out,) = c.turn(_gloss('s1.w2'))
    assert out == f'Error: {MOVED}', out


def test_the_newest_item_holds_the_one_map_failed_or_answered(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    _turn_that_fails(c, RuntimeError('a bug'), ('read_document', {'document': 'Text 1', 'sentences': [2]}))
    display = c.store.load('c1')[0]['display']
    assert [sorted((d.get('read') or {}).get('d1', ())) for d in display if d['kind'] != 'user'] == [[], ['1', '2']]


def test_a_stopped_turn_keeps_no_read(monkeypatch):
    c = Conversation(monkeypatch)
    _turn_that_fails(c, TurnCancelled(), READ_S1)
    item = c.last_item()
    assert item['kind'] == 'error' and 'read' not in item
    c.edit(_insert_word)
    out = c.turn(_gloss('s1.w2'))
    assert out[0].startswith('Planned'), out
