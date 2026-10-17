"""The drop invariant (Luke 2026-10-16, REV7-PLAN-4): the plan after a drop is
the plan its remaining requests make when asked again from scratch, in the
order they were made, over the same stored data. EVERY remaining request,
one answered "Nothing to change" included, a rule a drop left with nothing
to change, and a value an analysis took out.

The generator is REV7-PLAN's (``C/work/REV7-PLAN``), run with its three
switches off, which is the ruling word for word. Two documents carry stored
segmentations and values. A random sequence of requests runs on one
workspace on a live core:

  SA  set_analysis (1 to 3 morphemes, sometimes with values), also again
  FR  set_field_for_form on Morph Gloss (only_empty both ways, document=,
      a condition on the form or on Gloss)
  RP  replace_in_field on Morph Gloss (substring, whole, a regex)
  NV  set_field or set_morpheme on a morpheme of a planned analysis
  SV  set_field on a stored Gloss or a stored morpheme's Morph Gloss (also
      its stored value, a keep)
  RA  a rule asked again, word for word
  RES resume_plan into a new workspace
  DR  drop_planned by 1 to 3 numbers, by field (Gloss, or Morph Gloss, which
      takes only that field's values out of a planned analysis, PLAN-2), or
      by document

Every request that was not refused is logged with the entry of the plan it
stands for. A drop marks the requests of the entries it removes, and a drop
by field or document also the requests that stand for nothing in the plan
and ask for what it names. After every drop and every resume, a fresh
workspace asks the unmarked requests in order, and its whole plan payload
(ops, card rows, summary, documents) must equal the workspace's. At the end
the plan is approved through the service and what was written is read back.

``PLAN_REPLAY_CASES`` (8 by default), ``PLAN_REPLAY_START``,
``PLAN_REPLAY_STEPS`` (18) and ``PLAN_REPLAY_OUT`` (a jsonl of every case).
"""
import copy
import json
import os
import random

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, as_applied, project, resumed
from test_rule_restate_live import _doc

from plaid_agent.core import rules
from plaid_agent.igt import bulk
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace, op_target

START = int(os.environ.get('PLAN_REPLAY_START', '0'))
CASES = int(os.environ.get('PLAN_REPLAY_CASES', '8'))
STEPS = int(os.environ.get('PLAN_REPLAY_STEPS', '18'))
OUT = os.environ.get('PLAN_REPLAY_OUT')

SURF = ['kan', 'kas', 'ka', 'tos', 'to', 'mi', 'mis', 'kaka']
MFORMS = ['ka', 'n', 's', 'to', 'mi', 'kan', 'ki']
VALS = ['X', 'Y', 'Z', 'K', '']
PATS = ['X', 'Y', 'Z', 'K', 'A']
REPS = ['X', 'Y', 'Z', 'Q']
NONE = ('none',)


def splits(surface, rng):
    n = rng.choice([1, 2, 2, 3]) if len(surface) >= 3 else rng.choice([1, 2])
    n = min(n, len(surface))
    cuts = sorted(rng.sample(range(1, len(surface)), n - 1)) if n > 1 else []
    parts, prev = [], 0
    for c in cuts + [len(surface)]:
        parts.append(surface[prev:c])
        prev = c
    return parts


def make_docs(rng):
    docs, shape = [], {}
    for did, name in [('d0', 'Doc A'), ('d1', 'Doc B')]:
        words = []
        for _ in range(rng.choice([3, 4])):
            sf = rng.choice(SURF)
            gloss = rng.choice(['G', 'H', '', ''])
            if rng.random() < 0.5 and len(sf) >= 2:
                ms = [(p, rng.choice(['K', 'X', '', ''])) for p in splits(sf, rng)]
            else:
                ms = [(sf, rng.choice(['K', '', '']))]
            words.append((sf, gloss, ms))
        docs.append(_doc(did, name, words))
        shape[name] = words
    return docs, shape


