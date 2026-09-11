"""The read-only escape hatch: Plaid's query language, project-scoped.

The model writes a JSON query naming layers by NAME rather than by id; this
module substitutes the ids, pins the scope to the project, runs it under the
user's own token, and renders the rows. What a layer is CALLED, and how a row
is named back to the user, are the app's: it supplies a name index and a
reference index, and everything else here is the same for every app.

The language reference is served on demand (``query_help``) so it costs
context only when a query is actually being written. ``HELP`` below is the
half that is true of every project; an app appends its own layer names and
examples.
"""

import json
import re
from typing import Any, Callable, Dict, List, Optional

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
LAYER_SLOTS = ('layer', 'token-layer', 'text-layer', 'parent-token-layer', 'span-layer',
               'vocab-layer')

HELP = '''\
PLAID QUERY LANGUAGE (project-scoped; read-only; results limited)
Request: {"find": ["?a", ...], "where": [clause, ...], "return": "entities"|"ids"|"count"|aggregate, "limit": n,
          "order_by": [["?t.begin"], ["?t.doc", "desc"]]}   (find is omitted only with an aggregate return)
Variables start with "?"; the same name in two clauses is a join. Layers are named by NAME here (see the list
below); the tool turns names into ids. Scope is always this project.

Entity clauses  [kind, "?v", {constraints}]  (all constraints optional):
  ["span", "?s", {"layer": <layer name>, "value": ..., "doc": ..., "metadata": {...}}]   one annotation value
  ["token", "?t", {"layer": <layer name>, "value": <surface text>, "begin": n, "end": n, "metadata": {...}}]
  ["vocab", "?v", {"layer": <layer name>, "form": ..., "metadata": {...}}]               a vocabulary entry
  ["link", "?l", {"item": "?v" | <entry id>, "doc": ..., "metadata": {...}}]             a vocabulary link
  ["document", "?d", {"name": ..., "id": ..., "metadata": {...}}]
  ["relation", "?r", {"layer": <layer name>, "value": ..., "source": "?s1", "target": "?s2"}]
Constraint values: literal "NOUN" (equality) | list ["NOUN","PROPN"] (any of) | {"regex": "^N", "flags": "i"}
  (Java regex, substring unless anchored) | {"var": "?x"} (bind the column instead of filtering; the same ?x
  elsewhere is a join).
Metadata matches by JSON equality per key: {"metadata": {"prov": "inferred"}}; a regex runs on the value text.
Filter by document name: ["span","?s",{"layer":"X","doc":{"var":"?dv"}}], ["document","?d",{"name":{"regex":"^Text 3"}}], ["=","?dv","?d"]
Relationship clauses  [op, "?a", "?b"]:
  ["covers", ?span, ?token]      the span sits on that token
  ["precedes", ?t1, ?t2]         ?t2 is the very next token on the same layer; ["precedes*", ...] = somewhere later
  ["within", ?child, ?parent]    one token's extent inside another's, across layers
  ["first-in", ?token, ?container]   the first token of its layer inside the container token
  ["overlaps"|"contains"|"coextensive", ?span, ?span]   spans compared by the tokens they cover
  ["vocab-link", ?token, ?vocab] the token is linked to that entry
  ["link-token", ?link, ?token]  the link covers that token; ["link-item", ?link, ?vocab]  it points at that entry
Predicates over bound terms: ["=","?a","?b"], ["!=","?s1","?s2"] (distinct entities),
  ["<"|">"|"<="|">=", "?t.begin", 5], ["~", "?s.value", "^N"] (regex on a text field),
  ["in", "?s.value", ["A","B"]].
Dot paths read fields: ?s.value ?s.doc ?s.layer ?t.begin ?t.end ?t.precedence ?t.metadata.KEY ?v.form ?d.name ?l.item
Sequences over one token layer (adjacent tokens):
  ["seq", {"layer": <layer name>}, ["span", {"layer": "A", "value": "x"}, "as", "?a"],
   ["?", ["span", {"layer": "A", "value": "y"}]], ["rep", 0, 2, ["token", {}]]]
  Elements: ["span", {...}] a token covered by such a span; ["token", {...}] the token itself; "as" names one.
["or", [clauses...], [clauses...]]   any group matches (every find var bound in each group)
["not", clause, ...]                  no joint match (variables only inside the not are existential)
Return shapes: "ids" (default), "entities" (full objects), "count" (distinct find tuples),
  aggregate {"group": ["?d"], "aggregates": [["count"], ["min","?b"], ["max","?b"], ["avg","?b"]]} (group by
  bound variables; no find and no order_by with aggregates; extra joins inflate counts).
Limits: default 1000 rows from the engine (this tool shows at most `limit`, default 50), 30 s per query.
'''


