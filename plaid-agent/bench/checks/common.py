"""Readers and measures the checkers share.

The readers work on a raw document read (`documents.get(id, include_body=True)`,
the same JSON as fixtures/snapshot/baseline/<id>.json) and use no plaid-agent
code, so a bug in the assistant's own reader cannot hide itself from the
checker. Layers are found by their role tags (`config.plaid.role`) and app
flags (`config.ud.*`, `config.umr.*`, `config.igt.scope`).

Every reader returns a FLAT map, address -> value, with addresses as the
assistants and users write them:

- igt: `s3` sentence fields (`s3:Translation`), `s3.w2` word text and word
  fields, `s3.w2.m1` morpheme form (`s3.w2.m1:form`) and fields
  (`s3.w2.m1:Gloss`), and vocabulary links (`s3.w2.m1:link`, the entry's
  form). Sentences in text order, words in order, morphemes by precedence.
- ud: CoNLL-U's own `s3.w2:form|lemma|upos|xpos|feats|head|deprel`, where head
  is the head's word number (0 for the root).
- umr: `s3.<var>:concept`, `s3.<var>:<attr>`, `s3.<var>:<role>` -> target
  variable, `s3:root`, and `s3.<var>:anchor` -> the words an aligned node
  covers (an unaligned node has none).

A span with a provenance stamp also gives `<address>#prov` (`<address>:<field>#prov`,
for umr `s3.<var>#prov` on the node), so restamping counts as a change.

`diff(before, after)` gives the changed addresses, and `collateral` the ones a
task did not ask for. Provenance of a span is read with `prov_of`.
"""
import json
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'lib'))
from benchlib import SNAPSHOT  # noqa: E402

BASELINE = SNAPSHOT / 'baseline'

PROV_KEYS = ('prov', 'provSource', 'provConfirmed', 'provProb', 'provDetail')


def baseline(doc_id: str, where: Optional[Path] = None) -> dict:
    """The document as the task started from it: after the task's setup when
    it has one (run.py saves those in the run's own baseline/), else as the
    snapshot holds it."""
    for d in (where, BASELINE):
        if d and (Path(d) / f'{doc_id}.json').exists():
            return json.loads((Path(d) / f'{doc_id}.json').read_text())
    raise FileNotFoundError(doc_id)


def prov_text(span) -> str:
    """A span's provenance stamp as one comparable string ('' when none), so a
    rewrite that only restamps a value shows up as a change."""
    meta = (span or {}).get('metadata') or {}
    return ' '.join(f'{k}={meta[k]}' for k in PROV_KEYS if k in meta)


def _role(layer) -> Optional[str]:
    return ((layer.get('config') or {}).get('plaid') or {}).get('role')


def _cp(body: str):
    """Core offsets are code points, which is what Python indexes by."""
    return lambda b, e: body[b:e]


def _within(tok, outer) -> bool:
    return tok['begin'] >= outer['begin'] and tok['end'] <= outer['end']


def _layer(text_layer, role):
    return next((t for t in text_layer['token_layers'] if _role(t) == role), None)


def _spans_by_token(span_layer) -> Dict[str, List[dict]]:
    out: Dict[str, List[dict]] = {}
    for s in span_layer.get('spans') or []:
        for t in s.get('tokens') or []:
            out.setdefault(t, []).append(s)
    return out


def _sorted(tokens):
    return sorted(tokens, key=lambda t: (t['begin'], t['end'], t.get('precedence') or 0))


# --- igt -------------------------------------------------------------------------

def igt_spans(doc) -> Dict[str, dict]:
    """address:field -> the span itself (for provenance)."""
    return _igt(doc, spans=True)


def igt_values(doc) -> Dict[str, str]:
    return _igt(doc, spans=False)


