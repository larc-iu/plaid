"""The drop invariant (Luke 2026-10-16): the plan after a drop is the plan the
requests left in it make when asked again from scratch, in the order they
were made, over the same stored data. A random sequence of requests (planned
analyses, form rules and whole-value replacements that reach them, values and
forms named on planned morphemes, a stored Gloss, rules asked again, drops of
one to three entries, resume_plan) is run on a live core. After every step the
plan is checked against a fresh workspace that asks the requests the plan
holds, in their order. At the end the plan is approved and what is written is
checked against the planned analyses.

``PLAN_REPLAY_CASES`` (10 by default), ``PLAN_REPLAY_START``,
``PLAN_REPLAY_STEPS`` (14) and ``PLAN_REPLAY_OUT`` (a jsonl of every case)."""
import json
import os
import random

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, as_applied, project, resumed, values_of
from test_rule_restate_live import _doc

from plaid_agent.core import rules
from plaid_agent.igt.bulk import NAMED_EDITS, SEQ, inert_rules, settle_named
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

N = int(os.environ.get('PLAN_REPLAY_CASES', '10'))
START = int(os.environ.get('PLAN_REPLAY_START', '0'))
STEPS = int(os.environ.get('PLAN_REPLAY_STEPS', '14'))
OUT = os.environ.get('PLAN_REPLAY_OUT')

SEGS = {'kan': [['ka', 'n'], ['k', 'an'], ['kan']], 'kaka': [['ka', 'ka'], ['kak', 'a']],
        'nka': [['n', 'ka'], ['nk', 'a']], 'kana': [['ka', 'n', 'a'], ['ka', 'na']]}
WORDS = {'Doc A': ['to', 'kan', 'kaka'], 'Doc B': ['kana', 'nka', 'to'], 'Doc C': ['ka', 'kan']}
VALUES = ['X', 'Y', 'Z', '']
FORMS = ['ka', 'n', 'a']


def _docs():
    return [_doc('d0', 'Doc A', [(w, '', [(w, '')]) for w in WORDS['Doc A']]),
            _doc('d1', 'Doc B', [(w, '', [(w, '')]) for w in WORDS['Doc B']]),
            # Stored morphemes a rule finds, one holding a value.
            _doc('d2', 'Doc C', [('ka', '', [('ka', 'X')]), ('kan', '', [('ka', ''), ('n', '')])])]


def _word_id(ws, doc, wi):
    return ws.doc(doc).sentences[0].words[wi].id


def _analysis_of(ws, wid):
    return next((o for o in ws.ops if o.get('kind') == 'set_analysis' and o.get('word_id') == wid), None)


def _inert(ws):
    """The rules of the plan that write nothing anywhere: they find nothing,
    rewrite no named value and set nothing in a planned analysis. A rule
    asked again leaves the rules it empties in the plan, named in its answer
    (Luke 2026-10-16, REV5-AGENT-5), where a request asked from scratch
    stages none. A drop takes every one of them."""
    ws.plan_view()
    return {rules.target(o) for o in inert_rules(ws, settle_named(ws))}


def _shape(ws):
    """The plan as the invariant compares it: each analysis by its word, the
    rules in plan order with their counts (less the ones :func:`_inert`
    names), every other entry by its target."""
    ana, rows, other = {}, [], {}
    inert = _inert(ws)
    for o in ws.plan_view():
        if o.get('kind') == 'set_analysis':
            ana[o['word_id']] = [(m['form'], m.get('morph_type'),
                                  sorted((f['layer_id'], f.get('value') or '') for f in m.get('fields') or []))
                                 for m in o['morphemes']]
        elif rules.is_rule(o):
            if rules.target(o) not in inert:
                rows.append([list(rules.target(o)), o.get('count')])
        else:
            other[json.dumps(ws.op_target(o), default=str)] = o.get('value')
    return {'analyses': ana, 'rules': rows, 'other': other}


class Log:
    """The requests the plan holds, in the order they were made: each a dict
    with the tool, its arguments and what it is in the plan."""

    def __init__(self):
        self.items = []
        self.n = 0

    def add(self, **kw):
        self.n += 1
        self.items.append(dict(kw, id=self.n))

    def of(self, ws, op):
        """The requests an entry of the plan stands for."""
        if op.get('kind') == 'set_analysis':
            a = next((x for x in self.items if x['t'] == 'ana' and x['wid'] == op['word_id']), None)
            return [x for x in self.items if x is a or (a and x['t'] == 'named' and x['ana'] == a['id'])]
        if rules.is_rule(op):
            return [x for x in self.items if x['t'] == 'rule' and x['key'] == rules.target(op)]
        t = json.dumps(ws.op_target(op), default=str)
        return [x for x in self.items if x['t'] == 'gloss' and x['target'] == t]


