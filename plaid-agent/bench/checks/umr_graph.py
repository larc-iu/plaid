"""A UMR task's result: values on named nodes, document-level triples, and a
drafted sentence graph matched on its key parts, with nothing else changed.

args:
  document: the document (by name)
  expect:   {address: value}, value null for "must be gone". Addresses as in
            common.umr_values: `s3.s3e:concept`, `s3.s3e::aspect` (an
            attribute), `s3.s3e::actor` (a role, the value is the target
            variable), `s3:root`, `s3.s3e:anchor` (the words it covers).
  triples:  document-level triples that must be there. Each item is
            [a, rel, b] or {any: [[a, rel, b], ...]} when either of several
            ways of writing it is right (:same-entity both ways, or
            (x :before y) against (y :after x)). a and b are variables or
            constants (author, document-creation-time, ...).
  allow_triples: triples that may also appear and are not collateral (the
            conventional (root :modal author) beside an author's modal
            triple). Same shape as `triples`.
  draft:    a sentence graph to find, tolerant of variable names and of the
            order nodes and roles are written in:
              sentence: 5
              root: e                  # a pattern node id
              nodes: {e: {concept: purara, attrs: {":aspect": performance}},
                      x: {concept: [kay, kay-kana]}}   # a list: any of them
              edges: [[e, ":experiencer", p], [e, [":stimulus", ":theme"], x]]
              exact: true              # no other node and no other edge in
                                       # the sentence (default true)
            A node's attrs are its whole attribute set (none when left out)
            unless the node says `attrs_at_least: true`. A role written
            `:r-of` from y to x counts as `:r` from x to y.
  prov:     verified (default) | human | any, for what the task asks to be
            written: the nodes and edges an expected address names, every
            node and edge of a matched draft, every required triple.
  plan:     required (default) | none

Every address of the project outside what the task names counts as
collateral: the other sentences' nodes, attributes, roles, roots and
alignments, the document graph, the constants, and the igt layers under the
graph (words, morphemes, glosses, translations). A draft frees its own
sentence: anything there may change, and the pattern then judges it.

Measures: target_ok, triples_ok, draft (matched or why not), collateral,
prov_ok, plan_status.
"""
import unicodedata
from typing import Dict, List, Optional

import common as c
from exact_changes import plan_items


def _norm(s) -> str:
    return unicodedata.normalize('NFC', str(s if s is not None else '')).strip().lower()


def _cfg(x, key):
    return ((x.get('config') or {}).get('umr') or {}).get(key)


