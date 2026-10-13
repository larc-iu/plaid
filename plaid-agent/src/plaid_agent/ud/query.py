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

from ..core.query import HELP, display, layer_index, query_tool
from .project import word_ref
from .tools import Workspace

UD_HELP = '''
A STRUCTURAL QUESTION (a head and its dependent, a deprel with a UPOS on either end, a word that lacks a
dependent) and any pattern the user wants for the Search tab is grew_search's, not this language's: the
Search tab speaks Grew. Use this language for what Grew cannot say.

THIS PROJECT'S LAYERS, and how UD sits on them:
  token layers: sentences, tokens (the surface tokens), words (the syntactic words)
  text layer: baseline
  A WORD is where every annotation lives. A surface token holds one word, or several when it is a
  multi-word token, and every one of them covers the whole token.
  annotation layers (spans covering a word): {fields}
  A DEPENDENCY is a relation on the {deprel} layer whose source and target are the LEMMA SPANS of
  two words, not the words themselves. The SOURCE is the HEAD's lemma span and the TARGET the
  DEPENDENT's: a word's own relation (its DEPREL) is the one whose target is its lemma span, and the
  relations whose source is its lemma span are those of the words that depend on it.
  The root is a relation from a lemma span to itself.
  provenance metadata on machine-made values: {{"prov": "inferred", "provSource": "...", "provConfirmed": true|absent}}

Examples for this project:
  # every word whose UPOS is VERB, with the sentence it sits in
  {{"find": ["?w"], "where": [["span","?u",{{"layer":"upos","value":"VERB"}}], ["covers","?u","?w"]],
   "return": "entities"}}
  # words that are VERB and have a nominal subject hanging off them
  {{"find": ["?w"], "where": [["span","?u",{{"layer":"upos","value":"VERB"}}], ["covers","?u","?w"],
   ["span","?hl",{{"layer":"lemma"}}], ["covers","?hl","?w"],
   ["relation","?r",{{"layer":"{deprel}","value":"nsubj","source":"?hl"}}]], "return": "entities"}}
  # words whose own relation (DEPREL) is not case: the word's lemma span is the TARGET
  {{"find": ["?w"], "where": [["span","?wl",{{"layer":"lemma"}}], ["covers","?wl","?w"],
   ["relation","?r",{{"layer":"{deprel}","target":"?wl"}}], ["!=","?r.value","case"]], "return": "entities"}}
  # how many words per document
  {{"where": [["token","?w",{{"layer":"words","doc":{{"var":"?d"}}}}]],
   "return": {{"group": ["?d"], "aggregates": [["count"]]}}}}
  # a DET immediately followed by a NOUN
  {{"find": ["?a","?b"], "where": [["seq", {{"layer":"words"}},
   ["span", {{"layer":"upos","value":"DET"}}, "as", "?a"], ["span", {{"layer":"upos","value":"NOUN"}}, "as", "?b"]]],
   "return": "entities"}}
'''


def _layer_index(ws: Workspace) -> Dict[str, List[tuple]]:
    """Every layer the model may name (:func:`core.query.layer_index`), with
    UD's own names for its token layers, its columns ("upos") and its
    dependency layer."""
    p = ws.project
    names = {p.sentence_layer_id: 'sentences', p.token_layer_id: 'tokens', p.word_layer_id: 'words',
             p.relation_layer_id: 'dependency'}

    def aliases(kind, layer):
        if kind == 'span-layer':
            return [field for field, lid in p.span_layers.items() if lid == layer['id']]
        return [names[layer['id']]] if kind in ('token-layer', 'relation-layer') and layer['id'] in names else []
    return layer_index(ws, aliases)


def t_query_help(ws: Workspace) -> str:
    p = ws.project
    fields = ', '.join(sorted(p.span_layers)) or '(none)'
    deprel = 'dependency' if p.relation_layer_id else '(this project has no dependency layer)'
    return HELP + UD_HELP.format(fields=fields, deprel=deprel)


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents. What makes a
    row readable: "Viaje" s3.w2 rather than a UUID."""
    refs: Dict[str, str] = {}
    # Every one of them is read below, so there is nothing to guess at.
    ws.read_ahead(doc_ids)
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
                    for field, sp in w.all_spans():
                        refs[sp.id] = f'{wr} {field}'
                    if w.relation_id:
                        refs[w.relation_id] = f'{wr} {w.deprel or "dep"}'
    return refs


def t_query(ws: Workspace, query: Any = None, limit: Any = None) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    return query_tool(ws, query, limit, _layer_index, display, _ref_index)