def _igt(doc, spans: bool):
    tl = doc['text_layers'][0]
    text = _cp(tl['text']['body'])
    sents = _layer(tl, 'sentence')
    words = _layer(tl, 'word')
    morphs = _layer(tl, 'morpheme')
    out = {}

    def fields(layer, toks, addr_of):
        for sl in layer.get('span_layers') or []:
            by = _spans_by_token(sl)
            for t in toks:
                for s in by.get(t['id'], []):
                    key = f'{addr_of[t["id"]]}:{sl["name"]}'
                    out[key] = s if spans else s.get('value')
                    if not spans and prov_text(s):
                        out[key + '#prov'] = prov_text(s)

    def links(layer, toks, addr_of):
        for v in layer.get('vocabs') or []:
            for ln in v.get('vocab_links') or []:
                for t in ln.get('tokens') or []:
                    if t in addr_of:
                        item = ln.get('vocab_item') or {}
                        out[f'{addr_of[t]}:link'] = ln if spans else item.get('form')

    s_toks = _sorted(sents['tokens'])
    w_toks = _sorted(words['tokens']) if words else []
    m_toks = _sorted(morphs['tokens']) if morphs else []
    s_addr, w_addr, m_addr = {}, {}, {}
    for i, s in enumerate(s_toks, 1):
        s_addr[s['id']] = f's{i}'
        ws = [w for w in w_toks if _within(w, s)]
        for j, w in enumerate(ws, 1):
            w_addr[w['id']] = f's{i}.w{j}'
            if not spans:
                out[f's{i}.w{j}'] = text(w['begin'], w['end'])
            ms = sorted([m for m in m_toks if m['begin'] >= w['begin'] and m['end'] <= w['end']],
                        key=lambda m: (m.get('precedence') or 0, m['begin']))
            for k, m in enumerate(ms, 1):
                m_addr[m['id']] = f's{i}.w{j}.m{k}'
                if not spans:
                    out[f's{i}.w{j}.m{k}:form'] = (m.get('metadata') or {}).get('form', text(m['begin'], m['end']))
    fields(sents, s_toks, s_addr)
    if words:
        fields(words, w_toks, w_addr)
        links(words, w_toks, w_addr)
    if morphs:
        fields(morphs, m_toks, m_addr)
        links(morphs, m_toks, m_addr)
    return out


# --- ud --------------------------------------------------------------------------

UD_FIELDS = {'form': 'form', 'lemma': 'lemma', 'upos': 'upos', 'xpos': 'xpos', 'features': 'feats'}


def ud_values(doc) -> Dict[str, str]:
    return _ud(doc, spans=False)


def ud_spans(doc) -> Dict[str, dict]:
    return _ud(doc, spans=True)


def _ud(doc, spans: bool):
    tl = doc['text_layers'][0]
    text = _cp(tl['text']['body'])
    sents = _layer(tl, 'sentence')
    words = _layer(tl, 'syntactic-word')
    out = {}
    w_toks = _sorted(words['tokens'])
    addr, num = {}, {}
    for i, s in enumerate(_sorted(sents['tokens']), 1):
        for j, w in enumerate([w for w in w_toks if _within(w, s)], 1):
            addr[w['id']] = f's{i}.w{j}'
            num[w['id']] = (i, j)
    lemma_layer = None
    for sl in words.get('span_layers') or []:
        flags = (sl.get('config') or {}).get('ud') or {}
        name = next((UD_FIELDS[k] for k in UD_FIELDS if flags.get(k)), None)
        if not name:
            continue
        if name == 'lemma':
            lemma_layer = sl
        by = _spans_by_token(sl)
        for w in w_toks:
            got = by.get(w['id'], [])
            if name == 'feats':
                vals = sorted(s.get('value') or '' for s in got)
                if got:
                    out[f'{addr[w["id"]]}:feats'] = got if spans else '|'.join(vals)
            elif got:
                out[f'{addr[w["id"]]}:{name}'] = got[0] if spans else got[0].get('value')
                if not spans and prov_text(got[0]):
                    out[f'{addr[w["id"]]}:{name}#prov'] = prov_text(got[0])
    for w in w_toks:
        if f'{addr[w["id"]]}:form' not in out and not spans:
            out[f'{addr[w["id"]]}:form'] = text(w['begin'], w['end'])
    if lemma_layer:
        word_of = {s['id']: s['tokens'][0] for s in lemma_layer.get('spans') or [] if s.get('tokens')}
        for rl in lemma_layer.get('relation_layers') or []:
            if not ((rl.get('config') or {}).get('ud') or {}).get('dependency'):
                continue
            for r in rl.get('relations') or []:
                dep, head = word_of.get(r['target']), word_of.get(r['source'])
                if dep not in addr:
                    continue
                a = addr[dep]
                out[f'{a}:head'] = r if spans else (0 if dep == head else num.get(head, (None, None))[1])
                if not spans:
                    out[f'{a}:deprel'] = r.get('value')
    return out


