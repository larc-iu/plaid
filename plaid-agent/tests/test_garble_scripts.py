"""The garbled-script check after H8-AGENT (2026-10-08): what it looks at, what
vouches for what, how the seed pairs answers with calls, made files, and the
tables save_file writes.

Each block names the finding it answers. The rulings: a U+FFFD and every
character above the BMP (letters, marks, digits, symbols, private use,
unassigned) are vouched for by reading one like them, half a character is
refused always, a script is a real Unicode script (Han is one, all its
extensions included), and a file the assistant made vouches for nothing.
"""

import json
import os
import subprocess
import tempfile

import pytest

from fixtures import FakeClient, scan_ws
from live import require_sandbox
from node_exe import node_or_skip
from test_pdf import Store

from plaid_agent.core.files import Attachment, Attachments, FileKeeper
from plaid_agent.core.filetools import _table_text, save_api
from plaid_agent.core.garble import SCRIPTS, Seen, key, refusal, scripts_of, seed
from plaid_agent.igt.toolkit import call_tool

WANCHO = '\U0001E2C5\U0001E2E6'
GARBLED = ''.join(chr(ord(c) - 0x1E2C0 + 0x13340) for c in WANCHO)


def _file(name, text, made=False):
    a = Attachment({'id': name, 'name': name, 'bytes': len(text), 'lines': text.count('\n') + 1,
                    'made': made}, lambda i, n: None)
    a._text = text
    return a


def _ws(*files):
    w = scan_ws(FakeClient())
    w.files = Attachments(list(files))
    w.keeper = FileKeeper(Store(), 'c1')
    return w


def _read(*texts):
    seen = Seen()
    for t in texts:
        seen.add(t)
    return seen


# --- H8-AGENT-1: a U+FFFD is vouched for like a rare letter ------------------------

def test_a_broken_character_the_turn_read_may_be_copied():
    assert refusal({'value': 'ak�na'}, Seen())
    assert refusal({'value': 'ak�na'}, _read('Text 2: ak�na bo.')) is None


def test_a_broken_character_in_the_users_message_or_a_file_vouches():
    seen = Seen()
    seed(seen, 'system', [{'role': 'user', 'content': 'replace � with u'}])
    assert refusal({'pattern': '�', 'replacement': 'u'}, seen) is None
    assert refusal({'value': '�'}, Seen(), lambda: ['word,gloss\nak�na,x\n']) is None


def test_the_refusal_of_a_broken_character_says_nothing_read_holds_one():
    why = refusal({'value': 'ak�na'}, Seen())
    assert 'nothing you have read holds one' in why


def test_a_project_value_with_a_broken_character_is_staged_when_read():
    from test_garble_and_save import _wancho_doc_ws
    w = _wancho_doc_ws()
    w.seen.add('ak�na')  # what a read of the document answered
    out = call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': '�', 'replacement': 'u'})
    assert 'broken character' not in out


# --- H8-AGENT-2: every kind of character above the BMP -----------------------------

@pytest.mark.parametrize('ch,what', [
    ('\U0001E285', 'unassigned, below Toto'),
    ('\U00050000', 'plane 5'),
    ('\U0001E2EC', 'a Wancho tone mark'),
    ('\U0001E2F0', 'a Wancho digit'),
    ('\U0001F145', 'a squared letter'),
    ('\U0001F2C5', 'unassigned in a symbol block'),
    ('\U000F0001', 'private use'),
    ('\U0001FFFE', 'a noncharacter'),
    ('\U0001E5D0', 'Ol Onal, newer than Python 3.12'),
    ('\U00016D43', 'Kirat Rai, newer than Python 3.12'),
])
def test_any_character_above_the_bmp_is_refused_unread_and_taken_read(ch, what):
    assert refusal({'value': ch}, Seen()), what
    assert refusal({'value': ch}, _read(f'x {ch} y')) is None, what


def test_a_mark_or_digit_is_vouched_for_by_its_scripts_letters():
    seen = _read(WANCHO)
    assert refusal({'value': WANCHO + '\U0001E2EC\U0001E2F0'}, seen) is None


def test_an_unassigned_slot_is_not_vouched_for_by_a_script_beside_it():
    assert refusal({'value': '\U0001E285'}, _read(WANCHO))


