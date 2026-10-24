"""UMR writes by hand, for a task's setup (a planted error, a graph taken
away) and for validating its checker (the right result and wrong ones).

Every write goes through the API the way the app's editor stores it: a node
is an anchor token in the node layer and a concept span over it with
`metadata.umr` {var, attrs, root, sentence | words}, an edge is a relation in
the relations layer, a document-level triple a relation in the document-graph
layer with `metadata.umr.group`. `verified=True` stamps what an approved plan
stamps (handwrite.stamp), False writes it unstamped, as a person's own work
from an import looks.
"""
from typing import List, Optional

import common as c
import handwrite as h
from plaid_client import uuid7
from umr_graph import read

UMR = 'umr'


class Doc:
    """One read of a document, with the ids a write needs."""

    def __init__(self, ctx, name='Kukama text 2'):
        self.ctx = ctx
        self.meta = h.doc_of(ctx, name)
        self.raw = ctx.client.documents.get(self.meta['id'], include_body=True)
        tl = self.raw['text_layers'][0]
        self.text_id = tl['text']['id']
        self.nodes_layer = next(t for t in tl['token_layers'] if ((t.get('config') or {}).get(UMR) or {}).get('nodes'))
        self.concepts = next(s for s in self.nodes_layer['span_layers']
                             if ((s.get('config') or {}).get(UMR) or {}).get('concepts'))
        rls = self.concepts.get('relation_layers') or []
        self.edge_layer = next(r for r in rls if ((r.get('config') or {}).get(UMR) or {}).get('relations'))
        self.doc_layer = next(r for r in rls if ((r.get('config') or {}).get(UMR) or {}).get('documentGraph'))
        self.sentences = c._sorted(next(t for t in tl['token_layers'] if c._role(t) == 'sentence')['tokens'])
        self.g = read(self.raw)

    def node(self, sentence: Optional[int], var: str) -> dict:
        n = next((x for x in self.g['nodes'].values() if x['sentence'] == sentence and x['var'] == var), None)
        if n is None:
            raise KeyError(f's{sentence}.{var}')
        return n

    def edge(self, sentence, src, role, tgt) -> dict:
        s = self.node(sentence, src)
        return next(e for e in self.g['edges'] if e['source']['id'] == s['id'] and e['rel'] == role
                    and e['target']['var'] == tgt)


def _meta(span, umr_meta, verified, app='umr'):
    meta = dict(span.get('metadata') or {}) if span else {}
    for k in c.PROV_KEYS:
        meta.pop(k, None)
    meta[UMR] = umr_meta
    if verified:
        meta.update(h.stamp(app))
    return meta


def set_attrs(ctx, sentence, var, attrs: List[tuple], verified=True, doc='Kukama text 2'):
    """A node's whole attribute line, as set_attributes writes it."""
    d = Doc(ctx, doc)
    n = d.node(sentence, var)
    umr = dict((n['span'].get('metadata') or {}).get(UMR) or {})
    umr['attrs'] = [{'rel': r, 'value': v, 'order': i} for i, (r, v) in enumerate(attrs)]
    ctx.user.spans.set_metadata(n['span']['id'], _meta(n['span'], umr, verified))


def set_attr(ctx, sentence, var, rel, value, verified=True, doc='Kukama text 2'):
    """One attribute changed, added (value set, rel absent) or removed (value
    None), the node's other attributes kept in place."""
    d = Doc(ctx, doc)
    n = d.node(sentence, var)
    attrs = [(r, v) for r, v in n['attrs'] if r != rel or value is not None]
    if value is not None:
        if any(r == rel for r, _ in attrs):
            attrs = [(r, value if r == rel else v) for r, v in attrs]
        else:
            attrs.append((rel, value))
    set_attrs(ctx, sentence, var, attrs, verified, doc)


def set_concept(ctx, sentence, var, concept, verified=True, doc='Kukama text 2'):
    d = Doc(ctx, doc)
    n = d.node(sentence, var)
    ctx.user.spans.update(n['span']['id'], concept)
    umr = dict((n['span'].get('metadata') or {}).get(UMR) or {})
    ctx.user.spans.set_metadata(n['span']['id'], _meta(n['span'], umr, verified))


def delete_edge(ctx, sentence, src, role, tgt, doc='Kukama text 2'):
    d = Doc(ctx, doc)
    ctx.user.relations.delete(d.edge(sentence, src, role, tgt)['relation']['id'])


