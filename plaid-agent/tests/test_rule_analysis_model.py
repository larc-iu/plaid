"""The REV5-AGENT review's analysis sweep, kept as an oracle: one planned
analysis, then form rules on its morphemes, values named on them, rules asked
again and drops (``RULE_ANALYSIS_REPLACE=1`` adds whole-value replacements),
approved on a live core. The model replays the plan's instructions in order,
the analysis first: a rule asked again applies last, a dropped one leaves no
trace in the analysis or anywhere else. ``RULE_ANALYSIS_CASES`` (10 by
default), ``RULE_ANALYSIS_START`` and ``RULE_ANALYSIS_OUT``."""
import json
import os
import random

import pytest

from live import live_client, seed  # noqa: F401
from rule_plan_model import approve, as_applied, make_doc, project, values_of
from fixtures import lexicon_raw, VOCAB
from plaid_agent.core import rules as core_rules
from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace
from plaid_agent.igt.toolkit import call_tool

OUT = os.environ.get('RULE_ANALYSIS_OUT')
N = int(os.environ.get('RULE_ANALYSIS_CASES', '10'))
START = int(os.environ.get('RULE_ANALYSIS_START', '0'))
WITH_REPLACE = os.environ.get('RULE_ANALYSIS_REPLACE') == '1'


def doc(rng):
    d, _s, _f = make_doc(random.Random(1), 'd0', 'Doc A', nsent=1, nword=3)  # ka, kan, kan
    d['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'] = []
    morphs = d['text_layers'][0]['token_layers'][2]['tokens']
    d['text_layers'][0]['token_layers'][2]['span_layers'][0]['spans'] = [
        {'id': f'mg{i}', 'value': v, 'tokens': [m['id']]}
        for i, (m, v) in enumerate(zip(morphs, [rng.choice(['', 'A', 'X']) for _ in morphs])) if v]
    return d


def apply(spec, form, v):
    if spec['tool'] == 'replace_in_field':
        if v == '':
            return v
        return spec['replacement'] if v == spec['pattern'] else v
    if form != spec['form'] or (spec['only_empty'] and v != ''):
        return v
    return spec['value']


def replay(stored, forms, entries):
    V = dict(stored)
    for e in entries:
        if e[0] == 'ana':
            V['s1.w2.m1'], V['s1.w2.m2'] = '', ''
        elif e[0] == 'rule':
            for t in V:
                V[t] = apply(e[1], forms[t], V[t])
        else:
            V[e[1]] = e[2]
    return V