def payload(ws):
    p = ws.plan_payload()
    if p is None:
        return None
    p = json.loads(json.dumps(p, default=str))
    p.pop('id', None)
    p['documents'] = sorted(p.get('documents') or [], key=lambda d: d.get('id') or '')
    return p


def entry_key(op):
    if op.get('kind') == 'set_analysis':
        return ('ana', op.get('word_id'))
    if rules.is_rule(op):
        return rules.target(op)
    if op.get('kind') == 'keep' and op.get('kept') is not None and bulk.asked_of(op) is None:
        return ('named', json.dumps(list(op['kept']), default=str))
    base = bulk.asked_of(op)
    if base is not None:
        return ('named', json.dumps(op_target(base), default=str))
    return ('other', json.dumps(op, sort_keys=True, default=str)[:200])


def newest_key(ws, before_seq):
    best = None
    for op in ws.ops:
        top = max([op.get(bulk.SEQ) or 0] + [e[0] for e in op.get(bulk.NAMED_EDITS) or []])
        if top > before_seq and (best is None or top > best[0]):
            best = (top, entry_key(op))
    return best[1] if best else None


def is_err(out):
    return str(out).startswith('Error')


def without_field(args, field):
    """A set_analysis request less the values of ``field`` (PLAN-2)."""
    out = copy.deepcopy(args)
    for m in out.get('morphemes') or []:
        fields = {k: v for k, v in (m.get('fields') or {}).items() if k.casefold() != field.casefold()}
        if fields:
            m['fields'] = fields
        else:
            m.pop('fields', None)
    return out


