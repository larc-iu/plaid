"""The Python copies of plaid-igt's ignored-token rule, word splitter and
"Tokenize new text" against the app's own.

Word references (``s3.w2``) count words past the tokens the ignored-token rule
leaves out, and the agent cuts new text into words as the editor does. Both
are copies of plaid-igt's JavaScript, and a copy drifts silently: the Python
ones read the zero morph as punctuation and compared whole tokens to the
letter-like list long after the app stopped (R1-DEBT-CORE-2), so a document
holding such a token had every later word reference off by one. This runs the
app's modules over one case table and compares every answer. It skips only
where node cannot run.
"""

import json
import os
import random
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.igt.project import split_words
from plaid_client.workflows.igt.new_words import new_text_words, split_words as client_split_words
from plaid_client.workflows.igt.spaceless_scripts import SPACELESS_SCRIPTS
from plaid_client.workflows.igt import is_token_ignored
from plaid_client.workflows.igt.punctuation_classes import PICTOGRAPHIC, PUNCT_OR_SYMBOL

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'igt_tokens_mirror.mjs')

PUNCT = {'type': 'unicodePunctuation', 'whitelist': []}
CONFIGS = [
    None,
    PUNCT,
    {'type': 'unicodePunctuation', 'whitelist': ["'"]},
    {'type': 'unicodePunctuation', 'whitelist': ["'", '?', '-ab']},
    {'type': 'unicodePunctuation'},
    {'type': 'blacklist', 'blacklist': ['.', '--', 'x']},
    {'type': 'something-else'},
]
TOKENS = [
    '', '.', '...', ',', '?!', "'", "'.", "''", '-', '--', '-ab', 'x', 'ab', "k'a", '∅', '∅.', 'Ø', '0',
    '😀', '👍🏽', '©', '®', '™', '‼', '↔', '⌚', '〰', '〽', '⁉', '→', '=', '+', '$', '€', '§', '¶',
    '«', '»', '¿', '¡', '–', '—', '…', '。', '、', '、。', '٪', '٫', '·', '•', '★', '☆', '♪', '✓',
    'ʼ', '’', '‍', '¨', '^', '`', '~', '|', '\\', '°', '±', '×', '÷',
    # New in Unicode 16, which the app's node has and Python 3.12's
    # unicodedata (15.0) does not (REV-AGENT F2): Garay hyphen, a
    # legacy-computing symbol, a control picture.
    '\U00010d6e', '\U0001cc00', '\u2427', 'ab\U00010d6e',
]
TEXTS = [
    "Ali-di gam akuna.", "k'a b'ok?", "¿Qué tal? Bien.", "ab`cd ef", "a∅b ∅ c",
    "don't stop", "x--y x", "3.14 is pi", "« bonjour »", "hello  world ", " lead",
    "👍🏽 ok", "a→b c", "na=ka ta", "co-op", "a\tb c", "水。火、土", "𝑥y z",
    # Whitespace to JavaScript's \s and not to Python's isspace, and back.
    "a﻿b c", "a\x85b c", "a\x1cb c", "a　b c",
]

