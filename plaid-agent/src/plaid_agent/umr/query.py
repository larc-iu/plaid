"""UMR's half of the query escape hatch: what a layer is called, and how a row
is named back.

The language, the rewriting and the rendering are shared
(:mod:`plaid_agent.core.query`). What is UMR's is the vocabulary: a graph NODE
is a span in the concept layer, a RELATION is a relation between two of those
spans, and the document graph is a second relation layer over the same spans.
A model that does not know that writes queries that return nothing, so the
help says it in as many words.
"""

from typing import Any, Dict, List

from ..core.query import HELP, query_tool
from .project import node_ref
from .tools import Workspace

UMR_HELP = '''
THIS PROJECT'S LAYERS, and how UMR sits on them:
  token layers: sentences, words (the shared substrate), nodes (UMR's anchors)
  text layer: baseline
  A graph NODE is a SPAN on the `concepts` layer whose value is the concept. Its variable, its
  attributes and whether it is the sentence root are in the span's METADATA under "umr", which the
  engine does not index by value: read the document for those.
  A node's anchor is one token per contiguous piece on the `nodes` layer, zero-width when the node
  is not aligned to any word.
  A sentence-level RELATION is on the `relations` layer, source and target being two concept spans.
  A document-level relation (temporal, modal, coreference) is on `documentGraph`, over the same spans.

Examples for this project:
  # every node whose concept is a -91 roleset
  {{"find": ["?n"], "where": [["span","?n",{{"layer":"concepts","value":{{"regex":"-91$"}}}}]],
   "return": "entities"}}
  # how many nodes per document
  {{"where": [["span","?n",{{"layer":"concepts","doc":{{"var":"?d"}}}}]],
   "return": {{"group": ["?d"], "aggregates": [["count"]]}}}}
  # the commonest roles
  {{"where": [["relation","?r",{{"layer":"relations"}}]],
   "return": {{"group": ["?r.value"], "aggregates": [["count"]]}}}}
  # the targets of every :ARG0
  {{"find": ["?n"], "where": [["relation","?r",{{"layer":"relations","value":":ARG0","target":"?n"}}],
   ["span","?n",{{"layer":"concepts"}}]], "return": "entities"}}
'''


def _layer_index(ws: Workspace) -> Dict[str, List[tuple]]:
    """name (casefolded) -> [(kind, id, display)] over every layer the model
    may name. UMR's own names for its four layers are the aliases that matter,
    since a project's raw layer names are whatever its setup used."""
    p = ws.project
    raw = ws.client.projects.get(p.id)
    idx: Dict[str, List[tuple]] = {}

    def add(name, kind, lid):
        if name and lid:
            idx.setdefault(name.casefold(), []).append((kind, lid, name))

    aliases = {p.sentence_layer_id: 'sentences', p.word_layer_id: 'words',
               p.morpheme_layer_id: 'morphemes', p.node_layer_id: 'nodes'}
    for tl in raw.get('text_layers') or []:
        add(tl.get('name'), 'text-layer', tl['id'])
        if tl['id'] == p.text_layer_id:
            add('baseline', 'text-layer', tl['id'])
        for tk in tl.get('token_layers') or []:
            add(tk.get('name'), 'token-layer', tk['id'])
            alias = aliases.get(tk['id'])
            if alias:
                add(alias, 'token-layer', tk['id'])
            for sl in tk.get('span_layers') or []:
                add(sl.get('name'), 'span-layer', sl['id'])
                if sl['id'] == p.concept_layer_id:
                    add('concepts', 'span-layer', sl['id'])
                for rl in sl.get('relation_layers') or []:
                    add(rl.get('name'), 'relation-layer', rl['id'])
                    if rl['id'] == p.relation_layer_id:
                        add('relations', 'relation-layer', rl['id'])
                    if rl['id'] == p.document_graph_layer_id:
                        add('documentGraph', 'relation-layer', rl['id'])
    return idx


def _display(idx: Dict[str, List[tuple]]):
    names = {h[1]: h[2] for hs in idx.values() for h in hs}
    return lambda lid: names.get(lid, lid)


def t_query_help(ws: Workspace) -> str:
    return HELP + UMR_HELP.format()


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents. What makes a
    row readable: "Story" s3.s3e rather than a UUID."""
    refs: Dict[str, str] = {}
    ws.read_ahead(doc_ids)
    for did in doc_ids:
        try:
            doc = ws.doc(did)
        except Exception:  # noqa: BLE001 - a document we cannot load simply has no refs
            continue
        tag = f'"{doc.name}" '
        for c in doc.constants:
            refs[c.id] = f'{tag}{c.var}'
        for s in doc.sentences:
            refs[s.id] = f'{tag}s{s.index}'
            for w in s.words:
                refs.setdefault(w.id, f'{tag}s{s.index} word {w.index}')
            for node in s.nodes:
                where = f'{tag}{node_ref(s, node)}'
                refs[node.id] = where
                for piece in node.pieces:
                    refs.setdefault(piece.id, f'{where} anchor')
                for e in node.out:
                    target = doc.nodes_by_id.get(e.target)
                    refs[e.id] = f'{where} {e.role} {target.var if target else "?"}'
                for t in node.doc_out:
                    target = doc.nodes_by_id.get(t.target)
                    refs[t.id] = f'{where} {t.rel} {target.var if target else "?"}'
    return refs


def t_query(ws: Workspace, query: Any = None, limit: Any = None) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    return query_tool(ws, query, limit, _layer_index, _display, _ref_index)
