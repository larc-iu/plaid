"""The invariant behind igt's corpus-wide rules (FX-D-AGENT, REV3-AGENT-1 to 3).

Rules resolve in plan order, each over the stored values as only the rules
BEFORE it leave them, a value the plan keeps read as stored, and a change
named on a value beating every rule. One function finds them
(``igt.bulk.sync_rules`` over ``resolve_rule``), at staging, after any change
to the plan, and as approval finds them.

The oracle: random plans of chained rules, keeps and named changes,
staged in random order on a private core and approved through the service.
What approval writes is computed from the final plan's ops alone, as the
values that end other than stored, and the card's count, plan_status, the
applied count and the values read back after approval must all equal it.
A value approval leaves as stored keeps its provenance. Approval never refuses: nobody else touched the
project. ``RULE_ORACLE_CASES`` sets how many plans (12 by default, 300 for
the sweep in the fix report).
"""

import os
import random
import re

from fixtures import GLOSS, project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, seed, _Session  # noqa: F401
from rule_plan_model import as_applied
from test_service_flow import Helper

from plaid_agent.core import rules
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.core.keep import is_keep
from plaid_agent.core.plan import plan_changes
from plaid_agent.igt.project import load_project
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

VALUES = ['Ali', 'Bob', 'Cy', 'Dan']
REFS = ['s1.w1', 's1.w2', 's1.w3', 's2.w1']
# (pattern, replacement, whole): whole values, and pieces of one.
RULES = [(a, b, True) for a in VALUES for b in VALUES if a != b] + [
    (a, b, False) for a, b in [('li', 'LI'), ('LI', 'li'), ('y', 'ie'), ('ie', 'y'), ('o', 'oo'), ('oo', 'o')]]


def _doc(values):
    d = document_raw()
    for tk in d['text_layers'][0]['token_layers']:
        for sl in tk.get('span_layers') or []:
            if sl['id'] == GLOSS:
                sl['spans'] = [{'id': f'sp-g{i}', 'value': v, 'tokens': [f'w-{i}']} for i, v in enumerate(values, 1)]
    return d


def _rep(pattern, replacement, whole):
    if whole:
        return lambda v: replacement if v == pattern else v
    return lambda v: v.replace(pattern, replacement)


def oracle(ops, stored):
    """What approval writes, by token id, from the plan's ops and the stored
    values alone: the values that end other than they are stored. One the
    rules or a named change bring back to its stored value is no change
    (FX-E ruling a, REV4-AGENT-1)."""
    chain = [_rep(op['args']['pattern'], op['args'].get('replacement') or '', bool(op['args'].get('whole')))
             for op in ops if rules.is_rule(op)]
    kept = {op['kept'][2] for op in ops if is_keep(op)}
    named = {op['token_id']: op['value'] for op in ops if op.get('kind') == 'set_span'}
    out = {}
    for tok, v in stored.items():
        if tok in named:
            out[tok] = named[tok]
            continue
        if tok in kept:
            continue
        touched = False
        for rep in chain:
            if v != '' and rep(v) != v:
                v, touched = rep(v), True
        if touched:
            out[tok] = v
    for tok, v in named.items():
        out.setdefault(tok, v)
    return {tok: v for tok, v in out.items() if v != stored.get(tok)}


def _card_count(payload):
    return sum((r['rule'].get('total') or 0) if r.get('rule') else (0 if r.get('kept') else 1)
               for r in payload['changes'])


def _status_count(line):
    if line.startswith('No planned changes'):
        return 0
    m = re.match(r'(\d+) planned change', line)
    return int(m.group(1)) if m else None


def _approve(c, project_id, payload):
    store = ConversationStore(c, _Session.user, project_id, 'igt')
    item = assistant_item('Planned.', payload, [], [], '', 'fake/model', service='igt:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('x'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model'))
    svc = AssistantService()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = 'igt:assist:fake'
    h = Helper(request_id='r1')
    svc.process_request({'requester_client': c, 'requester_id': _Session.user, 'project_id': project_id,
                         'delegated_projects': [project_id], 'conversation_id': 'c1', 'op': 'approve',
                         'plan_id': payload['id']}, h)
    return h