def read(doc) -> dict:
    """The document's UMR graph, structured: nodes by sentence number (None for
    a constant), the sentence roots, every edge and every document-level
    triple, each with the stored entity it came from."""
    tl = doc['text_layers'][0]
    body = tl['text']['body']
    sents = c._sorted(next(t for t in tl['token_layers'] if c._role(t) == 'sentence')['tokens'])
    s_num = {s['id']: i for i, s in enumerate(sents, 1)}
    words_layer = next((t for t in tl['token_layers'] if c._role(t) == 'word'), None)
    w_tok = {t['id']: t for t in (words_layer or {}).get('tokens') or []}
    nodes_layer = next((t for t in tl['token_layers'] if _cfg(t, 'nodes')), None)
    out = {'nodes': {}, 'edges': [], 'triples': [], 'by_id': {}}
    if not nodes_layer:
        return out
    tok = {t['id']: t for t in nodes_layer['tokens']}
    concepts = next((s for s in nodes_layer.get('span_layers') or [] if _cfg(s, 'concepts')), None)
    if not concepts:
        return out

    def sentence_at(offset):
        for i, s in enumerate(sents, 1):
            if s['begin'] <= offset < max(s['end'], s['begin'] + 1):
                return i
        return None

    for sp in concepts.get('spans') or []:
        meta = (sp.get('metadata') or {}).get('umr') or {}
        words = c._sorted([w_tok[w] for w in meta.get('words') or [] if w in w_tok])
        if meta.get('constant'):
            n = None
        elif meta.get('sentence') in s_num:
            n = s_num[meta['sentence']]
        elif words:
            n = sentence_at(words[0]['begin'])
        else:
            covered = [tok[t] for t in sp.get('tokens') or [] if t in tok]
            n = sentence_at(covered[0]['begin']) if covered else None
        node = {'id': sp['id'], 'sentence': n, 'var': meta.get('var'), 'concept': sp.get('value'),
                'root': bool(meta.get('root')), 'constant': bool(meta.get('constant')),
                'attrs': [(a.get('rel'), str(a.get('value'))) for a in meta.get('attrs') or []],
                'words': ' '.join(body[w['begin']:w['end']] for w in words), 'span': sp}
        out['nodes'][sp['id']] = node
    for rl in concepts.get('relation_layers') or []:
        kind = 'edges' if _cfg(rl, 'relations') else 'triples' if _cfg(rl, 'documentGraph') else None
        if not kind:
            continue
        for r in rl.get('relations') or []:
            a, b = out['nodes'].get(r['source']), out['nodes'].get(r['target'])
            if a and b:
                out[kind].append({'source': a, 'target': b, 'rel': r.get('value'), 'relation': r,
                                  'group': (((r.get('metadata') or {}).get('umr') or {}).get('group'))})
    return out


def _addr(node) -> str:
    return f'C.{node["var"]}' if node['sentence'] is None else f's{node["sentence"]}.{node["var"]}'


def triple_key(a, rel, b) -> str:
    return f'doc:({a} {rel} {b})'


def flat(doc) -> Dict[str, str]:
    """Every UMR address of the document, and the igt layers under it, as
    one comparable map."""
    g = read(doc)
    out: Dict[str, str] = {}

    def add(k, v):
        out[k] = v if k not in out else '|'.join(sorted(out[k].split('|') + [v]))

    for n in g['nodes'].values():
        a = _addr(n)
        out[f'{a}:concept'] = n['concept']
        if n['root']:
            add(f's{n["sentence"]}:root', n['var'])
        for rel, v in n['attrs']:
            add(f'{a}:{rel}', v)
        if n['words']:
            out[f'{a}:anchor'] = n['words']
        p = c.prov_text(n['span'])
        if p:
            out[f'{a}#prov'] = p
    for e in g['edges']:
        add(f'{_addr(e["source"])}:{e["rel"]}', e['target']['var'])
    for t in g['triples']:
        out[triple_key(t['source']['var'], t['rel'], t['target']['var'])] = t['group'] or ''
    for k, v in c.igt_values(doc).items():
        out[f'igt:{k}'] = v
    return out


# --- the pieces of a check ---------------------------------------------------------

def _alternatives(item) -> List[list]:
    return item['any'] if isinstance(item, dict) else [item]


def _find_triple(g, a, rel, b):
    for t in g['triples']:
        if t['source']['var'] == a and t['rel'] == rel and t['target']['var'] == b:
            return t
    return None


def _edges_of(g, sentence) -> List[tuple]:
    """(source var, role, target var, edge) in one sentence, an inverse role
    read the other way round."""
    out = []
    for e in g['edges']:
        if e['source']['sentence'] != sentence:
            continue
        s, r, t = e['source']['var'], e['rel'], e['target']['var']
        if r.endswith('-of') and r not in (':consist-of',):
            s, r, t = t, r[:-3], s
        out.append((s, r, t, e))
    return out


