"""The igt assistant's text writes follow the project's "Tokenize new text"
(the word layer's ``igt.tokenizeNewText``) as the Baseline tab's save does:
an edit or a new text names the word layer, and the server makes the words of
the text it types (plaid-core's ``tokenize_new_text_test.clj``). None is named
when the project has it off."""
from fixtures import FakeClient, project_raw, fake_ws

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from test_shape import _TextServer


def _client(tokenize=None):
    raw = project_raw()
    if tokenize is not None:
        word = raw['text_layers'][0]['token_layers'][1]
        word['config']['igt']['tokenizeNewText'] = tokenize
    return FakeClient(project=raw)


def _append(new):
    return {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': None, 'begin': 25,
            'end': 25, 'old': '', 'new': new, 'word_ids': [], 'morpheme_ids': [], 'label': ''}


def _run(c, ops):
    server = _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}
    execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))
    return server


def test_the_setting_is_read_off_the_word_layer():
    assert load_project(_client(), 'p1').tokenize_new_text is True
    assert load_project(_client(True), 'p1').tokenize_new_text is True
    assert load_project(_client(False), 'p1').tokenize_new_text is False


def test_an_edit_names_the_word_layer_and_makes_no_words_itself():
    c = _client()
    server = _run(c, [_append(' Gam akuna.')])
    assert server.tokenize_layers == ['tk-word']
    assert not c.payloads('tokens.bulk_create')


def test_an_edit_names_no_layer_when_the_project_has_it_off():
    c = _client(False)
    server = _run(c, [_append(' Gam akuna.')])
    assert c._documents['d1']['text_layers'][0]['text']['body'].endswith('Gam-ar. Gam akuna.')
    assert server.tokenize_layers == [None]


def test_a_new_document_follows_the_setting():
    for tokenize, layer in ((None, 'tk-word'), (False, None)):
        c = _client(tokenize)
        ops = [{'kind': 'create_document', 'name': 'Text 2', 'text': 'Ali gam.\n我今天去北京。\nYes.\n',
                'metadata': {}, 'label': ''}]
        execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))
        [create] = c.payloads('texts.create')
        assert create['kwargs'].get('tokenize_layer') == layer
        # The sentences are made either way, and no word by the assistant.
        [sentences] = c.payloads('tokens.bulk_create')
        assert [t['token_layer_id'] for t in sentences] == ['tk-sent'] * 3


def test_the_cards_count_the_words_about_to_be_made():
    for tokenize, count in ((None, 4), (False, 0)):
        w = fake_ws(_client(tokenize))
        call_tool(w, 'append_text', {'document': 'd1', 'text': 'Gam akuna. 我今天去北京。 Ok.'})
        assert f'({count} words)' in w.ops[0]['label']
        w2 = fake_ws(_client(tokenize))
        out = call_tool(w2, 'create_document', {'name': 'Text 2', 'text': 'Gam akuna. 我今天去北京。 Ok.'})
        assert f'{count} words' in w2.ops[0]['label'] and f'{count} words' in out
