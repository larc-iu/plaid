"""The service's ``compact_plan`` against plaid-ui's ``compactPlan``.

A settled plan is compacted by whichever side settles it: the service for an
applied or out-of-date plan, the browser for a discarded one. What each keeps
of the plan's proposed changes (``proposed``, written when the plan was
staged) is the record a study of the assistant reads, so the two must write
the same thing, or discarded plans and applied ones would be described in two
dialects. Each case goes the way the
record does: the Python item recased to the stored kebab-case, read by the
browser through the JS client's own transforms, compacted, and written back.
It skips where it cannot run (no node); it does not skip when they disagree.
"""

import json
import os
import random
import subprocess
import tempfile

import pytest

from node_exe import node_or_skip
import test_stale_by_sentence as sbs

from plaid_client.transforms import transform_request
from datetime import datetime, timedelta, timezone

from plaid_agent.core.conversation import (
    PROPOSED_MAX, PROPOSED_VALUE_MAX, SETTLED_ROWS_MAX, assistant_item, compact_plan, error_item, now_iso, proposed_changes,
    user_item)
from plaid_agent.igt.service import AssistantService as IgtService
from plaid_agent.ud.service import AssistantService as UdService
from plaid_agent.umr.service import AssistantService as UmrService

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'plan_record_mirror.mjs')
UI = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-ui', 'src', 'components', 'assistant', 'planRecord.js'))
CASES = 300

KINDS = ['set_span', 'set_head', 'confirm', 'respell', 'edit_text', 'create_node', 'bulk_scope', 'add_comment',
         'create_edge', 'link', 'merge_sentences']
KEYS = [IgtService.proposed_keys, UdService.proposed_keys, UmrService.proposed_keys]
ALL_KEYS = tuple(sorted({k for targets, values, others in KEYS for k in targets + values + tuple(others.values())}))
# Values that are clipped: letters outside the BMP, which a JS string holds as
# two units, and Arabic with its vowel marks.
TEXTS = ['fish', '', 'x' * 30, '𝄞' * 30, 'كَتَبَ' * 6, 'a' * PROPOSED_VALUE_MAX, 'b' * (PROPOSED_VALUE_MAX + 1)]


def _value(rng):
    return rng.choice([
        lambda: rng.choice(TEXTS),
        lambda: f'019a{rng.randrange(16 ** 8):08x}-0000-7000-8000-000000000000',
        lambda: None,
        lambda: rng.randrange(-5, 5000),
        lambda: rng.choice([True, False]),
        lambda: [],
        lambda: [f'id{rng.randrange(99)}' for _ in range(rng.randrange(1, 4))],
        lambda: {'nested_key': 'v'},
    ])()


def _op(rng):
    op = {}
    if rng.random() < 0.95:
        op['kind'] = rng.choice(KINDS)
    for key in rng.sample(ALL_KEYS + ('layer_id', 'label', 'doc'),
                          rng.randrange(0, 6)):
        op[key] = _value(rng)
    if rng.random() < 0.15:
        op['metadata'] = {'some-key': 1, 'other_key': 'x'}
    return op


def _group(rng, n=None):
    n = n if n is not None else rng.randrange(13, 40)
    each = rng.sample(ALL_KEYS, rng.randrange(1, 4))
    fixed = {k: v for k, v in _op(rng).items() if k not in each}
    return {**fixed, 'compact': True, 'count': n, 'label': f'{n} changes',
            'items': {k: [_value(rng) for _ in range(n)] for k in each}}


def _item(ops, status, keys, docs=None):
    """A plan as a turn stages it: its proposed changes by one app's keys."""
    plan = {'id': 'p', 'summary': 's', 'labels': ['l'] * len(ops), 'changes': [{'label': 'l'}] * len(ops),
            'ops': ops, 'documents': docs if docs is not None else [{'id': 'd1', 'name': 'T', 'version': 2}]}
    plan['proposed'], plan['proposed_count'] = proposed_changes(ops, *keys)
    return {**assistant_item('a', plan, [], [], '', 'm'), 'status': status,
            'settled_at': '2026-09-28T12:00:00.000Z'}


