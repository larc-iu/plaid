"""compose_text. The cases are the JS client's test/fixtures/compose.json,
made by the core, so the three compose a body and map its positions alike."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import compose_text

FIXTURE = os.path.join(os.path.dirname(__file__), '..', '..', 'plaid-client-js', 'test',
                       'fixtures', 'compose.json')

with open(FIXTURE, encoding='utf-8') as f:
    CASES = json.load(f)


@pytest.mark.parametrize('case', CASES, ids=[str(i) for i in range(len(CASES))])
def test_fixture(case):
    text, at = compose_text(case['input'], case.get('cuts'))
    assert text == case['text']
    assert [at(p) for p in range(len(case['input']) + 1)] == case['at']


def test_composed_text_is_itself():
    text, at = compose_text('pʰá')
    assert text == 'pʰá'
    assert at(3) == 3


def test_a_token_edge_inside_a_character_keeps_it_decomposed():
    # morphemes "ka" [0, 2] and the tone [2, 3]
    text, at = compose_text('ka\u0301', [0, 2, 3])
    assert text == 'ka\u0301'
    assert [at(0), at(2), at(3)] == [0, 2, 3]
    whole, at2 = compose_text('ka\u0301')
    assert whole == 'k\u00e1'
    assert at2(2) == at2(3)
