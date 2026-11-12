"""The ud checker: the project ends exactly as expected, for edits that move
words and sentences as well as edits of values.

The expected end state is built from a starting point (`base`), changed by
any `split` the task asks for (words renumber, relations that would cross the
new boundary are gone, as split_sentence leaves them), then overlaid with
`expect` and `restore`. Every document of the project is compared with it,
address by address, provenance included, so a renumbering mistake, a lost
word or a stray rewrite all show as collateral.

args:
  document: the document the task is about
  base:     setup (default: the state after the task's setup, or the snapshot
            when there is none) | snapshot (the snapshot as built, for a task
            that undoes what its setup planted)
  split:    optional list of word addresses, in the base's numbering, where a
            new sentence starts (applied last to first)
  expect:   {address: value}. The value may be a list of acceptable values.
            null means the address must be absent (no head, no feature).
            An address in another document is written "French 2|s3.w4:lemma".
  restore:  word addresses (after numbering) whose every column must equal
            the base's: a word a reshape remade and the task annotated again
  allow:    addresses that may change to anything (a regex each)
  prov:     verified (default) | human | any: what every expected value must
            carry. Head and deprel are judged by the relation, features by
            every feature span.
  prov_skip: addresses left out of the provenance judgement: a value the
            task names but a reshape already seeded right (a lemma copied
            from its form), which the assistant need not rewrite
  plan:     required (default: some plan was applied) | none

Measures: target_ok, collateral (count and first few), prov_ok, plan_status,
plan_rows, sentences (count in the document after).
"""
import re

import common as c
from exact_changes import plan_items

FIELDS = ('form', 'lemma', 'upos', 'xpos', 'feats', 'head', 'deprel')


def values(doc):
    """common.ud_values, plus the provenance of features (every feature span)
    and of the relation (head and deprel)."""
    out = c.ud_values(doc)
    spans = c.ud_spans(doc)
    for k, sp in spans.items():
        if k.endswith(':feats'):
            p = ' ; '.join(sorted(f"{s.get('value')}@{c.prov_text(s)}" for s in sp if c.prov_text(s)))
            if p:
                out[k + '#prov'] = p
        elif k.endswith(':head') and isinstance(sp, dict):
            p = c.prov_text(sp)
            if p:
                out[k + '#prov'] = p
    return out


def _words(flat):
    """{(s, w): {field or field#prov: value}}."""
    out = {}
    for k, v in flat.items():
        m = re.match(r's(\d+)\.w(\d+):(\w+(?:#prov)?)$', k)
        if m:
            out.setdefault((int(m[1]), int(m[2])), {})[m[3]] = v
    return out


def _flat(words):
    return {f's{s}.w{w}:{f}': v for (s, w), fs in words.items() for f, v in fs.items()}


def split(flat, at):
    """The base with a new sentence starting at word `at` ("s13.w13")."""
    m = re.match(r's(\d+)\.w(\d+)$', at)
    S, W = int(m[1]), int(m[2])
    out = {}
    for (s, w), fs in _words(flat).items():
        fs = dict(fs)
        if s < S:
            out[(s, w)] = fs
            continue
        if s > S:
            out[(s + 1, w)] = fs
            continue
        first = w < W
        h = fs.get('head')
        if h not in (None, 0) and (h < W) != first:
            for f in ('head', 'deprel', 'head#prov'):
                fs.pop(f, None)
        elif h not in (None, 0) and not first:
            fs['head'] = h - W + 1
        out[(s, w) if first else (s + 1, w - W + 1)] = fs
    return _flat(out)


def _ok(now, want):
    return now in want if isinstance(want, list) else now == want


def _stamped(p):
    return 'prov=inferred' in p and 'provConfirmed=True' in p and 'provSource=service:' in p


def _verified(flat, before, addr):
    """Whether what the task changed at `addr` carries the verified stamp. For
    features, only the Feature=Value spans that are new are judged: a feature
    the word already had keeps its span and its stamp."""
    field = addr.split(':', 1)[1]
    if field in ('head', 'deprel'):
        return _stamped(flat.get(addr.rsplit(':', 1)[0] + ':head#prov') or '')
    if field != 'feats':
        return _stamped(flat.get(addr + '#prov') or '')
    stamped = {x.split('@', 1)[0] for x in (flat.get(addr + '#prov') or '').split(' ; ')
               if _stamped(x)}
    old = set((before.get(addr) or '').split('|'))
    new = [f for f in (flat.get(addr) or '').split('|') if f and f not in old]
    return all(f in stamped for f in new)


