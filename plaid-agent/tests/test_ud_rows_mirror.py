"""The ud assistant numbers a sentence's words as the app's grid does.

A surface token another app made after the last UD open has no UD word, and
plaid-ud's ``buildSentenceRows`` (sentenceRows.js) shows it as one stand-in
word with no annotation, numbered in its place, in the grid, a reader's view
and the export. The assistant's reader (``ud/project.py`` ``parse_document``)
must show the same words under the same CoNLL-U ids, or a plan row titled
"word 2" points at what the grid calls word 3. This runs the app's own row
builder (``ud_rows_mirror.mjs``) over fixture documents with random syntactic
words taken away and compares, word by word.

Every write naming a stand-in is refused, as the app's grid refuses it.
"""

import copy
import json
import os
import random
import subprocess
import tempfile

import pytest

from plaid_agent.ud.project import load_project, parse_document
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from test_enhanced_mirror import _camel, _node
from ud_fixtures import PID, WORD_LAYER, document_raw, project_raw, ud_client

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'ud_rows_mirror.mjs')
CASES = 40


def bare(raw: dict, gone_ids) -> dict:
    """``raw`` with the syntactic words ``gone_ids`` taken away, with every
    span on them and every relation touching those spans, as a word another
    app made after the last UD open stands."""
    raw = copy.deepcopy(raw)
    gone = set(gone_ids)
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            if tk['id'] != WORD_LAYER:
                continue
            tk['tokens'] = [t for t in tk['tokens'] if t['id'] not in gone]
            spans = set()
            for sl in tk.get('span_layers') or []:
                spans |= {sp['id'] for sp in sl.get('spans') or [] if set(sp['tokens']) & gone}
                sl['spans'] = [sp for sp in sl.get('spans') or [] if sp['id'] not in spans]
            for sl in tk.get('span_layers') or []:
                for rl in sl.get('relation_layers') or []:
                    rl['relations'] = [r for r in rl.get('relations') or []
                                       if r['source'] not in spans and r['target'] not in spans]
    return raw


def _word_ids(raw):
    layer = next(tk for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == WORD_LAYER)
    return [t['id'] for t in layer['tokens']]


def _cases():
    r = random.Random(7)
    base = document_raw()
    ids = _word_ids(base)
    out = [bare(base, ids), bare(base, ['uw-2a', 'uw-2b']), bare(base, ['uw-2b']), bare(base, ['uw-1', 'uw-5'])]
    while len(out) < CASES:
        out.append(bare(base, [i for i in ids if r.random() < 0.4]))
    return out


def _python_rows(raw):
    p = load_project(ud_client(), PID)
    doc = parse_document(raw, p)
    return [{'id': s.id, 'words': [[w.index, w.id, w.form, w.virtual] for w in s.words]}
            for s in doc.sentences if s.words]


@pytest.fixture(scope='module')
def compared():
    node = _node()
    raws = _cases()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'cases.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump([_camel(raw) for raw in raws], fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f'plaid-ud\'s domain modules would not run:\n{run.stderr[:2000]}')
    return raws, json.loads(run.stdout)


def test_the_cases_reach_partly_and_wholly_bare_sentences(compared):
    raws, js = compared
    py = [_python_rows(raw) for raw in raws]
    flags = [[w[3] for s in rows for w in s['words']] for rows in py]
    assert sum(all(f) for f in flags if f) >= 1
    assert sum(any(f) and not all(f) for f in flags) > CASES // 3


def test_the_assistant_numbers_every_word_as_the_grid_does(compared):
    raws, js = compared
    for raw, rows in zip(raws, js):
        assert _python_rows(raw) == rows


def test_a_write_naming_a_stand_in_is_refused():
    client = ud_client(documents={'ud1': bare(document_raw(), ['uw-3'])})
    ws = Workspace(client, load_project(client, PID))
    out = call_tool(ws, 'read_document', {'document': 'Viaje'})
    assert '\tmar\t' in out
    refusal = 'has no UD word yet'
    for name, args in (('set_field', {'refs': ['s1.w4'], 'field': 'lemma', 'value': 'mar'}),
                       ('set_feature', {'refs': ['s1.w4'], 'feature': 'Number', 'value': 'Sing'}),
                       ('set_head', {'ref': 's1.w4', 'head': 1, 'deprel': 'obl'}),
                       ('set_head', {'ref': 's1.w5', 'head': 4, 'deprel': 'punct'}),
                       ('del_relation', {'refs': ['s1.w4']}),
                       ('confirm', {'refs': ['s1.w4']}),
                       ('set_words', {'ref': 's1.w4', 'forms': ['ma', 'r']})):
        got = call_tool(ws, name, {'document': 'Viaje', **args})
        assert refusal in got and 'open the document in the app' in got, (name, got)
    assert ws.ops == []
