"""UD's half of the query escape hatch: what a layer is called, and how a row
is named back.

The language, the rewriting and the rendering are shared
(:mod:`plaid_agent.core.query`). What is UD's is the vocabulary: `words` are
the syntactic words that carry the annotation, `tokens` are the surface ones
they sit in, and a dependency is a relation between LEMMA spans rather than
between tokens. A model that does not know that writes queries that return
nothing, so the help says it in as many words.
"""

from typing import Any, Dict, List

from ..core.query import (HELP, QueryRefused, cell, documents_in, parse_query, render,
                          resolve_layer, rewrite, run)
from .project import word_ref
from .tools import ToolError, Workspace, _truncate

UD_HELP = '''
THIS PROJECT'S LAYERS, and how UD sits on them:
  token layers: sentences, tokens (the surface tokens), words (the syntactic words)
  text layer: baseline
  A WORD is where every annotation lives. A surface token holds one word, or several when it is a
  multi-word token, and every one of them covers the whole token.
  annotation layers (spans covering a word): {fields}
  A DEPENDENCY is a relation on the {deprel} layer whose source and target are the LEMMA SPANS of
  two words, not the words themselves. The root is a relation from a lemma span to itself.
  provenance metadata on machine-made values: {{"prov": "inferred", "provSource": "...", "provConfirmed": true|absent}}

Examples for this project:
  # every word whose UPOS is VERB, with the sentence it sits in
  {{"find": ["?w"], "where": [["span","?u",{{"layer":"upos","value":"VERB"}}], ["covers","?u","?w"]],
   "return": "entities"}}
  # words that are VERB and have a nominal subject hanging off them
  {{"find": ["?w"], "where": [["span","?u",{{"layer":"upos","value":"VERB"}}], ["covers","?u","?w"],
   ["span","?hl",{{"layer":"lemma"}}], ["covers","?hl","?w"],
   ["relation","?r",{{"layer":"{deprel}","value":"nsubj","source":"?hl"}}]], "return": "entities"}}
  # how many words per document
  {{"where": [["token","?w",{{"layer":"words","doc":{{"var":"?d"}}}}]],
   "return": {{"group": ["?d"], "aggregates": [["count"]]}}}}
  # a DET immediately followed by a NOUN
  {{"find": ["?a","?b"], "where": [["seq", {{"layer":"words"}},
   ["span", {{"layer":"upos","value":"DET"}}, "as", "?a"], ["span", {{"layer":"upos","value":"NOUN"}}, "as", "?b"]]],
   "return": "entities"}}
'''


def _layer_index(ws: Workspace) -> Dict[str, List[tuple]]:
    """name (casefolded) -> [(kind, id, display)] over every layer the model may
    name. UD's own names for the three token layers are the aliases that
    matter, since the project's raw layer names are whatever its setup used."""
    p = ws.project
    raw = ws.client.projects.get(p.id)
    idx: Dict[str, List[tuple]] = {}

    def add(name, kind, lid):
        if name and lid:
            idx.setdefault(name.casefold(), []).append((kind, lid, name))

    for tl in raw.get('text_layers') or []:
        add(tl.get('name'), 'text-layer', tl['id'])
        if tl['id'] == p.text_layer_id:
            add('baseline', 'text-layer', tl['id'])
        for tk in tl.get('token_layers') or []:
            add(tk.get('name'), 'token-layer', tk['id'])
            for alias, lid in (('sentences', p.sentence_layer_id),
                               ('tokens', p.token_layer_id),
                               ('words', p.word_layer_id)):
                if lid and tk['id'] == lid:
                    add(alias, 'token-layer', tk['id'])
            for sl in tk.get('span_layers') or []:
                add(sl.get('name'), 'span-layer', sl['id'])
                # The UD name ("upos") as well as whatever the layer is called.
                for field, lid in p.span_layers.items():
                    if lid == sl['id']:
                        add(field, 'span-layer', sl['id'])
                for rl in sl.get('relation_layers') or []:
                    add(rl.get('name'), 'relation-layer', rl['id'])
                    if p.relation_layer_id and rl['id'] == p.relation_layer_id:
                        add('dependency', 'relation-layer', rl['id'])
    return idx


def _display(idx: Dict[str, List[tuple]]):
    names = {h[1]: h[2] for hs in idx.values() for h in hs}
    return lambda lid: names.get(lid, lid)


def t_query_help(ws: Workspace) -> str:
    p = ws.project
    fields = ', '.join(sorted(p.span_layers)) or '(none)'
    deprel = 'dependency' if p.relation_layer_id else '(this project has no dependency layer)'
    return HELP + UD_HELP.format(fields=fields, deprel=deprel)


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents. What makes a
    row readable: "Viaje" s3.w2 rather than a UUID."""
    refs: Dict[str, str] = {}
    for did in doc_ids:
        try:
            doc = ws.doc(did)
        except Exception:  # noqa: BLE001 - a document we cannot load simply has no refs
            continue
        tag = f'"{doc.name}" '
        for s in doc.sentences:
            refs[s.id] = f'{tag}s{s.index}'
            for t in s.tokens:
                refs.setdefault(t.id, f'{tag}s{s.index}.{t.ref_range}')
                for w in t.words:
                    wr = f'{tag}{word_ref(s, w)}'
                    refs[w.id] = wr
                    for field, sp in w.fields.items():
                        refs[sp.id] = f'{wr} {field}'
                    if w.relation_id:
                        refs[w.relation_id] = f'{wr} {w.deprel or "dep"}'
    return refs


def t_query(ws: Workspace, query: Any = None, limit: int = 50) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    try:
        q = parse_query(query)
        limit = max(1, min(int(limit or 50), 500))
        idx = _layer_index(ws)
        docs = {(d.get('name') or '').casefold(): d['id'] for d in ws.documents()}
        q = rewrite(q, idx, _display(idx), docs)
        ws.on_progress('Running the query…')
        res = run(ws.client, q, ws.project.id)
    except QueryRefused as e:
        raise ToolError(str(e))
    doc_names = {d['id']: d.get('name') for d in ws.documents()}
    rows = res.get('results') or [] if isinstance(res, dict) else []
    refs = _ref_index(ws, documents_in(rows, limit))
    layer_names = {h[1]: h[2] for hs in idx.values() for h in hs}
    return _truncate(render(res, q, limit, refs, layer_names, doc_names))