# "Tokenize new text": an edit's gaps over a body and the words on it.
NEW_WORDS = [
    {'base': 'uno dos', 'gaps': [{'start': 7, 'end': 7, 'value': '. Tres cuatro, cinco.'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 7}], 'ignored': PUNCT},
    {'base': 'dog', 'gaps': [{'start': 3, 'end': 3, 'value': 's'}], 'words': [], 'ignored': None},
    {'base': 'hen', 'gaps': [{'start': 3, 'end': 3, 'value': 'ry'}], 'words': [{'begin': 0, 'end': 3}],
     'ignored': PUNCT},
    {'base': 'one two', 'gaps': [{'start': 1, 'end': 2, 'value': 'x y'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 7}], 'ignored': PUNCT},
    {'base': '', 'gaps': [{'start': 0, 'end': 0, 'value': '我今天去北京。\nI went home.\nYes.'}], 'words': [],
     'ignored': PUNCT},
    {'base': 'a', 'gaps': [{'start': 1, 'end': 1, 'value': ' 我用 Plaid 写，hello. 我用Plaid写 ภาษาไทย ok'}],
     'words': [{'begin': 0, 'end': 1}], 'ignored': PUNCT},
    {'base': "k'a", 'gaps': [{'start': 3, 'end': 3, 'value': " b'ok ' ... ∅ ★"}], 'words': [{'begin': 0, 'end': 3}],
     'ignored': {'type': 'unicodePunctuation', 'whitelist': ["'"]}},
    {'base': 'x', 'gaps': [{'start': 1, 'end': 1, 'value': ' -- x y.z'}], 'words': [],
     'ignored': {'type': 'blacklist', 'blacklist': ['--', 'x', '.']}},
    {'base': 'ab cd ef', 'gaps': [{'start': 0, 'end': 0, 'value': 'z '}, {'start': 3, 'end': 5, 'value': ''},
                                 {'start': 8, 'end': 8, 'value': ' g﻿h i\x85j'}],
     'words': [{'begin': 0, 'end': 2}, {'begin': 6, 'end': 8}], 'ignored': PUNCT},
    {'base': '𝑥 y', 'gaps': [{'start': 1, 'end': 1, 'value': ' 𝑧𝑧 w'}], 'words': [{'begin': 0, 'end': 1}],
     'ignored': PUNCT},
    # A line pasted over itself with a word added, and a selection typed
    # over: the gaps repeat the old text at their ends (L1-TEXT-2).
    {'base': 'One two three four.', 'gaps': [{'start': 0, 'end': 19, 'value': 'One two and three four.'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 7}, {'begin': 8, 'end': 13}, {'begin': 14, 'end': 18}],
     'ignored': PUNCT},
    {'base': 'One two three four.', 'gaps': [{'start': 4, 'end': 7, 'value': 'two plus'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 7}, {'begin': 8, 'end': 13}, {'begin': 14, 'end': 18}],
     'ignored': PUNCT},
    {'base': 'eta theta', 'gaps': [{'start': 0, 'end': 9, 'value': 'eta new theta'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 9}], 'ignored': PUNCT},
    {'base': 'One two', 'gaps': [{'start': 4, 'end': 7, 'value': 'two'}],
     'words': [{'begin': 0, 'end': 3}, {'begin': 4, 'end': 7}], 'ignored': PUNCT},
    # A sentence boundary between letters, text typed at it (REV-R4-TOK F3).
    {'base': 'Hello.World', 'gaps': [{'start': 6, 'end': 6, 'value': 'x'}], 'words': [], 'ignored': PUNCT,
     'sentences': [{'begin': 0, 'end': 6}, {'begin': 6, 'end': 11}]},
]


def _sentences(rng, base):
    """A partition of ``base`` with boundaries anywhere, between letters too."""
    cuts = sorted({rng.randint(1, len(base) - 1) for _ in range(rng.randint(0, 3))}) if len(base) > 1 else []
    ends = cuts + [len(base)]
    return [{'begin': b, 'end': e} for b, e in zip([0] + cuts, ends)] if base else []


def _random_new_words(seed: int, n: int):
    """Edits over bodies with some of their words tokenized, as a Baseline
    save makes them: inserts, deletes and replacements of letters, spaces,
    punctuation, line breaks, Han, Thai and a letter-like apostrophe."""
    rng = random.Random(seed)
    alphabet = ['a', 'b', 'k', 'o', ' ', ' ', '\n', '.', ',', "'", '-', '水', '火', 'ก', 'า', '∅', ' ']
    configs = [None, PUNCT, {'type': 'unicodePunctuation', 'whitelist': ["'"]},
               {'type': 'blacklist', 'blacklist': ['.', 'ab']}]
    out = []
    for _ in range(n):
        base = ''.join(rng.choice(alphabet) for _ in range(rng.randint(0, 14)))
        cfg = rng.choice(configs)
        words = [{'begin': b, 'end': e} for b, e in split_words(base, 0, len(base), cfg) if rng.random() < 0.7]
        gaps = []
        pos = 0
        for _ in range(rng.randint(1, 3)):
            if pos > len(base):
                break
            start = rng.randint(pos, len(base))
            end = rng.randint(start, min(len(base), start + 3))
            value = ''.join(rng.choice(alphabet) for _ in range(rng.randint(0, 5)))
            gaps.append({'start': start, 'end': end, 'value': value})
            pos = end + 1
        out.append({'base': base, 'gaps': gaps, 'words': words, 'ignored': cfg,
                    'sentences': _sentences(rng, base)})
    return out