def test_half_a_character_is_refused_even_when_read():
    why = refusal({'value': 'ab\ud83a'}, _read('ab\ud83a'))
    assert why and 'half of a character' in why and 'U+D83A' in why
    json.dumps(why, ensure_ascii=False).encode('utf-8')  # the message itself can be sent


@pytest.mark.parametrize('emoji', ['\U0001F44D\U0001F3FD', '\U0001F469‍\U0001F4BB', '\U0001F1EE\U0001F1F3',
                                   '\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F'])
def test_emoji_are_never_in_doubt(emoji):
    assert refusal({'value': f'great {emoji}'}, Seen()) is None


# --- H8-AGENT-3: scripts are Unicode's ---------------------------------------------

@pytest.mark.parametrize('read,typed,named', [
    ('\U00010300', '\U00010C00', 'Old Turkic'),           # Old Italic read
    ('\U00010000', '\U00010600', 'Linear A'),             # Linear B read
    ('\U00010B40', '\U00010B60', 'Inscriptional Pahlavi'),  # Parthian read
])
def test_scripts_sharing_a_first_word_are_told_apart(read, typed, named):
    why = refusal({'value': typed}, _read(read))
    assert why and f'the {named} script' in why


def test_han_is_one_script_in_every_plane():
    # Nanchang Gan writes "that" with an Extension B character.
    assert refusal({'value': '\U00020BB6'}, Seen())
    assert refusal({'value': '\U00020BB6'}, _read('漢')) is None
    assert 'Han (Chinese characters)' in refusal({'value': '\U00020BB6'}, Seen())


def test_mathematical_letters_are_refused_unless_read():
    nom = '\U0001D40D\U0001D40E\U0001D40C'
    why = refusal({'value': nom}, Seen())
    assert why and 'Mathematical Alphanumeric Symbols' in why
    assert refusal({'value': nom}, _read(nom)) is None


def test_every_script_the_unicode_data_knows_is_named():
    regex_core = pytest.importorskip('regex._regex_core')
    table = regex_core.PROPERTIES['SCRIPT'][1]
    known = set(table.values()) - {table[n] for n in ('UNKNOWN', 'COMMON', 'INHERITED', 'KATAKANAORHIRAGANA')}
    assert {table[n.replace('_', '').upper()] for n in SCRIPTS} == known
    assert key('\U0001E2C5') == 'script:Wancho' and key('a') is None and key('é') == 'script:Latin'


# --- H8-AGENT-4: the seed pairs an answer with its own turn's call -----------------

def _turn(call_id, name, args, answer):
    return [{'role': 'assistant', 'content': '',
             'tool_calls': [{'id': call_id, 'function': {'name': name, 'arguments': json.dumps(args)}}]},
            {'role': 'tool', 'tool_call_id': call_id, 'content': answer}]


def test_an_id_used_again_in_a_later_turn_does_not_erase_an_earlier_answer():
    transcript = ([{'role': 'user', 'content': 'read it'}]
                  + _turn('call_0', 'read_document', {'document': 'Text 1'}, f'{WANCHO} akuna.')
                  + [{'role': 'user', 'content': 'search it'}]
                  + _turn('call_0', 'search', {'form': WANCHO}, '1 hit'))
    seen = Seen()
    seed(seen, 'system', transcript)
    assert 'script:Wancho' in seen.scripts


def test_calls_without_ids_are_paired_by_place():
    transcript = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'function': {'name': 'search', 'arguments': json.dumps({'form': GARBLED})}},
        {'function': {'name': 'read_document', 'arguments': '{}'}}]},
        {'role': 'tool', 'content': f'No entry matches "{GARBLED}".'},
        {'role': 'tool', 'content': f'{WANCHO} akuna.'}]
    seen = Seen()
    seed(seen, 'system', transcript)
    assert seen.scripts == {'script:Wancho'}


