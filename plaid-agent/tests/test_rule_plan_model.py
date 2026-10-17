"""The REV4-AGENT review's sweep: random igt plans approved on a live core
against the model in ``rule_plan_model.py``. Every count (the card,
plan_status, the research record, the applied count) must equal the values
that changed, and those must be what the model says the user asked for,
with no refusal. ``RULE_MODEL_CASES`` sets how many plans (10 by default),
``RULE_MODEL_START`` the first seed, ``RULE_MODEL_WEIGHTS`` the step mix,
``RULE_MODEL_DENSE=1`` steps that pick the values the plan already names or
rewrites, so rules meet named changes often, and ``RULE_MODEL_OUT`` a file
each case is written to."""
import json
import os
import random
import re

import pytest

from live import live_client, seed  # noqa: F401
from rule_plan_model import (DOCS, FIELDS, LET, VALS, Model, approve, as_applied, make_doc, parse_int_sum, project,
                             values_of)
from fixtures import lexicon_raw, VOCAB
from plaid_agent.core.conversation import proposed_changes
from plaid_agent.core import rules as core_rules
from plaid_agent.igt.project import load_project
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.workspace import Workspace
from plaid_agent.igt.toolkit import call_tool

OUT = os.environ.get('RULE_MODEL_OUT')
N = int(os.environ.get('RULE_MODEL_CASES', '10'))
START = int(os.environ.get('RULE_MODEL_START', '0'))
WEIGHTS = json.loads(os.environ.get('RULE_MODEL_WEIGHTS', '{}'))
DENSE = os.environ.get('RULE_MODEL_DENSE') == '1'


def spec_key(tool, args):
    return json.dumps([tool, {k: v for k, v in sorted(args.items()) if k != 'where'}], sort_keys=True, default=str)


def gen_case(case):
    rng = random.Random(case)
    docs, stored, forms = {}, {}, {}
    for i, name in enumerate(DOCS):
        d, s, f = make_doc(rng, f'd{i}', name, nsent=2, nword=rng.choice([2, 3]))
        docs[f'd{i}'] = d
        stored.update(s)
        forms.update(f)
    return rng, docs, stored, forms