def match_draft(g, d) -> dict:
    """Find the draft pattern in its sentence. Answers {ok, why, mapping,
    nodes, edges} where nodes and edges are the stored ones it matched."""
    n = d['sentence']
    nodes = [x for x in g['nodes'].values() if x['sentence'] == n]
    by_var = {x['var']: x for x in nodes}
    edges = _edges_of(g, n)
    edge_set = {(s, r, t) for s, r, t, _ in edges}
    pat = d['nodes']
    pedges = d.get('edges') or []
    exact = d.get('exact', True)

    def concepts(p):
        cs = p.get('concept')
        return [_norm(x) for x in (cs if isinstance(cs, list) else [cs])]

    def attrs_ok(p, node):
        want = sorted((r, _norm(v)) for r, v in (p.get('attrs') or {}).items())
        have = sorted((r, _norm(v)) for r, v in node['attrs'])
        return all(w in have for w in want) if p.get('attrs_at_least') else want == have

    def roles(r):
        return r if isinstance(r, list) else [r]

    cands = {pid: [x['var'] for x in nodes if _norm(x['concept']) in concepts(p) and attrs_ok(p, x)]
             for pid, p in pat.items()}
    order = sorted(pat, key=lambda pid: len(cands[pid]))
    best = {'why': None}

    def consistent(m):
        for s, r, t in pedges:
            if s in m and t in m and not any((m[s], rr, m[t]) in edge_set for rr in roles(r)):
                return False
        return True

    def search(i, m):
        if i == len(order):
            return dict(m)
        pid = order[i]
        for v in cands[pid]:
            if v in m.values():
                continue
            m[pid] = v
            if consistent(m):
                got = search(i + 1, m)
                if got:
                    return got
            del m[pid]
        return None

    empty = [pid for pid in pat if not cands[pid]]
    if empty:
        return {'ok': False, 'why': 'no node fits ' + ', '.join(
            f'{pid} ({pat[pid].get("concept")} {pat[pid].get("attrs") or ""})' for pid in empty),
            'nodes_in_sentence': len(nodes)}
    m = search(0, {})
    if not m:
        return {'ok': False, 'why': 'nodes fit one by one, but not with the edges between them',
                'candidates': cands, 'nodes_in_sentence': len(nodes)}
    root = d.get('root')
    roots = [x['var'] for x in nodes if x['root']]
    if root and roots != [m[root]]:
        best['why'] = f'root is {roots}, expected {m[root]}'
    used_edges = set()
    for s, r, t in pedges:
        for rr in roles(r):
            if (m[s], rr, m[t]) in edge_set:
                used_edges.add((m[s], rr, m[t]))
                break
    extra_nodes = [v for v in by_var if v not in m.values()]
    extra_edges = [f'({s} {r} {t})' for s, r, t in edge_set if (s, r, t) not in used_edges]
    if exact and (extra_nodes or extra_edges) and not best['why']:
        best['why'] = f'extra nodes {extra_nodes} or edges {extra_edges}'
    matched_edges = [e for s, r, t, e in edges if (s, r, t) in used_edges]
    return {'ok': best['why'] is None, 'why': best['why'], 'mapping': m,
            'nodes': [by_var[v] for v in m.values()], 'edges': matched_edges,
            'extra_nodes': extra_nodes, 'extra_edges': extra_edges}


def _prov_ok(entity, want) -> bool:
    if want == 'any':
        return True
    p = c.prov_of(entity)
    return c.verified_machine(entity) if want == 'verified' else not p


def _node_of_address(g, address):
    head = address.split(':', 1)[0]
    if '.' not in head:
        return None
    s, var = head.split('.', 1)
    n = None if s == 'C' else int(s[1:])
    return next((x for x in g['nodes'].values() if x['sentence'] == n and x['var'] == var), None)


def _edge_of_address(g, address, value):
    node = _node_of_address(g, address)
    rel = address.split(':', 1)[1] if ':' in address else ''
    if node is None or not rel.startswith(':'):
        return None
    return next((e for e in g['edges'] if e['source']['id'] == node['id'] and e['rel'] == rel
                 and e['target']['var'] == value), None)


