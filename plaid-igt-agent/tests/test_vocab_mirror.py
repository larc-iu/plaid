"""``plaid_igt_agent.vocab`` against the app's own domain modules, function by
function, over randomized lexicons.

The agent writes the sense tree, the entry references and the promoted examples
that plaid-igt reads back, and it addresses an entry by the number plaid-igt
draws beside it. Both live in JavaScript, in ``plaid-igt/src/domain``. The port
therefore has to track them, and nothing about a port announces that it has
stopped tracking: the shapes it writes stay well-formed and the agent's own
tests keep passing while the meaning underneath has moved.

That has happened repeatedly. A headword stopped being its own sense 1; numbers
grew a homograph segment; a lone headword with senses stopped being bare. Each
changed what "kwatha#1" names, each left the agent naming a different entry than
the user sees, and the agent's unit tests caught none of them, because a fixture
written against the old rule is consistent with itself.

So this compares the two implementations directly. It skips where it cannot run
(no node, or plaid-igt not installed beside the agent); it does not skip when
they disagree.

``plan_sense_set_number`` is deliberately absent: the app dropped its copy when
senses became draggable, and the agent kept a place-among-siblings gesture
because dragging is not one it has. ``plan_sense_drop`` below covers the write
those two share. See its docstring in vocab.py.
"""

import inspect
import json
import os
import random
import re
import shutil
import subprocess
import tempfile

import pytest

from plaid_igt_agent import vocab as vocab_module
from plaid_igt_agent.vocab import (
    build_sense_tree, build_item_numbers, build_homonym_index, plan_delete_refs,
    plan_merge_refs, plan_sense_drop, next_sense_order, descendants_of, references_to,
    validate_vocab_refs, homograph_group, plan_homograph_order, homograph_of,
    arrange_as_tree, normalize_vocab_fields)

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'vocab_mirror.mjs')
DOMAIN = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-igt', 'src', 'domain'))
MODULES = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-igt', 'node_modules'))
CASES = 300


def _node():
    """The node to run the app's modules with, or None to skip. They are ESM
    and reach @larc-iu/plaid-client through plaid-igt's own node_modules."""
    exe = shutil.which('node')
    if not exe or not os.path.isdir(DOMAIN) or not os.path.isdir(MODULES):
        return None
    try:
        v = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=30).stdout
        return exe if int(v.strip().lstrip('v').split('.')[0]) >= 18 else None
    except Exception:  # noqa: BLE001 - any trouble asking means do not rely on it
        return None


FORMS = ['ama', 'run', 'bank', 'kita', 'x']
FIELDS = [
    {'name': 'gloss', 'inline': True, 'immutable': True, 'tagset': None, 'lang': None,
     'type': 'text', 'many': False, 'scope': 'sense'},
    {'name': 'syn', 'inline': False, 'immutable': False, 'tagset': None, 'lang': None,
     'type': 'item', 'many': False, 'scope': 'sense'},
    {'name': 'rel', 'inline': False, 'immutable': False, 'tagset': None, 'lang': None,
     'type': 'item', 'many': True, 'scope': 'sense'},
    {'name': 'note', 'inline': False, 'immutable': False, 'tagset': None, 'lang': None,
     'type': 'text', 'many': False, 'scope': 'entry'},
]


