"""The drop invariant in ud and umr (Luke 2026-10-16, REV7-PLAN-4, built for
igt in FX-H-PLAN): the plan after a drop is the plan its remaining requests
make when asked again from scratch, in the order they were made, over the
same stored data. Every remaining request, one answered "Nothing to change"
included.

ud's plan reads itself as it is made: a keep is made only while a scope in
the plan takes the value, a value set again to what the plan already writes
plans nothing, a value set back to what is stored takes the planned change
back, a feature or a head is worked out over the plan's own. Dropped in
place, a keep a later scope still takes stayed where, asked from scratch, the
scope takes the value; so a drop asks the requests again (core/requests.py).

The generator runs a random sequence of requests on one workspace (the
fixture client, two documents with machine values; ud's query engine is the
documents themselves):

  ud   set_field, set_feature, set_head, del_relation (one word each),
       confirm and discard_predictions (one word and field, or a whole
       document), replace_in_field over the corpus or one document, a scope
       asked again
  umr  set_attributes, set_attribute_for_concept, add_triple, delete_triple
  both resume_plan into a new workspace, drop_planned by 1 to 3 numbers, by
       field, or by document

Every request that was not refused is logged with the entry it stands for,
by this file's own reading of the plan before and after it. A drop marks the
requests of the entries it removes, and a drop by field or document also the
requests that stand for nothing in the plan and ask for what it names. After
every drop and every resume, a fresh workspace asks the unmarked requests in
order, and its whole plan payload must equal the workspace's. At the end the
plan is approved through the service.

``UD_UMR_REPLAY_CASES`` (40 by default), ``UD_UMR_REPLAY_START``,
``UD_UMR_REPLAY_STEPS`` (18), ``UD_UMR_REPLAY_OUT`` (a jsonl of every case).
"""
import copy
import json
import os
import random

import pytest

import ud_fixtures as ud_fx
import umr_fixtures as umr_fx
from test_grew_search import _renamed
from test_replaced_work_corpus import _store
from test_stale_by_sentence import APPS, _approve, _layer

from plaid_agent.core import keep as _keep, opkind

START = int(os.environ.get('UD_UMR_REPLAY_START', '0'))
CASES = int(os.environ.get('UD_UMR_REPLAY_CASES', '40'))
STEPS = int(os.environ.get('UD_UMR_REPLAY_STEPS', '18'))
OUT = os.environ.get('UD_UMR_REPLAY_OUT')
NONE = ('none',)

#: What a stored op carries about how it was staged or counted rather than
#: what it writes, read past by this file's own entry keys.
VOLATILE = ('count', 'per_field', 'label', 'found', 'card', 'matched', 'replaces_accepted',
            'contributed_count', 'staging')


def is_err(out):
    return str(out).startswith('Error')


def payload(ws):
    p = ws.plan_payload()
    if p is None:
        return None
    p = json.loads(json.dumps(p, default=str))
    p.pop('id', None)
    for op in p.get('ops') or []:
        op.pop('staging', None)
    p['documents'] = sorted(p.get('documents') or [], key=lambda d: d.get('id') or '')
    return p


def diff(a, b, path=''):
    if type(a) != type(b):
        return [f'{path}: {json.dumps(a, default=str)[:300]} != {json.dumps(b, default=str)[:300]}']
    if isinstance(a, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out += diff(a.get(k), b.get(k), f'{path}.{k}')
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [f'{path}: len {len(a)} != {len(b)}: {json.dumps(a, default=str)[:600]} || '
                    f'{json.dumps(b, default=str)[:600]}']
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f'{path}[{i}]')
        return out
    return [] if a == b else [f'{path}: {a!r} != {b!r}']


# --- the two apps ------------------------------------------------------------------

