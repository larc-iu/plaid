"""The igt assistant's text writes follow the project's "Tokenize new text"
(the word layer's ``igt.tokenizeNewText``) as the Baseline tab's save does:
the text a plan adds gets the words ``new_words.py`` gives it, none when the
project has it off, and none in a script written without spaces. The rule
itself is checked against the app's in test_igt_tokens_mirror.py."""
from fixtures import FakeClient, project_raw, scan_ws

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


def _words_made(c):
    body = c._documents['d1']['text_layers'][0]['text']['body']
    return [body[t['begin']:t['end']] for b in c.payloads('tokens.bulk_create') for t in b]


def _run(c, ops):
    _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}
    return execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))


def test_the_setting_is_read_off_the_word_layer():
    assert load_project(_client(), 'p1').tokenize_new_text is True
    assert load_project(_client(True), 'p1').tokenize_new_text is True
    assert load_project(_client(False), 'p1').tokenize_new_text is False


def test_an_edit_gets_the_words_of_the_text_it_adds():
    c = _client()
    _run(c, [_append(' Gam akuna.')])
    assert _words_made(c) == ['Gam', 'akuna']


def test_an_edit_gets_no_words_when_the_project_has_it_off():
    c = _client(False)
    _run(c, [_append(' Gam akuna.')])
    assert c._documents['d1']['text_layers'][0]['text']['body'].endswith('Gam-ar. Gam akuna.')
    assert not c.payloads('tokens.bulk_create')


def test_text_in_a_script_without_spaces_gets_no_words():
    c = _client()
    _run(c, [_append(' 我用 Plaid 写，hello. 我用Plaid写 ภาษาไทย ok')])
    assert _words_made(c) == ['Plaid', 'hello', 'ok']


def test_letters_typed_against_a_word_are_left_to_it():
    # "s" typed after the word "gam" joins it on the server, and no word "s"
    # is made beside it.
    c = _client()
    op = {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': 's-1', 'begin': 7,
          'end': 10, 'old': 'gam', 'new': 'gams ok', 'word_ids': [], 'morpheme_ids': [], 'label': ''}
    _run(c, [op])
    assert _words_made(c) == ['ok']


def test_a_planned_word_over_one_the_server_placed_is_left_out():
    # The server here gives the typed text to the word before it, whatever the
    # space: the planned word "ok" would lie over it, and is not sent.
    c = _client()
    server = _TextServer(c)
    edit = server.edit

    def greedy(text_id, edits, audit_message=None, *, base=None, versioned=None):
        out = edit(text_id, edits, audit_message, base=base, versioned=versioned)
        words = c._documents['d1']['text_layers'][0]['token_layers'][1]['tokens']
        last = max(words, key=lambda t: t['end'])
        last['end'] = len(c._documents['d1']['text_layers'][0]['text']['body'])
        return out
    c.texts.edit = greedy
    c.tokens.split = lambda sid, pos, id=None: {'id': id}
    execute_plan(c, [_append(' ok')], source='s', label='l', project=load_project(c, 'p1'))
    assert not c.payloads('tokens.bulk_create')


def test_a_new_document_follows_the_setting():
    for tokenize, words in ((None, ['Ali', 'gam', 'Yes']), (False, [])):
        c = _client(tokenize)
        ops = [{'kind': 'create_document', 'name': 'Text 2', 'text': 'Ali gam.\n我今天去北京。\nYes.\n',
                'metadata': {}, 'label': ''}]
        execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))
        [batch] = [b for b in c.batches if b[0][0] == 'tokens.bulk_create']
        text = 'Ali gam.\n我今天去北京。\nYes.\n'
        made = [text[t['begin']:t['end']] for kind, b in batch for t in b if t['token_layer_id'] == 'tk-word']
        assert made == words
        # The sentences are made either way.
        assert len(batch[0][1]) == 3


def test_the_cards_count_the_words_that_will_be_made():
    for tokenize, count in ((None, 3), (False, 0)):
        w = scan_ws(_client(tokenize))
        call_tool(w, 'append_text', {'document': 'd1', 'text': 'Gam akuna. 我今天去北京。 Ok.'})
        assert f'({count} words)' in w.ops[0]['label']
        w2 = scan_ws(_client(tokenize))
        out = call_tool(w2, 'create_document', {'name': 'Text 2', 'text': 'Gam akuna. 我今天去北京。 Ok.'})
        assert f'{count} words' in w2.ops[0]['label'] and f'{count} words' in out


def test_words_refused_as_outside_every_sentence_leave_the_edit_without_them():
    # REV-R4-TOK F3: the words go in a request of their own after the edit; a
    # refusal of them alone must not fail the plan with the text written.
    from plaid_client import PlaidAPIError
    c = _client()
    _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}

    def refuse(rows, *a, **k):
        raise PlaidAPIError('HTTP 400', status=400,
                            response_data={'error': 'Token is not contained within any parent-layer token'})
    c.tokens.bulk_create = refuse
    execute_plan(c, [_append(' Gam akuna.')], source='s', label='l', project=load_project(c, 'p1'))
    assert c._documents['d1']['text_layers'][0]['text']['body'].endswith('Gam-ar. Gam akuna.')


def test_another_refusal_of_the_words_still_fails_the_plan():
    import pytest
    from plaid_client import PlaidAPIError
    from plaid_agent.igt.plan import PlanError
    c = _client()
    _TextServer(c)
    c.tokens.split = lambda sid, pos, id=None: {'id': id}

    def refuse(rows, *a, **k):
        raise PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Forbidden'})
    c.tokens.bulk_create = refuse
    with pytest.raises((PlanError, PlaidAPIError)):
        execute_plan(c, [_append(' Gam akuna.')], source='s', label='l', project=load_project(c, 'p1'))