def test_ids_repeated_in_one_message_are_paired_by_place():
    transcript = [{'role': 'assistant', 'content': '', 'tool_calls': [
        {'id': 'x', 'function': {'name': 'search', 'arguments': json.dumps({'form': GARBLED})}},
        {'id': 'x', 'function': {'name': 'read_document', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'x', 'content': f'No entry matches "{GARBLED}".'},
        {'role': 'tool', 'tool_call_id': 'x', 'content': f'{WANCHO} akuna.'}]
    seen = Seen()
    seed(seen, 'system', transcript)
    assert seen.scripts == {'script:Wancho'}


# --- H8-AGENT-5: a made file vouches for nothing, on every path --------------------

def test_the_seed_skips_an_earlier_read_of_a_made_file():
    from plaid_agent.core.filetools import vouches
    w = _ws(_file('mine.csv', f'form\n{WANCHO}\n', made=True), _file('theirs.csv', 'form\nx\n'))
    transcript = _turn('a', 'read_file', {'name': 'mine.csv'}, f'1: form\n2: {WANCHO}')
    seen = Seen()
    seed(seen, 'system', transcript, lambda tool, args: vouches(w, tool, args))
    assert seen.scripts == set()
    seed(seen, 'system', _turn('b', 'read_file', {'name': 'theirs.csv'}, f'2: {WANCHO}'),
         lambda tool, args: vouches(w, tool, args))
    assert 'script:Wancho' in seen.scripts


def test_the_turn_takes_nothing_from_reading_a_made_file(monkeypatch):
    from test_turn_failures import Script, _call, _kit, _resp
    from plaid_agent.core import agent
    from plaid_agent.core.agent import ModelConfig, run_turn
    w = _ws(_file('mine.csv', f'form\n{WANCHO}\n', made=True))

    def tool(ws, name, args):
        return f'1: form\n2: {WANCHO}' if name == 'read_file' else 'Planned.'
    script = Script(_resp(calls=[_call(1, 'read_file', json.dumps({'name': 'mine.csv'}))]), _resp('Done.'))
    monkeypatch.setattr(agent.litellm, 'completion', script)
    run_turn(ModelConfig(model='fake/m', stream=False), _kit(tool), w, 'system', [{'role': 'user', 'content': 'hi'}])
    assert w.seen.scripts == set()


@require_sandbox()
def test_code_reading_a_made_file_vouches_for_nothing_even_printed():
    w = _ws(_file('mine.csv', f'form\n{WANCHO}\n', made=True))
    w.files.items[0].table = lambda: (['form'], [{'form': WANCHO}])
    code = '''
r = file_rows("mine.csv")[0]
print(r["form"], file_text("mine.csv"), files())
print(plan("set_field", document="Text 1", refs=["s1.w2"], field="Gloss", value=r["form"]))
'''
    out = call_tool(w, 'run_code', {'code': code})
    assert 'Wancho' in out and not w.ops, out
    assert 'script:Wancho' not in w.seen.scripts
    out = call_tool(w, 'run_code', {'code': 'print(plan("set_field", document="Text 1", refs=["s1.w2"], '
                                            f'field="Gloss", value="{WANCHO}"))'})
    assert 'Wancho' in out and not w.ops, out


def test_the_refusal_says_a_saved_file_is_no_source():
    # The model that copied a value from its own file is told where to copy from.
    w = _ws(_file('mine.csv', f'form\n{WANCHO}\n', made=True))
    assert 'never of one you saved' in w.garbled({'value': WANCHO})


@pytest.mark.parametrize('name', ['x.json', 'x.txt'])
def test_save_file_checks_what_escaped_text_decodes_to(name):
    w = _ws()
    escaped = json.dumps([{'form': GARBLED}])  # ASCII: every letter an escape
    assert escaped.isascii()
    with pytest.raises(ValueError, match='Egyptian'):
        save_api(w)['save_file'](name, escaped)
    with pytest.raises(ValueError, match='half of a character'):
        save_api(w)['save_file'](name, '["ab\\ud83a"]')
    assert w.keeper.refs == []


def test_save_file_takes_escaped_text_of_what_the_turn_read():
    w = _ws(_file('words.csv', f'form\n{WANCHO}\n'))
    assert 'Saved' in save_api(w)['save_file']('x.json', json.dumps([WANCHO]))


# --- H8-AGENT-6: a table save_file writes reads back the same in Bulk Add ----------

TABLES = [
    ('tab in a cell', [{'form': 'kha', 'meaning': 'eat', 'note': 'see\tbelow'}, {'form': 'ahi', 'meaning': 'go'}]),
    ('semicolon senses', [{'form': 'kha', 'meaning': 'eat; drink; consume; take; have'},
                          {'form': 'ahi', 'meaning': 'go; walk; leave'}]),
    ('quoted newline', [{'form': 'kha', 'meaning': 'eat\nalso drink', 'note': 'a "quote", here'}]),
    ('one column, commas', [{'meaning': 'eat, drink'}, {'meaning': 'go, walk'}]),
    ('one column, semicolons', [{'meaning': 'eat; drink'}, {'meaning': 'go; walk; run'}]),
    ('one column, a tab', [{'meaning': 'eat\tdrink'}, {'meaning': 'go'}]),
    ('formula-looking cells', [{'form': '-ka', 'gloss': '=PL', 'n': '+3', 'x': '@foo'}]),
    ('lists', [['form', 'gloss'], ['a;b;c;d', 'x'], ['e', 'f\tg']]),
]


def _expected(rows):
    if all(isinstance(r, dict) for r in rows):
        cols = []
        for r in rows:
            cols += [k for k in r if k not in cols]
        return [cols] + [[str(r.get(c, '')) for c in cols] for r in rows]
    return [[str(v) for v in r] for r in rows]


def test_every_table_reads_back_in_bulk_add_as_it_was_saved():
    node = node_or_skip("The Bulk Add mirror runs plaid-igt's table reader with it.")
    here = os.path.dirname(os.path.abspath(__file__))
    cases = []
    for what, rows in TABLES:
        for suffix in ('.csv', '.tsv'):
            name = 't' + suffix
            text = _table_text(name, rows)
            # Dropped in as the file, and pasted into the dialog as text.
            for given in (name, None):
                cases.append((what, suffix, given, text, _expected(rows)))
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as fh:
        json.dump([{'text': c[3], 'name': c[2]} for c in cases], fh)
    try:
        run = subprocess.run([node, os.path.join(here, 'bulk_add_mirror.mjs'), fh.name],
                             capture_output=True, text=True, timeout=120)
    finally:
        os.unlink(fh.name)
    assert run.returncode == 0, run.stderr
    for (what, suffix, given, text, want), got in zip(cases, json.loads(run.stdout)):
        assert got['rows'] == want, (what, suffix, given, text, got)
        # A .tsv is read as one and a .csv as one, by name or from the text. A
        # table of one column has no separator to read.
        assert len(want[0]) == 1 or got['delimiter'] == ('\t' if suffix == '.tsv' else ','), \
            (what, suffix, given, got['delimiter'])


def test_a_csv_stays_a_csv_whatever_its_cells_hold():
    w = _ws()
    save = save_api(w)['save_file']
    out = save('entries.csv', TABLES[1][1])
    assert '"entries.csv"' in out and 'tab-separated' not in out
    assert w.keeper.refs[0]['name'] == 'entries.csv'
    text = w.files.get('entries.csv').text()
    assert text == 'form,meaning\nkha,"eat; drink; consume; take; have"\nahi,"go; walk; leave"\n'
    save('entries.csv', TABLES[0][1])
    assert '\t' in w.files.get('entries.csv').text()
    assert [r['name'] for r in w.keeper.refs] == ['entries.csv']


def test_cells_are_written_exactly_as_given():
    assert _table_text('t.csv', TABLES[6][1]) == 'form,gloss,n,x\n-ka,=PL,+3,@foo\n'


# --- H8-AGENT-7: a failed save leaves nothing in the store -------------------------

def test_a_save_that_fails_partway_removes_the_parts_it_wrote():
    keeper = FileKeeper(Store(), 'c1', budget=40)
    files = Attachments([])
    keeper.save(files, 'a.txt', 'one')
    user_data = keeper.store.client.user_data
    put, puts = user_data.put, []

    def failing(*a, **k):
        puts.append(1)
        if len(puts) == 3:
            raise RuntimeError('down')
        return put(*a, **k)
    user_data.put = failing
    with pytest.raises(RuntimeError):
        keeper.save(files, 'a.txt', 'x' * 400)
    user_data.put = put
    assert [r['name'] for r in keeper.refs] == ['a.txt'] and files.get('a.txt').text() == 'one'
    assert len(user_data.store) == 1


# --- polish ------------------------------------------------------------------------

def test_one_line_is_one_line_and_a_name_keeps_no_control_characters():
    w = _ws()
    save = save_api(w)['save_file']
    assert '(1 line)' in save('a.txt', 'x')
    assert '"ab.csv"' in save('a\x00b.csv', 'x')
    assert '"avsc.txt"' in save('a‮vsc.txt', 'x')
