"""Documents by name in number order, the way every app lists them
(plaid-ui domain/collation.js ``compareNames``): a run of digits counts as its
number, so "(2)" comes before "(10)" whatever shape the numbering takes."""

import json
import os
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.core.tools import _by_name, name_key

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'name_order_mirror.mjs')

#: The owner's shapes, unnumbered names, case, a right-to-left name, other
#: scripts' digits and a blank. Names whose order hangs on one mark against
#: another ("10_x" against "10. Ten") are left out: the apps order marks by the
#: locale, this by code point.
NAMES = ['(10) Frog story', '(2) Pear', '(1) Intro', '10. Ten', '2. Two', '1. One', 'Text 10', 'text 2',
         'Text 1', 'Text', 'text', '12', '02', '2', 'Zebra', 'apple', 'Banana', '', 'קובץ 10', 'קובץ 2',
         'نص ١٠', 'نص ٢']


def _sorted(names):
    return sorted(names, key=name_key)


def test_numbered_prefixes_in_number_order():
    assert _sorted(['(10) Frog story', '(2) Pear', '(1) Intro']) == ['(1) Intro', '(2) Pear', '(10) Frog story']
    assert _sorted(['10. Ten', '2. Two', '1. One']) == ['1. One', '2. Two', '10. Ten']
    assert _sorted(['Text 10', 'Text 2', 'text 3']) == ['Text 2', 'text 3', 'Text 10']
    assert _sorted(['10_x', '02_x', '1_x']) == ['1_x', '02_x', '10_x']


def test_ties_fall_to_the_names_and_a_blank_is_first():
    assert _sorted(['2_x', '02_x']) == ['02_x', '2_x']
    assert _sorted(['text', 'Text']) == ['Text', 'text']
    assert _sorted(['b', '', 'A']) == ['', 'A', 'b']
    assert name_key(None) == name_key('')


def test_other_scripts_count_their_digits():
    assert _sorted(['קובץ 10', 'קובץ 2']) == ['קובץ 2', 'קובץ 10']
    assert _sorted(['نص ١٠', 'نص ٢']) == ['نص ٢', 'نص ١٠']


def test_list_documents_pages_in_that_order():
    docs = [{'id': f'd{i}', 'name': n} for i, n in enumerate(['(10) c', '(2) b', None, '(1) a'])]
    assert [d['name'] for d in _by_name(docs)] == [None, '(1) a', '(2) b', '(10) c']


def test_the_apps_order_the_same_names_the_same_way(tmp_path):
    node = node_or_skip('the name order mirror')
    path = tmp_path / 'names.json'
    path.write_text(json.dumps(NAMES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    assert _sorted(NAMES) == json.loads(run.stdout)
