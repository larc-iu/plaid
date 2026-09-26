"""The ud assistant's sentence split and enhanced graph against plaid-ud's own,
over randomized documents.

Three rules live in plaid-ud's JavaScript and have a Python copy here:

- the enhanced graph a document states: the tree, less what is suppressed,
  plus the extra edges (``ud/project.py`` ``_read_enhanced`` against
  ``enhancedGraph.js`` as the CoNLL-U export reads it),
- the suppressor lying over a basic relation, which a write that moves or
  deletes that relation takes with it (``Word.suppressor_id``, swept by
  ``ud/plan.py`` ``_suppressors``, against ``suppressorFor``),
- what a sentence split sends: the cut and every relation of either layer it
  would leave spanning two sentences, and what a merge sends
  (``ud/sentences.py`` against ``ConlluDocument.toggleSentenceBoundary``).

Each split fix so far landed on the Python side after the JavaScript side
already had the rule, and the agent's own tests passed throughout, because a
fixture written against the old rule is consistent with itself. So this runs
both implementations over the same documents and compares what they answer.
It skips where it cannot run (no node, or plaid-ud not installed beside the
agent). It does not skip when they disagree.
"""

import copy
import json
import os
import random
import shutil
import subprocess
import tempfile

from live import _skip_or_fail

import pytest

from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import deps_of, load_project
from plaid_agent.ud.sentences import t_merge_sentences, t_split_sentence
from plaid_agent.ud.tools import Workspace
from ud_fixtures import (DEPREL, ENHANCED, FEATS, FORM, LEMMA, PID, SENT_LAYER, TEXT_ID,
                         TEXT_LAYER, TOK_LAYER, UPOS, WORD_LAYER, XPOS, FakeClient, project_raw)

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'enhanced_mirror.mjs')
UD = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-ud'))
CASES = 150
NAME = 'Mirror'

# Labels with the characters DEPS sorting and splitting turn on: a subtype
# colon, a pipe inside a label, a letter outside ASCII.
LABELS = ['nsubj', 'obj', 'obl', 'conj:and', 'obl:in:loc', 'obl|x', 'nmod', 'é']


def _node():
    """The node to run plaid-ud with, or None to skip. Its domain modules are
    ESM and reach @larc-iu/plaid-client through plaid-ud's own node_modules."""
    exe = shutil.which('node')
    if not exe or not os.path.isdir(os.path.join(UD, 'node_modules')):
        return None
    try:
        v = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=30).stdout
        return exe if int(v.strip().lstrip('v').split('.')[0]) >= 18 else None
    except Exception:  # noqa: BLE001 - any trouble asking means do not rely on it
        return None