def check(ctx):
    a = ctx.args
    use_setup = a.get('base', 'setup') == 'setup'
    bdir = getattr(ctx, 'baseline_dir', None) if use_setup else None
    docs = ctx.project['documents']
    allow = [re.compile(p) for p in a.get('allow') or []]
    expect = {}
    for k, v in (a.get('expect') or {}).items():
        name, addr = k.split('|', 1) if '|' in k else (a['document'], k)
        expect.setdefault(name, {})[addr] = v

    unexpected, hits, afters, befores = {}, {}, {}, {}
    for d in docs:
        name = d['name']
        before = values(c.baseline(d['id'], bdir))
        after = values(ctx.client.documents.get(d['id'], include_body=True))
        afters[name] = after
        # What the turn started from, for judging which features are new.
        befores[name] = values(c.baseline(d['id'], getattr(ctx, 'baseline_dir', None))) if not use_setup \
            else before
        want = dict(before)
        exp = expect.setdefault(name, {})
        if name == a['document']:
            for at in sorted(a.get('split') or [], key=lambda x: [int(n) for n in re.findall(r'\d+', x)],
                             reverse=True):
                want = split(want, at)
            for w in a.get('restore') or []:
                for f in FIELDS:
                    exp.setdefault(f'{w}:{f}', want.get(f'{w}:{f}'))
        for k, v in exp.items():
            hits[f'{name}|{k}'] = _ok(after.get(k), v)
        for k in set(want) | set(after):
            key = k[:-5] if k.endswith('#prov') else k
            if key in exp or (key.endswith(':head') and key[:-5] + ':deprel' in exp):
                continue
            if name == a['document'] and any(p.search(key) for p in allow):
                continue
            if want.get(k) != after.get(k):
                unexpected[f'{name}|{k}'] = [want.get(k), after.get(k)]

    unexpected.update({k: list(v) for k, v in c.guideline_changes(ctx).items()})

    want_prov = a.get('prov', 'verified')
    prov_ok = None
    if want_prov != 'any':
        checks = []
        for name, exp in expect.items():
            after = afters.get(name) or {}
            skip = set(a.get('prov_skip') or [])
            for k in exp:
                if after.get(k) in (None, '') or k.endswith(':form') or k in skip or f'{name}|{k}' in skip:
                    continue
                if want_prov == 'verified':
                    checks.append(_verified(after, befores.get(name) or {}, k))
                else:
                    checks.append(not any(x.startswith(k) and x.endswith('#prov') for x in after))
        prov_ok = all(checks) if checks else None

    plans = plan_items(ctx.conversation)
    statuses = [p.get('status') for p in plans]
    plan_ok = 'applied' in statuses if a.get('plan', 'required') == 'required' else True
    target_after = afters.get(a['document']) or {}
    n_sent = len({k.split('.', 1)[0] for k in target_after if re.match(r's\d+\.w', k)})
    missed = [k for k, h in hits.items() if not h]
    passed = not missed and not unexpected and plan_ok and prov_ok is not False
    extra = list(unexpected)
    return {
        'pass': passed,
        'measures': {
            'target_ok': f'{sum(hits.values())}/{len(hits)}',
            'collateral': len(extra),
            'collateral_first': {k: unexpected[k] for k in extra[:10]},
            'prov_ok': prov_ok,
            'plan_status': statuses,
            'plan_rows': [len((p.get('plan') or {}).get('proposed') or (p.get('plan') or {}).get('ops') or [])
                          for p in plans],
            'sentences': n_sent,
        },
        'detail': {'missed': {k: [afters.get(k.split('|')[0], {}).get(k.split('|')[1]),
                                  expect[k.split('|')[0]][k.split('|')[1]]] for k in missed},
                   'unexpected': unexpected},
    }