def _case(seed: int) -> dict:
    """One lexicon, built to hit the awkward shapes: parents that point at
    nothing or at themselves, chains that loop, homograph numbers that are
    missing or junk, reference fields holding the wrong type, and headwords
    that share a form."""
    r = random.Random(seed)
    ids = [f'i{k}' for k in range(r.randint(1, 14))]
    items = []
    for i in ids:
        meta = {}
        c = r.random()
        if c < 0.55:
            meta['parent'] = r.choice(ids + ['gone', i])   # real, dangling, or itself
            if r.random() < 0.75:
                meta['senseOrder'] = r.choice([1, 2, 3, 3, 7, 0, 2.5])
        elif c < 0.62:
            meta['senseOrder'] = r.randint(1, 4)           # a stray order on a headword
        if r.random() < 0.45:
            meta['homograph'] = r.choice([1, 2, 3, 0, -1, '2', 'x', None, 2.0])
        if r.random() < 0.4:
            meta['syn'] = r.choice(ids + ['gone', i, 5, None])
        if r.random() < 0.25:
            # A list where one reference is expected: what a field narrowed
            # from Entries to Entry leaves behind.
            meta['syn'] = r.sample(ids + ['gone'], r.randint(1, min(3, len(ids) + 1)))
        if r.random() < 0.4:
            meta['rel'] = r.sample(ids + ['gone', i], r.randint(1, min(3, len(ids) + 2)))
        if r.random() < 0.3:
            meta['rel'] = r.choice(['notalist', [], [None, 3]])
        if r.random() < 0.5:
            meta['gloss'] = r.choice(FORMS)
        items.append({'id': i, 'form': r.choice(FORMS), 'metadata': meta})
    move = r.choice(ids)
    return {
        'items': items, 'fields': FIELDS,
        'deleted': r.sample(ids, r.randint(1, min(3, len(ids)))),
        'survivor': r.choice(ids), 'losers': r.sample(ids, r.randint(1, min(3, len(ids)))),
        'moveId': move, 'orderParent': r.choice(ids),
        # A search's hits, in list order: what arrange_as_tree lays out.
        'listed': r.sample(ids, r.randint(0, len(ids))),
        'drops': [{'kind': 'root'}, {'kind': 'into', 'id': r.choice(ids)},
                  {'kind': 'before', 'id': r.choice(ids)}, {'kind': 'after', 'id': r.choice(ids)},
                  {'kind': 'after', 'id': move}, None],
        'rawFields': _raw_fields(r),
    }


def _raw_fields(r: random.Random):
    """A field schema as a vocab layer stores it, including the legacy boolean
    form, names that are reserved, and a core field the config never names."""
    out = {}
    for name in r.sample(['gloss', 'pos', 'morphType', 'note', 'parent', 'form',
                          'seeAlso', 'gloss (ru)', 'homograph'], r.randint(0, 6)):
        out[name] = r.choice([
            True, False,
            {'inline': True},
            {'inline': False, 'type': 'item'},
            {'inline': False, 'type': 'item', 'many': True},
            {'inline': True, 'scope': 'entry', 'tagset': 'Status'},
            {'inline': False, 'lang': 'pt', 'type': 'text'},
            {'type': 'nonsense', 'scope': 'nonsense', 'many': 'yes'},
        ])
    return r.choice([out, None, {}])


def _python_side(c: dict) -> dict:
    t = build_sense_tree(c['items'])
    return {
        'numberOf': t.number_of,
        'parentOf': t.parent_of,
        'depthOf': t.depth_of,
        'rootOf': t.root_of,
        'roots': [x['id'] for x in t.roots],
        'childrenOf': {k: [x['id'] for x in v] for k, v in t.children_of.items()},
        'itemNumbers': build_item_numbers(c['items']),
        'homonyms': build_homonym_index(c['items']),
        'homographOf': {it['id']: homograph_of(it) for it in c['items']},
        'homographGroup': [r['id'] for r in homograph_group(c['items'], c['moveId'])],
        'planHomographOrder': plan_homograph_order(
            homograph_group(c['items'], c['moveId']), c['losers']),
        'planSenseDrop': [plan_sense_drop(t, c['moveId'], d) for d in c['drops']],
        'nextSenseOrder': next_sense_order(t, c['orderParent']),
        'descendantsOf': [x['id'] for x in descendants_of(t, c['orderParent'])],
        'referencesTo': [[x['item']['id'], x['field']['name'] if x['field'] else None]
                         for x in references_to(c['items'], c['fields'], c['orderParent'])],
        'planDeleteRefs': plan_delete_refs(c['items'], c['fields'], c['deleted']),
        'planMergeRefs': plan_merge_refs(c['items'], c['fields'], c['survivor'], c['losers']),
        'validateVocabRefs': validate_vocab_refs(c['items'], c['fields'])[0],
        'arrangeAsTree': [[it['id'], depth, context] for it, depth, context in arrange_as_tree(
            [it for it in c['items'] if it['id'] in c['listed']], t)],
        # `declared` is the port's own: it tells a core field the config named
        # from one injected for it, which the app reads off the raw config.
        'normalizeVocabFields': [{k: v for k, v in f.items() if k != 'declared'}
                                 for f in normalize_vocab_fields(c['rawFields'])],
    }


