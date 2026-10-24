"""IGT: the project ends with exactly the expected changes, over the documents
AND the lexicon, and (optionally) the last reply says the right thing.

For tasks about the lexicon, links, reshapes and corpus-wide glossing. The
task's setup must end with igtlib.snap(ctx), which records the lexicon as the
task starts.

args:
  expect:   {"<document>|<address>": value}   document values, igtlib's
            addressing (links name the entry label "form|gloss"). null: the
            address must be gone.
  lexicon:  {"<label>:<key>": value}   lexicon values (igtlib.lex_values).
            "<label>": null means the entry is gone (all its keys).
  rules:    computed expectations, each a dict:
            {gloss: {form, from, to, docs?}}   every morpheme of that form
                (case-insensitive) glossed `from` (null: no gloss) gets `to`
            {relabel: {map: {OLD: NEW, ...}, field?}}   a gloss convention
                migration: every value of the field (default Gloss), on words
                and morphemes, whose labels (runs of letters and digits, so
                RL.3AUG is RL and 3AUG) include an OLD gets each OLD label
                replaced by its NEW, all at once (relabel()). A label that
                only contains an OLD (3AUGIS for 3AUG) is not one. Renaming a
                lexicon gloss the same way is no fault.
            {link_by_gloss: {form, docs?, sentences?, only_linked?}} every
                morpheme of that form links to the entry "form|<its gloss>"
                (form lowercased); only_linked: only those linked at the start
  allow:    regexes of changed keys that are no fault (e.g. a homograph
            number a split renumbers). Keys are "<document>|<key>" and
            "LEX|<key>".
  optional: {"<document>|<address>" or "LEX|<key>": value}: a change the task
            did not ask for but that is no fault when it lands on exactly this
            value (e.g. linking a newly segmented morpheme to its entry).
  prov:     verified (default) | any. verified: every expected document
            value and link carries the approved-plan stamp.
  plan:     required (default) | none
  match / reject: as checks/answer.py, on the last reply (optional).
  numbers:  {after: regex, expect: [int, ...]}: the integers in the reply
            after the first match of `after` (to the end of that line) must
            be exactly `expect`, as a set (for "list the sentence numbers").
            A list of them checks several lines (e.g. one line per text).

Measures: target_ok, collateral (count, first few), prov_ok, plan_status,
plan_rows, and matched / reply when the task judges the reply.
"""
import re

import common as c
import igtlib as L
from exact_changes import plan_items


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


LABEL = re.compile(r'[^\W_]+')


def relabel(value, mapping):
    """``value`` with every label that is a key of ``mapping`` replaced, all
    in one pass, so the renames compose (RL.3AUG under RL and 3AUG) and a
    label that merely contains one (3AUGIS) is left."""
    if not isinstance(value, str):
        return value
    return LABEL.sub(lambda m: mapping.get(m.group(0), m.group(0)), value)


def _lex_relabels(args, lex_before):
    out = {}
    for r in args.get('rules') or []:
        if 'relabel' not in r:
            continue
        for k, v in lex_before.items():
            if k.endswith(':gloss') and relabel(v, r['relabel']['map']) != v:
                out[f'LEX|{k}'] = relabel(v, r['relabel']['map'])
    return out


def _rules(ctx, base_docs, base_labels):
    exp = {}
    for r in ctx.args.get('rules') or []:
        if 'relabel' in r:
            field = r['relabel'].get('field') or 'Gloss'
            for name, vals in base_docs.items():
                for k, v in vals.items():
                    if k.endswith(':' + field) and relabel(v, r['relabel']['map']) != v:
                        exp[f'{name}|{k}'] = relabel(v, r['relabel']['map'])
        if 'gloss' in r:
            g = r['gloss']
            for name, vals in base_docs.items():
                if g.get('docs') and name not in g['docs']:
                    continue
                for k, v in vals.items():
                    if not k.endswith(':form') or str(v).lower() != g['form'].lower():
                        continue
                    a = k[:-5]
                    if vals.get(a + ':Gloss') == g.get('from'):
                        exp[f'{name}|{a}:Gloss'] = g['to']
        if 'link_by_gloss' in r:
            g = r['link_by_gloss']
            for name, vals in base_docs.items():
                if g.get('docs') and name not in g['docs']:
                    continue
                for k, v in vals.items():
                    if not k.endswith(':form') or str(v).lower() != g['form'].lower():
                        continue
                    a = k[:-5]
                    if g.get('sentences') and a.split('.')[0] not in g['sentences']:
                        continue
                    if g.get('only_linked') and (a + ':link') not in vals:
                        continue
                    exp[f'{name}|{a}:link'] = f'{g["form"].lower()}|{vals.get(a + ":Gloss") or ""}'
    return exp


