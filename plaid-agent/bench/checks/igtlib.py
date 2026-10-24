"""IGT readers and writers for the igt tasks that touch the lexicon or reshape
words: the document values of common.igt_values with lexicon links that name
the SENSE they point at, the lexicon itself as a flat map, and helpers that
setups and validations write with.

Names
-----
An entry is named by a label, `form|gloss`, from the lexicon as the task
started (after its setup): `ава|cop` for that sense, `ава|` for the headword
with no gloss of its own. In the SIGMORPHON lexicons no two entries share a
label. An entry made since is `+form|gloss` (its form and gloss now).

Lexicon map: `<label>:form`, `<label>:<metadata key>` (gloss, pos,
morphType, senseOrder, homograph, ...), `<label>:parent` (the parent's
label), `<label>#prov`.

Document map: what common.igt_values gives, except that a link is
`sN.wN[.mN]:link` -> the label of the entry it points at (not the bare form),
a multi-word expression is `sN.wA+sN.wB:mwe` -> label, and a link with a
provenance stamp adds `...:link#prov` / `...:mwe#prov`.
"""
import json
from typing import Dict, List, Optional

import common as c

LEX_SKIP = set(c.PROV_KEYS)


# --- the lexicon -----------------------------------------------------------------

def vocab_items(client, vocab_id) -> List[dict]:
    return client.vocab_layers.get(vocab_id, include_items=True).get('items') or []


def label(item) -> str:
    return f'{item.get("form") or ""}|{(item.get("metadata") or {}).get("gloss") or ""}'


def labels(items) -> Dict[str, str]:
    return {it['id']: label(it) for it in items}


def snap(ctx):
    """Record the lexicon as the task starts. Every igt_changes task calls it
    at the end of its setup, so the checker can diff the lexicon too."""
    v = ctx.project['vocabs'][0]['id']
    ctx.lex_baseline = vocab_items(ctx.client, v)


def lex_values(items, base_labels: Dict[str, str]) -> Dict[str, object]:
    lab = {it['id']: base_labels.get(it['id']) or '+' + label(it) for it in items}
    out = {}
    for it in items:
        L = lab[it['id']]
        out[f'{L}:form'] = it.get('form')
        meta = it.get('metadata') or {}
        for k, v in meta.items():
            if k in LEX_SKIP:
                continue
            if k == 'parent':
                out[f'{L}:parent'] = lab.get(v, v)
            else:
                out[f'{L}:{k}'] = v if isinstance(v, (str, int, float, bool)) or v is None else \
                    json.dumps(v, ensure_ascii=False, sort_keys=True)
        if c.prov_text(it):
            out[f'{L}#prov'] = c.prov_text(it)
    return out


# --- documents -------------------------------------------------------------------

def addresses(doc) -> Dict[str, str]:
    """token id -> address (sN, sN.wN, sN.wN.mN), numbered as common numbers them."""
    tl = doc['text_layers'][0]
    sents, words, morphs = (c._layer(tl, r) for r in ('sentence', 'word', 'morpheme'))
    w_toks = c._sorted(words['tokens']) if words else []
    m_toks = c._sorted(morphs['tokens']) if morphs else []
    out = {}
    for i, s in enumerate(c._sorted(sents['tokens']), 1):
        out[s['id']] = f's{i}'
        for j, w in enumerate([w for w in w_toks if c._within(w, s)], 1):
            out[w['id']] = f's{i}.w{j}'
            ms = sorted([m for m in m_toks if m['begin'] >= w['begin'] and m['end'] <= w['end']],
                        key=lambda m: (m.get('precedence') or 0, m['begin']))
            for k, m in enumerate(ms, 1):
                out[m['id']] = f's{i}.w{j}.m{k}'
    return out


def ids_by_address(doc) -> Dict[str, str]:
    return {a: t for t, a in addresses(doc).items()}


