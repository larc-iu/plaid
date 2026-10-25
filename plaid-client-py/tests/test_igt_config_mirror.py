"""``plaid_client.workflows.igt.config`` against plaid-igt's igtConfig.js.

The services and the workflows read plaid-igt's own config keys through the
Python readers, and the app through igtConfig.js, so the two must answer the
same for every config. It skips where node or plaid-igt is not beside this
package, and does not skip when the two disagree. The last test keeps every
other Python reader of the namespace out of the client and the services.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from plaid_client.workflows.igt import config

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
    exe = shutil.which('node')
    if not exe or not JS.is_file():
        pytest.skip('node or plaid-igt is not here')
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


def test_nothing_else_in_the_client_or_the_services_reads_the_namespace():
    """One reader per key: an inline ``.get('igt')`` is where defaults drift."""
    inline = re.compile(r"""\.get\(\s*['"]igt['"]|\[\s*['"]igt['"]\s*\]""")
    own = ROOT / 'plaid-client-py' / 'src' / 'plaid_client' / 'workflows' / 'igt' / 'config.py'
    roots = [ROOT / 'plaid-client-py' / 'src'] + [ROOT / app / 'services' for app in
                                                   ('plaid-igt', 'plaid-ud', 'plaid-umr')]
    found = [f'{p.relative_to(ROOT)}:{n}'
             for root in roots for p in sorted(root.rglob('*.py'))
             if p != own and 'tests' not in p.parts
             for n, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1) if inline.search(line)]
    assert not found, found
