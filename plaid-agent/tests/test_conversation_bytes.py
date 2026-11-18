"""The record's weight as the server counts it (H2-4-1).

Core counts a stored value as the UTF-8 bytes of its JSON, each character
written as itself (round one's H20-2). The size meter, the full state and the
prune budget read the same figure, so a conversation in a script outside ASCII
is weighed at its stored size, not three times it."""

import json

from plaid_agent.core.conversation import _bytes, conversation_bytes, with_size


def _stored(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def test_an_arabic_record_weighs_what_the_server_stores():
    conv = {'messages': [{'role': 'assistant', 'content': 'ب' * 1000 + ' done/0'}],
            'display': [{'kind': 'assistant', 'text': 'ب' * 1000}]}
    stored = _stored({'messages': conv['messages'], 'display': conv['display']})
    assert conversation_bytes(conv) == stored
    assert with_size({}, conv, 5_000_000)['size'] == {'bytes': stored, 'cap': 5_000_000}


def test_an_astral_letter_weighs_its_four_bytes():
    assert _bytes('\U0001E2C0' * 10) == 2 + 40


def test_a_lone_surrogate_is_counted_not_raised():
    assert _bytes('a\ud800b') == 2 + 1 + 6 + 1
