"""The ud assistant's sentence split and enhanced graph against plaid-ud's own,
over randomized documents.

Three rules live in plaid-ud's JavaScript and have a Python copy here:

- the enhanced graph a document states: the tree, less what is suppressed,
  plus the extra edges (``ud/project.py`` ``_read_enhanced`` against
  ``enhancedGraph.js`` as the CoNLL-U export reads it),
- the suppressor lying over a basic relation, which a write that moves or
  deletes that relation takes with it (``Word.suppressor_id`` against
  ``suppressorFor``), and the suppressor rows a head write or a head removal
  actually sends deletes for (``t_set_head`` and ``t_del_relation`` through
  ``ud/plan.py`` ``_suppressors``, against ``createRelation``,
  ``updateRelation`` and ``deleteRelation``),
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
import subprocess
import tempfile

from live import _skip_or_fail
from node_exe import node_or_skip

import pytest

from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import deps_of, load_project
from plaid_agent.ud.sentences import t_merge_sentences, t_split_sentence
from plaid_agent.ud.tools import Workspace, t_del_relation, t_set_head
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


def _node() -> str:
    """The node to run plaid-ud with, or a skip that says why. Its domain
    modules are ESM and reach @larc-iu/plaid-client through plaid-ud's own
    node_modules."""
    if not os.path.isdir(os.path.join(UD, 'node_modules')):
        _skip_or_fail('needs plaid-ud installed beside the agent')
    return node_or_skip("The enhanced-dependency mirror runs plaid-ud's modules with it.")


def _case(seed: int) -> dict:
    """One document in the live API's shape: one to three sentences, some
    multi-word tokens, a tree with gaps in it, and an enhanced layer holding
    extra edges, suppressors, two suppressors over one pair, a suppressor over
    no basic relation, and a valueless row that is no suppressor."""
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
        def suppress(source, target):
            # Now and then a second row over the same pair, which nothing
            # stops a writer leaving: a split takes every one, a head write
            # the first, as the editor reads them.
            for _ in range(2 if r.random() < 0.25 else 1):
                rows.append({'id': nid('e'), 'source': source, 'target': target,
                             'value': None, 'metadata': {'suppress': True}})
        for rel in basic:
            if rel['target'] in sent_words and r.random() < 0.35:
                suppress(rel['source'], rel['target'])
        if r.random() < 0.35:
            # A suppressor over a pair with no basic relation: dangling.
            pair = (r.choice(sent_words), r.choice(sent_words))
            if not any((b['source'], b['target']) == pair for b in basic):
                suppress(*pair)
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
    for kind, payload in client.writes:
        if kind == 'tokens.split':
            args = payload['args'] if isinstance(payload, dict) else payload
            out.append(['split', *args[:2]])
        elif kind == 'tokens.merge':
            out.append([kind.split('.')[1], *payload])
        elif kind == 'relations.delete':
            out.append(['delete', payload])
    return out


def _deletes(client):
    return [op[1] for op in _sent(client) if op[0] == 'delete']


def _head_writes(raw: dict, doc) -> list:
    """The head writes to run on both sides, each one word's: removing its
    head, a relabel under the head it has, the root, a head onto every pair a
    suppressor already lies over (dangling or not), and one other word of its
    sentence."""
    r = random.Random(json.dumps(raw, sort_keys=True))
    suppressed_from = {}
    for source, target in _suppressor_rows(raw).values():
        suppressed_from.setdefault(target, []).append(source)
    out = []
    for s in doc.sentences:
        lemma_of = {w.index: w.fields['lemma'].id for w in s.words if w.fields.get('lemma')}
        index_of = {v: k for k, v in lemma_of.items()}
        for w in s.words:
            if w.index not in lemma_of:
                continue
            target, ref = lemma_of[w.index], f's{s.index}.w{w.index}'
            if w.relation_id:
                out.append({'key': f'del {target}', 'kind': 'del', 'ref': ref, 'target': target})
            heads = [0]
            if w.relation_id and w.head is not None:
                heads.append(w.head)
            heads += [index_of[src] for src in suppressed_from.get(target, []) if src in index_of]
            heads.append(r.choice(sorted(lemma_of)))
            for head in dict.fromkeys(heads):
                if head == w.index:
                    continue
                source = target if head == 0 else lemma_of[head]
                out.append({'key': f'head {target} {source}', 'kind': 'head', 'ref': ref,
                            'head': head, 'target': target, 'source': source,
                            'deprel': 'root' if head == 0 else 'nmod'})
    return out


def _python_side(raw: dict) -> dict:
    client, ws = _workspace(raw)
    doc = ws.doc(NAME)
    heads = {}
    actions = _head_writes(raw, doc)
    for a in actions:
        client, ws = _workspace(raw)
        if a['kind'] == 'del':
            t_del_relation(ws, document=NAME, refs=[a['ref']])
        else:
            t_set_head(ws, document=NAME, ref=a['ref'], head=a['head'], deprel=a['deprel'])
        execute_plan(client, ws.ops, source='s', label='l', project=ws.project)
        heads[a['key']] = _deletes(client)
    deps, has_enhanced, suppressor_of = [], [], {}
    for s in doc.sentences:
        has_enhanced.append(s.has_enhanced)
        deps.append([deps_of(w) for w in s.words] if s.has_enhanced else None)
        for w in s.words:
            if w.suppressor_id:
                suppressor_of[w.fields['lemma'].id] = w.suppressor_id
    splits, merges, crossing = {}, {}, {}
    for s in doc.sentences:
        # The first word starts its sentence, so a toggle there is a merge.
        for i, t in enumerate(s.tokens):
            if i == 0:
                continue
            ref = f's{s.index}.w{t.words[0].index}'
            client, ws = _workspace(raw)
            t_split_sentence(ws, document=NAME, ref=ref)
            crossing[str(t.begin)] = [*ws.ops[-1]['relation_ids'], *ws.ops[-1]['suppressor_ids']]
            execute_plan(client, ws.ops, source='s', label='l', project=ws.project)
            splits[str(t.begin)] = _sent(client)
        if s.index > 1:
            client, ws = _workspace(raw)
            t_merge_sentences(ws, document=NAME, ref=f's{s.index}')
            execute_plan(client, ws.ops, source='s', label='l', project=ws.project)
            merges[str(s.tokens[0].begin)] = _sent(client)
    return {'deps': deps, 'hasEnhanced': has_enhanced, 'suppressorOf': suppressor_of,
            'splits': splits, 'merges': merges, 'heads': heads, 'actions': actions,
            'crossing': crossing}


@pytest.fixture(scope='module')
def compared():
    node = _node()
    raws = [_case(s) for s in range(CASES)]
    py = [_python_side(raw) for raw in raws]
    cases = [{'raw': _camel(raw), 'splitAt': [int(k) for k in p['splits']],
              'mergeAt': [int(k) for k in p['merges']],
              'heads': [{k: a[k] for k in ('key', 'kind', 'target', 'source', 'deprel') if k in a}
                        for a in p['actions']]}
             for raw, p in zip(raws, py)]
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
    # A split with relations across it, which the core drops (its layer rule).
    assert sum(any(p['crossing'].values()) for p in py) > CASES // 3
    assert sum(bool(p['merges']) for p in py) > CASES // 3
    rows = [_suppressor_rows(raw) for raw in raws]
    # Two suppressors over one pair, and a split that sends both.
    assert sum(len(set(pairs.values())) < len(pairs) for pairs in rows) > CASES // 10
    assert sum(any(sum(pairs.get(i) == pair for i in ids) > 1
                   for ids in p['crossing'].values() for pair in set(pairs.values()))
               for p, pairs in zip(py, rows)) > CASES // 20
    # A head write that sweeps a suppressor, and one onto a dangling pair.
    assert sum(any(i in pairs for ids in p['heads'].values() for i in ids)
               for p, pairs in zip(py, rows)) > CASES // 5
    assert sum(any(a['kind'] == 'head' and _dangling(raw, a['source'], a['target'])
                   for a in p['actions']) for raw, p in zip(raws, py)) > CASES // 10


def _relation_layers(raw):
    """The lemma layer's two relation layers, the tree's then the enhanced
    graph's, as _case lays them out."""
    return raw['text_layers'][0]['token_layers'][2]['span_layers'][1]['relation_layers']