def check(ctx):
    a = ctx.args
    vocab_id = ctx.project['vocabs'][0]['id']
    base_items = getattr(ctx, 'lex_baseline', None)
    if base_items is None:
        raise RuntimeError('igt_changes needs a setup that ends with igtlib.snap(ctx)')
    base_labels = L.labels(base_items)
    items_now = L.vocab_items(ctx.client, vocab_id)

    before, after, raws = {}, {}, {}
    for d in ctx.project['documents']:
        before[d['name']] = L.doc_values(c.baseline(d['id'], getattr(ctx, 'baseline_dir', None)), base_labels)
        raws[d['name']] = ctx.client.documents.get(d['id'], include_body=True)
        after[d['name']] = L.doc_values(raws[d['name']], base_labels, items_now)
    flat = {}
    for name in before:
        for k, v in c.diff(before[name], after[name]).items():
            flat[f'{name}|{k}'] = v
    known = {d['id'] for d in ctx.project['documents']}
    for d in ctx.client.projects.get(ctx.project['id']).get('documents') or []:
        if d['id'] not in known:
            flat[f'{d.get("name") or d["id"]}|(new document)'] = (None, d['id'])
    lex_before = L.lex_values(base_items, base_labels)
    lex_after = L.lex_values(items_now, base_labels)
    for k, v in c.diff(lex_before, lex_after).items():
        flat[f'LEX|{k}'] = v
    flat.update(c.guideline_changes(ctx))

    expect = {}
    for k, v in (a.get('expect') or {}).items():
        expect[k] = v
    expect.update(_rules(ctx, before, base_labels))
    for k, v in (a.get('lexicon') or {}).items():
        if ':' not in k and v is None:
            for bk in lex_before:
                if bk.startswith(k + ':') or bk == k + '#prov':
                    expect[f'LEX|{bk}'] = None
        else:
            expect[f'LEX|{k}'] = v

    def now_of(key):
        doc, k = key.split('|', 1)
        return lex_after.get(k) if doc == 'LEX' else after.get(doc, {}).get(k)
    hits = {k: now_of(k) == v for k, v in expect.items()}
    allowed = set(expect) | {k + '#prov' for k in expect} | \
        {k.split('#', 1)[0] + '#prov' for k in expect if k.startswith('LEX|')}
    # A new entry's own stamp, and any new entry's prov key, is what creating it writes.
    allow_re = [re.compile(p) for p in _list(a.get('allow'))] + [re.compile(r'^LEX\|\+.*#prov$')]
    optional = {**_lex_relabels(a, lex_before), **(a.get('optional') or {})}
    for k, v in optional.items():
        if now_of(k) == v:
            allowed |= {k, k + '#prov'}
    extra = [k for k in flat if k not in allowed and not any(p.search(k) for p in allow_re)]

    prov_ok = None
    if a.get('prov', 'verified') == 'verified':
        ok = []
        for k, v in expect.items():
            doc, addr = k.split('|', 1)
            if doc == 'LEX' or v is None or (before.get(doc, {}).get(addr) == v and k not in flat):
                continue
            if addr.endswith(':link') or addr.endswith(':mwe'):
                sp = L.link_spans(raws[doc]).get(addr)
            elif ':' in addr:
                sp = c.igt_spans(raws[doc]).get(addr)
            else:
                continue
            if sp is not None and ':form' not in addr:
                ok.append(c.verified_machine(sp))
        prov_ok = all(ok) if ok else None

    plans = plan_items(ctx.conversation)
    statuses = [p.get('status') for p in plans]
    want_plan = a.get('plan', 'required')
    plan_ok = ('applied' in statuses) if want_plan == 'required' else (not flat and 'applied' not in statuses)

    replies = [d for d in ctx.conversation.get('display') or [] if d.get('kind') in ('assistant', 'error')]
    text = (replies[-1].get('text') or '') if replies else ''
    plain = re.sub(r'<cite\b[^>]*/>', ' ', text)
    pats = _list(a.get('match'))
    matched = [bool(re.search(p, plain, re.I | re.S)) for p in pats]
    bad = [p for p in _list(a.get('reject')) if re.search(p, plain, re.I | re.S)]
    nums_ok, got_nums = True, None
    if a.get('numbers'):
        specs = a['numbers'] if isinstance(a['numbers'], list) else [a['numbers']]
        got_nums = []
        for spec in specs:
            # The last line that starts with it, after at most one word ("Lezgi
            # Text 1:"): the first match was often a heading of the reasoning
            # above the closing lines, with no numbers on it.
            found = list(re.finditer(r'^\W*(?:\w+\s+)?(?:' + spec['after'] + ')', plain, re.I | re.M))
            mm = found[-1] if found else None
            line = plain[mm.end():].split('\n', 1)[0] if mm else ''
            got = sorted({int(x) for x in re.findall(r'(?<![\w.])s?(\d+)(?![\d.]?\d)', line)})
            got_nums.append(got)
            nums_ok = nums_ok and got == sorted(set(spec['expect']))
        if not isinstance(a['numbers'], list):
            got_nums = got_nums[0]
    reply_ok = nums_ok and ((not pats and not bad) or (bool(replies) and replies[-1].get('kind') == 'assistant'
                                          and all(matched) and not bad))

    passed = all(hits.values()) and not extra and plan_ok and prov_ok is not False and reply_ok
    measures = {
        'target_ok': f'{sum(hits.values())}/{len(hits)}',
        'collateral': len(extra),
        'collateral_first': {k: list(flat[k]) for k in extra[:10]},
        'prov_ok': prov_ok,
        'plan_status': statuses,
        'plan_rows': [len((p.get('plan') or {}).get('proposed') or (p.get('plan') or {}).get('ops') or [])
                      for p in plans],
    }
    if a.get('numbers'):
        measures['numbers'] = got_nums
    if pats or a.get('reject') or a.get('numbers'):
        measures.update(matched=f'{sum(matched)}/{len(matched)}', rejected_hits=bad, reply=plain[:300])
    missed = {k: [now_of(k), v] for k, v in expect.items() if not hits[k]}
    return {'pass': passed, 'measures': measures,
            'detail': {'missed_first': dict(list(missed.items())[:30]),
                       'changes': {k: list(v) for k, v in list(flat.items())[:400]}}}
