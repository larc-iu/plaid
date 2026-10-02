"""The Python copies of plaid-igt's ignored-token rule and word splitter
against the app's own.

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
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.igt.project import split_words
from plaid_client.workflows.igt import is_token_ignored

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
]
TEXTS = [
    "Ali-di gam akuna.", "k'a b'ok?", "¿Qué tal? Bien.", "ab`cd ef", "a∅b ∅ c",
    "don't stop", "x--y x", "3.14 is pi", "« bonjour »", "hello  world ", " lead",
    "👍🏽 ok", "a→b c", "na=ka ta", "co-op", "a\tb c", "水。火、土", "𝑥y z",
]


@pytest.fixture(scope='module')
def app(tmp_path_factory):
    node = node_or_skip('the ignored-token mirror')
    path = tmp_path_factory.mktemp('mirror') / 'cases.json'
    path.write_text(json.dumps({'configs': CONFIGS, 'tokens': TOKENS, 'texts': TEXTS}))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_is_token_ignored_answers_as_the_app_does(app):
    for cfg, answers in zip(CONFIGS, app['ignored']):
        for token, expected in zip(TOKENS, answers):
            assert is_token_ignored(token, cfg) == expected, (token, cfg)


def test_split_words_cuts_text_as_the_editor_does(app):
    for cfg, answers in zip(CONFIGS, app['words']):
        for text, expected in zip(TEXTS, answers):
            assert [list(r) for r in split_words(text, 0, len(text), cfg)] == expected, (text, cfg)


def test_the_cases_reach_every_answer(app):
    """A table whose answers are all one way proves nothing about the rule."""
    flat = [a for answers in app['ignored'] for a in answers]
    assert True in flat and False in flat