def run_case(c, case):
    rng = random.Random(case)
    s = seed(c, project(), {'d0': doc(rng)}, {VOCAB: lexicon_raw()}, name=f'rule analysis {case}')
    log, res = [], {'case': case}
    res['log'] = log
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        stored = {k[1]: v for k, v in values_of(ws).items() if k[2] == 'Morph Gloss'}
        forms = {'s1.w1.m1': 'ka', 's1.w2.m1': 'ka', 's1.w2.m2': 'n', 's1.w3.m1': 'ka', 's1.w3.m2': 'n'}
        assert set(stored) == set(forms), stored
        out = call_tool(ws, 'set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                             'morphemes': [{'form': 'ka'}, {'form': 'n'}]})
        entries = [('ana',)]
        log.append(['ana', out[:200]])
        asked = []
        for step in range(rng.randint(3, 7)):
            act = rng.choices(['rule', 'again', 'named', 'drop'], [4, 2, 2, 2])[0]
            if act == 'again' and not asked:
                act = 'rule'
            if act == 'rule' or act == 'again':
                if act == 'again':
                    spec = rng.choice(asked)
                elif WITH_REPLACE and rng.random() < 0.3:
                    spec = {'tool': 'replace_in_field', 'pattern': rng.choice(['A', 'X', 'Y']),
                            'replacement': rng.choice(['X', 'Y', 'Z'])}
                    if spec['pattern'] == spec['replacement']:
                        continue
                else:
                    spec = {'tool': 'set_field_for_form', 'form': rng.choice(['ka', 'n']),
                            'value': rng.choice(['X', 'Y', 'Z']), 'only_empty': rng.random() < 0.3}
                if spec['tool'] == 'replace_in_field':
                    args = {'field': 'Morph Gloss', 'pattern': spec['pattern'], 'replacement': spec['replacement'],
                            'whole': True}
                else:
                    args = {'form': spec['form'], 'field': 'Morph Gloss', 'value': spec['value'],
                            'only_empty': spec['only_empty']}
                def has_rule():
                    return any(core_rules.is_rule(op) and op.get('tool') == spec['tool'] and all(
                        op['args'].get(k) == v for k, v in args.items() if k != 'only_empty') and
                        bool(op['args'].get('only_empty', True)) == bool(args.get('only_empty', True))
                        for op in ws.ops)
                def ana_now():
                    return json.dumps([op for op in ws.ops if op.get('kind') == 'set_analysis'], sort_keys=True, default=str)
                had, a0 = has_rule(), ana_now()
                out = call_tool(ws, spec['tool'], args)
                if spec not in asked:
                    asked.append(spec)
                staged, changed = has_rule(), ana_now() != a0
                stays = 'which stays where it is' in out
                if not stays:
                    if had:
                        entries = [e for e in entries if not (e[0] == 'rule' and e[1] == spec)]
                    if staged or changed:
                        entries.append(('rule', spec))
                log.append([act, args, out[:300]])
            elif act == 'named':
                t = rng.choice(['s1.w2.m1', 's1.w2.m2'])
                v = rng.choice(['P', 'Q', ''])
                out = call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': [t], 'field': 'Morph Gloss', 'value': v})
                entries.append(('named', t, v))
                log.append([act, t, v, out[:200]])
            else:
                rule_ix = [i for i, op in enumerate(ws.ops, start=1) if core_rules.is_rule(op)]
                if not rule_ix:
                    continue
                i = rng.choice(rule_ix)
                a = ws.ops[i - 1]['args']
                spec = ({'tool': 'set_field_for_form', 'form': a['form'], 'value': a['value'],
                         'only_empty': bool(a.get('only_empty', True))} if ws.ops[i - 1]['tool'] == 'set_field_for_form'
                        else {'tool': 'replace_in_field', 'pattern': a['pattern'], 'replacement': a['replacement']})
                out = call_tool(ws, 'drop_planned', {'indexes': [i]})
                entries = [e for e in entries if not (e[0] == 'rule' and e[1] == spec)]
                log.append([act, spec, out[:300]])
        ana = next((op for op in ws.ops if op.get('kind') == 'set_analysis'), None)
        res['ana'] = [[f['value'] for f in m['fields']] for m in ana['morphemes']] if ana else None
        expected = replay(stored, forms, entries)
        p = ws.plan_payload()
        if p:
            _p, h, _ = approve(c, s.project_id, ws)
            as_applied(h)
            res['errors'] = h.errors
        after = {k[1]: v for k, v in values_of(Workspace(c, load_project(c, s.project_id))).items()
                 if k[2] == 'Morph Gloss'}
        res['stored'], res['expected'], res['after'], res['entries'] = stored, expected, after, entries
        res['ok'] = after == expected and not res.get('errors')
        return res
    finally:
        s.delete()


@pytest.mark.parametrize('case', range(START, START + N))
def test_ana(live_client, case):
    try:
        res = run_case(live_client, case)
    except Exception:  # noqa
        import traceback
        res = {'case': case, 'crash': traceback.format_exc()[-3000:], 'ok': False}
    if OUT:
        with open(OUT, 'a') as f:
            f.write(json.dumps(res, default=str) + '\n')
    assert res.get('ok'), json.dumps(res, default=str, indent=1)[:5000]