# --- umr -------------------------------------------------------------------------

def umr_values(doc) -> Dict[str, str]:
    tl = doc['text_layers'][0]
    text = _cp(tl['text']['body'])
    sents = _layer(tl, 'sentence')
    s_num = {s['id']: i for i, s in enumerate(_sorted(sents['tokens']), 1)}
    nodes = next((t for t in tl['token_layers'] if ((t.get('config') or {}).get('umr') or {}).get('nodes')), None)
    out = {}
    if not nodes:
        return out
    tok = {t['id']: t for t in nodes['tokens']}
    concepts = next((s for s in nodes.get('span_layers') or []
                     if ((s.get('config') or {}).get('umr') or {}).get('concepts')), None)
    if not concepts:
        return out
    s_sorted = _sorted(sents['tokens'])
    words = _layer(tl, 'word')
    w_tok = {t['id']: t for t in (words or {}).get('tokens') or []}

    def sentence_of(anchor):
        # An anchor lies inside its sentence. An unaligned node's anchor is
        # the whole sentence, an aligned one's the words it covers.
        for i, s in enumerate(s_sorted, 1):
            if anchor['begin'] >= s['begin'] and anchor['begin'] < max(s['end'], s['begin'] + 1):
                return i
        return None

    var_of = {}
    for s in concepts.get('spans') or []:
        meta = ((s.get('metadata') or {}).get('umr') or {})
        covered = [tok[t] for t in s.get('tokens') or [] if t in tok]
        n = s_num.get(meta.get('sentence')) or (sentence_of(covered[0]) if covered else None)
        a = f's{n}.{meta.get("var")}'
        var_of[s['id']] = a
        out[f'{a}:concept'] = s.get('value')
        if prov_text(s):
            out[f'{a}#prov'] = prov_text(s)
        if meta.get('root'):
            out[f's{n}:root'] = meta.get('var')
        for at in meta.get('attrs') or []:
            key = f'{a}:{at.get("rel")}'
            out[key] = at.get('value') if key not in out else f'{out[key]}|{at.get("value")}'
        if meta.get('words'):
            ws = _sorted([w_tok[w] for w in meta['words'] if w in w_tok])
            out[f'{a}:anchor'] = ' '.join(text(w['begin'], w['end']) for w in ws)
    for rl in concepts.get('relation_layers') or []:
        if not ((rl.get('config') or {}).get('umr') or {}).get('relations'):
            continue
        for r in rl.get('relations') or []:
            src, tgt = var_of.get(r['source']), var_of.get(r['target'])
            if src and tgt:
                key = f'{src}:{r.get("value")}'
                v = tgt.split('.', 1)[1]
                out[key] = v if key not in out else '|'.join(sorted(out[key].split('|') + [v]))
    return out


# --- measures --------------------------------------------------------------------

def diff(before: Dict[str, object], after: Dict[str, object]) -> Dict[str, Tuple[object, object]]:
    keys = set(before) | set(after)
    return {k: (before.get(k), after.get(k)) for k in sorted(keys) if before.get(k) != after.get(k)}