def _case(seed: int) -> dict:
    """One document in the live API's shape: one to three sentences, some
    multi-word tokens, a tree with gaps in it, and an enhanced layer holding
    extra edges, suppressors, a suppressor over no basic relation, and a
    valueless row that is no suppressor."""
    r = random.Random(seed)
    body = ''
    sentences, tokens, words = [], [], []
    lemma_spans, form_spans, basic, rows = [], [], [], []
    n = 0

    def nid(prefix):
        nonlocal n
        n += 1
        return f'{prefix}{n}'

    for _ in range(r.randint(1, 3)):
        start = len(body)
        sent_words = []
        for _ in range(r.randint(1, 5)):
            surface = r.choice(['ab', 'cde', 'f', 'gh'])
            begin, end = len(body), len(body) + len(surface)
            body += surface + ' '
            tokens.append({'id': nid('t'), 'begin': begin, 'end': end})
            parts = r.choice([1, 1, 1, 1, 2, 3])
            for p in range(parts):
                w = {'id': nid('w'), 'begin': begin, 'end': end, 'precedence': p + 1}
                words.append(w)
                if parts > 1:
                    form_spans.append({'id': nid('f'), 'value': f'{surface}{p}', 'tokens': [w['id']]})
                if r.random() < 0.9:
                    lemma = {'id': nid('l'), 'value': surface, 'tokens': [w['id']]}
                    lemma_spans.append(lemma)
                    sent_words.append(lemma['id'])
        # Gap-free: a sentence runs to where the next one's first word begins.
        sentences.append({'id': nid('s'), 'begin': start, 'end': len(body)})
        # One head a word, within the sentence, the root a self-relation.
        for target in sent_words:
            if r.random() < 0.2:
                continue
            source = target if r.random() < 0.2 else r.choice(sent_words)
            basic.append({'id': nid('r'), 'source': source, 'target': target,
                          'value': r.choice(LABELS + [''] if r.random() < 0.1 else LABELS)})
        if r.random() < 0.35 or not sent_words:
            continue
        pairs = set()
        for rel in basic:
            if rel['target'] in sent_words and r.random() < 0.35:
                rows.append({'id': nid('e'), 'source': rel['source'], 'target': rel['target'],
                             'value': None, 'metadata': {'suppress': True}})
                pairs.add((rel['source'], rel['target']))
        if r.random() < 0.2:
            # A suppressor over a pair with no basic relation: dangling.
            pair = (r.choice(sent_words), r.choice(sent_words))
            if pair not in pairs and not any((b['source'], b['target']) == pair for b in basic):
                rows.append({'id': nid('e'), 'source': pair[0], 'target': pair[1],
                             'value': None, 'metadata': {'suppress': True}})
        for _ in range(r.randint(0, 3)):
            target = r.choice(sent_words)
            source = target if r.random() < 0.15 else r.choice(sent_words)
            value = r.choice(LABELS)
            if r.random() < 0.08:
                value = r.choice(['', None])
            rows.append({'id': nid('e'), 'source': source, 'target': target, 'value': value})
    body = body.rstrip(' ') + ' '
    sentences[-1]['end'] = len(body)

    raw = {
        'id': 'mirror-doc', 'name': NAME, 'version': 1, 'metadata': {},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': body},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': sentences, 'span_layers': []},
                {'id': TOK_LAYER, 'tokens': tokens, 'span_layers': []},
                {'id': WORD_LAYER, 'tokens': words, 'span_layers': [
                    {'id': FORM, 'spans': form_spans},
                    {'id': LEMMA, 'spans': lemma_spans, 'relation_layers': [
                        {'id': DEPREL, 'relations': basic},
                        {'id': ENHANCED, 'relations': rows}]},
                    # Empty, and there: the export refuses a project missing one.
                    {'id': UPOS, 'spans': []},
                    {'id': XPOS, 'spans': []},
                    {'id': FEATS, 'spans': []},
                ]},
            ]}],
    }
    return raw


def _camel(raw: dict) -> dict:
    """The same document as the JavaScript client hands it to the editor: keys
    in camelCase, each layer carrying the config the project gives it."""
    config = {}

    def collect(node):
        for key in ('text_layers', 'token_layers', 'span_layers', 'relation_layers'):
            for child in node.get(key) or []:
                config[child['id']] = child.get('config') or {}
                collect(child)
    collect(project_raw())

    def convert(node):
        out = {}
        for k, v in node.items():
            key = {'text_layers': 'textLayers', 'token_layers': 'tokenLayers',
                   'span_layers': 'spanLayers', 'relation_layers': 'relationLayers'}.get(k, k)
            out[key] = [convert(c) for c in v] if key != k else v
        if out.get('id') in config and ('tokens' in out or 'spans' in out or 'relations' in out
                                        or 'text' in out):
            out['config'] = config[out['id']]
        return out
    return convert(copy.deepcopy(raw))


def _workspace(raw):
    client = FakeClient(project=project_raw(), documents={raw['id']: copy.deepcopy(raw)})
    return client, Workspace(client, load_project(client, PID))


def _sent(client):
    """What a plan sent, in the runner's terms."""
    out = []
    for resource, method, args, _ in client.log:
        if resource == 'tokens' and method in ('split', 'merge'):
            out.append([method, *args])
        elif resource == 'relations' and method == 'delete':
            out.append(['delete', args[0]])
    return out


