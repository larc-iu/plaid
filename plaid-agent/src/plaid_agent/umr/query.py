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

from ..core.bidi import plain_quote
from ..core.query import HELP, display, layer_index, query_tool
from .project import node_ref
from .tools import Workspace

UMR_HELP = '''
THIS PROJECT'S LAYERS, and how UMR sits on them:
  token layers: sentences, words (the shared substrate), nodes (UMR's anchors)
  text layer: baseline
  A graph NODE is a SPAN on the `concepts` layer whose value is the concept. Its variable, its
  attributes and whether it is the sentence root are in the span's METADATA under "umr", which the
  engine does not index by value: read the document for those.
  A node's anchor is one token per contiguous piece on the `nodes` layer, over its whole sentence
  when the node is not aligned to any word (a constant such as author: a point at the text's start).
  A sentence-level RELATION is on the `relations` layer, source and target being two concept spans.
  The SOURCE is the PARENT node's span and the TARGET the CHILD's: in
  (s1x / see-01 :ARG0 (s1p / person)), :ARG0 goes from see-01 to person. A node's own role is the
  relation whose target is its span, and the relations whose source is its span are its children's.
  A document-level relation (temporal, modal, coreference) is on `documentGraph`, over the same spans.
  Its SOURCE is the first node of the triple and its TARGET the last: (s2e :before s1e) goes from
  s2e to s1e.

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
    """Every layer the model may name (:func:`core.query.layer_index`), with
    UMR's own names for its layers."""
    p = ws.project
    names = {('token-layer', p.sentence_layer_id): 'sentences', ('token-layer', p.word_layer_id): 'words',
             ('token-layer', p.morpheme_layer_id): 'morphemes', ('token-layer', p.node_layer_id): 'nodes',
             ('span-layer', p.concept_layer_id): 'concepts',
             ('relation-layer', p.relation_layer_id): 'relations',
             ('relation-layer', p.document_graph_layer_id): 'documentGraph'}
    return layer_index(ws, lambda kind, layer: [names[kind, layer['id']]] if (kind, layer['id']) in names else [])


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
        tag = f'{plain_quote(doc.name)} '
        for c in doc.constants:
            refs[c.id] = f'{tag}{c.var}'
        for s in doc.sentences:
            refs[s.id] = f'{tag}s{s.number}'
            for w in s.words:
                refs.setdefault(w.id, f'{tag}s{s.number} word {w.index}')
            for node in s.nodes:
                where = f'{tag}{node_ref(s, node)}'
                refs[node.id] = where
                for piece in node.pieces + node.holds:
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
    return query_tool(ws, query, limit, _layer_index, display, _ref_index)