def add_edge(ctx, sentence, src, role, tgt, verified=True, doc='Kukama text 2', tgt_sentence=None):
    d = Doc(ctx, doc)
    s = d.node(sentence, src)
    t = d.node(sentence if tgt_sentence is None else tgt_sentence, tgt)
    order = 1 + max([e['relation'].get('metadata', {}).get(UMR, {}).get('order') or 0
                     for e in d.g['edges'] if e['source']['id'] == s['id']] + [len(s['attrs'])])
    meta = {UMR: {'order': order}}
    if verified:
        meta.update(h.stamp('umr'))
    ctx.user.relations.create(d.edge_layer['id'], s['span']['id'], t['span']['id'], role, meta)


def relabel_edge(ctx, sentence, src, role, tgt, new_role, verified=True, doc='Kukama text 2'):
    delete_edge(ctx, sentence, src, role, tgt, doc)
    add_edge(ctx, sentence, src, new_role, tgt, verified, doc)


def delete_sentence_graph(ctx, sentence, doc='Kukama text 2'):
    """Every node of one sentence, with its edges (core's cascade: deleting a
    node's anchor tokens takes its concept span and every relation on it)."""
    d = Doc(ctx, doc)
    toks = [t for n in d.g['nodes'].values() if n['sentence'] == sentence for t in n['span']['tokens']]
    ctx.client.tokens.bulk_delete(toks)


def create_node(ctx, sentence, var, concept, attrs=(), root=False, verified=True, doc='Kukama text 2'):
    """A node aligned to no word, as the assistant makes one: an anchor over
    the whole sentence, the sentence's id in its record."""
    d = Doc(ctx, doc)
    s = d.sentences[sentence - 1]
    tok = ctx.user.tokens.create(d.nodes_layer['id'], d.text_id, s['begin'], s['end'], id=uuid7())
    umr = {'var': var, 'attrs': [{'rel': r, 'value': v, 'order': i} for i, (r, v) in enumerate(attrs)],
           'sentence': s['id']}
    if root:
        umr['root'] = True
    meta = {UMR: umr}
    if verified:
        meta.update(h.stamp('umr'))
    tok_id = tok['id'] if isinstance(tok, dict) else tok
    ctx.user.spans.create(d.concepts['id'], [tok_id], concept, meta, id=uuid7())


def draft(ctx, sentence, nodes, edges, verified=True, doc='Kukama text 2'):
    """A whole graph for an empty sentence: nodes [(var, concept, attrs,
    root)], edges [(src, role, tgt)]."""
    for var, concept, attrs, root in nodes:
        create_node(ctx, sentence, var, concept, attrs, root, verified, doc)
    for src, role, tgt in edges:
        add_edge(ctx, sentence, src, role, tgt, verified, doc)


def _end(ctx, d, name):
    """A triple end: `s7.s7a` or a constant, made (a point at the text's
    start, as the app makes one) when no node has it yet."""
    if '.' in name:
        s, var = name.split('.', 1)
        return d.node(int(s[1:]), var)['span']['id']
    n = next((x for x in d.g['nodes'].values() if x['constant'] and x['var'] == name), None)
    if n:
        return n['span']['id']
    tok = ctx.user.tokens.create(d.nodes_layer['id'], d.text_id, 0, 0, id=uuid7())
    tok_id = tok['id'] if isinstance(tok, dict) else tok
    sp = ctx.user.spans.create(d.concepts['id'], [tok_id], name,
                               {UMR: {'var': name, 'attrs': [], 'constant': True}, **h.stamp('umr')}, id=uuid7())
    return sp['id'] if isinstance(sp, dict) else sp


def add_triple(ctx, a, rel, b, group, verified=True, doc='Kukama text 2'):
    """(a rel b) in the document graph. a and b are `s7.s7a` or a constant."""
    d = Doc(ctx, doc)
    src = _end(ctx, d, a)
    d = Doc(ctx, doc)
    tgt = _end(ctx, d, b)
    meta = {UMR: {'group': group}}
    if verified:
        meta.update(h.stamp('umr'))
    ctx.user.relations.create(d.doc_layer['id'], src, tgt, rel, meta)


def answer(text):
    """The conversation for a turn that answered in words and wrote nothing."""
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def as_admin(ctx):
    """ctx with admin A as the writer, for a setup: the planted state is
    somebody else's earlier work, not the task user's."""
    from types import SimpleNamespace
    return SimpleNamespace(**{**vars(ctx), 'user': ctx.client})