def engine_rows(client, project, field, document_id, cap):
    """ud's query engine as these tests read it: every value of the field in
    the documents themselves, which ``bulk.changes`` narrows to the ones the
    replacement changes."""
    from plaid_agent.ud.project import load_document
    rows = []
    for did in sorted(client._documents):
        if document_id and did != document_id:
            continue
        doc = load_document(client, project, did)
        for s in doc.sentences:
            for w in s.words:
                if field == 'deprel':
                    if w.relation_id:
                        rows.append([{'id': w.relation_id, 'value': w.deprel, 'document': did,
                                      'source': w.relation_id if w.head == 0 else None,
                                      'target': w.relation_id, 'metadata': w.relation_metadata}])
                    continue
                for sp in w.spans(field):
                    rows.append([{'id': sp.id, 'value': sp.value, 'document': did, 'layer': sp.layer_id,
                                  'metadata': sp.metadata},
                                 {'id': w.id, 'document': did, 'begin': 0}])
    return rows[:cap + 1]


class UdApp:
    name = 'ud'
    docs = ('Viaje', 'Viaje dos')
    fields = ('lemma', 'upos')

    def __init__(self, rng, monkeypatch):
        from plaid_agent.ud import bulk
        self.rng = rng
        raws = {'ud1': ud_fx.document_raw(), 'b-ud1': _renamed(ud_fx.document_raw(), 'b-', 'Viaje dos')}
        for raw in raws.values():
            for layer in (ud_fx.UPOS, ud_fx.LEMMA):
                for sp in _layer(raw, layer)['spans']:
                    sp.pop('metadata', None)
                    r = rng.random()
                    if r < 0.4:
                        sp['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
                    elif r < 0.5:
                        sp['metadata'] = {'prov': 'contributed', 'provSource': 'user:c@x'}
            for rel in _layer(raw, ud_fx.LEMMA)['relation_layers'][0]['relations']:
                if rng.random() < 0.4:
                    rel['metadata'] = {'prov': 'inferred', 'provSource': 'service:ud:parse'}
        self.client = ud_fx.FakeClient(project=ud_fx.project_raw(), documents=raws)
        monkeypatch.setattr(bulk, 'matches', self._matches)

    def _matches(self, c, field, spec, document_id, cap):
        return engine_rows(self.client, self.project, field, document_id, cap)

    def workspace(self):
        from plaid_agent.ud.project import load_project
        from plaid_agent.ud.tools import Workspace
        self.project = load_project(self.client, ud_fx.PID)
        return Workspace(self.client, self.project)

    def call(self, ws, tool, args):
        from plaid_agent.ud.toolkit import call_tool
        return call_tool(ws, tool, args)

    def words(self, ws, doc):
        d = ws.doc(doc)
        return [f's{s.index}.w{w.index}' for s in d.sentences for w in s.words]

    def step(self, ws):
        rng, doc = self.rng, self.rng.choice(self.docs)
        refs = self.words(ws, doc)
        r = rng.random()
        if r < 0.22:
            field = rng.choice(self.fields)
            vals = (['ir', 'mar', 'a', 'el', 'correr', ''] if field == 'lemma'
                    else ['VERB', 'NOUN', 'PROPN', 'ADP', 'DET', 'PUNCT', 'AUX'])
            return 'set_field', {'document': doc, 'refs': [rng.choice(refs)], 'field': field,
                                 'value': rng.choice(vals)}
        if r < 0.28:
            return 'set_feature', {'document': doc, 'refs': [rng.choice(refs)], 'feature': 'Number',
                                   'value': rng.choice(['Sing', 'Plur', ''])}
        if r < 0.36:
            ref = rng.choice(refs)
            s = ref.split('.')[0]
            heads = [0] + [int(x.split('.w')[1]) for x in refs if x.startswith(s + '.')]
            return 'set_head', {'document': doc, 'ref': ref, 'head': rng.choice(heads),
                                'deprel': rng.choice(['obl', 'nmod', 'punct', 'root', 'case'])}
        if r < 0.40:
            return 'del_relation', {'document': doc, 'refs': [rng.choice(refs)]}
        if r < 0.52:
            tool = rng.choice(['confirm', 'discard_predictions'])
            if rng.random() < 0.5:
                return tool, {'document': doc, 'refs': [rng.choice(refs)], 'field': rng.choice(self.fields)}
            a = {'document': doc}
            if rng.random() < 0.6:
                a['field'] = rng.choice(self.fields + ('deprel',))
            return tool, a
        if r < 0.62:
            field = rng.choice(self.fields)
            pats = ['ar', 'mar', 'e', 'a'] if field == 'lemma' else ['NOUN', 'VERB', 'N', 'P']
            a = {'field': field, 'pattern': rng.choice(pats),
                 'replacement': rng.choice(['ER', 'mares', 'PROPN', 'AUX', 'x'])}
            if field == 'upos':
                a['whole'] = True
                a['replacement'] = rng.choice(['PROPN', 'AUX', 'NOUN', 'VERB'])
            if rng.random() < 0.3:
                a['document'] = doc
            return 'replace_in_field', a
        return None

    def scope_tool(self, tool, args):
        return tool == 'replace_in_field' or (tool in ('confirm', 'discard_predictions') and not args.get('refs'))

    def scope_target(self, ws, tool, args):
        """The scope a call stages, by its registry target, from the call."""
        doc = ws.resolve_document_id(args['document']) if args.get('document') else None
        if tool == 'replace_in_field':
            return ('replace', args['field'], args['pattern'], args['replacement'], doc)
        return ('scope', 'confirm_scope' if tool == 'confirm' else 'discard_scope', doc)


class UmrApp:
    name = 'umr'
    docs = ('Story',)
    fields = ()

    def __init__(self, rng, monkeypatch):
        self.rng = rng
        self.client = umr_fx.FakeClient()
        for sp in _layer(self.client._documents['umr1'], umr_fx.CONCEPT_LAYER)['spans']:
            if rng.random() < 0.4:
                sp['metadata']['prov'] = 'inferred'

    def workspace(self):
        from plaid_agent.umr.project import load_project
        from plaid_agent.umr.tools import Workspace
        return Workspace(self.client, load_project(self.client, umr_fx.PID))

    def call(self, ws, tool, args):
        from plaid_agent.umr.toolkit import call_tool
        return call_tool(ws, tool, args)

    def step(self, ws):
        rng = self.rng
        r = rng.random()
        if r < 0.3:
            s, var = rng.choice([(1, 's1b'), (1, 's1d'), (2, 's2r'), (2, 's2t')])
            line = rng.choice([':aspect state', ':aspect performance', ':polarity -', '',
                               ':aspect state :polarity -', ':refer-number singular'])
            return 'set_attributes', {'document': 'Story', 'sentence': s, 'var': var, 'line': line}
        if r < 0.55:
            a = {'document': 'Story', 'concept': rng.choice(['bark-01', 'run-01', 'dog', 'thing', '-01']),
                 'rel': rng.choice([':aspect', ':polarity']), 'value': rng.choice(['state', 'performance', '-', ''])}
            if rng.random() < 0.4:
                a['overwrite'] = True
            return 'set_attribute_for_concept', a
        if r < 0.7:
            # Between nodes the document has: a constant's node is a second
            # entry of the same call.
            a, b = rng.sample(['s1b', 's2r', 's1d', 's2t'], 2)
            return 'add_triple', {'document': 'Story', 'a': a, 'rel': rng.choice([':before', ':after', ':overlap']),
                                  'b': b}
        if r < 0.75:
            return 'delete_triple', {'document': 'Story', 'a': 's2t', 'rel': ':same-entity', 'b': 's1d'}
        return None

    def scope_tool(self, tool, args):
        return tool == 'set_attribute_for_concept'

    def scope_target(self, ws, tool, args):
        return ('attrs_scope', ws.resolve_document_id(args['document']), args['concept'], args['rel'])


# --- the case ----------------------------------------------------------------------

def hkey(ws, op):
    """This file's entry key: what an op writes to, a keep by the value it
    keeps, else what it holds."""
    if _keep.is_keep(op):
        return ('value', json.dumps(list(op['kept']), default=str))
    t = opkind.target_of(ws.KIND, op)
    if t is not None:
        return ('value', json.dumps(list(t), default=str))
    return ('op', json.dumps({k: v for k, v in op.items() if k not in VOLATILE}, sort_keys=True, default=str))


def held(ws):
    out = {}
    for op in ws.ops:
        out.setdefault(hkey(ws, op), []).append(
            json.dumps({k: v for k, v in op.items() if k not in VOLATILE}, sort_keys=True, default=str))
    return out


class Case:
    def __init__(self, app_cls, n, monkeypatch):
        self.rng = random.Random(n)
        self.app = app_cls(self.rng, monkeypatch)
        self.ws = self.app.workspace()
        self.log = []    # [tool, args, key, dropped]
        self.trace = []

    def key_of(self, ws, tool, args, out, before):
        after = held(ws)
        changed = [k for k, v in after.items() if before.get(k) != v]
        if self.app.scope_tool(tool, args) and str(out).startswith('Planned'):
            # A scope it staged, changed or not: a scope asked twice is one
            # entry, and both asks stand for it (as a rule asked twice in igt).
            want = self.app.scope_target(ws, tool, args)
            hit = [hkey(ws, o) for o in ws.ops if opkind.resolver(ws.KIND, o) and opkind.target_of(ws.KIND, o) == want]
            assert hit, (tool, args, want)
            return hit[0]
        if not changed:
            return NONE
        assert len(changed) == 1, (tool, args, changed)
        return changed[0]

    def call(self, tool, args):
        before = held(self.ws)
        out = self.app.call(self.ws, tool, args)
        self.trace.append([tool, args, str(out)[:300]])
        if is_err(out):
            return out
        self.log.append([tool, args, self.key_of(self.ws, tool, args, out, before), False])
        return out

    def step(self):
        r = self.rng.random()
        if r < 0.72:
            req = self.app.step(self.ws)
            if req:
                self.call(*req)
            return None
        if r < 0.78:
            asked = [e for e in self.log if self.app.scope_tool(e[0], e[1])]
            if asked:
                e = self.rng.choice(asked)
                self.call(e[0], copy.deepcopy(e[1]))
            return None
        if r < 0.83:
            if self.ws.ops:
                self.ws = self.resumed()
                self.trace.append(['RESUME'])
                return 'check'
            return None
        return self.drop()

    def resumed(self):
        w1 = self.ws
        p = w1.plan_payload()
        w2 = self.app.workspace()
        w2.waiting = {'count': len(w1.ops), 'summary': p['summary'], 'id': p['id'], 'documents': p['documents']}
        state = json.loads(json.dumps(w1.plan_state(), default=str))
        w2.load_plan_state = lambda plan_id: state if plan_id == p['id'] else None
        out = self.app.call(w2, 'resume_plan', {})
        assert out.startswith('Took over'), out
        return w2

    def drop(self):
        rng = self.rng
        n = len(self.ws.ops)
        if not n:
            return None
        q = rng.random()
        if q < 0.12 and self.app.fields:
            args = {'field': rng.choice(self.app.fields)}
        elif q < 0.22:
            args = {'document': rng.choice(self.app.docs)}
        else:
            k = min(n, rng.choice([1, 1, 1, 2, 2, 3]))
            args = {'indexes': sorted(rng.sample(range(1, n + 1), k))}
        ops = list(self.ws.ops)
        live = {hkey(self.ws, o) for o in ops}
        out = self.app.call(self.ws, 'drop_planned', args)
        self.trace.append(['drop_planned', args, str(out)[:400]])
        if is_err(out):
            return None
        if 'indexes' in args:
            gone = {hkey(self.ws, ops[i - 1]) for i in args['indexes']}
        else:
            # What the drop names (this file reads the entries as plan_status
            # numbers them): the entries that matched it.
            gone = {hkey(self.ws, o) for o in ops if self._matches(o, args)}
        for e in self.log:
            if e[3]:
                continue
            if e[2] in gone:
                e[3] = True
            elif 'indexes' not in args and e[2] not in live and self._asks_for(e, args):
                e[3] = True
        return 'check'

    def _matches(self, op, args):
        if 'field' in args:
            return args['field'].casefold() in {f.casefold() for f in self.ws.op_fields(op)}
        did = self.ws.resolve_document_id(args['document'])
        docs = self.ws.op_documents(op)
        return did in docs and len(docs) == 1

    def _asks_for(self, e, args):
        a = e[1]
        if 'field' in args:
            return isinstance(a.get('field'), str) and a['field'].casefold() == args['field'].casefold()
        return bool(a.get('document')) and self.ws.resolve_document_id(a['document']) == \
            self.ws.resolve_document_id(args['document'])

    def replay(self):
        """A fresh workspace asking the requests left, in order. A request
        that stood for nothing and now stages an entry stands for it from now
        on, so a drop of that entry takes it."""
        fresh = self.app.workspace()
        outs = []
        for e in self.log:
            tool, args, key, dropped = e
            if dropped:
                continue
            before = held(fresh)
            out = str(self.app.call(fresh, tool, copy.deepcopy(args)))
            outs.append([tool, args, out[:200]])
            if not is_err(out):
                now = self.key_of(fresh, tool, args, out, before)
                if key == NONE or now != NONE:
                    e[2] = now
        return fresh, outs


def run_case(app_cls, n, monkeypatch):
    res = {'app': app_cls.name, 'seed': n, 'fails': [], 'drops': 0, 'resumes': 0}
    case = Case(app_cls, n, monkeypatch)
    for _ in range(STEPS):
        if case.step() != 'check':
            continue
        res['resumes' if case.trace[-1][0] == 'RESUME' else 'drops'] += 1
        fresh, outs = case.replay()
        d = diff(payload(case.ws), payload(fresh))
        if d:
            res['fails'].append({'at': len(case.trace), 'diff': d[:8], 'replay': outs,
                                 'log': [[e[0], e[1], list(e[2]), e[3]] for e in case.log]})
            break
    if not res['fails'] and case.ws.ops:
        spec = APPS[app_cls.name]()
        plan = _store(case.ws, case.app.client, spec['pid'], app_cls.name)
        h = _approve(spec, case.app.client, plan)
        errors = [e for e in h.errors if not e.startswith('Nothing to write.')]
        if errors or not (h.done or h.errors):
            res['fails'].append({'approve': h.errors})
    res['trace'] = case.trace
    return res


@pytest.mark.parametrize('app_cls', [UdApp, UmrApp], ids=['ud', 'umr'])
def test_a_plan_after_a_drop_is_every_remaining_request_asked_from_scratch(app_cls, monkeypatch):
    bad, drops = [], 0
    for n in range(START, START + CASES):
        try:
            r = run_case(app_cls, n, monkeypatch)
        except Exception:  # noqa: BLE001 - a crash is a failed case, written out
            import traceback
            r = {'app': app_cls.name, 'seed': n, 'fails': [{'crash': traceback.format_exc()[-2500:]}]}
        drops += r.get('drops', 0)
        if OUT:
            with open(OUT, 'a') as f:
                f.write(json.dumps(r, default=str) + '\n')
        if r['fails']:
            bad.append(r)
    assert not bad, json.dumps(bad[0], default=str)[:5000]
    assert drops, 'the sweep dropped nothing'


# --- directed shapes ------------------------------------------------------------------

def _ud_ws(monkeypatch):
    from plaid_agent.ud import bulk
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    client = ud_fx.ud_client()
    project = load_project(client, ud_fx.PID)
    monkeypatch.setattr(bulk, 'matches', lambda c, field, spec, did, cap: engine_rows(client, project, field,
                                                                                        did, cap))
    return client, project, lambda: Workspace(client, project)


def _ask(app, ws, *reqs):
    for tool, args in reqs:
        out = app(ws, tool, copy.deepcopy(args))
        assert not is_err(out), (tool, out)


def test_ud_a_keep_a_later_scope_still_takes_goes_when_its_own_scope_is_dropped(monkeypatch):
    """The first replacement made the keep; the second also takes the
    value. Dropped in place, the keep stayed and held the value out of the
    second. Asked from scratch, the keep is never made, and the second
    replacement takes the value."""
    from plaid_agent.ud.toolkit import call_tool
    client, project, new_ws = _ud_ws(monkeypatch)
    reqs = [('replace_in_field', {'field': 'upos', 'pattern': 'NOUN', 'replacement': 'PROPN', 'whole': True}),
            ('set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'}),
            ('replace_in_field', {'field': 'upos', 'pattern': 'OU', 'replacement': 'AU'})]
    ws = new_ws()
    _ask(call_tool, ws, *reqs)
    assert [o['kind'] for o in ws.ops] == ['replace_scope', 'keep', 'replace_scope']
    out = call_tool(ws, 'drop_planned', {'indexes': [1]})
    assert '1 value kept out of it went with it' in out, out
    assert [o['kind'] for o in ws.ops] == ['replace_scope']
    assert ws.ops[0]['count'] == 1
    scratch = new_ws()
    _ask(call_tool, scratch, reqs[1], reqs[2])
    assert payload(ws) == payload(scratch)


