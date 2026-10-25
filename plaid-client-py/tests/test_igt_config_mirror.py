"""``plaid_client.workflows.igt.config`` against plaid-igt's igtConfig.js.

The services and the workflows read plaid-igt's own config keys through the
Python readers, and the app through igtConfig.js, so the two must answer the
same for every config. It skips where node, plaid-igt or plaid-igt's
node_modules is not beside this package (mirror_node), and does not skip when
the two disagree. The last two tests keep
every other Python reader of the namespace, and every hand-spelled
orthography key, out of the client, the services and plaid-agent.
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from plaid_client.workflows.igt import config

from mirror_node import IGT_MODULES, node_or_skip

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'igt_config_mirror.mjs')
ROOT = Path(HERE).resolve().parents[1]
JS = ROOT / 'plaid-igt' / 'src' / 'domain' / 'igtConfig.js'

VALUES = [None, '', 0, False, True, 'Word', 'Morpheme', 'gloss', 'pmy', {'gloss': {'role': 'gloss'}}, []]
KEYS = ['scope', 'lang', 'lexiconField', 'tokenizeNewText', 'fields']
CASES = [None, {}, {'igt': None}, {'igt': {}}, {'igt': 0}, {'igt': ''}, {'igt': False},
         {'plaid': {'scope': 'Word'}}, {'igt': {'other': 'x'}}]
CASES += [{'igt': {k: v}} for k in KEYS for v in VALUES]
CASES += [{'igt': {'scope': 'Sentence', 'lang': 'en', 'lexiconField': 'Meaning',
                   'tokenizeNewText': False, 'fields': {'Meaning': {}}}}]


@pytest.fixture(scope='module')
def js(tmp_path_factory):
    exe = node_or_skip(JS, IGT_MODULES)
    cases = tmp_path_factory.mktemp('mirror') / 'cases.json'
    cases.write_text(json.dumps(CASES), encoding='utf-8')
    out = subprocess.run([exe, SCRIPT, str(cases)], capture_output=True, text=True, timeout=60,
                         check=True).stdout
    return json.loads(out)


def test_the_keys_are_the_apps(js):
    assert (config.IGT_NAMESPACE, config.LEXICON_FIELD_KEY, config.TOKENIZE_NEW_TEXT_KEY) == \
        (js['namespace'], js['lexiconFieldKey'], js['tokenizeNewTextKey'])


@pytest.mark.parametrize('name, read', [
    ('scope', config.read_scope), ('fieldLang', config.read_field_lang),
    ('lexiconField', config.read_lexicon_field), ('tokenizeNewText', config.read_tokenize_new_text),
    ('vocabFields', config.read_vocab_fields)])
def test_each_reader_answers_as_the_apps(js, name, read):
    got = [read(c) for c in CASES]
    assert [g == w and type(g) is type(w) for g, w in zip(got, js[name])] == [True] * len(CASES), [
        (c, g, w) for c, g, w in zip(CASES, got, js[name]) if g != w or type(g) is not type(w)]


ORTHOGRAPHY_NAMES = ['IPA', '', 'orthog:x', 'Cyrillic (old)']
ORTHOGRAPHY_KEYS = ['orthog:IPA', 'orthog:', 'Orthog:IPA', 'IPA', '', None, 3]


def test_the_orthography_keys_are_the_apps(js):
    assert [config.orthography_key(n) for n in ORTHOGRAPHY_NAMES] == js['orthographyKey']
    assert [config.is_orthography_key(k) for k in ORTHOGRAPHY_KEYS] == js['isOrthographyKey']
    assert [config.orthography_name(config.orthography_key(n)) for n in ORTHOGRAPHY_NAMES] == \
        js['orthographyName'] == ORTHOGRAPHY_NAMES


def _python_sources():
    own = ROOT / 'plaid-client-py' / 'src' / 'plaid_client' / 'workflows' / 'igt' / 'config.py'
    roots = [ROOT / 'plaid-client-py' / 'src', ROOT / 'plaid-agent' / 'src'] + [
        ROOT / app / 'services' for app in ('plaid-igt', 'plaid-ud', 'plaid-umr')]
    return [p for root in roots for p in sorted(root.rglob('*.py')) if p != own and 'tests' not in p.parts]


def test_nothing_else_spells_the_orthography_key():
    """A word's spelling is stored under orthography_key(name): a key spelled
    by hand is where a typo stores values nothing reads."""
    found = [f'{p.relative_to(ROOT)}:{n}' for p in _python_sources()
             for n, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1) if 'orthog:' in line]
    assert not found, found


def test_nothing_else_in_the_client_the_services_or_the_agent_reads_the_namespace():
    """One reader per key: an inline ``.get('igt')`` is where defaults drift."""
    inline = re.compile(r"""\.get\(\s*['"]igt['"]|\[\s*['"]igt['"]\s*\]""")
    found = [f'{p.relative_to(ROOT)}:{n}' for p in _python_sources()
             for n, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1) if inline.search(line)]
    assert not found, found
