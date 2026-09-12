"""IGT's half of run_code: what a document looks like to the code, and how
the code reaches the project. The harness is :mod:`plaid_agent.core.sandbox`.

The view is plain data: sentences, words and morphemes with their fields by
display name, orthographies, lexicon links, and the review state of each
value. Nothing in it is an id the code could write to."""

from typing import Any, Callable, Dict

from plaid_client.provenance import prov_state

from ..core import sandbox
from ..core.query import QueryRefused, parse_query, run as run_query
from .project import IgtDoc, word_ref
from .tools import ToolError, Workspace, WRITE_TOOLS, call_tool

IGT_HELP = '''
THE SHAPE load(document) RETURNS:
  {"id", "name", "metadata": {...}, "sentences": [
     {"ref": "s3", "text": "...", "fields": {"Translation": "...", ...}, "words": [
        {"ref": "s3.w2", "surface": "...", "orthographies": {"<name>": "..."}, "fields": {"<word field>": "..."},
         "link": "<lexicon headword>" or None, "mwes": ["<headword>", ...],
         "review": {"<field>": "human"|"machine"|"contributed"|"verified"},
         "morphemes": [{"ref": "s3.w2.m1", "form": "...", "type": "stem"|"prefix"|"suffix"|..., "fields": {...},
                        "link": "<headword>" or None, "review": {...}}, ...]}, ...]}, ...]}
  Field names are the project's own (project_overview lists them; a name shared by a word field and a
  morpheme field is written "Gloss (Word)" and "Gloss (Morpheme)"). A missing value is "". review names,
  per field, who made the value and whether it has been confirmed.

EXAMPLES
  # Every morpheme form glossed two different ways, with counts
  from collections import defaultdict
  glosses = defaultdict(lambda: defaultdict(int))
  for d in documents():
      for s in load(d["id"])["sentences"]:
          for w in s["words"]:
              for m in w["morphemes"]:
                  g = m["fields"].get("Gloss (Morpheme)") or m["fields"].get("Gloss")
                  if g:
                      glosses[m["form"]][g] += 1
  print({f: dict(g) for f, g in glosses.items() if len(g) > 1})

  # Words with a gloss but no lexicon link, by document
  for d in documents():
      doc = load(d["id"])
      unlinked = [w["ref"] for s in doc["sentences"] for w in s["words"]
                  if w["fields"].get("Gloss (Word)") and not w["link"] and not w["mwes"]]
      if unlinked:
          print(doc["name"], len(unlinked), unlinked[:5])

  # Count with the engine instead of walking (fast on a large corpus)
  r = query({"where": [["span", "?g", {"layer": "Gloss (Morpheme)"}]],
             "return": {"group": ["?g.value"], "aggregates": [["count"]]}})
  print(r["results"][:20])

  # Stage a change for the user to approve, through a plan tool
  print(plan("set_field", document="Text 1", refs=["s3.w2"], field="Gloss (Word)", value="fish"))
'''


def _review(fields) -> Dict[str, str]:
    return {name: prov_state(sp.metadata) for name, sp in fields.items() if sp.value}


def view(doc: IgtDoc) -> Dict[str, Any]:
    sentences = []
    for s in doc.sentences:
        words = []
        for w in s.words:
            morphemes = []
            for m in w.morphemes:
                morphemes.append({
                    'ref': f'{word_ref(s, w)}.m{m.index}', 'form': m.form, 'type': m.morph_type,
                    'fields': {name: sp.value or '' for name, sp in m.fields.items()},
                    'link': m.link.form if m.link else None, 'review': _review(m.fields)})
            words.append({
                'ref': word_ref(s, w), 'surface': w.surface,
                'orthographies': dict(w.orthographies or {}),
                'fields': {name: sp.value or '' for name, sp in w.fields.items()},
                'link': w.link.form if w.link else None,
                'mwes': [l.form for l in (w.mwes or [])],
                'review': _review(w.fields), 'morphemes': morphemes})
        sentences.append({'ref': f's{s.index}', 'text': s.text,
                          'fields': {name: sp.value or '' for name, sp in s.fields.items()},
                          'words': words})
    return {'id': doc.id, 'name': doc.name, 'metadata': dict(doc.metadata or {}), 'sentences': sentences}


def api(ws: Workspace) -> Dict[str, Callable]:
    from .query import _layer_index, _rewrite

    def documents():
        return [{'id': d['id'], 'name': d.get('name') or ''} for d in ws.documents()]

    def load(document: str):
        try:
            return view(ws.doc(document))
        except ToolError as e:
            raise ValueError(str(e))

    def query(q):
        try:
            parsed = parse_query(q)
            idx = _layer_index(ws)
            docs = {(d.get('name') or '').casefold(): d['id'] for d in ws.documents()}
            return run_query(ws.client, _rewrite(parsed, idx, docs), ws.project.id)
        except (QueryRefused, ToolError) as e:
            raise ValueError(str(e))

    return {'documents': documents, 'load': load, 'query': query,
            'plan': sandbox.plan_proxy(ws, call_tool, WRITE_TOOLS)}


def t_run_code(ws: Workspace, code: str = None) -> str:
    try:
        return sandbox.run(code, api(ws), on_progress=ws.on_progress)
    except sandbox.CodeError as e:
        raise ToolError(str(e))


def t_code_help(ws: Workspace) -> str:
    return sandbox.help_text(IGT_HELP)