def doc_values(doc, base_labels: Dict[str, str], items_now: Optional[List[dict]] = None) -> Dict[str, object]:
    out = {k: v for k, v in c.igt_values(doc).items() if ':link' not in k}
    now = {it['id']: it for it in items_now or []}
    addr = addresses(doc)
    tl = doc['text_layers'][0]
    for layer in tl['token_layers']:
        for v in layer.get('vocabs') or []:
            for ln in v.get('vocab_links') or []:
                toks = [t for t in ln.get('tokens') or [] if t in addr]
                if not toks:
                    continue
                item = ln.get('vocab_item') or {}
                L = base_labels.get(item.get('id'))
                if not L:
                    it = now.get(item.get('id')) or item
                    L = '+' + label(it)
                key = f'{addr[toks[0]]}:link' if len(toks) == 1 else \
                    '+'.join(sorted((addr[t] for t in toks), key=_addr_key)) + ':mwe'
                out[key] = L
                if c.prov_text(ln):
                    out[key + '#prov'] = c.prov_text(ln)
    return out


def _addr_key(a):
    return [int(x[1:]) for x in a.split('.')]


def link_spans(doc) -> Dict[str, dict]:
    """address key (as doc_values names it) -> the link itself."""
    addr = addresses(doc)
    out = {}
    for layer in doc['text_layers'][0]['token_layers']:
        for v in layer.get('vocabs') or []:
            for ln in v.get('vocab_links') or []:
                toks = [t for t in ln.get('tokens') or [] if t in addr]
                if toks:
                    key = f'{addr[toks[0]]}:link' if len(toks) == 1 else \
                        '+'.join(sorted((addr[t] for t in toks), key=_addr_key)) + ':mwe'
                    out[key] = ln
    return out


# --- writing, for setups and validations -------------------------------------------

def doc_of(ctx, name):
    return next(d for d in ctx.project['documents'] if d['name'] == name)


def raw(ctx, name):
    return ctx.client.documents.get(doc_of(ctx, name)['id'], include_body=True)


def layer_ids(doc) -> Dict[str, str]:
    """'sentence' | 'word' | 'morpheme' -> token layer id, plus field name -> span layer id."""
    tl = doc['text_layers'][0]
    out = {}
    for t in tl['token_layers']:
        r = c._role(t)
        if r:
            out[r] = t['id']
        for sl in t.get('span_layers') or []:
            out[sl['name']] = sl['id']
    out['text'] = tl['text']['id']
    return out


def item_by_label(items, lab) -> dict:
    hits = [it for it in items if label(it) == lab]
    if len(hits) != 1:
        raise KeyError(f'{lab}: {len(hits)} entries')
    return hits[0]


def stamp(app='igt'):
    from handwrite import stamp as s
    return s(app)


def link(ctx, document, refs, entry_label, verified=True, who=None):
    """Link each of `refs` (one address each) to the entry labelled `entry_label`."""
    who = who or ctx.user
    d = raw(ctx, document)
    ids = ids_by_address(d)
    items = vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])
    it = item_by_label(items, entry_label)
    meta = stamp() if verified else None
    body = [{'vocab_item': it['id'], 'tokens': [ids[r]], **({'metadata': meta} if meta else {})} for r in refs]
    if body:
        who.vocab_links.bulk_create(body)


def link_phrase(ctx, document, refs, entry_label, verified=True):
    d = raw(ctx, document)
    ids = ids_by_address(d)
    it = item_by_label(vocab_items(ctx.client, ctx.project['vocabs'][0]['id']), entry_label)
    ctx.user.vocab_links.create(it['id'], [ids[r] for r in refs], stamp() if verified else None)


def unlink(ctx, document, refs):
    d = raw(ctx, document)
    by = link_spans(d)
    ids = [by[f'{r}:link']['id'] for r in refs]
    ctx.user.vocab_links.bulk_delete(ids)


def gloss_spans(doc, field='Gloss') -> Dict[str, dict]:
    return {k[:-len(':' + field)]: v for k, v in c.igt_spans(doc).items() if k.endswith(':' + field)}


