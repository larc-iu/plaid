"""The assistant's respell refuses what igt's Respell box refuses (REV-HFT-3).

igt's F2 box and Bulk Edit's Respell words refuse a spelling with a space or
a line break (the word would hold a space), one that starts with a combining
mark (the mark lands on the letter before the word, outside it), and one the
project's ignored-tokens rule reads as no word (the word and its analysis
leave the grid). respell and respell_all refused only an empty spelling. They
now give the same three refusals, each saying what to do instead, and stage
nothing.
"""
import pytest

from live import live_client, seed  # noqa: F401
from fixtures import VOCAB, lexicon_raw
from rule_plan_model import project
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.queries import respell_refusal
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

RULE = {'type': 'unicodePunctuation', 'whitelist': []}


def test_the_three_refusals_and_what_passes():
    assert 'split_word' in respell_refusal('b o', RULE)
    assert 'split_word' in respell_refusal('b\no', RULE)
    # REV-HFT-R2-4: U+FEFF is whitespace to the page (JS \\s), so it is here.
    assert 'split_word' in respell_refusal('b\ufeffo', RULE)
    assert 'split_word' in respell_refusal('\ufeffbo', RULE)
    assert 'combining mark' in respell_refusal('̀KALA', RULE)
    assert 'ignored token' in respell_refusal('—', RULE)
    assert 'ignored token' in respell_refusal('...', RULE)
    assert respell_refusal('kàla', RULE) is None
    # A character the project lists as a letter makes a word.
    assert respell_refusal("'", {'type': 'unicodePunctuation', 'whitelist': ["'"]}) is None
    # Under a list of ignored words, only a listed word is refused.
    listed = {'type': 'blacklist', 'blacklist': ['uh']}
    assert 'ignored token' in respell_refusal('uh', listed)
    assert respell_refusal('—', listed) is None


WORDS = [('kala', '', [('kala', '')]), ('bo', '', [('bo', '')])]


@pytest.fixture
def doc_a(live_client):
    s = seed(live_client, project(), {'d0': _doc('d0', 'Doc A', WORDS)}, {VOCAB: lexicon_raw()},
             name='respell refusals')
    yield s, Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


@pytest.mark.parametrize('typed,says', [('b o', 'split_word'), ('̀bo', 'combining mark'),
                                        ('—', 'ignored token'),
                                        # REV-HFT-R2-4: as on the page, a space at an end is
                                        # refused, not taken off.
                                        (' bo2', 'split_word'), ('bo2\n', 'split_word')])
def test_respell_refuses_and_stages_nothing(doc_a, typed, says):
    _s, ws = doc_a
    out = call_tool(ws, 'respell', {'document': 'Doc A', 'ref': 's1.w2', 'new_text': typed})
    assert out.startswith('Error') and says in out, out
    assert ws.ops == []


@pytest.mark.parametrize('replacement,says', [('b o', 'split_word'), ('̀bo', 'combining mark'),
                                              ('—', 'ignored token')])
def test_respell_all_refuses_and_stages_nothing(doc_a, replacement, says):
    _s, ws = doc_a
    out = call_tool(ws, 'respell_all', {'pattern': 'bo', 'replacement': replacement, 'whole': True})
    assert out.startswith('Error') and says in out, out
    assert ws.ops == []
