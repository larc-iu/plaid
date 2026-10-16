"""IGT's half of the query escape hatch: what a layer is called, and how a row
is named back.

The language, the rewriting and the rendering are shared
(:mod:`plaid_agent.core.query`). What is IGT's is the vocabulary: fields are
named by their display names, the three token layers answer to "words",
"morphemes" and "sentences", a morpheme carries its form in metadata, and a
lexicon is a vocab layer. A model that does not know that writes queries that
return nothing, so the help says it in as many words.
"""

import json
from typing import Any, Dict, List

from ..core.query import HELP, display, layer_index, query_tool
from .project import word_ref
from .workspace import Workspace

IGT_HELP = '''
THIS PROJECT'S LAYERS, and how interlinear text sits on them:
  token layers: words, sentences{morphemes}  (text layer: baseline)
  A field is a span layer covering a token of its scope. A morpheme token carries its form in
  metadata.form and its type in metadata.morphType.
  A vocab layer is a lexicon; ["link", "?l", {{...}}] is a link itself, and its metadata is its
  provenance ({{"prov": "inferred"|"contributed", "provConfirmed": true}}). One link over several
  words is a multi-word expression.
  An entry's own fields are its metadata, by exact field name: ["vocab","?v",{{"metadata":{{{entry}:"dog"}}}}]
  matches one, and "?v.metadata.{entry_bare}" reads one in a predicate or a group.
{layers}
  provenance metadata on machine-made annotations: {{"prov": "inferred", "provSource": "...", "provConfirmed": true|absent}}

Examples for this project:
  # morphemes glossed ERG that are the last morpheme of their word
  {{"find": ["?m"], "where": [["span","?g",{{"layer":"{gloss}","value":"ERG"}}], ["covers","?g","?m"],
   ["token","?m",{{"layer":"morphemes"}}],
   ["not", ["precedes","?m","?n"], ["token","?n",{{"layer":"morphemes"}}], ["within","?n","?w"],
    ["within","?m","?w"], ["token","?w",{{"layer":"words"}}]]]}}
  # how many words per document
  {{"where": [["token","?t",{{"layer":"words","doc":{{"var":"?d"}}}}]],
   "return": {{"group": ["?d"], "aggregates": [["count"]]}}}}
  # words linked to the entry "kar"
  {{"find": ["?t"], "where": [["vocab","?v",{{"form":"kar"}}], ["vocab-link","?t","?v"]], "return": "entities"}}
  # words under a machine-made link nobody confirmed
  {{"find": ["?t"], "where": [["link","?l",{{"metadata":{{"prov":"inferred"}}}}],
   ["not", ["link","?l",{{"metadata":{{"provConfirmed":true}}}}]],
   ["link-token","?l","?t"], ["token","?t",{{"layer":"words"}}]]}}
'''


def _layer_index(ws: Workspace) -> Dict[str, List[tuple]]:
    """Every layer the model may name (:func:`core.query.layer_index`), the
    three token layers also as "words", "morphemes" and "sentences", and a
    field by its IGT display name ("Gloss (Word)") as well as its bare layer
    name, which is ambiguous when scopes collide."""
    p = ws.project
    tokens = {p.word_layer_id: 'words', p.morpheme_layer_id: 'morphemes', p.sentence_layer_id: 'sentences'}

    def aliases(kind, layer):
        if kind == 'token-layer' and layer['id'] in tokens:
            return [tokens[layer['id']]]
        if kind == 'span-layer':
            f = p.field_by_layer(layer['id'])
            return [f.name] if f else []
        return []
    return layer_index(ws, aliases)


def t_query_help(ws: Workspace) -> str:
    p = ws.project
    lines = []
    for scope in ('Word', 'Morpheme', 'Sentence'):
        fs = p.fields_by_scope(scope)
        if fs:
            lines.append(f'  {scope}-scope fields (span layers on {scope.lower()} tokens): '
                         + ', '.join(f.name for f in fs))
    if p.vocabs:
        lines.append('  lexicons (vocab layers): ' + ', '.join(
            v['name'] + (f' (entry fields: {", ".join(f["name"] for f in v["fields"])})' if v.get('fields') else '')
            for v in p.vocabs))
    gloss = p.gloss_field('Morpheme') or p.gloss_field('Word')
    # The example spells a lexicon field this project has, since a metadata
    # key matches only as it is spelled.
    names = [f['name'] for v in p.vocabs or [] for f in v.get('fields') or []]
    entry = next((n for n in names if 'gloss' in n.casefold()), names[0] if names else 'Gloss')
    return HELP + IGT_HELP.format(morphemes=', morphemes' if p.morpheme_layer_id else '',
                                  layers='\n'.join(lines), gloss=gloss.name if gloss else 'Gloss',
                                  entry=json.dumps(entry, ensure_ascii=False), entry_bare=entry)


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents. What makes a
    row readable: "Text 1" s3.w2 rather than a UUID."""
    refs: Dict[str, str] = {}
    # Every one of them is read below, so there is nothing to guess at.
    ws.read_ahead(doc_ids)
    for did in doc_ids:
        try:
            doc = ws.doc(did)
        except Exception:  # noqa: BLE001 - a document we cannot load simply has no refs
            continue
        tag = f'"{ws.corpus.ref_name(did)}" '
        for s in doc.sentences:
            refs[s.id] = f'{tag}s{s.index}'
            for f, sp in s.fields.items():
                refs[sp.id] = f'{tag}s{s.index} {f}'
            for w in s.words:
                wr = f'{tag}{word_ref(s, w)}'
                refs[w.id] = wr
                for f, sp in w.fields.items():
                    refs[sp.id] = f'{wr} {f}'
                if w.link:
                    refs[w.link.id] = f'{wr} link'
                for m in w.morphemes:
                    refs[m.id] = f'{wr}.m{m.index}'
                    for f, sp in m.fields.items():
                        refs[sp.id] = f'{wr}.m{m.index} {f}'
    return refs


def _entry_refs(ws: Workspace, entities: List[Dict[str, Any]]) -> Dict[str, str]:
    """entry id -> its label as the lexicon tools take it back ("kwatha",
    "kwatha#1.2" for a sense), since a sense carries its headword's form and
    several of them read as one headword repeated (2026-10-13 survey)."""
    refs: Dict[str, str] = {}
    vocabs = {v['id']: v for v in ws.project.vocabs or []}
    for e in entities:
        v = vocabs.get(e.get('layer')) or ws.vocab_of_item(e['id'])
        if v is None:
            continue
        view = ws.view(v, removed=True)
        if e['id'] in view.tree.by_id:
            refs[e['id']] = view.label(e['id'])
    return refs


def t_query(ws: Workspace, query: Any = None, limit: Any = None) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    return query_tool(ws, query, limit, _layer_index, display, _ref_index, _entry_refs)