def _rule_row(rng, i):
    """A rule's card row (core/rules.py), which a settled plan never cuts."""
    return {'label': f'rule {i}', 'where': None, 'change': 'Gloss "VASP" → "ASP"', 'writes_text': False,
            'replaces_work': rng.choice([0, 12]),
            'rule': {'tool': 'replace_in_field', 'args': {'pattern': 'VASP', 'whole_value': False},
                     'total': 1240, 'kinds': {'set_span': 1240}, 'documents': [['d1', 'Text 1', 1240]],
                     'documents_more': [0, 0], 'sample': [{'label': 'T s1.w2: Gloss "VASP" → "ASP"',
                                                           'where': None, 'change': 'x', 'replaces_work': 1}]}}


def _long(rng, n, status, settled_before=False, rules=0, labels=True):
    """A plan of more rows than a settled one keeps, each row located as a
    service locates it, some rewriting the text or replacing work. Settled
    before the cap, it has no ops left and every row still. ``rules`` of its
    rows are a rule's, some past the cap, and a plan made since rules has no
    ``labels`` and may hold what an interrupted approval found."""
    changes = [{'label': f'r{i}', 'change': 'Gloss = x',
                'where': {'kind': 'token', 'document_id': f'd{i % 3}', 'document_name': 'T', 'sentence': i},
                'writes_text': rng.random() < 0.05, 'replaces_work': rng.choice([0, 0, 0, 1, 3])}
               for i in range(n)]
    for i in rng.sample(range(n), rules):
        changes[i] = _rule_row(rng, i)
    item = _item([_op(rng) for _ in range(n)], status, rng.choice(KEYS))
    item['plan'] = {**item['plan'], 'changes': changes, 'labels': [c['label'] for c in changes]}
    if not labels:
        item['plan'].pop('labels')
    if rules and rng.random() < 0.7:
        item['plan']['expansion'] = {'0': [{'kind': 'set_span', 'token_id': 't1', 'value': 'ASP'}]}
    if settled_before:
        plan = {k: v for k, v in item['plan'].items() if k not in ('ops', 'documents')}
        item['plan'] = {**plan, 'op_count': n}
    return item


def _real_plans():
    """The plans the three assistants actually stage, as the stale tests stage them."""
    out = []
    for name in sorted(sbs.APPS):
        spec = sbs.APPS[name]()
        for tool in (spec['plan'], spec['whole']):
            plan, _ = sbs._plan(spec, spec['client'](), tool)
            plan['proposed'], plan['proposed_count'] = proposed_changes(plan['ops'], *spec['service'].proposed_keys)
            out.append(plan)
    return out


def _cases():
    rng = random.Random(20260928)
    cases = []
    for plan in _real_plans():
        for status in ('applied', 'discarded', 'stale'):
            cases.append({**assistant_item('a', plan, [], [], '', 'm'), 'status': status})
    for _ in range(CASES):
        ops = [(_group(rng) if rng.random() < 0.2 else _op(rng)) for _ in range(rng.randrange(0, 8))]
        cases.append(_item(ops, rng.choice(['applied', 'discarded', 'stale', None]), rng.choice(KEYS)))
    cases.append(_item([_group(rng, PROPOSED_MAX + 17)], 'discarded', KEYS[0]))
    cases.append(_item([_group(rng, PROPOSED_MAX), _op(rng)], 'stale', KEYS[2]))
    for status in ('applied', 'discarded', 'stale', 'replaced', 'partial', None):
        cases.append(_long(rng, SETTLED_ROWS_MAX + rng.randrange(1, 400), status))
        cases.append(_long(rng, SETTLED_ROWS_MAX + rng.randrange(1, 400), status, settled_before=True))
    for status in ('applied', 'discarded', 'stale', 'replaced', None):
        cases.append(_long(rng, SETTLED_ROWS_MAX + rng.randrange(1, 300), status, rules=rng.randrange(1, 6),
                           labels=False))
        cases.append(_long(rng, rng.randrange(1, SETTLED_ROWS_MAX), status, rules=1, labels=False))
    cases.append(_long(rng, SETTLED_ROWS_MAX, 'applied'))
    cases.append(_long(rng, SETTLED_ROWS_MAX + 1, 'applied', settled_before=True))
    cases.append({'kind': 'assistant', 'text': 'no plan', 'plan': None, 'status': None})
    cases.append(user_item('a question'))
    cases.append(error_item('Stopped.', stopped=True, model='m', steps=[{'id': 'c1', 'name': 'search',
                                                                          'kind': 'read', 'label': 'Searched'}],
                            calls=[{'id': 'c1', 'name': 'search', 'arguments': '{"query_text": "x"}',
                                    'result': 'Error: No such thing'}]))
    return cases