def run_case(c, case):
    rng, docs, stored, forms = gen_case(case)
    s = seed(c, project(), docs, {VOCAB: lexicon_raw()}, name=f'rule model {case}')
    log = []
    res = {'case': case, 'log': log}
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        got = values_of(ws)
        assert got == stored, ('seed mismatch', got, stored)
        doc_ids = {d['name']: d['id'] for d in ws.documents()}
        model = Model(stored, forms)
        rule_specs = {}  # spec key -> model spec
        targets = list(stored)
        nsteps = rng.randint(3, 8)
        acts = ['replace', 'form', 'set', 'values']
        w = [WEIGHTS.get(a, d) for a, d in zip(acts, [4, 2, 3, 1.5])]
        for step in range(nsteps):
            act = rng.choices(acts, w)[0]
            out = None
            if act == 'replace':
                field = rng.choice(list(FIELDS))
                prev = [sp['replacement'] for sp in rule_specs.values()
                        if sp['tool'] == 'replace_in_field' and sp['replacement']]
                pat = rng.choice(prev) if prev and rng.random() < 0.5 else rng.choice(LET[:3])
                # Dense: often a value the plan names, so rules rewrite named changes.
                named = [e[2] for e in model.entries if e[0] == 'named' and e[1][2] == field and e[2]]
                if DENSE and named and rng.random() < 0.6:
                    pat = rng.choice(named)
                rep = rng.choice([x for x in LET if x != pat] + ([''] if rng.random() < 0.1 else []))
                whole = rng.random() < 0.6
                document = rng.choice(DOCS) if rng.random() < 0.2 else None
                args = {'field': field, 'pattern': pat, 'replacement': rep, 'whole': whole}
                if document:
                    args['document'] = document
                out = call_tool(ws, 'replace_in_field', args)
                spec = {'tool': 'replace_in_field', 'field': field, 'pattern': pat, 'replacement': rep,
                        'whole': whole, 'document': document}
            elif act == 'form':
                field = rng.choice(list(FIELDS))
                form = rng.choice(sorted({forms[t] for t in targets if t[2] == field}))
                val = rng.choice(LET)
                only = rng.random() < 0.5
                args = {'form': form, 'field': field, 'value': val, 'only_empty': only}
                out = call_tool(ws, 'set_field_for_form', args)
                spec = {'tool': 'set_field_for_form', 'field': field, 'form': form, 'value': val,
                        'only_empty': only, 'document': None}
            elif act == 'set':
                t = rng.choice(targets)
                v = stored[t] if rng.random() < 0.5 else rng.choice(VALS + ['D'])
                if DENSE and rng.random() < 0.5:
                    # A value a rule of the plan reads or writes.
                    v = rng.choice([x for sp in rule_specs.values() for x in (sp.get('pattern'), sp.get('replacement'),
                                                                               sp.get('value')) if x] or [v])
                args = {'document': t[0], 'refs': [t[1]], 'field': t[2], 'value': v}
                out = call_tool(ws, 'set_field', args)
                if not out.startswith('Error'):
                    model.set_field(t, v)
            elif act == 'values':
                dn = rng.choice(DOCS)
                wt = [t for t in targets if t[0] == dn and t[2] == 'Gloss']
                mt = [t for t in targets if t[0] == dn and t[2] == 'Morph Gloss']
                pick = rng.sample(wt, rng.randint(1, min(3, len(wt)))) + rng.sample(mt, rng.randint(1, min(3, len(mt))))
                v1 = rng.choice([stored[pick[0]], rng.choice(LET)])
                mv = [t for t in pick if t[2] == 'Morph Gloss']
                v2 = rng.choice([stored[mv[0]], rng.choice(LET)])
                args = {'document': dn, 'refs': [t[1] for t in pick], 'values': {'Gloss': v1, 'Morph Gloss': v2}}
                out = call_tool(ws, 'set_field', args)
                if not out.startswith('Error'):
                    for t in pick:
                        model.set_field(t, v1 if t[2] == 'Gloss' else v2)
            if act in ('replace', 'form'):
                # A rule that finds nothing is not staged.
                if not out.startswith('Error') and not out.startswith('Nothing to change'):
                    sk = json.dumps(spec, sort_keys=True)
                    # Asked again: its earlier copy goes, and it applies last (ruling b).
                    if sk in rule_specs:
                        model.entries = [e for e in model.entries
                                         if not (e[0] == 'rule' and json.dumps(e[1], sort_keys=True) == sk)]
                    rule_specs[sk] = spec
                    model.entries.append(('rule', spec))
            # Sync model with the rules the plan still holds.
            ops_rules = []
            for op in ws.ops:
                if core_rules.is_rule(op) and op.get('head') is not None:
                    a = op['args']
                    ops_rules.append(a)
            if act in ('replace', 'form'):
                # rules: keep model rules whose args are still present (count by order)
                remaining = []
                pool = list(ops_rules)
                for e in model.entries:
                    if e[0] != 'rule':
                        remaining.append(e)
                        continue
                    sp = e[1]
                    m = None
                    for i, a in enumerate(pool):
                        doc = doc_ids.get(sp['document']) if sp['document'] else None
                        if sp['tool'] == 'replace_in_field' and a.get('pattern') == sp['pattern'] and \
                                (a.get('replacement') or '') == sp['replacement'] \
                                and bool(a.get('whole')) == sp['whole'] \
                                and a.get('field') == sp['field'] and (a.get('document') or None) == doc:
                            m = i
                            break
                        if sp['tool'] == 'set_field_for_form' and a.get('form') == sp['form'] and \
                                a.get('value') == sp['value'] and a.get('field') == sp['field'] and \
                                bool(a.get('only_empty', True)) == sp['only_empty']:
                            m = i
                            break
                    if m is not None:
                        pool.pop(m)
                        remaining.append(e)
                    else:
                        rule_specs.pop(json.dumps(sp, sort_keys=True), None)
                model.entries = remaining
            log.append([step, act, args, (out or '')[:400]])
        # --- the plan as the user sees it
        p = ws.plan_payload()
        status = call_tool(ws, 'plan_status', {})
        res['status'] = status.splitlines()[0] if status else ''
        res['entries'] = [list(e[:1]) + [e[1] if e[0] != 'rule' else e[1]] + list(e[2:]) for e in model.entries]
        expected = model.run()
        exp_changed = {str(t): [stored[t], expected[t]] for t in stored if expected[t] != stored[t]}
        res['expected'] = exp_changed
        if p is None:
            res['summary'] = None
            res['ok'] = not exp_changed
            return res
        res['summary'] = p['summary']
        res['rows'] = [(r.get('change') or r.get('label'), (r.get('rule') or {}).get('total'), r.get('kept'),
                        r.get('writes_nothing')) for r in p['changes']]
        rows, total = proposed_changes(p['ops'], *AssistantService.proposed_keys)
        res['research'] = total
        payload, h, _ = approve(c, s.project_id, ws)
        as_applied(h)
        res['errors'] = h.errors
        res['done'] = [(d.get('applied'), d.get('message')) for d in h.done]
        fresh = Workspace(c, load_project(c, s.project_id))
        after = values_of(fresh)
        changed = {str(t): [stored[t], after[t]] for t in stored if after[t] != stored[t]}
        res['changed'] = changed
        res['card_n'] = parse_int_sum(p['summary']) if p['summary'] != 'no changes' else 0
        m = re.match(r'(\d+) planned change', res['status'])
        res['status_n'] = int(m.group(1)) if m else 0
        applied = res['done'][0][0] if res['done'] else None
        res['applied'] = applied
        checks = {
            'no_refusal': not h.errors,
            'model': changed == exp_changed,
            'card_eq_writes': res['card_n'] == len(changed),
            'status_eq_writes': res['status_n'] == len(changed),
            'research_eq_writes': total == len(changed),
            'applied_eq_writes': (applied or 0) == len(changed),
        }
        res['checks'] = checks
        res['ok'] = all(checks.values())
        return res
    finally:
        s.delete()


@pytest.mark.parametrize('case', range(START, START + N))
def test_gen(live_client, case):
    try:
        res = run_case(live_client, case)
    except Exception as e:  # noqa
        import traceback
        res = {'case': case, 'crash': traceback.format_exc()[-3000:], 'ok': False}
    if OUT:
        with open(OUT, 'a') as f:
            f.write(json.dumps(res, default=str) + '\n')
    assert res.get('ok'), json.dumps(res, default=str, indent=1)[:6000]