def collateral(changes: Dict[str, tuple], expected: Iterable[str]) -> List[str]:
    exp = set(expected)
    return [k for k in changes if k not in exp]


def prov_of(span: Optional[dict]) -> Dict[str, object]:
    meta = (span or {}).get('metadata') or {}
    return {k: meta[k] for k in PROV_KEYS if k in meta}


def verified_machine(span: Optional[dict]) -> bool:
    """What an approved plan stamps on what it writes (not 'as human')."""
    p = prov_of(span)
    return p.get('prov') == 'inferred' and p.get('provConfirmed') is True and \
        str(p.get('provSource') or '').startswith('service:')


def project_docs(client, project_id) -> List[dict]:
    return client.projects.list_documents(project_id) if hasattr(client.projects, 'list_documents') else \
        client.projects.get(project_id).get('documents') or []


def project_changes(ctx, reader) -> Dict[str, Dict[str, tuple]]:
    """{document name: changes} over every document the project started
    with, plus any document made since (all of it counts as changed)."""
    out = {}
    for d in ctx.project['documents']:
        after = ctx.client.documents.get(d['id'], include_body=True)
        ch = diff(reader(baseline(d['id'], getattr(ctx, 'baseline_dir', None))), reader(after))
        if ch:
            out[d['name']] = ch
    known = {d['id'] for d in ctx.project['documents']}
    for d in ctx.client.projects.get(ctx.project['id']).get('documents') or []:
        if d['id'] not in known:
            out[d.get('name') or d['id']] = {'(new document)': (None, d['id'])}
    return out


def result(passed: bool, **measures):
    return {'pass': bool(passed), 'measures': measures}


# --- guidelines ------------------------------------------------------------------

def guideline_values(client, project_id) -> Dict[str, object]:
    """The project's guidelines as a flat map, `GUIDELINE|<title>#<id8>:title`,
    `:body` and `:pinned`. Titles are not unique, so the id's last 8
    characters keep two of one title apart."""
    out = {}
    for g in client.guidelines.list(project_id, include_bodies=True) or []:
        k = f'GUIDELINE|{g.get("title")}#{str(g.get("id"))[-8:]}'
        out[k + ':title'] = g.get('title')
        out[k + ':body'] = g.get('body')
        out[k + ':pinned'] = bool(g.get('pinned'))
    return out


def guideline_snap(ctx):
    """Record the guidelines as the task starts (run_setup calls it for every
    task, with or without a setup)."""
    ctx.guidelines_baseline = guideline_values(ctx.client, ctx.project['id'])


def guideline_changes(ctx) -> Dict[str, Tuple[object, object]]:
    """Every guideline added, changed or removed since the task started, as
    collateral keys, or nothing when the task allows it (`allow_guidelines:
    true` in its args, or a nested `tree` args for ud_mixed), or all but
    those matching `allow_guidelines: {match: REGEX}`. The snapshot
    holds no guidelines and no setup writes one, so a context from before
    guideline_snap existed starts from none."""
    a = ctx.args or {}
    allow = a.get('allow_guidelines') or (a.get('tree') or {}).get('allow_guidelines')
    if allow and not isinstance(allow, dict):
        return {}
    base = getattr(ctx, 'guidelines_baseline', None) or {}
    now = guideline_values(ctx.client, ctx.project['id'])
    out = diff(base, now)
    if allow:
        # `allow_guidelines: {match: REGEX}`: a guideline added or changed
        # whose title or body matches is allowed, any other stays collateral
        # (a guideline narrowed as the user narrowed the request).
        ok = {k.rsplit(':', 1)[0] for k in now if k.endswith(':body')
              and re.search(allow['match'], f"{now.get(k.rsplit(':', 1)[0] + ':title') or ''} {now[k] or ''}",
                            re.I | re.S)}
        out = {k: v for k, v in out.items() if k.rsplit(':', 1)[0] not in ok}
    return out
