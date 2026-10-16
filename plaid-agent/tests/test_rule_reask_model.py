"""The REV5-AGENT review's sweep, kept as an oracle: random igt plans heavy
on rules asked again, values set back to stored or to what the rules bring,
drops of rules asked again and resume_plan mid-sequence, approved through
the service on a live core. The model replays the instructions in plan order:
a rule asked again leaves its old place and applies last (staying put only
when, so placed, it would change nothing), a keep holds its value out of
every rule, a dropped instruction leaves no trace. Every count must equal the
net changes, with no refusal and no restamp. ``RULE_REASK_CASES`` (10 by
default), ``RULE_REASK_START``, ``RULE_REASK_MIX`` (again or plain) and
``RULE_REASK_OUT`` (a file each case is written to)."""
import json
import os
import random
import re

import pytest

from live import live_client, seed  # noqa: F401
from rule_plan_model import (DOCS, FIELDS, LET, VALS, approve, as_applied, make_doc, parse_int_sum, project,
                             resumed, values_of)
from fixtures import lexicon_raw, VOCAB
from plaid_agent.core.conversation import proposed_changes
from plaid_agent.core import rules as core_rules
from plaid_agent.core.keep import is_keep
from plaid_agent.igt.project import load_project
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.workspace import Workspace
from plaid_agent.igt.toolkit import call_tool

OUT = os.environ.get('RULE_REASK_OUT')
N = int(os.environ.get('RULE_REASK_CASES', '10'))
START = int(os.environ.get('RULE_REASK_START', '0'))
MIX = os.environ.get('RULE_REASK_MIX', 'again')


def apply_rule(spec, t, v, form):
    if spec['field'] != t[2] or (spec.get('document') and spec['document'] != t[0]):
        return None
    if spec['tool'] == 'replace_in_field':
        if v == '':
            return None
        nv = (spec['replacement'] if v == spec['pattern'] else v) if spec['whole'] \
            else v.replace(spec['pattern'], spec['replacement'])
        return nv if nv != v else None
    if form != spec['form'] or v == spec['value'] or (spec['only_empty'] and v != ''):
        return None
    return spec['value']


class Model:
    def __init__(self, stored, forms):
        self.stored, self.forms, self.entries = dict(stored), forms, []

    def replay(self, entries=None):
        entries = self.entries if entries is None else entries
        kept = {e['t'] for e in entries if e['k'] == 'keep'}
        V = dict(self.stored)
        changed_by = set()
        for e in entries:
            if e['k'] == 'rule':
                for t in V:
                    if t in kept:
                        continue
                    nv = apply_rule(e['spec'], t, V[t], self.forms[t])
                    if nv is not None:
                        V[t] = nv
                        changed_by.add(e['key'])
            elif e['k'] == 'named':
                V[e['t']] = e['v']
        return V, changed_by

    def rule_takes(self, t):
        """A rule of the plan finds t: rules over stored values plus the
        rules before them, keeps (other than t) held out."""
        kept = {e['t'] for e in self.entries if e['k'] == 'keep'}
        V = dict(self.stored)
        for e in self.entries:
            if e['k'] != 'rule':
                continue
            for u in V:
                if u in kept and u != t:
                    continue
                nv = apply_rule(e['spec'], u, V[u], self.forms[u])
                if nv is not None:
                    if u == t:
                        return True
                    if u not in kept:
                        V[u] = nv
        return False

    def set_field(self, t, v):
        # A value named again is the latest instruction, after every rule
        # staged before it, whatever it held.
        self.entries = [e for e in self.entries if not (e['k'] in ('named', 'keep') and e['t'] == t)]
        if v == self.stored[t]:
            if self.rule_takes(t):
                self.entries.append({'k': 'keep', 't': t})
            return
        self.entries.append({'k': 'named', 't': t, 'v': v})

    def rule(self, spec):
        """Returns 'new', 'moved', 'stay' (fixer's exception) or 'none'."""
        key = json.dumps(spec, sort_keys=True)
        e = {'k': 'rule', 'spec': spec, 'key': key}
        had = any(x['k'] == 'rule' and x['key'] == key for x in self.entries)
        cand = [x for x in self.entries if not (x['k'] == 'rule' and x['key'] == key)] + [e]
        _V, by = self.replay(cand)
        if key not in by:
            # The model's own "finds nothing": the rule changes no value
            # (and so rewrites no named value) where it would stand.
            return 'stay' if had else 'none'
        # Whether staying would end the same: the plan may then stay.
        self.before, self.same = self.entries, _V == self.replay()[0]
        self.entries = cand
        return 'moved' if had else 'new'