# Instants the two sides date items at: the epoch, whole seconds, a single
# millisecond, the end of a year, a leap day, and now.
TIMES = [0, 1_000, 1, 1_759_276_800_999, 1_709_164_799_123, 4_102_444_800_000,
         int(datetime.now(timezone.utc).timestamp() * 1000)]


@pytest.fixture(scope='module')
def compared():
    if not os.path.isfile(UI):
        pytest.skip('needs plaid-ui beside the agent')
    node = node_or_skip("The plan record mirror runs plaid-ui's planRecord.js with it.")
    cases = _cases()
    stored = [transform_request(c) for c in cases]
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump({'cases': stored, 'times': TIMES}, f)
        path = f.name
    try:
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    finally:
        os.unlink(path)
    if run.returncode != 0:
        pytest.fail(f"plaid-ui's planRecord.js would not run:\n{run.stderr[:2000]}")
    out = json.loads(run.stdout)
    return cases, out['results'], out['times']


def test_the_cases_reach_every_shape_they_are_for(compared):
    cases, _, _ = compared
    proposed = [compact_plan(c)['plan'] for c in cases if c.get('plan') and c.get('status')]
    flat = [p for plan in proposed for p in plan['proposed']]
    assert any(plan['proposed_count'] > PROPOSED_MAX for plan in proposed), 'the cap'
    assert any(isinstance(p[2], str) and p[2].endswith('…') and '𝄞' in p[2] for p in flat), 'a clip past the BMP'
    assert any(isinstance(p[2], int) for p in flat), 'a number kept'
    assert any(p[1] is None for p in flat) and any(p[1] for p in flat)
    assert any(p[0] is None for p in flat), 'an op with no kind'
    assert any(len(p) == 4 and p[3] for p in flat) and any(len(p) == 4 and p[3] is None for p in flat), 'a second end'
    assert any(c.get('status') is None and c.get('plan') for c in cases), 'an undecided plan'
    kept = [compact_plan(c)['plan'] for c in cases if c.get('plan') and c.get('status')]
    assert any(p.get('omitted', {}).get('writes_text') and p['omitted'].get('replaces_work') for p in kept), \
        'rows cut, with what they held'
    assert any(len(p.get('changes') or []) == SETTLED_ROWS_MAX and 'omitted' not in p for p in kept), 'at the cap'
    assert any(any(c.get('rule') and c.get('row', 0) >= SETTLED_ROWS_MAX for c in p.get('changes') or [])
               for p in kept), 'a rule row kept past the cap'
    assert any('expansion' in (c.get('plan') or {}) and c.get('status') for c in cases), 'what an approval found'


def test_the_service_and_the_browser_write_the_same_record(compared):
    cases, results, _ = compared
    assert len(results) == len(cases)
    for i, (case, got) in enumerate(zip(cases, results)):
        want = json.loads(json.dumps(transform_request(compact_plan(case))))
        assert got == want, f'case {i}: {json.dumps(case)[:600]}'


def test_every_item_keeps_when_it_was_written(compared):
    """Each item carries ``created_at``, and compaction keeps it on both
    sides: a reader of the record dates every turn by it."""
    cases, results, _ = compared
    assert all(c.get('created_at') for c in cases if c.get('kind') in ('user', 'error')
               or (c.get('kind') == 'assistant' and c.get('text') != 'no plan'))
    for case, got in zip(cases, results):
        if case.get('created_at'):
            assert got['created-at'] == case['created_at']


def test_the_service_and_the_browser_date_items_alike(compared):
    """The browser stamps the items it writes (a question, a turn it settles
    as failed or stopped) with ``itemTime``, the service with ``now_iso``,
    so one reader sorts and compares them as one kind of string."""
    _, _, times = compared
    want = [now_iso(datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)) for ms in TIMES]
    assert times == want