def _step(rng, ws):
    roll = rng.random()
    if roll < 0.4 or not ws.ops:
        p, r, whole = rng.choice(RULES)
        return 'replace_in_field', {'field': 'Gloss', 'pattern': p, 'replacement': r, 'whole': whole,
                                    'case_sensitive': True}
    ref = rng.choice(REFS)
    doc = ws.doc('Text 1')
    s, w = (int(x[1:]) for x in ref.split('.'))
    word = doc.sentences[s - 1].words[w - 1]
    stored = word.fields['Gloss'].value
    # Half the time what it holds: a keep, or a change taken back.
    value = stored if rng.random() < 0.5 else rng.choice(VALUES)
    if rng.random() < 0.3:
        return 'set_field', {'document': 'Text 1', 'refs': [ref], 'values': {'Gloss': value}}
    return 'set_field', {'document': 'Text 1', 'refs': [ref], 'field': 'Gloss', 'value': value}


def run_case(c, seed_no):
    rng = random.Random(seed_no)
    values = [rng.choice(VALUES) for _ in REFS]
    s = seed(c, project_raw(), {'d1': _doc(values)}, {VOCAB: lexicon_raw()}, name=f'rule oracle {seed_no}')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        doc = ws.doc('Text 1')
        words = [w for sent in doc.sentences for w in sent.words]
        stored = {w.id: w.fields['Gloss'].value for w in words}
        meta = {w.id: w.fields['Gloss'].metadata for w in words}
        steps = []
        for _ in range(rng.randint(2, 7)):
            name, args = _step(rng, ws)
            steps.append((name, args, str(call_tool(ws, name, args))[:200]))
        where = f'case {seed_no}, stored {values}, steps:\n' + '\n'.join(f'  {n} {a} -> {o}' for n, a, o in steps)
        payload = ws.plan_payload()
        if payload is None:
            return 'empty'
        want = oracle(payload['ops'], stored)
        status = str(call_tool(ws, 'plan_status', {})).splitlines()[0]
        assert _card_count(payload) == len(want), f'card {_card_count(payload)} != {len(want)}\n{where}'
        assert plan_changes(payload['ops']) == len(want), f'plan_changes != {len(want)}\n{where}'
        assert _status_count(status) == len(want), f'plan_status {status!r} != {len(want)}\n{where}'
        h = as_applied(_approve(c, s.project_id, payload))
        assert not h.errors, f'approval refused: {h.errors}\n{where}'
        [done] = h.done
        assert done.get('applied') == len(want), f'applied {done.get("applied")} != {len(want)}\n{where}'
        after = Workspace(c, load_project(c, s.project_id)).doc('Text 1')
        got = {w.id: w.fields['Gloss'].value for sent in after.sentences for w in sent.words}
        expected = {**stored, **want}
        assert got == expected, f'stored after approval {got} != {expected}\n{where}'
        # Nothing approval leaves as stored is written: its provenance stays.
        restamped = {w.id for sent in after.sentences for w in sent.words
                     if w.id not in want and w.fields['Gloss'].metadata != meta[w.id]}
        assert not restamped, f'restamped {sorted(restamped)} with no change\n{where}'
        return 'ok'
    finally:
        s.delete()


def test_rules_keeps_and_named_changes_count_and_approve_as_one(live_client):
    n = int(os.environ.get('RULE_ORACLE_CASES') or 12)
    start = int(os.environ.get('RULE_ORACLE_START') or 0)
    outcomes, violations = [], []
    for i in range(start, start + n):
        try:
            outcomes.append(run_case(live_client, i))
        except AssertionError as e:
            violations.append(str(e))
    print(f'{n} plans: {outcomes.count("ok")} approved, {outcomes.count("empty")} empty, '
          f'{len(violations)} violations')
    assert not violations, f'{len(violations)} of {n}:\n\n' + '\n\n'.join(violations[:5])
    assert outcomes.count('ok') >= n // 2, outcomes
