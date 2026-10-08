"""A typed form in a rare script that came out garbled is refused, and run_code
can hand the user a file (save_file).

The garbling is GLM's on a Wancho lexicon (2026-10-07): typed out, every Wancho
letter came out as an Egyptian hieroglyph with the same last UTF-8 byte.
"""

import csv
import io

from fixtures import FakeClient, scan_ws
from live import require_sandbox
from test_pdf import Store

from plaid_agent.core.files import Attachment, Attachments, FileKeeper, MAX_SAVED
from plaid_agent.core.garble import Seen, refusal, scripts_of
from plaid_agent.igt.toolkit import call_tool

WANCHO = '\U0001E2C5\U0001E2E6'  # a real form from the lexicon in question
GARBLED = ''.join(chr(ord(c) - 0x1E2C0 + 0x13340) for c in WANCHO)  # as GLM typed it


def _file(name, text):
    a = Attachment({'id': name, 'name': name, 'bytes': len(text), 'lines': text.count('\n') + 1}, lambda i, n: None)
    a._text = text
    return a


def _ws(*files):
    w = scan_ws(FakeClient())
    w.files = Attachments([_file(n, t) for n, t in files])
    w.keeper = FileKeeper(Store(), 'c1')
    return w


def _stage(w, value):
    return call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': value})


# --- the check itself --------------------------------------------------------------

def test_a_script_is_seen_from_an_answer_but_not_from_what_the_call_asked():
    seen = Seen()
    seen.add(f'No entry matches "{GARBLED}".', unless={'form': GARBLED})
    assert seen.scripts == set()
    seen.add(f'{WANCHO}: bamboo', unless={'form': 'bamboo'})
    assert seen.scripts == {'script:Wancho'}


def test_letters_of_the_common_scripts_are_never_in_doubt():
    # Read, they vouch for their scripts (a Han character for every Han one).
    assert scripts_of('Grüße, Ελληνικά, हिन्दी, 漢字') == {
        'script:Latin', 'script:Greek', 'script:Devanagari', 'script:Han'}
    assert refusal({'value': 'हिन्दी'}, Seen()) is None


def test_a_broken_character_is_refused_when_nothing_read_holds_one():
    why = refusal({'value': '��' + WANCHO}, Seen())
    assert why and 'broken character' in why


def test_files_are_read_only_when_a_letter_is_in_doubt():
    asked = []

    def more():
        asked.append(1)
        return [WANCHO]
    assert refusal({'value': 'plain'}, Seen(), more) is None and not asked
    assert refusal({'value': WANCHO}, Seen(), more) is None and asked
    assert 'Egyptian' in refusal({'value': GARBLED}, Seen(), more)


# --- in a plan ---------------------------------------------------------------------
# What is checked is what the model HANDS a plan tool, never the op: an op also
# carries the label and old values a tool read from the project.

def test_a_garbled_form_is_refused():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    why = w.garbled({'value': GARBLED})
    assert why and 'Egyptian' in why and 'copy it in run_code' in why


def test_a_form_from_an_attached_file_is_not_refused():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    assert w.garbled({'value': WANCHO}) is None


def test_a_rare_script_found_nowhere_is_refused():
    assert _ws().garbled({'value': WANCHO})


def test_a_file_the_assistant_made_vouches_for_nothing():
    w = _ws()
    made = _file('mine.csv', WANCHO)
    made.made = True
    w.files.items.append(made)
    assert w.garbled({'value': WANCHO})