class QueryRefused(Exception):
    """The engine turned the query down, with its own reason."""


def resolve_layer(value: Any, idx: Dict[str, List[tuple]], display: Callable[[str], str]) -> Any:
    """One layer name to its id. A name two layers share is refused by naming
    both, since guessing which was meant is worse than asking."""
    if not isinstance(value, str) or value.startswith('?') or UUID_RE.match(value):
        return value
    hits = idx.get(value.casefold())
    if not hits:
        known = sorted({h[2] for hs in idx.values() for h in hs if h[2]})
        raise QueryRefused(f'No layer named "{value}". Layers: ' + ', '.join(known))
    ids = {h[1] for h in hits}
    if len(ids) > 1:
        raise QueryRefused(f'"{value}" names {len(ids)} layers ('
                           + ', '.join(sorted(display(i) for i in ids))
                           + '). Use the one you mean, or its id.')
    return hits[0][1]


def rewrite(node: Any, idx: Dict[str, List[tuple]], display: Callable[[str], str],
            docs: Optional[Dict[str, str]] = None) -> Any:
    """Substitute layer names with ids in every layer slot, and document names
    with ids in `doc` slots, recursively."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in LAYER_SLOTS:
                out[k] = resolve_layer(v, idx, display)
            elif k == 'doc' and docs is not None and isinstance(v, str) and not v.startswith('?') \
                    and not UUID_RE.match(v):
                out[k] = docs.get(v.casefold(), v)
            else:
                out[k] = rewrite(v, idx, display, docs)
        return out
    if isinstance(node, list):
        return [rewrite(x, idx, display, docs) for x in node]
    return node


def parse_query(query: Any) -> Dict[str, Any]:
    if isinstance(query, str):
        try:
            query = json.loads(query)
        except json.JSONDecodeError as e:
            raise QueryRefused(f'query must be a JSON object ({e})')
    if not isinstance(query, dict) or 'where' not in query:
        raise QueryRefused('query must be an object with at least "where" (call query_help for '
                           'the language)')
    # Only an aggregate return may omit `find`. The engine says ":find must be
    # a non-empty list of vars", which is about a JSON shape rather than about
    # what was asked for, so say it in the language the query was written in.
    ret = query.get('return')
    if not query.get('find') and not isinstance(ret, dict):
        raise QueryRefused('this query needs "find": the variables to return, e.g. "find": ["?w"]. '
                           'Only an aggregate return ({"group": [...], "aggregates": [...]}) may '
                           'leave it out, and "count" counts the distinct find tuples.')
    return dict(query)


def run(client, q: Dict[str, Any], project_id: str) -> Dict[str, Any]:
    """Pin the scope, refuse time travel, and run it. The engine's own reason
    for turning a query down is the most useful thing to hand back."""
    q['scope'] = {'project_ids': [project_id]}
    q.pop('as_of', None)
    q.pop('as-of', None)
    ret = q.get('return')
    if not isinstance(ret, dict) and ret != 'count':
        q['return'] = ret or 'entities'
        # The model writes this object, so the limit inside it is as likely to
        # be "20 or so" as a number. Every other refusal here is a sentence it
        # can act on, and int() raising would be the one that is not.
        raw = q.get('limit')
        try:
            q['limit'] = min(int(raw or 1000), 1000) if raw is not None else 1000
        except (TypeError, ValueError):
            raise QueryRefused(f'"limit" has to be a number, not {raw!r}.')
    try:
        return client.query(q)
    except Exception as e:  # noqa: BLE001 - the engine's complaint is the answer
        msg = str(e)
        m = re.search(r'"error"\s*:\s*"([^"]+)"', msg)
        raise QueryRefused('Query rejected: ' + (m.group(1) if m else msg[:400]))


def cell(entity: Any, refs: Dict[str, str], layer_names: Dict[str, str]) -> str:
    """One result value, as a line of text: a positional reference where the
    app could give one, and enough of the raw entity where it could not."""
    if not isinstance(entity, dict):
        return str(entity)
    eid = entity.get('id') or '?'
    ref = refs.get(eid)
    layer = layer_names.get(entity.get('layer'), '')
    if 'form' in entity and 'tokens' not in entity:
        return f'entry "{entity.get("form")}"' + (f' [{layer}]' if layer else '')
    if 'tokens' in entity:
        return (ref or f'span {eid[:8]}') + f' = "{entity.get("value")}"' + ('' if ref else f' [{layer}]')
    if 'begin' in entity:
        return (ref or f'token {eid[:8]}') + f' "{entity.get("value", "")}"' \
            + ('' if ref else f' [{layer}] {entity.get("begin")}-{entity.get("end")}')
    if 'name' in entity and 'text_layers' not in entity:
        return f'document "{entity.get("name")}"'
    if 'source' in entity:
        return f'relation "{entity.get("value")}"'
    return json.dumps(entity, ensure_ascii=False)[:120]


def render(res: Any, q: Dict[str, Any], limit: int, refs: Dict[str, str],
           layer_names: Dict[str, str], doc_names: Dict[str, str]) -> str:
    """The engine's answer as text. Counts and groups read plainly; rows are
    rendered through ``cell``."""
    if not isinstance(res, dict):
        return json.dumps(res, ensure_ascii=False)[:4000]
    if res.get('return') == 'count':
        return f'count: {res.get("count")}' + (
            ' (truncated at the engine limit)' if res.get('truncated') else '')
    cols = res.get('columns') or []
    rows = res.get('results') or []
    if res.get('return') == 'aggregate':
        lines = [f'{len(rows)} group{"s" if len(rows) != 1 else ""}: ' + '\t'.join(cols)]
        for r in rows[:limit]:
            lines.append('  ' + '\t'.join(
                str(doc_names.get(c, c)) if isinstance(c, str) else str(c) for c in r))
        if len(rows) > limit:
            lines.append(f'  … {len(rows) - limit} more groups')
        return '\n'.join(lines)
    total = res.get('count', len(rows))
    head = f'{total} row{"s" if total != 1 else ""}' \
        + (' (truncated by the engine limit)' if res.get('truncated') else '') \
        + (f', showing {limit}' if len(rows) > limit else '') + ': ' + '\t'.join(cols)
    if q.get('return') == 'ids':
        return '\n'.join([head] + ['  ' + '\t'.join(str(c) for c in r) for r in rows[:limit]])
    return '\n'.join([head] + ['  ' + '\t'.join(cell(c, refs, layer_names) for c in r)
                               for r in rows[:limit]])


def documents_in(rows: List[Any], limit: int, cap: int = 25) -> List[str]:
    """The documents the shown rows mention, so the app loads only those to
    build its reference index."""
    out: List[str] = []
    for r in rows[:limit]:
        for c in r:
            if isinstance(c, dict) and c.get('document') and c['document'] not in out:
                out.append(c['document'])
    return out[:cap]