def gen_case(case):
    rng = random.Random(case)
    docs, stored, forms = {}, {}, {}
    for i, name in enumerate(DOCS):
        d, s, f = make_doc(rng, f'd{i}', name, nsent=rng.choice([1, 2]), nword=rng.choice([2, 3]))
        docs[f'd{i}'] = d
        stored.update(s)
        forms.update(f)
    return rng, docs, stored, forms


def metas(c, doc_ids):
    out = {}
    for did in doc_ids:
        d = c.documents.get(did, include_body=True)
        for tl in d['text_layers']:
            for tk in tl['token_layers']:
                for sl in tk.get('span_layers') or []:
                    for s in sl.get('spans') or []:
                        out[(sl['id'], tuple(s.get('tokens') or []))] = (s.get('value'),
                                                                         json.dumps(s.get('metadata'), sort_keys=True))
    return out


def run_case(c, case):
    rng, docs, stored, forms = gen_case(case)
    s = seed(c, project(), docs, {VOCAB: lexicon_raw()}, name=f'rule reask {case}')
    log, flags = [], []
    res = {'case': case, 'log': log, 'flags': flags}
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        assert values_of(ws) == stored
        idmap = {}
        for d in ws.documents():
            doc = ws.doc(d['id'])
            for si, sn in enumerate(doc.sentences, start=1):
                for wi, w in enumerate(sn.words, start=1):
                    idmap[w.id] = (doc.name, f's{si}.w{wi}', 'Gloss')
                    for mi, m in enumerate(w.morphemes, start=1):
                        idmap[m.id] = (doc.name, f's{si}.w{wi}.m{mi}', 'Morph Gloss')
        doc_ids = {d['name']: d['id'] for d in ws.documents()}
        id_docs = {v: k for k, v in doc_ids.items()}
        model = Model(stored, forms)
        targets = list(stored)
        asked_specs = []
        nsteps = rng.randint(4, 10)
        acts = ['replace', 'form', 'again', 'set', 'set_back', 'values', 'drop', 'resume']
        w = {'again': [4, 1.5, 3, 2, 1.5, 1, 1.5, 0.7], 'plain': [4, 2, 1, 3, 1, 1.5, 1, 0.7]}[MIX]
        did_resume = False
        def rebuild():
            """The model asked the plan's requests again, in order: a drop
            asks every remaining one again from scratch (Luke 2026-10-16).
            Which requests a drop takes is not under test here."""
            m = Model(stored, forms)
            for rec in ws.requests:
                a, gone = rec['args'], set()
                for k in rec.get('without') or ():
                    k = json.loads(k)
                    if k[0] == 'value' and isinstance(k[1], list) and k[1][-1] in idmap:
                        gone.add(idmap[k[1][-1]])
                if rec['tool'] in ('replace_in_field', 'set_field_for_form'):
                    spec = ({'tool': 'replace_in_field', 'field': a['field'], 'pattern': a['pattern'],
                             'replacement': a.get('replacement') or '', 'whole': bool(a.get('whole')),
                             'document': a.get('document')} if rec['tool'] == 'replace_in_field' else
                            {'tool': 'set_field_for_form', 'field': a['field'], 'form': a['form'], 'value': a['value'],
                             'only_empty': bool(a.get('only_empty', True)), 'document': None})
                    if m.rule(spec) == 'moved' and m.same:
                        m.entries = m.before
                elif rec['tool'] == 'set_field':
                    pairs = list(a['values'].items()) if a.get('values') else [(a['field'], a['value'])]
                    for ref in a['refs']:
                        for field, v in pairs:
                            t = (a['document'], ref, field)
                            if t in stored and t not in gone:
                                m.set_field(t, v)
            # Where asking again moves a rule or leaves it is not under test
            # after a drop: the plan's order is taken where it ends the same.
            cr = code_rules()
            slots = [i for i, e in enumerate(m.entries) if e['k'] == 'rule']
            if sorted(cr) == sorted(m.entries[i]['key'] for i in slots):
                by = {m.entries[i]['key']: m.entries[i] for i in slots}
                cand = list(m.entries)
                for i, k in zip(slots, cr):
                    cand[i] = by[k]
                if m.replay(cand)[0] == m.replay()[0]:
                    m.entries = cand
            return m

        def spec_of(op):
            a = op['args']
            if op['tool'] == 'replace_in_field':
                return {'tool': 'replace_in_field', 'field': a['field'], 'pattern': a['pattern'],
                        'replacement': a.get('replacement') or '', 'whole': bool(a.get('whole')),
                        'document': id_docs.get(a.get('document')) if a.get('document') else None}
            return {'tool': 'set_field_for_form', 'field': a['field'], 'form': a['form'], 'value': a['value'],
                    'only_empty': bool(a.get('only_empty', True)), 'document': None}

        def code_rules():
            return [json.dumps(spec_of(op), sort_keys=True) for op in ws.ops
                    if core_rules.is_rule(op) and op.get('head') is not None]

        def code_named():
            out = {}
            for op in ws.ops:
                if op.get('kind') == 'set_span' and op.get('token_id') in idmap:
                    out[idmap[op['token_id']]] = ('named', op.get('value') or '')
                elif is_keep(op) and op.get('token_id') in idmap:
                    out[idmap[op['token_id']]] = ('asked', (op.get('asked') or {}).get('value')) \
                        if op.get('asked') else ('keep', None)
            return out

        for step in range(nsteps):
            act = rng.choices(acts, w)[0]
            if act == 'again' and not asked_specs:
                act = 'replace'
            if act in ('drop', 'resume') and not ws.ops:
                act = 'replace'
            if act == 'resume' and did_resume:
                act = 'set'
            out, args, mres = None, None, None
            if act in ('replace', 'form', 'again'):
                if act == 'again':
                    spec = dict(rng.choice(asked_specs))
                elif act == 'replace':
                    field = rng.choice(list(FIELDS))
                    prev = [sp['replacement'] for sp in asked_specs if sp['tool'] == 'replace_in_field' and sp['replacement']]
                    pat = rng.choice(prev) if prev and rng.random() < 0.5 else rng.choice(LET[:3])
                    rep = rng.choice([x for x in LET if x != pat])
                    spec = {'tool': 'replace_in_field', 'field': field, 'pattern': pat, 'replacement': rep,
                            'whole': rng.random() < 0.6, 'document': rng.choice(DOCS) if rng.random() < 0.3 else None}
                else:
                    field = rng.choice(list(FIELDS))
                    form = rng.choice(sorted({forms[t] for t in targets if t[2] == field}))
                    spec = {'tool': 'set_field_for_form', 'field': field, 'form': form, 'value': rng.choice(LET),
                            'only_empty': rng.random() < 0.4, 'document': None}
                if spec['tool'] == 'replace_in_field':
                    args = {k: spec[k] for k in ('field', 'pattern', 'replacement', 'whole')}
                    if spec['document']:
                        args['document'] = spec['document']
                else:
                    args = {k: spec[k] for k in ('form', 'field', 'value', 'only_empty')}
                out = call_tool(ws, spec['tool'], args)
                if spec not in asked_specs:
                    asked_specs.append(spec)
                mres = model.rule(spec)
                said_stay = 'which stays where it is' in out
                said_moved = 'that copy is gone' in out
                if mres == 'stay' and not said_stay:
                    flags.append(['stay_disagree', step, mres, out[:300]])
                if said_stay and mres == 'moved' and model.same:
                    # Staying ends where moving would: the model follows the plan.
                    model.entries = model.before
                elif said_stay and mres != 'stay':
                    flags.append(['stay_disagree', step, mres, out[:300]])
                if mres == 'moved' and not said_moved:
                    # moved to the end of an op list where it was not last
                    pass
            elif act in ('set', 'set_back'):
                t = rng.choice(targets)
                v = stored[t] if act == 'set_back' else rng.choice(VALS + ['D'])
                if act == 'set_back' and rng.random() < 0.5:
                    # a value that some rule of the plan writes: the model sets
                    # a value back to what the rules bring
                    V, _ = model.replay()
                    v = V[t]
                args = {'document': t[0], 'refs': [t[1]], 'field': t[2], 'value': v}
                out = call_tool(ws, 'set_field', args)
                if not out.startswith('Error'):
                    model.set_field(t, v)
            elif act == 'values':
                dn = rng.choice(DOCS)
                wt = [t for t in targets if t[0] == dn and t[2] == 'Gloss']
                mt = [t for t in targets if t[0] == dn and t[2] == 'Morph Gloss']
                pick = rng.sample(wt, rng.randint(1, min(3, len(wt)))) + rng.sample(mt, rng.randint(1, min(2, len(mt))))
                v1 = rng.choice([stored[pick[0]], rng.choice(LET)])
                mv = [t for t in pick if t[2] == 'Morph Gloss']
                v2 = rng.choice([stored[mv[0]], rng.choice(LET)])
                args = {'document': dn, 'refs': [t[1] for t in pick], 'values': {'Gloss': v1, 'Morph Gloss': v2}}
                out = call_tool(ws, 'set_field', args)
                if not out.startswith('Error'):
                    for t in pick:
                        model.set_field(t, v1 if t[2] == 'Gloss' else v2)
            elif act == 'drop':
                i = rng.randint(1, len(ws.ops))
                args = {'indexes': [i]}
                out = call_tool(ws, 'drop_planned', args)
                model = rebuild()
            elif act == 'resume':
                ws = resumed(c, s.project_id, ws)
                did_resume = True
                args, out = {}, 'resumed'
            # rules the code dropped as finding nothing go from the model too
            cr = code_rules()
            mr = [e['key'] for e in model.entries if e['k'] == 'rule']
            if cr != mr:
                gone = [k for k in mr if k not in cr]
                if [k for k in mr if k in cr] != cr:
                    flags.append(['rule_order', step, mr, cr])
                    model.entries = [e for e in model.entries if e['k'] != 'rule'] + \
                        [{'k': 'rule', 'spec': json.loads(k), 'key': k} for k in cr]
                else:
                    _V0, _ = model.replay()
                    model.entries = [e for e in model.entries if not (e['k'] == 'rule' and e['key'] in gone)]
                    _V1, _ = model.replay()
                    if _V0 != _V1:
                        flags.append(['rule_gone_changed_result', step, gone])
            log.append([step, act, args, mres, (out or '')[:500]])
        # --- the plan as the user sees it
        expected, _ = model.replay()
        exp_changed = {str(t): [stored[t], expected[t]] for t in stored if expected[t] != stored[t]}
        res['expected'] = exp_changed
        res['entries'] = model.entries
        p = ws.plan_payload()
        status = call_tool(ws, 'plan_status', {})
        res['status'] = status
        before = metas(c, doc_ids.values())
        if p is None:
            res['ok'] = not exp_changed and not flags
            res['checks'] = {'model': not exp_changed}
            return res
        res['summary'] = p['summary']
        res['rows'] = [(r.get('change') or r.get('label'), (r.get('rule') or {}).get('total'), r.get('kept'),
                        r.get('writes_nothing')) for r in p['changes']]
        _rows, total = proposed_changes(p['ops'], *AssistantService.proposed_keys)
        res['research'] = total
        _p, h, _ = approve(c, s.project_id, ws)
        as_applied(h)
        res['errors'] = h.errors
        res['done'] = [(d.get('applied'), d.get('message')) for d in h.done]
        after = values_of(Workspace(c, load_project(c, s.project_id)))
        changed = {str(t): [stored[t], after[t]] for t in stored if after[t] != stored[t]}
        res['changed'] = changed
        am = metas(c, doc_ids.values())
        restamped = [str(k) for k in set(before) | set(am) if before.get(k) != am.get(k)
                     and (before.get(k) or (None,))[0] == (am.get(k) or (None,))[0]]
        res['restamped'] = restamped
        card_n = parse_int_sum(p['summary']) if p['summary'] != 'no changes' else 0
        m = re.match(r'(\d+) planned change', status)
        status_n = int(m.group(1)) if m else 0
        applied = res['done'][0][0] if res['done'] else None
        res['nums'] = [card_n, status_n, total, applied, len(changed)]
        checks = {
            'no_refusal': not h.errors,
            'model': changed == exp_changed,
            'card': card_n == len(changed),
            'status': status_n == len(changed),
            'research': total == len(changed),
            'applied': (applied or 0) == len(changed),
            'no_restamp': not restamped,
            'no_flags': not flags,
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
    except Exception:  # noqa
        import traceback
        res = {'case': case, 'crash': traceback.format_exc()[-3000:], 'ok': False}
    if OUT:
        with open(OUT, 'a') as f:
            f.write(json.dumps(res, default=str) + '\n')
    assert res.get('ok'), json.dumps(res, default=str, indent=1)[:6000]