def test_ud_a_value_asked_twice_comes_back_from_its_second_ask_when_dropped(monkeypatch):
    """The second ask planned nothing (the plan wrote that value already):
    it stands for no entry, so it remains, and asked from scratch it plans
    the value (Luke 2026-10-16: every remaining request, one answered
    "Nothing to change" included). As in igt."""
    from plaid_agent.ud.toolkit import call_tool
    client, project, new_ws = _ud_ws(monkeypatch)
    ask = ('set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'andar'})
    ws = new_ws()
    _ask(call_tool, ws, ask, ask)
    out = call_tool(ws, 'drop_planned', {'indexes': [1]})
    assert 'back in it' in out, out
    scratch = new_ws()
    _ask(call_tool, scratch, ask)
    assert payload(ws) == payload(scratch)


def test_ud_a_scope_asked_twice_goes_whole_with_its_entry(monkeypatch):
    """Both asks stand for the one confirmation of the document, the second
    one wider or not, so dropping it takes both (as a rule asked twice in
    igt)."""
    from plaid_agent.ud.toolkit import call_tool
    client, project, new_ws = _ud_ws(monkeypatch)
    ws = new_ws()
    _ask(call_tool, ws, ('confirm', {'document': 'Viaje'}), ('confirm', {'document': 'Viaje', 'field': 'upos'}),
         ('set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'andar'}))
    call_tool(ws, 'drop_planned', {'indexes': [1]})
    assert [o['kind'] for o in ws.ops] == ['set_span']
    assert [r['tool'] for r in ws.requests] == ['set_field']


def test_ud_a_drop_after_resume_asks_the_resumed_requests_again(monkeypatch):
    from plaid_agent.ud.toolkit import call_tool
    client, project, new_ws = _ud_ws(monkeypatch)
    reqs = [('replace_in_field', {'field': 'upos', 'pattern': 'NOUN', 'replacement': 'PROPN', 'whole': True}),
            ('set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'}),
            ('replace_in_field', {'field': 'upos', 'pattern': 'OU', 'replacement': 'AU'})]
    w1 = new_ws()
    _ask(call_tool, w1, *reqs)
    p = w1.plan_payload()
    w2 = new_ws()
    w2.waiting = {'count': len(w1.ops), 'summary': p['summary'], 'id': p['id'], 'documents': p['documents']}
    state = json.loads(json.dumps(w1.plan_state(), default=str))
    w2.load_plan_state = lambda plan_id: state if plan_id == p['id'] else None
    assert call_tool(w2, 'resume_plan', {}).startswith('Took over')
    call_tool(w2, 'drop_planned', {'indexes': [1]})
    assert [o['kind'] for o in w2.ops] == ['replace_scope']


def test_umr_a_relation_removed_twice_comes_back_from_its_second_ask_when_dropped():
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.toolkit import call_tool
    from plaid_agent.umr.tools import Workspace
    client = umr_fx.FakeClient()
    ask = ('delete_triple', {'document': 'Story', 'a': 's2t', 'rel': ':same-entity', 'b': 's1d'})
    keep_ = ('set_attributes', {'document': 'Story', 'sentence': 1, 'var': 's1b', 'line': ':aspect state'})
    ws = Workspace(client, load_project(client, umr_fx.PID))
    _ask(call_tool, ws, ask, keep_, ask)
    call_tool(ws, 'drop_planned', {'indexes': [1]})
    scratch = Workspace(client, load_project(client, umr_fx.PID))
    _ask(call_tool, scratch, keep_, ask)
    assert payload(ws) == payload(scratch)