def _enhanced_rows(raw):
    return _relation_layers(raw)[1]['relations']


def _suppressor_rows(raw):
    """Each suppressor row's id, to the pair it lies over."""
    return {row['id']: (row['source'], row['target']) for row in _enhanced_rows(raw)
            if (row.get('metadata') or {}).get('suppress')}


def _dangling(raw, source, target):
    basic = _relation_layers(raw)[0]['relations']
    return ((source, target) in set(_suppressor_rows(raw).values())
            and not any((b['source'], b['target']) == (source, target) for b in basic))


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
    """The cut and a merge. The relations a cut leaves across the boundary
    are the core's to drop, by the layer rule both relation layers declare,
    so the cut is compared as an id and a position. Any delete sent beside
    them is compared as a set, since order within the deletes is each side's
    own."""
    raws, js, py = compared

    def norm(ops):
        return ([op for op in ops if op[0] != 'delete'],
                sorted(op[1] for op in ops if op[0] == 'delete'))
    for i, (a, b) in enumerate(zip(js, py)):
        app = {k: norm(v) for k, v in a[key].items()}
        port = {k: norm(v) for k, v in b[key].items()}
        if app != port:
            _differ(key, i, app, port, raws)


def test_a_split_drops_what_the_editor_takes_off_the_screen(compared):
    """What the card counts as a split's dropped relations, suppressors
    included, against the editor's ``relationsCrossing``. The core does the
    dropping (its layer rule), so this is what the user approves."""
    raws, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        app = {k: sorted(v) for k, v in a['crossing'].items()}
        port = {k: sorted(v) for k, v in b['crossing'].items()}
        if app != port:
            _differ('crossing', i, app, port, raws)


def test_a_head_write_sweeps_the_suppressors_the_editor_sweeps(compared):
    """The suppressor rows a head removal, a relabel, a new head and a root
    each send a delete for, against ``deleteRelation``, ``updateRelation`` and
    ``createRelation``. Only enhanced rows are compared: the port writes a
    relabel as a delete and a create of the basic relation, where the editor
    updates it in place, and either is the same tree."""
    raws, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        rows = {row['id'] for row in _enhanced_rows(raws[i])}
        app = {k: sorted(x for x in v if x in rows) for k, v in a['heads'].items()}
        port = {k: sorted(x for x in v if x in rows) for k, v in b['heads'].items()}
        if app != port:
            _differ('heads', i, app, port, raws)