class Case:
    def __init__(self, c, rng, pid, shape):
        self.c, self.rng, self.pid, self.shape = c, rng, pid, shape
        self.ws = Workspace(c, load_project(c, pid))
        self.log = []  # [tool, args, key, dropped]
        self.trace = []
        self.analysed = {}  # (doc, ref) -> n morphemes, as last asked

    def wid(self, doc, ref):
        return self.ws.doc(doc).sentences[0].words[int(ref.split('.w')[1].split('.')[0]) - 1].id

    def key_of(self, ws, tool, args, out, seq0, before, key=None):
        """The entry a request answered with ``out`` stands for."""
        if tool == 'set_analysis':
            return ('ana', self.wid(args['document'], args['ref']))
        if key is not None:
            # Asked of a planned analysis's morpheme: it goes with that
            # analysis, whatever it changed there.
            return key
        if str(out).startswith('Nothing to change after the changes planned since'):
            # Asked again, a rule that stays where it is stands for that rule.
            return next((e[2] for e in self.log if e[0] == tool and e[1] == args and e[2][0] == 'rule'), NONE)
        if str(out).startswith('Nothing to change'):
            return NONE
        if tool in ('set_field_for_form', 'replace_in_field'):
            k = newest_key(ws, seq0)
            if k is None or k[0] != 'rule':
                k = next((e[2] for e in self.log if e[0] == tool and e[1] == args and e[2][0] == 'rule'), None)
            return k
        new = [entry_key(o) for o in ws.ops if entry_key(o) not in before]
        if new:
            return new[0]
        ref = args['refs'][0] if 'refs' in args else args['ref']
        lab = f"{args['document']} {ref} "
        # A value set back to what is stored takes an earlier change back and
        # stands for nothing.
        return next((entry_key(o) for o in ws.ops if (o.get('label') or '').startswith(lab)
                     and o.get('kind') != 'set_analysis'), None) or ('took back',)

    def call(self, tool, args, key=None):
        seq0 = bulk.next_seq(self.ws.ops) - 1
        before = {entry_key(o) for o in self.ws.ops}
        out = call_tool(self.ws, tool, args)
        self.trace.append([tool, args, str(out)[:300]])
        if is_err(out):
            return out
        self.log.append([tool, args, self.key_of(self.ws, tool, args, out, seq0, before, key), False])
        return out

    def words(self, doc):
        return [(f's1.w{i + 1}', w[0]) for i, w in enumerate(self.shape[doc])]

    def step(self):
        rng = self.rng
        r = rng.random()
        doc = rng.choice(['Doc A', 'Doc B'])
        if r < 0.20:
            ref, sf = rng.choice(self.words(doc))
            ms = []
            for p in splits(sf, rng):
                m = {'form': p}
                if rng.random() < 0.3:
                    m['fields'] = {'Morph Gloss': rng.choice(['X', 'Y', 'P'])}
                ms.append(m)
            out = self.call('set_analysis', {'document': doc, 'ref': ref, 'morphemes': ms})
            if not is_err(out):
                self.analysed[(doc, ref)] = len(ms)
        elif r < 0.40:
            a = {'form': rng.choice(MFORMS), 'field': 'Morph Gloss', 'value': rng.choice(VALS),
                 'only_empty': rng.random() < 0.4}
            if rng.random() < 0.2:
                a['document'] = doc
            if rng.random() < 0.12:
                a['where'] = {'form': rng.choice(SURF)}
            elif rng.random() < 0.08:
                a['where'] = {'Gloss': rng.choice(['G', 'H'])}
            self.call('set_field_for_form', a)
        elif r < 0.52:
            a = {'field': 'Morph Gloss', 'pattern': rng.choice(PATS), 'replacement': rng.choice(REPS),
                 'whole': rng.random() < 0.5}
            if rng.random() < 0.1:
                a = {'field': 'Morph Gloss', 'pattern': '^(K|X)$', 'replacement': r'\1\1', 'regex': True}
            if rng.random() < 0.15:
                a['document'] = doc
            self.call('replace_in_field', a)
        elif r < 0.64:
            live = [k for k in self.analysed if any(o.get('kind') == 'set_analysis' and o.get('word_id') ==
                                                    self.wid(*k) for o in self.ws.ops)]
            if not live:
                return None
            d, ref = rng.choice(live)
            k = rng.randrange(self.analysed[(d, ref)]) + 1
            wid = self.wid(d, ref)
            if rng.random() < 0.25:
                self.call('set_morpheme', {'document': d, 'ref': f'{ref}.m{k}', 'form': rng.choice(MFORMS)},
                          key=('ana', wid))
                return None
            self.call('set_field', {'document': d, 'refs': [f'{ref}.m{k}'], 'field': 'Morph Gloss',
                                    'value': rng.choice(['X', 'Y', 'Z', 'Q', ''])}, key=('ana', wid))
        elif r < 0.72:
            ref, _sf = rng.choice(self.words(doc))
            if (doc, ref) in self.analysed or rng.random() < 0.5:
                self.call('set_field', {'document': doc, 'refs': [ref], 'field': 'Gloss',
                                        'value': rng.choice(['G', 'H', 'J'])})
            else:
                self.call('set_field', {'document': doc, 'refs': [f'{ref}.m1'], 'field': 'Morph Gloss',
                                        'value': rng.choice(['K', 'X', 'Y', 'Z'])})
        elif r < 0.80:
            asked = [e for e in self.log if e[0] in ('set_field_for_form', 'replace_in_field')]
            if asked:
                e = rng.choice(asked)
                self.call(e[0], e[1])
        elif r < 0.85:
            if self.ws.ops:
                self.ws = resumed(self.c, self.pid, self.ws)
                self.trace.append(['RESUME'])
                return 'check'
        else:
            return self.drop(doc)
        return None

    def drop(self, doc):
        rng = self.rng
        n = len(self.ws.ops)
        if not n:
            return None
        q = rng.random()
        if q < 0.08:
            args = {'field': 'Gloss'}
        elif q < 0.16:
            args = {'field': 'Morph Gloss'}
        elif q < 0.24:
            args = {'document': doc}
        else:
            k = min(n, rng.choice([1, 1, 1, 2, 2, 3]))
            args = {'indexes': sorted(rng.sample(range(1, n + 1), k))}
        ops = list(self.ws.ops)
        live = {entry_key(o) for o in ops}
        field = args.get('field')
        narrowed = {entry_key(o) for o in ops if o.get('kind') == 'set_analysis' and field
                    and field.casefold() in {f.casefold() for f in self.ws.op_fields(o)}}
        # Which entries the drop names, read before it: a drop puts aside the
        # documents only the dropped requests read, and a change placed by
        # its ids is found in the documents loaded.
        named = [o for o in ops if 'indexes' not in args and self._matches(o, args)]
        out = call_tool(self.ws, 'drop_planned', args)
        self.trace.append(['drop_planned', args, str(out)[:400]])
        if is_err(out):
            return None
        if 'indexes' in args:
            gone = {entry_key(ops[i - 1]) for i in args['indexes']}
        else:
            left = {entry_key(o) for o in self.ws.ops}
            gone = {entry_key(o) for o in named if entry_key(o) not in left}
        # Every ask of a dropped rule goes with it, one answered "Nothing to
        # change" too: they ask for one rule.
        asks = {(e[0], json.dumps(e[1], sort_keys=True)) for e in self.log if e[2] in gone and e[2][0] == 'rule'}
        for e in self.log:
            if e[3]:
                continue
            if (e[0], json.dumps(e[1], sort_keys=True)) in asks:
                e[3] = True
            elif e[2] in narrowed:
                # PLAN-2: the analysis stays, less the field's values.
                if e[0] == 'set_analysis':
                    e[1] = without_field(e[1], field)
                elif e[0] == 'set_field' and e[1].get('field', '').casefold() == field.casefold():
                    e[3] = True
            elif e[2] in gone:
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
        answered "Nothing to change" that now stages an entry stands for it
        from now on, so a drop of that entry takes it."""
        fresh = Workspace(self.c, load_project(self.c, self.pid))
        outs = []
        for e in self.log:
            tool, args, key, dropped = e
            if dropped:
                continue
            seq0 = bulk.next_seq(fresh.ops) - 1
            before = {entry_key(o) for o in fresh.ops}
            out = str(call_tool(fresh, tool, args))
            outs.append([tool, args, out[:200]])
            if key == NONE and not is_err(out) and not out.startswith('Nothing to change'):
                e[2] = self.key_of(fresh, tool, args, out, seq0, before)
        return fresh, outs


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


def run_case(c, n):
    rng = random.Random(n)
    docs, shape = make_docs(rng)
    s = seed(c, project(), {d['id']: d for d in docs}, {VOCAB: lexicon_raw()}, name=f'drop replay {n}')
    res = {'seed': n, 'fails': [], 'drops': 0, 'resumes': 0}
    try:
        case = Case(c, rng, s.project_id, shape)
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
        if not res['fails']:
            plan = case.ws.plan_payload()
            ana = {o['word_id']: [(m['form'], next((f['value'] for f in m.get('fields') or []), ''))
                                  for m in o['morphemes']]
                   for o in (plan or {}).get('ops') or [] if o.get('kind') == 'set_analysis'}
            _p, h, _st = approve(c, s.project_id, case.ws)
            h = as_applied(h)
            if h is not None and h.errors:
                res['fails'].append({'approve': h.errors})
            after = Workspace(c, load_project(c, s.project_id))
            for d in after.documents():
                for sn in after.doc(d['id']).sentences:
                    for w in sn.words:
                        got = [(m.form, m.fields['Morph Gloss'].value if 'Morph Gloss' in m.fields else '')
                               for m in w.morphemes]
                        if w.id in ana and got != ana[w.id]:
                            res['fails'].append({'written': [w.surface, got, ana[w.id]]})
        res['trace'] = case.trace
    finally:
        s.delete()
    return res


def test_a_plan_after_a_drop_is_every_remaining_request_asked_from_scratch(live_client):
    bad = []
    for n in range(START, START + CASES):
        try:
            r = run_case(live_client, n)
        except Exception:  # noqa: BLE001 - a crash is a failed case, written out
            import traceback
            r = {'seed': n, 'fails': [{'crash': traceback.format_exc()[-1500:]}]}
        if OUT:
            with open(OUT, 'a') as f:
                f.write(json.dumps(r, default=str) + '\n')
        if r['fails']:
            bad.append(r)
    assert not bad, json.dumps(bad[0], default=str)[:4000]