def _wancho_doc_ws():
    from fixtures import document_raw
    d = document_raw()
    d['text_layers'][0]['text']['body'] = 'Ali-di ' + WANCHO + '\U0001E2C7 akuna. Gam-ar.'
    d['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
        {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2']})
    return scan_ws(FakeClient(documents={'d1': d}))


def test_a_change_to_a_word_in_a_rare_script_is_staged_when_the_model_typed_none_of_it():
    w = _wancho_doc_ws()
    assert not _stage(w, 'net').startswith('Error')
    assert not call_tool(w, 'replace_in_field',
                         {'field': 'Gloss', 'pattern': 'fish', 'replacement': 'net'}).startswith('Error')


def test_the_turn_refuses_a_garbled_plan_call_before_the_tool_runs(monkeypatch):
    import json
    from test_turn_failures import Script, _call, _kit, _resp
    from plaid_agent.core import agent
    from plaid_agent.core.agent import ModelConfig, run_turn
    w = _ws()
    ran = []

    def tool(ws, name, args):
        ran.append(args)
        return 'Planned.'
    script = Script(_resp(calls=[_call(1, 'plan_a', json.dumps({'value': GARBLED}))]), _resp('Done.'))
    monkeypatch.setattr(agent.litellm, 'completion', script)
    turn = run_turn(ModelConfig(model='fake/m', stream=False), _kit(tool), w, 'system',
                    [{'role': 'user', 'content': 'hi'}])
    assert ran == [] and turn.steps[0].get('failed')


@require_sandbox()
def test_a_form_copied_in_code_from_a_file_is_staged_and_a_typed_one_is_not():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    w.files.items[0].table = lambda: (['form', 'meaning'], [{'form': WANCHO, 'meaning': 'bamboo'}])
    # The file's text is out of reach, so only what the code read can vouch for the form.
    w.files.items[0].text = lambda: ''
    code = '''
row = file_rows("words.csv")[0]
print(plan("set_field", document="Text 1", refs=["s1.w2"], field="Gloss", value=row["form"]))
'''
    out = call_tool(w, 'run_code', {'code': code})
    assert 'Planned' in out, out
    typed = call_tool(w, 'run_code', {'code': f'print(plan("set_field", document="Text 1", refs=["s1.w1"], '
                                              f'field="Gloss", value="{GARBLED}"))'})
    assert 'Egyptian' in typed and len(w.ops) == 1


# --- what a turn starts out able to copy from ----------------------------------------

def test_the_seed_keeps_what_the_user_pasted_and_drops_what_a_call_only_echoed():
    import json
    from plaid_agent.core.garble import seed
    transcript = [
        {'role': 'user', 'content': f'Add {WANCHO} meaning bamboo'},
        {'role': 'assistant', 'content': f'I planned {WANCHO}.', 'tool_calls': [
            {'id': 'x', 'function': {'name': 'read_lexicon', 'arguments': json.dumps({'form': GARBLED})}}]},
        {'role': 'tool', 'tool_call_id': 'x', 'content': f'No entry matches "{GARBLED}".'},
    ]
    seen = Seen()
    seed(seen, 'system', transcript)
    # The arguments arrive escaped (json.dumps), and still hide nothing.
    assert seen.scripts == {'script:Wancho'}


# --- save_file ----------------------------------------------------------------------

@require_sandbox()
def test_code_saves_a_table_on_the_reply_quoted_and_readable_later():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},"bamboo, young"\n'))
    code = '''
rows = [{"form": r["form"], "meaning": r["meaning"]} for r in file_rows("words.csv")]
save_file("words cleaned.csv", rows)
'''
    out = call_tool(w, 'run_code', {'code': code})
    assert 'Saved "words cleaned.csv"' in out, out
    [ref] = w.keeper.refs
    assert ref['made'] is True and ref['name'] == 'words cleaned.csv'
    text = w.files.get('words cleaned.csv').text()
    assert list(csv.reader(io.StringIO(text))) == [['form', 'meaning'], [WANCHO, 'bamboo, young']]
    # The same run's next call reads it like any attachment.
    assert WANCHO in call_tool(w, 'run_code', {'code': 'print(file_rows("words cleaned.csv")[0]["form"])'})
    assert 'save_file(name, content)' in call_tool(w, 'code_help', {})


@require_sandbox()
def test_saving_a_name_again_replaces_the_file():
    w = _ws()
    call_tool(w, 'run_code', {'code': 'save_file("a.txt", "one")'})
    call_tool(w, 'run_code', {'code': 'save_file("a.txt", "two")'})
    assert [r['name'] for r in w.keeper.refs] == ['a.txt']
    assert w.files.get('a.txt').text() == 'two'
    keys = [k for (_, k) in w.keeper.store.client.user_data.store]
    assert len(keys) == 1


@require_sandbox()
def test_what_save_file_refuses():
    w = _ws()
    for code, said in [('save_file("../x.csv", "a")', 'plain name'),
                       ('save_file("x.exe", "a")', 'ends in one of'),
                       ('save_file("x.txt", [1, 2])', 'content is text'),
                       ('save_file("x.csv", [{"a": 1}, [1]])', 'Not a mix'),
                       ('save_file("x.txt", "\\ufffd")', 'broken character')]:
        out = call_tool(w, 'run_code', {'code': code})
        assert said in out, (code, out)
    assert w.keeper.refs == []


def test_one_reply_carries_at_most_a_few_files():
    keeper = FileKeeper(Store(), 'c1')
    files = Attachments([])
    for i in range(MAX_SAVED):
        keeper.save(files, f'f{i}.txt', 'x')
    try:
        keeper.save(files, 'one more.txt', 'x')
    except ValueError as e:
        assert str(MAX_SAVED) in str(e)
    else:
        raise AssertionError('a sixth file was saved')
    keeper.discard()
    assert keeper.refs == []


def test_save_file_refuses_garbled_content():
    from plaid_agent.core.filetools import save_api
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    try:
        save_api(w)['save_file']('entries.csv', f'form,meaning\n{GARBLED},bamboo\n')
    except ValueError as e:
        assert 'Egyptian' in str(e)
    else:
        raise AssertionError('a garbled table was saved')
    assert w.keeper.refs == []


def test_saving_again_under_the_name_it_was_given_replaces_the_file():
    from plaid_agent.core.filetools import save_api
    w = _ws(('words.csv', 'a,b\n1,2\n'))
    save = save_api(w)['save_file']
    assert '"words (2).csv"' in save('words.csv', 'a,b\n3,4\n')
    save('words (2).csv', 'a,b\n5,6\n')
    assert [r['name'] for r in w.keeper.refs] == ['words (2).csv']
    assert sorted(a.name for a in w.files) == ['words (2).csv', 'words.csv']
    assert w.files.get('words (2).csv').text() == 'a,b\n5,6\n'


def test_a_replacement_that_cannot_be_stored_leaves_the_earlier_file():
    keeper = FileKeeper(Store(), 'c1')
    files = Attachments([])
    keeper.save(files, 'a.txt', 'one')
    put = keeper.store.client.user_data.put
    keeper.store.client.user_data.put = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('down'))
    try:
        keeper.save(files, 'a.txt', 'two')
    except RuntimeError:
        pass
    keeper.store.client.user_data.put = put
    assert [a.name for a in files] == ['a.txt'] and files.get('a.txt').text() == 'one'
    assert len(keeper.refs) == 1