def set_field(ctx, document, values: Dict[str, str], field='Gloss', verified=True, who=None):
    """Set `field` on each address (creating the span where there is none),
    stamped as an approved plan stamps it unless verified=False. A value of
    None deletes the span."""
    who = who or ctx.user
    d = raw(ctx, document)
    ids, spans, lay = ids_by_address(d), gloss_spans(d, field), layer_ids(d)
    meta = stamp() if verified else {}
    creates, deletes = [], []
    for a, v in values.items():
        sp = spans.get(a)
        if v is None:
            if sp:
                deletes.append(sp['id'])
            continue
        if sp:
            who.spans.update(sp['id'], v)
            m = {k: x for k, x in (sp.get('metadata') or {}).items() if k not in c.PROV_KEYS}
            m.update(meta)
            who.spans.set_metadata(sp['id'], m)
        else:
            creates.append({'span_layer_id': lay[field], 'tokens': [ids[a]], 'value': v,
                            **({'metadata': meta} if meta else {})})
    if creates:
        who.spans.bulk_create(creates)
    if deletes:
        who.spans.bulk_delete(deletes)


def create_entry(ctx, form, metadata, verified=True):
    v = ctx.project['vocabs'][0]['id']
    meta = dict(metadata)
    if verified:
        meta.update(stamp())
    return ctx.user.vocab_items.create(v, form, meta)


def patch_entry(ctx, entry_label, patch: Dict[str, object]):
    """Metadata patch on one entry: a None value removes the key."""
    from plaid_client.metadata_ops import metadata_ops
    it = item_by_label(vocab_items(ctx.client, ctx.project['vocabs'][0]['id']), entry_label)
    ctx.user.vocab_items.patch_metadata(it['id'], metadata_ops(patch))
    return it['id']


def morphemes_of(doc, word_addr) -> List[str]:
    a2i = ids_by_address(doc)
    return sorted([a for a in a2i if a.startswith(word_addr + '.m')], key=_addr_key)


def analyze(ctx, document, word_addr, morphs, verified=True):
    """Replace a word's morphemes with `morphs`: [(form, gloss), ...]. A
    morpheme token has its word's extent (the layer is coextensive with the
    words) and its form in metadata.form, as the importer and the assistant
    write them."""
    d = raw(ctx, document)
    ids, lay = ids_by_address(d), layer_ids(d)
    tl = d['text_layers'][0]
    words = c._layer(tl, 'word')
    wtok = next(t for t in words['tokens'] if t['id'] == ids[word_addr])
    old = [ids[a] for a in morphemes_of(d, word_addr)]
    if old:
        sp = [s['id'] for s in (c._layer(tl, 'morpheme').get('span_layers') or [{}])[0].get('spans') or []
              if set(s.get('tokens') or []) & set(old)]
        if sp:
            ctx.user.spans.bulk_delete(sp)
        ctx.user.tokens.bulk_delete(old)
    meta = stamp() if verified else {}
    for i, (form, gloss) in enumerate(morphs, 1):
        b, e = wtok['begin'], wtok['end']
        t = ctx.user.tokens.create(lay['morpheme'], lay['text'], b, e, precedence=i,
                                   metadata={'form': form, **meta})
        tid = t['id'] if isinstance(t, dict) else t
        if gloss is not None:
            ctx.user.spans.create(lay['Gloss'], [tid], gloss, meta or None)


def strip_analysis(ctx, document, word_addr):
    """Delete a word's morphemes and their values (the word left unanalyzed)."""
    d = raw(ctx, document)
    ids = ids_by_address(d)
    tl = d['text_layers'][0]
    old = [ids[a] for a in morphemes_of(d, word_addr)]
    sp = [s['id'] for s in (c._layer(tl, 'morpheme').get('span_layers') or [{}])[0].get('spans') or []
          if set(s.get('tokens') or []) & set(old)]
    if sp:
        ctx.user.spans.bulk_delete(sp)
    if old:
        ctx.user.tokens.bulk_delete(old)


def values_now(ctx, document):
    items = vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])
    base = labels(getattr(ctx, 'lex_baseline', None) or items)
    return doc_values(raw(ctx, document), base, items)
