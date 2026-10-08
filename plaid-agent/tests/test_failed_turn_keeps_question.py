"""A turn whose model call fails keeps the user's message in the model
transcript, so the next message ("go on with the rest of what I asked")
reaches the model with what it follows. Before, a failed or stopped turn
dropped it, and the model answered the next message without knowing what had
been asked (bench note 8: two turns lost to 429s, and the third met "I don't
carry over the context of our previous exchange")."""

import pytest
from fixtures import FakeClient
from test_service_flow import Helper, _request, _seed, _service

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnCancelled
from plaid_agent.core.conversation import build_meta, user_item

ASKED = 'Split the two long sentences in Text 1.'
NEXT = 'Go on with the rest of what I asked.'


def _ask_next(store, text, request_id):
    """What the browser writes before submitting a turn: the message, on the
    record as it stands."""
    conv, meta = store.load('c1')
    conv = {'messages': conv['messages'] + [{'role': 'user', 'content': text}],
            'display': conv['display'] + [user_item(text)]}
    store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                      pending={'kind': 'turn', 'request_id': request_id,
                                               'service_id': 'igt:assist:fake'}))


@pytest.mark.parametrize('failure', [RuntimeError('RateLimitError: Model capacity reached'), TurnCancelled()])
def test_the_next_turn_reads_the_question_a_failed_turn_never_answered(monkeypatch, failure):
    client = FakeClient()
    store = _seed(client, text=ASKED)

    def fail(*a, **k):
        raise failure

    monkeypatch.setattr(service_mod, 'run_turn', fail)
    _service().process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    assert [d['kind'] for d in conv['display']] == ['user', 'error']
    [kept] = conv['messages']
    assert kept['role'] == 'user' and kept['content'].endswith(ASKED)

    seen = {}

    def answer(cfg, kit, ws, system, transcript, on_progress, cancelled=None, on_text=None):
        seen['transcript'] = transcript
        raise RuntimeError('still down')

    monkeypatch.setattr(service_mod, 'run_turn', answer)
    _ask_next(store, NEXT, 'r2')
    helper = Helper(request_id='r2')
    _service().process_request(_request(client), helper)
    users = [m['content'] for m in seen['transcript'] if m['role'] == 'user']
    assert len(users) == 2 and users[0].endswith(ASKED) and users[1].endswith(NEXT)
    # And it failed too: both questions stay, each once.
    conv, _meta = store.load('c1')
    assert len(conv['messages']) == 2 and conv['messages'][1]['content'].endswith(NEXT)