@pytest.fixture(scope='module')
def compared():
    node = _node()
    if not node:
        pytest.skip('needs node 18+ and plaid-igt installed beside the agent')
    cases = [_case(s) for s in range(CASES)]
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'cases.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(cases, fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f'the app\'s domain modules would not run:\n{run.stderr[:2000]}')
    return cases, json.loads(run.stdout), [_python_side(c) for c in cases]


# What the app exports from vocabDictionary.js and does NOT have a port, on
# purpose. Each belongs to a gesture the app has and the agent does not. A new
# name showing up unexplained is the drift this check exists to catch: the value
# comparison below can only ever run what both sides already have.
SURFACE_EXEMPT = {
    'dictionaryEnablement': 'seeds a vocabulary when the switch goes on',
    'statusTagset': 'the same seeding',
    'splitEntryLevel': 'Add headword',
    'groupRankedByHeadword': "the link popover's list",
    'exampleKey': 'keys a rendering cache',
}
# Where the port did not keep the app's name.
SURFACE_ALIAS = {'readDictionaryEnabled': 'dictionary_enabled'}


def _snake(name: str) -> str:
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def test_every_app_function_is_ported_or_exempted():
    """The value comparison runs the functions both sides have, so it is blind
    to one the app grew and the port never got. This is not."""
    node = _node()
    if not node:
        pytest.skip('node or plaid-igt not available')
    run = subprocess.run([node, RUNNER, '--surface'], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    exported = json.loads(run.stdout)['vocabDictionary']
    ported = {n for n, o in vars(vocab_module).items()
              if not n.startswith('_') and inspect.isfunction(o)
              and o.__module__ == vocab_module.__name__}
    missing = [n for n in exported
               if n not in SURFACE_EXEMPT
               and SURFACE_ALIAS.get(n, _snake(n)) not in ported]
    assert not missing, (
        'plaid-igt exports these from vocabDictionary.js with no counterpart in '
        f'plaid_igt_agent/vocab.py: {missing}. Port each one, or add it to '
        'SURFACE_EXEMPT here and to the module docstring with the reason.')
    stale = [n for n in SURFACE_EXEMPT if n not in exported]
    assert not stale, f'SURFACE_EXEMPT names functions the app no longer exports: {stale}'


def test_the_two_runners_cover_the_same_functions(compared):
    _, js, py = compared
    assert set(js[0]) == set(py[0]), 'one runner reports a function the other does not'


@pytest.mark.parametrize('key', [
    'numberOf', 'parentOf', 'depthOf', 'rootOf', 'roots', 'childrenOf',
    'itemNumbers', 'homonyms', 'homographOf', 'homographGroup', 'planHomographOrder',
    'planSenseDrop', 'nextSenseOrder', 'descendantsOf', 'referencesTo',
    'planDeleteRefs', 'planMergeRefs', 'validateVocabRefs', 'arrangeAsTree',
    'normalizeVocabFields',
])
def test_the_port_matches_the_app(compared, key):
    cases, js, py = compared
    for i, (a, b) in enumerate(zip(js, py)):
        if a[key] != b[key]:
            pytest.fail(
                f'{key} differs from plaid-igt on lexicon {i}.\n'
                f'  the app: {json.dumps(a[key], default=str)[:600]}\n'
                f'  the port: {json.dumps(b[key], default=str)[:600]}\n'
                f'  lexicon: {json.dumps(cases[i]["items"], default=str)[:800]}\n'
                'Update plaid_igt_agent/vocab.py to match, then check what reads it: a change to '
                'the numbering also changes what an entry_form names.')
