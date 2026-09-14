"""IGT's half of the query escape hatch: what a layer is called, and how a row
is named back.

The language, the rewriting and the rendering are shared
(:mod:`plaid_agent.core.query`). What is IGT's is the vocabulary: fields are
named by their display names, the three token layers answer to "words",
"morphemes" and "sentences", a morpheme carries its form in metadata, and a
lexicon is a vocab layer. A model that does not know that writes queries that
return nothing, so the help says it in as many words.
"""

from typing import Any, Dict, List, Optional

from ..core.query import HELP, query_tool
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
    """name (casefolded) -> [(kind, id, display)] over every layer the model may name."""
    p = ws.project
    raw = ws.client.projects.get(p.id)
    idx: Dict[str, List[tuple]] = {}

    def add(name, kind, lid):
        idx.setdefault((name or '').casefold(), []).append((kind, lid, name))

    for tl in raw.get('text_layers') or []:
        add(tl.get('name'), 'text-layer', tl['id'])
        if tl['id'] == p.text_layer_id:
            add('baseline', 'text-layer', tl['id'])
        for tk in tl.get('token_layers') or []:
            add(tk.get('name'), 'token-layer', tk['id'])
            for alias, lid in (('words', p.word_layer_id), ('morphemes', p.morpheme_layer_id), ('sentences', p.sentence_layer_id)):
                if lid and tk['id'] == lid:
                    add(alias, 'token-layer', tk['id'])
            for sl in tk.get('span_layers') or []:
                f = p.field_by_layer(sl['id'])
                # The IGT display name ("Gloss (Word)") first. The bare layer
                # name too, which is ambiguous when scopes collide.
                if f and f.name != sl.get('name'):
                    add(f.name, 'span-layer', sl['id'])
                add(sl.get('name'), 'span-layer', sl['id'])
            for rl in tk.get('relation_layers') or []:
                add(rl.get('name'), 'relation-layer', rl['id'])
    for v in raw.get('vocabs') or []:
        add(v.get('name'), 'vocab-layer', v['id'])
    return idx


def ws_field_name(idx: Dict[str, List[tuple]], layer_id: str) -> Optional[str]:
    """The most specific display name registered for a layer id."""
    best = None
    for hs in idx.values():
        for kind, lid, name in hs:
            if lid == layer_id and name and (best is None or len(name) > len(best)):
                best = name
    return best


def _display(idx: Dict[str, List[tuple]]):
    """How a refusal names a layer: the most specific name it answers to, so
    two layers sharing a bare name are told apart by their scopes."""
    return lambda lid: ws_field_name(idx, lid) or lid


def t_query_help(ws: Workspace) -> str:
    p = ws.project
    lines = []
    for scope in ('Word', 'Morpheme', 'Sentence'):
        fs = p.fields_by_scope(scope)
        if fs:
            lines.append(f'  {scope}-scope fields (span layers on {scope.lower()} tokens): '
                         + ', '.join(f.name for f in fs))
    if p.vocabs:
        lines.append('  lexicons (vocab layers): ' + ', '.join(v['name'] for v in p.vocabs))
    gloss = p.gloss_field('Morpheme') or p.gloss_field('Word')
    return HELP + IGT_HELP.format(morphemes=', morphemes' if p.morpheme_layer_id else '',
                                  layers='\n'.join(lines), gloss=gloss.name if gloss else 'Gloss')


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents. What makes a
    row readable: "Text 1" s3.w2 rather than a UUID."""
    refs: Dict[str, str] = {}
    for did in doc_ids:
        try:
            doc = ws.doc(did)
        except Exception:  # noqa: BLE001 - a document we cannot load simply has no refs
            continue
        tag = f'"{doc.name}" '
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


def t_query(ws: Workspace, query: Any = None, limit: Any = None) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    return query_tool(ws, query, limit, _layer_index, _display, _ref_index)