def _python_side(raw: dict) -> dict:
    client, ws = _workspace(raw)
    doc = ws.doc(NAME)
    deps, has_enhanced, suppressor_of = [], [], {}
    for s in doc.sentences:
        has_enhanced.append(s.has_enhanced)
        deps.append([deps_of(w) for w in s.words] if s.has_enhanced else None)
        for w in s.words:
            if w.suppressor_id:
                suppressor_of[w.fields['lemma'].id] = w.suppressor_id
    splits, merges = {}, {}
    for s in doc.sentences:
        # The first word starts its sentence, so a toggle there is a merge.
        for i, t in enumerate(s.tokens):
            if i == 0:
                continue
            ref = f's{s.index}.w{t.words[0].index}'
            client, ws = _workspace(raw)
            t_split_sentence(ws, document=NAME, ref=ref)
            execute_plan(client, ws.ops, source='s', label='l', project=ws.project)
            splits[str(t.begin)] = _sent(client)
        if s.index > 1:
            client, ws = _workspace(raw)
            t_merge_sentences(ws, document=NAME, ref=f's{s.index}')
            execute_plan(client, ws.ops, source='s', label='l', project=ws.project)
            merges[str(s.tokens[0].begin)] = _sent(client)
    return {'deps': deps, 'hasEnhanced': has_enhanced, 'suppressorOf': suppressor_of,
            'splits': splits, 'merges': merges}


@pytest.fixture(scope='module')
def compared():
    node = _node()
    if not node:
        _skip_or_fail('needs node 18+ and plaid-ud installed beside the agent')
    raws = [_case(s) for s in range(CASES)]
    py = [_python_side(raw) for raw in raws]
    cases = [{'raw': _camel(raw), 'splitAt': [int(k) for k in p['splits']],
              'mergeAt': [int(k) for k in p['merges']]} for raw, p in zip(raws, py)]
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'cases.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(cases, fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f'plaid-ud\'s domain modules would not run:\n{run.stderr[:2000]}')
    return raws, json.loads(run.stdout), py


def test_the_cases_reach_every_shape_they_are_for(compared):
    """A generator that stopped producing a shape would leave its comparison
    passing over nothing."""
    raws, js, py = compared
    assert sum(any(p['hasEnhanced']) for p in py) > CASES // 3
    assert sum(bool(p['suppressorOf']) for p in py) > CASES // 10
    assert sum(any(op[0] == 'delete' for ops in p['splits'].values() for op in ops)
               for p in py) > CASES // 3
    assert sum(bool(p['merges']) for p in py) > CASES // 3


def _differ(key, i, a, b, raws):
    pytest.fail(
        f'{key} differs from plaid-ud on document {i}.\n'
        f'  the app: {json.dumps(a, default=str)[:800]}\n'
        f'  the port: {json.dumps(b, default=str)[:800]}\n'
        f'  document: {json.dumps(raws[i], default=str)[:1500]}')


def test_which_sentences_state_an_enhanced_graph(compared):
    raws, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        if a['hasEnhanced'] != b['hasEnhanced']:
            _differ('hasEnhanced', i, a['hasEnhanced'], b['hasEnhanced'], raws)


def test_the_deps_column_is_the_tree_less_the_suppressed_plus_the_extras(compared):
    """Only where the sentence has enhanced rows: elsewhere the assistant
    leaves the column off, and the export writes the tree again."""
    raws, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        app = [d if has else None for d, has in zip(a['deps'], a['hasEnhanced'])]
        if app != b['deps']:
            _differ('deps', i, app, b['deps'], raws)


def test_the_suppressor_over_each_basic_relation(compared):
    raws, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        if a['suppressorOf'] != b['suppressorOf']:
            _differ('suppressorOf', i, a['suppressorOf'], b['suppressorOf'], raws)


@pytest.mark.parametrize('key', ['splits', 'merges'])
def test_a_sentence_boundary_sends_what_the_editor_sends(compared, key):
    """The cut, then every relation of either layer that it would leave
    spanning two sentences, suppressors included. Order within the deletes is
    each side's own, so they are compared as a set."""
    raws, js, py = compared

    def norm(ops):
        return ([op for op in ops if op[0] != 'delete'],
                sorted(op[1] for op in ops if op[0] == 'delete'))
    for i, (a, b) in enumerate(zip(js, py)):
        app = {k: norm(v) for k, v in a[key].items()}
        port = {k: norm(v) for k, v in b[key].items()}
        if app != port:
            _differ(key, i, app, port, raws)