def _random_paste_overs(seed: int, n: int):
    """A stretch of the body pasted over by itself with some text put
    inside, as a retyped selection or a corrected line is sent."""
    rng = random.Random(seed)
    alphabet = ['a', 'b', 'k', 'o', ' ', ' ', '\n', '.', ',', "'", '水', 'ก']
    configs = [None, PUNCT, {'type': 'unicodePunctuation', 'whitelist': ["'"]}]
    out = []
    for _ in range(n):
        base = ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 16)))
        cfg = rng.choice(configs)
        words = [{'begin': b, 'end': e} for b, e in split_words(base, 0, len(base), cfg)]
        start = rng.randint(0, len(base))
        end = rng.randint(start, len(base))
        old = base[start:end]
        cut = rng.randint(0, len(old))
        added = ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 6)))
        out.append({'base': base, 'gaps': [{'start': start, 'end': end, 'value': old[:cut] + added + old[cut:]}],
                    'words': words, 'ignored': cfg, 'sentences': _sentences(rng, base)})
    return out


RANDOM_NEW_WORDS = _random_new_words(7, 600) + _random_paste_overs(11, 400)


@pytest.fixture(scope='module')
def app(tmp_path_factory):
    node = node_or_skip('the ignored-token mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps({'configs': CONFIGS, 'tokens': TOKENS, 'texts': TEXTS,
                                'newWords': NEW_WORDS + RANDOM_NEW_WORDS}))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_both_read_the_same_character_table(app):
    """The rule's classes are one generated table, pinned to one Unicode
    version, not the runtime's: node 24.21 (Unicode 17) reads ★ as no
    pictograph where the table, and node 24.1, read it as one."""
    assert [list(r) for r in PUNCT_OR_SYMBOL] == app['tables']['punctOrSymbol']
    assert [list(r) for r in PICTOGRAPHIC] == app['tables']['pictographic']
    assert [list(r) for r in SPACELESS_SCRIPTS] == app['tables']['spaceless']


def test_is_token_ignored_answers_as_the_app_does(app):
    for cfg, answers in zip(CONFIGS, app['ignored']):
        for token, expected in zip(TOKENS, answers):
            assert is_token_ignored(token, cfg) == expected, (token, cfg)


def test_the_word_break_class_is_the_editors_on_every_code_point(app):
    """The splitter's punctuation class is a hand copy of the editor's: it
    once kept two Sharada code points the editor had dropped."""
    from plaid_client.workflows.igt.new_words import is_unicode_punctuation
    out = []
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        if not is_unicode_punctuation(chr(cp)):
            continue
        if out and out[-1][1] == cp - 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    assert out == app['tables']['breaks']


def test_the_agent_splits_with_the_clients_splitter():
    assert split_words is client_split_words


def test_split_words_cuts_text_as_the_editor_does(app):
    for cfg, answers in zip(CONFIGS, app['words']):
        for text, expected in zip(TEXTS, answers):
            assert [list(r) for r in split_words(text, 0, len(text), cfg)] == expected, (text, cfg)


def test_new_text_words_are_the_editors(app):
    """The words "Tokenize new text" gives an edit, the app's and the
    assistant's, on the table and on random edits."""
    for case, expected in zip(NEW_WORDS + RANDOM_NEW_WORDS, app['newWords']):
        got = [list(w) for w in new_text_words(case['base'], case['gaps'], case['words'], case['ignored'],
                                               case.get('sentences') or ())]
        assert got == expected, case


def test_the_new_words_cases_reach_every_answer(app):
    """Some edits get words and some get none, and the table's spaceless,
    letter-like and joining cases answer as the app's own tests say."""
    answers = app['newWords']
    assert sum(1 for a in answers[len(NEW_WORDS):] if a) > 50
    assert sum(1 for a in answers[len(NEW_WORDS):] if not a) > 50
    texts = []
    for case, a in zip(NEW_WORDS, answers):
        body = case['base']
        for g in sorted(case['gaps'], key=lambda g: g['start'], reverse=True):
            body = body[:g['start']] + g['value'] + body[g['end']:]
        texts.append([body[b:e] for b, e in a])
    assert texts[0] == ['Tres', 'cuatro', 'cinco']
    assert texts[1] == ['dogs']
    assert texts[2] == []
    assert texts[4] == ['I', 'went', 'home', 'Yes']
    assert texts[5] == ['Plaid', 'hello', 'ok']
    assert texts[6] == ["b'ok", "'", '∅', '★']
    assert texts[10] == ['and']
    assert texts[11] == ['plus']
    assert texts[12] == ['new']
    assert texts[13] == []
    assert texts[14] == ['x']


def test_the_cases_reach_every_answer(app):
    """A table whose answers are all one way proves nothing about the rule."""
    flat = [a for answers in app['ignored'] for a in answers]
    assert True in flat and False in flat
