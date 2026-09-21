"""UMR's half of run_code: what a document looks like to the code, and how the
code reaches the project. The harness is :mod:`plaid_agent.core.sandbox`.

The view is plain data: per sentence, its words, its gloss lines, its nodes
with their variables, concepts, attributes and alignment, its relations, and
the document-level triples written in its block, with the positional
references every other tool speaks. Nothing in it is an id the code could
write to.
"""

from typing import Any, Callable, Dict

from ..core import filetools, sandbox
from ..core.query import QueryRefused, parse_query, rewrite, run as run_query
from .project import UmrDoc, ilg_lines, penman_of, resolve_ilg
from .tools import Workspace

UMR_HELP = '''
THE SHAPE load(document) RETURNS:
  {"id", "name", "metadata": {...}, "sentences": [
     {"ref": "s3", "text": "...", "words": ["...", ...],
      "lines": [{"header": "Word Gloss", "lang": "en", "items": [...]}, ...],
      "penman": "(s3s / say-01\\n    :ARG0 (s3p / person))",
      "nodes": [{"ref": "s3.s3p", "var": "s3p", "concept": "person",
                 "attrs": [{"rel": ":refer-number", "value": "singular"}],
                 "alignment": [[2, 2]], "root": false}, ...],
      "relations": [{"source": "s3s", "role": ":ARG0", "target": "s3p"}, ...],
      "triples": [{"source": "s3s", "rel": ":same-event", "target": "s2s", "group": "coref"}, ...]}, ...]}
  `alignment` is 1-based inclusive word ranges; an unaligned node has [].

EXAMPLES
  # Which concepts carry an :aspect, and which value?
  from collections import defaultdict
  seen = defaultdict(lambda: defaultdict(int))
  for d in documents():
      for s in load(d["id"])["sentences"]:
          for n in s["nodes"]:
              for a in n["attrs"]:
                  if a["rel"] == ":aspect":
                      seen[n["concept"]][a["value"]] += 1
  print(sorted(((c, dict(v)) for c, v in seen.items()), key=lambda kv: -sum(kv[1].values()))[:20])

  # Every event node with no :aspect at all, with a reference
  hits = []
  for d in documents():
      doc = load(d["id"])
      for s in doc["sentences"]:
          for n in s["nodes"]:
              if n["concept"].endswith("-01") and not any(a["rel"] == ":aspect" for a in n["attrs"]):
                  hits.append((doc["name"], n["ref"], n["concept"]))
  print(len(hits)); print(hits[:15])

  # Count with the engine instead of walking (fast on a large corpus)
  r = query({"where": [["relation", "?r", {"layer": "relations"}]],
             "return": {"group": ["?r.value"], "aggregates": [["count"]]}})
  print(r["results"])

  # Stage a change for the user to approve, through a plan tool
  print(plan("set_attributes", document="Story", sentence=3, var="s3p",
             line=":refer-number singular"))
'''


def view(doc: UmrDoc, project=None) -> Dict[str, Any]:
    sentences = []
    mapping = resolve_ilg(project) if project is not None else []
    for s in doc.sentences:
        nodes = [{'ref': f's{s.index}.{n.var}', 'var': n.var, 'concept': n.concept,
                  'attrs': [{'rel': a.get('rel'), 'value': a.get('value')} for a in n.attrs],
                  'alignment': [list(a) for a in n.alignment], 'root': bool(n.root)}
                 for n in s.nodes]
        relations = []
        for e in s.edges:
            source = doc.nodes_by_id.get(e.source)
            target = doc.nodes_by_id.get(e.target)
            if source is None or target is None:
                continue
            relations.append({'source': source.var, 'role': e.role, 'target': target.var})
        triples = []
        for t in s.triples:
            source = doc.nodes_by_id.get(t.source)
            target = doc.nodes_by_id.get(t.target)
            if source is None or target is None:
                continue
            triples.append({'source': source.var, 'rel': t.rel, 'target': target.var,
                            'group': t.group})
        lines = ilg_lines(s, project, doc.gloss, mapping) if project is not None else []
        sentences.append({
            'ref': f's{s.index}', 'text': s.text,
            'words': [w.text for w in s.words],
            'lines': [{'header': line.get('header') or line.get('key') or '',
                       'lang': line.get('lang'),
                       'items': [str(i) for i in line.get('items') or []]} for line in lines],
            'penman': penman_of(doc, s), 'nodes': nodes, 'relations': relations,
            'triples': triples})
    return {'id': doc.id, 'name': doc.name, 'metadata': dict(doc.metadata or {}),
            'sentences': sentences}


def api(ws: Workspace) -> Dict[str, Callable]:
    from .query import _display, _layer_index

    def documents():
        return [{'id': d['id'], 'name': d.get('name') or ''} for d in ws.documents()]

    def query(q):
        try:
            parsed = parse_query(q)
            idx = _layer_index(ws)
            docs = {(d.get('name') or '').casefold(): d['id'] for d in ws.documents()}
            return run_query(ws.client, rewrite(parsed, idx, _display(idx), docs), ws.project.id)
        except QueryRefused as e:
            raise ValueError(str(e))

    # The toolkit is the last module imported (it reads every tool module, this
    # one included), so it is asked for here rather than at the top.
    from .toolkit import WRITE_TOOLS, call_tool
    return {'documents': documents,
            'load': sandbox.load_proxy(ws, lambda doc: view(doc, ws.project)),
            'query': query,
            'plan': sandbox.plan_proxy(ws, call_tool, WRITE_TOOLS),
            **filetools.api(ws)}


def t_run_code(ws: Workspace, code: str = None) -> str:
    return sandbox.run_tool(ws, code, api)


def t_code_help(ws: Workspace) -> str:
    return sandbox.help_text(UMR_HELP, filetools.code_help(ws))
