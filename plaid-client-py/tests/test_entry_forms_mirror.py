"""``plaid_client.workflows.igt.entry_forms`` against the JS client's rule.

Lexicon entry forms are stored without affix or clitic markers, and both
clients' writers store what the rule returns, so the two copies must agree on
every form. It skips where node or the JS client is not beside this package,
and does not skip when the two disagree.
"""

import json
import os
import shutil
import subprocess

import pytest

from plaid_client.workflows.igt.entry_forms import (
    MORPH_TYPES, decorate_with_affix_markers, entry_form)

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'entry_forms_mirror.mjs')
JS = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-client-js', 'src', 'entryForms.js'))

TYPES = [None, '', 'Suffix', 'Martian', 3, *MORPH_TYPES]
FORMS = ['s', '-s', 's-', '-s-', '=ni', 'ni=', '=ni=', '*kwa', '~H~', '-', '=', '--', '-=', 'a-b',
         '=a-', '-a=', '\n-s', '-s\n', '-𝑥', '𝑥', 'ka- ', '', None, '--s', 'ʔ-']
CASES = [[t, f] for t in TYPES for f in FORMS]


@pytest.fixture(scope='module')
def js(tmp_path_factory):
    exe = shutil.which('node')
    if not exe or not os.path.isfile(JS):
        pytest.skip('node or plaid-client-js is not here')
    cases = tmp_path_factory.mktemp('mirror') / 'cases.json'
    cases.write_text(json.dumps(CASES), encoding='utf-8')
    out = subprocess.run([exe, SCRIPT, str(cases)], capture_output=True, text=True, timeout=60,
                         check=True).stdout
    return json.loads(out)


def test_the_morph_types_are_the_js_clients(js):
    assert list(MORPH_TYPES) == js['types']


def test_an_entry_form_is_stored_as_the_js_client_stores_it(js):
    got = [entry_form(t, f) for t, f in CASES]
    assert [g == w for g, w in zip(got, js['entry'])] == [True] * len(CASES), [
        (c, g, w) for c, g, w in zip(CASES, got, js['entry']) if g != w]


def test_a_form_is_decorated_as_the_js_client_decorates_it(js):
    assert [decorate_with_affix_markers(t, f) for t, f in CASES] == js['decorated']


def test_the_rule():
    assert entry_form('suffix', '-s') == {'form': 's', 'morphType': 'suffix'}
    assert entry_form(None, 'ni=') == {'form': 'ni', 'morphType': 'proclitic'}
    assert entry_form('stem', '-s') == {'form': 's', 'morphType': 'suffix'}
    assert entry_form('bound root', '*pa') == {'form': 'pa', 'morphType': 'bound root'}
    assert entry_form(None, '*kwa') == {'form': '*kwa', 'morphType': None}
    assert entry_form('stem', 'perro') == {'form': 'perro', 'morphType': 'stem'}
