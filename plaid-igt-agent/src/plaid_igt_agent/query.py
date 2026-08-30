"""The read-only escape hatch: Plaid's query language, project-scoped.

The model writes the JSON query with layers named by NAME (field names,
"words", "morphemes", "sentences", "baseline", a lexicon's name); this module
substitutes the ids, pins the scope to the project, runs it under the user's
own token, and renders rows with positional references where it can. The
reference the model needs is served on demand by ``query_help`` so it costs
context only when a query is actually being written.
"""

import json
import re
from typing import Any, Dict, List, Optional

from .project import IgtProject
from .tools import Workspace, ToolError, _truncate, word_ref

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
LAYER_SLOTS = ('layer', 'token-layer', 'text-layer', 'parent-token-layer', 'span-layer', 'vocab-layer')

HELP = '''\
PLAID QUERY LANGUAGE (project-scoped; read-only; results limited)
Request: {"find": ["?a", ...], "where": [clause, ...], "return": "entities"|"ids"|"count"|aggregate, "limit": n,
          "order_by": [["?t.begin"], ["?t.doc", "desc"]]}   (find is omitted only with an aggregate return)
Variables start with "?"; the same name in two clauses is a join. Layers are named by NAME here (see the list below);
the tool turns names into ids. Scope is always this project.

Entity clauses  [kind, "?v", {constraints}]  (all constraints optional):
  ["span", "?s", {"layer": <field name>, "value": ..., "doc": ..., "metadata": {...}}]   an annotation (a field value)
  ["token", "?t", {"layer": "words"|"morphemes"|"sentences", "value": <surface text>, "begin": n, "end": n, "metadata": {...}}]
      morpheme tokens carry their form in metadata.form and type in metadata.morphType
  ["vocab", "?v", {"layer": <lexicon name>, "form": ..., "metadata": {...}}]           a lexicon entry
  ["document", "?d", {"name": ..., "id": ..., "metadata": {...}}]
Constraint values: literal "NOUN" (equality) | list ["NOUN","PROPN"] (any of) | {"regex": "^N", "flags": "i"} (Java regex,
  substring unless anchored) | {"var": "?x"} (bind the column instead of filtering; same ?x elsewhere = join).
Metadata constraints match by JSON equality per key: {"metadata": {"prov": "inferred"}}; regexes run on the value text.
Filter by document name: ["span","?s",{"layer":"Gloss","doc":{"var":"?dv"}}], ["document","?d",{"name":{"regex":"^Text 3"}}], ["=","?dv","?d"]
Relationship clauses  [op, "?a", "?b"]:
  ["covers", ?span, ?token]      the span sits on that token (a morpheme field span covers a morpheme token, etc.)
  ["precedes", ?t1, ?t2]         ?t2 is the very next token on the same layer; ["precedes*", ?t1, ?t2] = somewhere later
  ["within", ?child, ?parent]    token extent inside another token's extent, across layers (morpheme within word within sentence)
  ["first-in", ?token, ?container]   the first token of its layer inside the container token
  ["overlaps"|"contains"|"coextensive", ?span, ?span]   spans compared by the tokens they cover
  ["vocab-link", ?token, ?vocab] the token (word or morpheme) is linked to that entry
Predicates over bound terms: ["=","?a","?b"], ["!=","?s1","?s2"] (distinct entities), ["<"|">"|"<="|">=", "?t.begin", 5],
  ["~", "?s.value", "^N"] (regex on a text field), ["in", "?s.value", ["A","B"]].
Dot paths read fields: ?s.value ?s.doc ?s.layer ?t.begin ?t.end ?t.precedence ?t.metadata.form ?v.form ?d.name ?x.metadata.KEY
Sequences over one token layer (adjacent tokens): ["seq", {"layer": "words"}, ["span", {"layer": "POS", "value": "n"}, "as", "?a"],
  ["?", ["span", {"layer": "POS", "value": "adj"}]], ["rep", 0, 2, ["token", {}]], ["span", {"layer": "Gloss", "value": {"regex": "ERG"}}, "as", "?b"]]
  Elements: ["span", {...}] matches a token covered by such a span; ["token", {...}] the token itself; "as" names fixed elements.
["or", [clauses...], [clauses...]]   any group matches (every find var bound in each group)
["not", clause, ...]                  no joint match (variables only inside the not are existential)
Return shapes: "ids" (default), "entities" (full objects), "count" (distinct find tuples),
  aggregate {"group": ["?d"], "aggregates": [["count"], ["min","?b"], ["max","?b"], ["avg","?b"]]} (group by bound
  variables; value variables group by value; no find/order_by with aggregates; extra joins inflate counts).
Limits: default limit 1000 rows (this tool shows at most `limit` rows, default 50), 30 s per query.

Examples (this project's names):
  # morphemes glossed ERG that are the last morpheme of their word
  {"find": ["?m"], "where": [["span","?g",{"layer":"Gloss","value":"ERG"}], ["covers","?g","?m"], ["token","?m",{"layer":"morphemes"}],
   ["not", ["precedes","?m","?n"], ["token","?n",{"layer":"morphemes"}], ["within","?n","?w"], ["within","?m","?w"], ["token","?w",{"layer":"words"}]]]}
  # how many words per document
  {"where": [["token","?t",{"layer":"words","doc":{"var":"?d"}}]], "return": {"group": ["?d"], "aggregates": [["count"]]}}
  # words linked to the entry "kar"
  {"find": ["?t"], "where": [["vocab","?v",{"form":"kar"}], ["vocab-link","?t","?v"]], "return": "entities"}
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
                # The IGT display name ("Gloss (Word)") first; the bare layer
                # name too, which is ambiguous when scopes collide.
                if f and f.name != sl.get('name'):
                    add(f.name, 'span-layer', sl['id'])
                add(sl.get('name'), 'span-layer', sl['id'])
            for rl in tk.get('relation_layers') or []:
                add(rl.get('name'), 'relation-layer', rl['id'])
    for v in raw.get('vocabs') or []:
        add(v.get('name'), 'vocab-layer', v['id'])
    return idx


def _resolve(value: Any, idx: Dict[str, List[tuple]]) -> Any:
    if not isinstance(value, str) or value.startswith('?') or UUID_RE.match(value):
        return value
    hits = idx.get(value.casefold())
    if not hits:
        raise ToolError(f'No layer named "{value}". Layers: ' + ', '.join(sorted({ws_field_name(idx, h[1]) or h[2] for hs in idx.values() for h in hs if h[2]})))
    ids = {h[1] for h in hits}
    if len(ids) > 1:
        names = sorted({(ws_field_name(idx, i) or h[2]) for h in hits for i in [h[1]]})
        raise ToolError(f'"{value}" names several layers; say which: ' + ', '.join(names))
    return hits[0][1]


def ws_field_name(idx: Dict[str, List[tuple]], layer_id: str) -> Optional[str]:
    """The most specific display name registered for a layer id."""
    best = None
    for hs in idx.values():
        for kind, lid, name in hs:
            if lid == layer_id and name and (best is None or len(name) > len(best)):
                best = name
    return best


def _rewrite(node: Any, idx: Dict[str, List[tuple]]) -> Any:
    """Substitute layer names with ids in every layer slot, recursively."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in LAYER_SLOTS:
                out[k] = _resolve(v, idx)
            else:
                out[k] = _rewrite(v, idx)
        return out
    if isinstance(node, list):
        return [_rewrite(x, idx) for x in node]
    return node


def t_query_help(ws: Workspace) -> str:
    p = ws.project
    lines = [HELP, 'LAYER NAMES YOU CAN USE IN THIS PROJECT:']
    lines.append('  token layers: words, sentences' + (', morphemes' if p.morpheme_layer_id else '') + '  (text layer: baseline)')
    for scope in ('Word', 'Morpheme', 'Sentence'):
        fs = p.fields_by_scope(scope)
        if fs:
            lines.append(f'  {scope}-scope fields (span layers on {scope.lower()} tokens): ' + ', '.join(f.name for f in fs))
    if p.vocabs:
        lines.append('  lexicons (vocab layers): ' + ', '.join(v['name'] for v in p.vocabs))
    lines.append('  provenance metadata on machine-made annotations: {"prov": "inferred", "provSource": "...", "provConfirmed": true|absent}')
    return '\n'.join(lines)


def _ref_index(ws: Workspace, doc_ids: List[str]) -> Dict[str, str]:
    """entity id -> positional reference, for the named documents."""
    refs: Dict[str, str] = {}
    for did in doc_ids:
        try:
            doc = ws.doc(did)
        except Exception:
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


def _cell(entity: Any, refs: Dict[str, str], layer_names: Dict[str, str], doc_names: Dict[str, str]) -> str:
    if not isinstance(entity, dict):
        return str(entity)
    eid = entity.get('id')
    ref = refs.get(eid)
    layer = layer_names.get(entity.get('layer'), '')
    if 'form' in entity and 'tokens' not in entity:
        return f'entry "{entity.get("form")}"' + (f' [{layer}]' if layer else '')
    if 'tokens' in entity:
        return (ref or f'span {eid[:8]}') + f' = "{entity.get("value")}"' + ('' if ref else f' [{layer}]')
    if 'begin' in entity:
        return (ref or f'token {eid[:8]}') + f' "{entity.get("value", "")}"' + ('' if ref else f' [{layer}] {entity.get("begin")}-{entity.get("end")}')
    if 'name' in entity and 'text_layers' not in entity:
        return f'document "{entity.get("name")}"'
    if 'source' in entity:
        return f'relation "{entity.get("value")}"'
    return json.dumps(entity, ensure_ascii=False)[:120]


def t_query(ws: Workspace, query: Any, limit: int = 50) -> str:
    """Run a Plaid query over this project (read-only). See query_help."""
    if isinstance(query, str):
        try:
            query = json.loads(query)
        except json.JSONDecodeError as e:
            raise ToolError(f'query must be a JSON object ({e})')
    if not isinstance(query, dict) or 'where' not in query:
        raise ToolError('query must be an object with at least "where" (call query_help for the language)')
    limit = max(1, min(int(limit or 50), 500))
    idx = _layer_index(ws)
    q = _rewrite(dict(query), idx)
    q['scope'] = {'project_ids': [ws.project.id]}
    q.pop('as_of', None)
    ret = q.get('return')
    aggregate = isinstance(ret, dict)
    if not aggregate and ret not in ('count',):
        q['return'] = ret or 'entities'
        q['limit'] = min(int(q.get('limit') or limit), 1000)
    ws.on_progress('Running the query…')
    try:
        res = ws.client.query(q)
    except Exception as e:
        msg = str(e)
        m = re.search(r'"error"\s*:\s*"([^"]+)"', msg)
        raise ToolError('Query rejected: ' + (m.group(1) if m else msg[:400]))
    if not isinstance(res, dict):
        return _truncate(json.dumps(res, ensure_ascii=False)[:4000])
    if res.get('return') == 'count':
        return f'count: {res.get("count")}' + (' (truncated at the engine limit)' if res.get('truncated') else '')
    cols = res.get('columns') or []
    rows = res.get('results') or []
    if res.get('return') == 'aggregate':
        lines = [f'{len(rows)} group{"s" if len(rows) != 1 else ""}: ' + '\t'.join(cols)]
        doc_names = {d['id']: d.get('name') for d in ws.documents()}
        for r in rows[:limit]:
            lines.append('  ' + '\t'.join(str(doc_names.get(c, c)) if isinstance(c, str) else str(c) for c in r))
        if len(rows) > limit:
            lines.append(f'  … {len(rows) - limit} more groups')
        return _truncate('\n'.join(lines))
    total = res.get('count', len(rows))
    head = f'{total} row{"s" if total != 1 else ""}' + (' (truncated by the engine limit)' if res.get('truncated') else '') \
        + (f', showing {limit}' if len(rows) > limit else '') + ': ' + '\t'.join(cols)
    if q['return'] == 'ids':
        return _truncate('\n'.join([head] + ['  ' + '\t'.join(str(c) for c in r) for r in rows[:limit]]))
    layer_names = {h[1]: h[2] for hs in idx.values() for h in hs}
    doc_names = {d['id']: d.get('name') for d in ws.documents()}
    doc_ids = []
    for r in rows[:limit]:
        for c in r:
            if isinstance(c, dict) and c.get('document') and c['document'] not in doc_ids:
                doc_ids.append(c['document'])
    refs = _ref_index(ws, doc_ids[:25])
    lines = [head]
    for r in rows[:limit]:
        lines.append('  ' + '\t'.join(_cell(c, refs, layer_names, doc_names) for c in r))
    return _truncate('\n'.join(lines))
