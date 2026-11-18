"""JOIN18 (RL2's join item): split_sentence says what the split does to a
multi-word expression over the sentence's words, by the rule plaid-igt's
split dialog uses (sentenceSplitLoss): hidden when fewer than two of its
words stay in the sentence of its first word, shown in part when fewer than
before, never deleted."""

import pytest

from fixtures import FakeClient
from fixtures_ext import MWE_LINK, mwe_document_raw, mwe_lexicon_raw

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _ws(tokens):
    raw = mwe_document_raw()
    for link in raw['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links']:
        if link['id'] == MWE_LINK:
            link['tokens'] = tokens
    c = FakeClient(documents={'d1': raw}, lexicon=mwe_lexicon_raw())
    return Workspace(c, load_project(c, 'p1'))


@pytest.mark.parametrize('tokens,before,said', [
    # "gam akuna" over w2 and w3: a split between them leaves one word in
    # the sentence of its first word.
    (['w-2', 'w-3'], 3, ' (1 multi-word expression will not be shown until the sentences are merged again)'),
    # Both words go to the new sentence together: still drawn whole.
    (['w-2', 'w-3'], 2, ''),
    # Over w1, w2 and w3: two stay with the first.
    (['w-1', 'w-2', 'w-3'], 3,
     ' (1 multi-word expression will be shown only in part until the sentences are merged again)'),
])
def test_a_split_says_what_it_does_to_a_multi_word_expression(tokens, before, said):
    ws = _ws(tokens)
    call_tool(ws, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': before})
    [op] = [op for op in ws.ops if op['kind'] == 'split_sentence']
    label = op['label']
    if said:
        assert label.endswith(said), label
    else:
        assert 'multi-word' not in label, label
    # Nothing is unlinked: the expression stays.
    assert not [op for op in ws.ops if op['kind'] == 'unlink']
