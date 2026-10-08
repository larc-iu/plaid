"""A morpheme's place in its word is its stored precedence, 1 when it stores
none, as plaid-igt reads it (derive.js ``m.precedence ?? 1``). A stored 0 is
kept, so it sorts first, and ``m1`` names the morpheme the grid shows first.
``or 1`` read 0 as 1 and left the order to the server's row order."""

from fixtures import FakeClient, document_raw

from plaid_agent.igt.project import load_project, parse_document
from plaid_client.workflows.igt import derive, precedence


def _zero_first_raw():
    """Word 1 ("Alimon") stores its chain as m-1a at precedence 1 and m-1b at
    precedence 0, in that row order."""
    raw = document_raw()
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for t in tk['tokens']:
                if t['id'] == 'm-1b':
                    t['precedence'] = 0
    return raw


def test_precedence_keeps_zero_and_reads_none_as_one():
    assert [precedence(m) for m in ({'precedence': 0}, {}, {'precedence': None}, {'precedence': 2})] == [0, 1, 1, 2]


def test_the_assistant_puts_a_precedence_zero_morpheme_first():
    client = FakeClient()
    doc = parse_document(_zero_first_raw(), load_project(client, 'p1'))
    first = doc.sentences[0].words[0]
    assert [m.id for m in first.morphemes] == ['m-1b', 'm-1a']


def test_derive_puts_a_precedence_zero_morpheme_first():
    project = load_project(FakeClient(), 'p1')
    raw = _zero_first_raw()
    sentences, _ = derive(raw, project.word_layer_id, project.morpheme_layer_id, project.sentence_layer_id,
                          gloss_field=None)
    first = sentences[0]['words'][0]
    assert [m['id'] for m in first['morphs']] == ['m-1b', 'm-1a']