def _replay(c, pid, log):
    ws = Workspace(c, load_project(c, pid))
    for x in log.items:
        out = call_tool(ws, x['tool'], dict(x['args']))
        assert not out.startswith('Error'), (x, out)
    return ws


def _rule_args(rng):
    if rng.random() < 0.3:
        p, r = rng.choice(['X', 'Y', 'Z']), rng.choice(['X', 'Y', 'Z', 'W'])
        if p == r:
            r = 'W'
        return 'replace_in_field', {'field': 'Morph Gloss', 'pattern': p, 'replacement': r, 'whole': True}
    doc = rng.choice([None, None, 'Doc A', 'Doc B', 'Doc C'])
    return 'set_field_for_form', {'form': rng.choice(FORMS), 'field': 'Morph Gloss', 'value': rng.choice(VALUES),
                                  'only_empty': rng.random() < 0.35, **({'document': doc} if doc else {})}


def _rule_op(ws, key):
    return next((o for o in ws.ops if rules.is_rule(o) and rules.target(o) == key), None)


def run_case(c, case):
    rng = random.Random(case)
    s = seed(c, project(), {d['id']: d for d in _docs()}, {VOCAB: lexicon_raw()}, name=f'drop replay {case}')
    log, said = Log(), []
    res = {'case': case, 'said': said}
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        asked = []
        for step in range(STEPS):
            r = rng.random()
            if r < 0.2:
                doc = rng.choice(list(WORDS))
                wi = rng.choice([i for i, w in enumerate(WORDS[doc]) if w in SEGS])
                forms = rng.choice(SEGS[WORDS[doc][wi]])
                morphs = [{'form': f, **({'fields': {'Morph Gloss': rng.choice(VALUES[:3])}}
                                         if rng.random() < 0.4 else {})} for f in forms]
                args = {'document': doc, 'ref': f's1.w{wi + 1}', 'morphemes': morphs}
                out = call_tool(ws, 'set_analysis', args)
                said.append(['ana', args, out[:160]])
                wid = _word_id(ws, doc, wi)
                if _analysis_of(ws, wid) is not None and not out.startswith('Error'):
                    gone = [x for x in log.items if x['t'] == 'ana' and x['wid'] == wid]
                    log.items = [x for x in log.items if x not in gone and not (
                        x['t'] == 'named' and any(x['ana'] == g['id'] for g in gone))]
                    log.add(t='ana', wid=wid, tool='set_analysis', args=args)
            elif r < 0.5:
                if asked and rng.random() < 0.3:
                    tool, args = rng.choice(asked)
                else:
                    tool, args = _rule_args(rng)
                    asked.append((tool, args))
                before = {rules.target(o): o.get(SEQ) for o in ws.ops if rules.is_rule(o)}
                out = call_tool(ws, tool, dict(args))
                said.append(['rule', tool, args, out[:200]])
                for o in ws.ops:
                    if rules.is_rule(o) and o.get('tool') == tool and before.get(rules.target(o)) != o.get(SEQ):
                        # Staged now, at the end, an earlier copy gone.
                        log.items = [x for x in log.items if not (x['t'] == 'rule' and x['key'] == rules.target(o))]
                        log.add(t='rule', key=rules.target(o), tool=tool, args=args)
            elif r < 0.65:
                ana = [o for o in ws.ops if o.get('kind') == 'set_analysis']
                if not ana:
                    continue
                o = rng.choice(ana)
                doc_id = next(d['id'] for d in ws.documents() if ws.doc(d['id']).find(o['word_id']))
                doc = ws.doc(doc_id)
                wi = next(i for i, w in enumerate(doc.sentences[0].words) if w.id == o['word_id'])
                k = rng.randrange(len(o['morphemes']))
                ref = f's1.w{wi + 1}.m{k + 1}'
                if rng.random() < 0.15:
                    tool, args = 'set_morpheme', {'document': doc.name, 'ref': ref,
                                                  'form': rng.choice(['ka', 'kä', 'n', 'a'])}
                else:
                    tool, args = 'set_field', {'document': doc.name, 'refs': [ref], 'field': 'Morph Gloss',
                                               'value': rng.choice(VALUES)}
                had = len(o.get(NAMED_EDITS) or [])
                out = call_tool(ws, tool, args)
                said.append(['named', args, out[:160]])
                now = _analysis_of(ws, o['word_id'])
                if now is not None and len(now.get(NAMED_EDITS) or []) > had:
                    a = next(x for x in log.items if x['t'] == 'ana' and x['wid'] == o['word_id'])
                    log.add(t='named', ana=a['id'], tool=tool, args=args)
            elif r < 0.72:
                args = {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': rng.choice(['G', 'H', ''])}
                out = call_tool(ws, 'set_field', args)
                said.append(['gloss', args, out[:120]])
                t = json.dumps(('span', ws.project.field('Gloss').layer_id, _word_id(ws, 'Doc A', 0)), default=str)
                log.items = [x for x in log.items if not (x['t'] == 'gloss' and x['target'] == t)]
                if any(json.dumps(ws.op_target(o), default=str) == t for o in ws.ops):
                    log.add(t='gloss', target=t, tool='set_field', args=args)
            elif r < 0.92:
                if not ws.ops:
                    continue
                k = min(len(ws.ops), rng.choice([1, 1, 2, 3]))
                idx = sorted(rng.sample(range(1, len(ws.ops) + 1), k))
                gone = [x for i in idx for x in log.of(ws, ws.ops[i - 1])]
                out = call_tool(ws, 'drop_planned', {'indexes': idx})
                said.append(['drop', idx, out[:240]])
                assert not out.startswith('Error'), out
                inert = _inert(ws)
                if inert:
                    res.update(ok=False, where='inert after drop', step=step, inert=sorted(map(list, inert)))
                    return res
                log.items = [x for x in log.items if x not in gone]
                # What went with the drop: a rule asked from scratch would
                # not be staged either, which the comparison below checks.
                keys = {rules.target(o) for o in ws.ops if rules.is_rule(o)}
                log.items = [x for x in log.items if x['t'] != 'rule' or x['key'] in keys]
            else:
                if not ws.ops:
                    continue
                ws = resumed(c, s.project_id, ws)
                said.append(['resume'])
            got = _shape(ws)
            want = _shape(_replay(c, s.project_id, log))
            if got != want:
                res.update(ok=False, where='plan', step=step, got=got, want=want,
                           requests=[[x['tool'], x['args']] for x in log.items])
                return res
        p, h, _ = approve(c, s.project_id, ws)
        as_applied(h)
        if p is not None and h.errors:
            res.update(ok=False, where='approve', errors=[str(e)[:300] for e in h.errors])
            return res
        vals = values_of(Workspace(c, load_project(c, s.project_id)))
        for o in (p or {}).get('ops') or []:
            if o.get('kind') != 'set_analysis':
                continue
            doc = next(d for d in ws.documents() if ws.doc(d['id']).find(o['word_id']))
            name = ws.doc(doc['id']).name
            wi = next(i for i, w in enumerate(ws.doc(doc['id']).sentences[0].words) if w.id == o['word_id'])
            for k, m in enumerate(o['morphemes']):
                want_v = next((f.get('value') or '' for f in m.get('fields') or []), '')
                got_v = vals.get((name, f's1.w{wi + 1}.m{k + 1}', 'Morph Gloss'))
                if got_v != want_v:
                    res.update(ok=False, where='written', ref=f'{name} s1.w{wi + 1}.m{k + 1}', got_v=got_v,
                               want_v=want_v)
                    return res
        res.update(ok=True, steps=len(said), drops=sum(1 for x in said if x[0] == 'drop'),
                   resumes=sum(1 for x in said if x[0] == 'resume'))
        return res
    finally:
        s.delete()


def test_a_plan_after_a_drop_is_its_requests_asked_from_scratch(live_client):
    bad = []
    for case in range(START, START + N):
        try:
            res = run_case(live_client, case)
        except Exception as e:  # noqa: BLE001 - a crash is a failed case, written out
            import traceback
            res = {'case': case, 'ok': False, 'where': 'exception', 'err': traceback.format_exc()[-1500:],
                   'e': str(e)[:200]}
        if OUT:
            with open(OUT, 'a') as f:
                f.write(json.dumps(res, default=str) + '\n')
        if not res['ok']:
            bad.append(res)
    assert not bad, json.dumps(bad[0], default=str)[:4000]