def check(ctx):
    a = ctx.args
    doc = next(d for d in ctx.project['documents'] if d['name'] == a['document'])
    expect = a.get('expect') or {}
    draft = a.get('draft')
    want_prov = a.get('prov', 'verified')

    changes = c.project_changes(ctx, flat)
    after_raw = ctx.client.documents.get(doc['id'], include_body=True)
    after = flat(after_raw)
    g = read(after_raw)

    hits = {k: after.get(k) == (None if v is None else str(v)) for k, v in expect.items()}

    tri_hits, tri_found, allowed = [], [], set()
    for item in a.get('triples') or []:
        found = None
        for alt in _alternatives(item):
            allowed.add(triple_key(*alt))
            found = found or _find_triple(g, *alt)
        tri_hits.append(found is not None)
        if found:
            tri_found.append(found)
    for item in a.get('allow_triples') or []:
        for alt in _alternatives(item):
            allowed.add(triple_key(*alt))

    drafted = match_draft(g, draft) if draft else None

    # What may change: the expected addresses, the stamps on their nodes, the
    # triples asked for or allowed, a constant a triple brings, and all of a
    # drafted sentence.
    ok_keys = set()
    for k in expect:
        ok_keys.add(k)
        node = k.split(':', 1)[0]
        ok_keys.add(f'{node}#prov')
    ok_keys |= allowed
    free = f's{draft["sentence"]}' if draft else None
    constants_used = {t['source']['var'] for t in g['triples'] if t['source']['constant']} | \
                     {t['target']['var'] for t in g['triples'] if t['target']['constant']}

    def allowed_change(name, k):
        if name != a['document']:
            return False
        if k in ok_keys:
            return True
        if free and (k == f'{free}:root' or k.startswith(f'{free}.')):
            return True
        if k.startswith('C.') and k.split(':', 1)[0].split('#', 1)[0][2:] in constants_used:
            return True
        return False

    flat_changes = {f'{name}|{k}': v for name, ch in changes.items() for k, v in ch.items()}
    flat_changes.update(c.guideline_changes(ctx))
    extra = [k for k in flat_changes if not allowed_change(*k.split('|', 1))]

    prov = []
    for k, v in expect.items():
        if v is None:
            continue
        e = _edge_of_address(g, k, str(v))
        ent = e['relation'] if e else (_node_of_address(g, k) or {}).get('span')
        prov.append(_prov_ok(ent, want_prov))
    for t in tri_found:
        prov.append(_prov_ok(t['relation'], want_prov))
    if drafted and drafted.get('ok'):
        prov += [_prov_ok(n['span'], want_prov) for n in drafted['nodes']]
        prov += [_prov_ok(e['relation'], want_prov) for e in drafted['edges']]
    prov_ok = all(prov) if prov else None

    plans = plan_items(ctx.conversation)
    statuses = [p.get('status') for p in plans]
    plan_ok = ('applied' in statuses) if a.get('plan', 'required') == 'required' else not flat_changes
    passed = all(hits.values()) and all(tri_hits) and (drafted is None or drafted['ok']) and \
        not extra and plan_ok and prov_ok is not False
    return {
        'pass': passed,
        'measures': {
            'target_ok': f'{sum(hits.values())}/{len(hits)}',
            'triples_ok': f'{sum(tri_hits)}/{len(tri_hits)}',
            'draft': None if drafted is None else (
                'matched' if drafted['ok'] else drafted.get('why')),
            'collateral': len(extra),
            'collateral_first': {k: flat_changes[k] for k in extra[:10]},
            'prov_ok': prov_ok,
            'plan_status': statuses,
        },
        'detail': {'expected': {k: [after.get(k), v] for k, v in expect.items()},
                   'draft': None if drafted is None else {
                       k: v for k, v in drafted.items() if k not in ('nodes', 'edges')},
                   'changes': {n: {k: list(v) for k, v in ch.items()} for n, ch in changes.items()}},
    }
