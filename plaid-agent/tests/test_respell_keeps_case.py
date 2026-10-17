"""An any-case respelling keeps the case of what it matched (FX-K, REV9-AGENT).

igt's respell_all ignores case by default and wrote the replacement exactly as
given, so "a" → "ä" respelled "Ali" as "äli", a capital lost at every sentence
start. The replacement now takes each match's capitals as igt's own Respell
screen writes them (plaid-igt src/domain/replacer.js, matchCase): a match that
starts with a capital gives the replacement a capital first letter, a match of
two or more letters all in capitals gives it in capitals, and a find or a
replacement typed with a capital is written as typed. The mirror runs the
app's replacer over the same cases, so the two cannot drift.
"""
import json
import os
import subprocess

import pytest

from live import live_client, seed  # noqa: F401
from fixtures import VOCAB, lexicon_raw
from node_exe import node_or_skip
from rule_plan_model import approve, project
from test_rule_restate_live import _doc

from plaid_agent.core.replace import replacer
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'respell_case_mirror.mjs')

CASES = [
    ('a', 'ä', ['Ali', 'ALI', 'ali', 'tao', 'aA', 'Aa', 'bAn']),
    ('ka', 'ga', ['Kalamang', 'KALAMANG', 'kalamang', 'kaKa', 'kA']),
    ('ts', 'c', ['Tsapa', 'TSAPA', 'tSapa', 'atsa']),
    ('ng', 'ŋ', ['Ngai', 'NGAI', 'ngai', 'Ng', 'NG']),
    ('цу', 'цы', ['Цуз', 'ЦУЗ', 'цуз']),
    ('ka', 'Ga', ['kat', 'KAT']),
    ('Ka', 'ga', ['kat', 'Kat', 'KAT']),
    ('PFV', 'pfv', ['sbj:3.PFV', 'Pfv']),
    ('a', '', ['Ali', 'ALI']),
    ('i', 'ı', ['Iris', 'IRIS']),
    ('ss', 'ß', ['Ssa', 'SSA']),
    ('e', 'é', ['Eke', 'EKE', 'éke']),
    ('a', 'ä', ['A', 'Áli']),
]


def _ours(find, replacement, values):
    apply = replacer(find, replacement, False, False, False, keep_case=True)
    out = []
    for v in values:
        new = apply(v)
        out.append(None if new == v else new)
    return out


def test_an_any_case_respelling_takes_each_matchs_capitals():
    assert _ours('a', 'ä', ['Ali', 'ALI', 'ali', 'bAn']) == ['Äli', 'ÄLI', 'äli', 'bÄn']
    assert _ours('ng', 'ŋ', ['Ngai', 'NGAI']) == ['Ŋai', 'ŊAI']
    # Typed with a capital, it is written as typed.
    assert _ours('ka', 'Ga', ['KAT']) == ['GaT']
    # In a regular expression an escape's letter names no case.
    assert replacer(r'a\b', 'ä', True, False, False, keep_case=True)('ALA') == 'ALÄ'
    # A case-sensitive respelling reaches only what it names.
    assert replacer('a', 'ä', False, False, True, keep_case=True)('Ali') == 'Ali'


def test_the_assistant_respells_as_the_respell_screen_does(tmp_path):
    node = node_or_skip('the Respell screen mirror')
    path = tmp_path / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    theirs = json.loads(run.stdout)
    differ = [(f, r, vs, ours, app) for (f, r, vs), app in zip(CASES, theirs)
              if (ours := _ours(f, r, vs)) != app]
    assert differ == []


WORDS = [('Ali', '', [('Ali', '')]), ('gam', '', [('ga', ''), ('m', '')]), ('ALI', '', [('ALI', '')])]


@pytest.fixture
def doc_a(live_client):
    s = seed(live_client, project(), {'d0': _doc('d0', 'Doc A', WORDS)}, {VOCAB: lexicon_raw()}, name='respell case')
    yield s, Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


def test_the_card_and_approval_keep_the_matched_capitals(live_client, doc_a):
    c, (s, ws) = live_client, doc_a
    out = call_tool(ws, 'respell_all', {'lexicon': True, 'pattern': 'a', 'replacement': 'ä'})
    assert not out.startswith('Error'), out
    assert 'respell "Ali" → "Äli"' in out and 'morpheme form "ALI" → "ÄLI"' in out, out
    assert 'rename entry "Ali" → "Äli"' in out and '"äli"' not in out and '"äLI"' not in out, out
    _p, h, _ = approve(c, s.project_id, ws)
    assert not h.errors, h.errors
    ws = Workspace(c, load_project(c, s.project_id))
    d = ws.doc('Doc A')
    assert d.body == 'Äli gäm ÄLI', d.body
    assert [m.form for st in d.sentences for w in st.words for m in w.morphemes] == ['Äli', 'gä', 'm', 'ÄLI']
    heads = sorted(it['form'] for v in ws.project.vocabs for it in ws.lexicon(v))
    assert 'Äli' in heads and 'äli' not in heads and 'Ali' not in heads, heads
