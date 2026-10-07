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
    assert seen.scripts == {'WANCHO'}


def test_letters_of_the_common_scripts_are_never_in_doubt():
    assert scripts_of('Grüße, Ελληνικά, हिन्दी, 漢字') == set()
    assert refusal({'value': 'हिन्दी'}, Seen()) is None


def test_a_broken_character_is_refused_whatever_was_seen():
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


# --- in a plan ----------------------------------------------------------------------

def test_a_garbled_form_is_not_staged():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    out = _stage(w, GARBLED)
    assert out.startswith('Error') and 'Egyptian' in out and 'copy it in run_code' in out
    assert w.ops == []


def test_a_form_from_an_attached_file_is_staged():
    w = _ws(('words.csv', f'form,meaning\n{WANCHO},bamboo\n'))
    assert not _stage(w, WANCHO).startswith('Error')
    assert len(w.ops) == 1


def test_a_rare_script_found_nowhere_is_refused():
    w = _ws()
    assert _stage(w, WANCHO).startswith('Error') and w.ops == []


@require_sandbox()
def test_a_form_copied_in_code_from_a_file_is_staged():
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
    assert len(w.ops) == 1


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
