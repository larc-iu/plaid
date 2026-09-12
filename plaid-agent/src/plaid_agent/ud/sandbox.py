"""UD's half of run_code: what a document looks like to the code, and how
the code reaches the project. The harness is :mod:`plaid_agent.core.sandbox`.

The view is plain data: the CoNLL-U columns per word, with the positional
references every other tool speaks, and the review state of each value.
Nothing in it is an id the code could write to."""

from typing import Any, Callable, Dict

from plaid_client.provenance import prov_state

from ..core import sandbox
from ..core.query import documents_in, parse_query, rewrite, run as run_query, QueryRefused
from .project import UdDoc, word_ref
from .tools import ToolError, Workspace, WRITE_TOOLS, call_tool

UD_HELP = '''
THE SHAPE load(document) RETURNS:
  {"id", "name", "metadata": {...}, "sentences": [
     {"ref": "s3", "text": "...", "metadata": {...}, "words": [
        {"ref": "s3.w2", "form", "lemma", "upos", "xpos", "feats", "head", "deprel",
         "token": <the surface token>, "mwt": true when the token holds several words,
         "review": {"lemma": "human"|"machine"|"contributed"|"verified", ... , "deprel": ...}}, ...]}, ...]}
  An empty column is "". head is a number (0 for the root) or None. review names, per column, who made
  the value and whether it has been confirmed: "machine" and "contributed" are what ~ and ^ mark.
  feats is the whole FEATS string ("Case=Nom|Number=Sing"); split it on "|".

EXAMPLES
  # Which lemmas appear with both AUX and VERB, and how often each way?
  from collections import defaultdict
  seen = defaultdict(lambda: defaultdict(int))
  for d in documents():
      for s in load(d["id"])["sentences"]:
          for w in s["words"]:
              if w["upos"] in ("AUX", "VERB"):
                  seen[w["lemma"]][w["upos"]] += 1
  both = {l: dict(c) for l, c in seen.items() if len(c) == 2}
  print(sorted(both.items(), key=lambda kv: -sum(kv[1].values()))[:20])

  # Every copula whose head is not a NOUN, ADJ or PROPN, with a reference
  hits = []
  for d in documents():
      doc = load(d["id"])
      for s in doc["sentences"]:
          by_id = {w["ref"].split(".w")[1]: w for w in s["words"]}
          for w in s["words"]:
              if w["deprel"] == "cop" and w["head"]:
                  h = by_id.get(str(w["head"]))
                  if h and h["upos"] not in ("NOUN", "ADJ", "PROPN"):
                      hits.append((doc["name"], w["ref"], h["form"], h["upos"]))
  print(len(hits)); print(hits[:15])

  # Count with the engine instead of walking (fast on a large corpus)
  r = query({"where": [["span", "?u", {"layer": "upos"}]],
             "return": {"group": ["?u.value"], "aggregates": [["count"]]}})
  print(r["results"])

  # Stage a change for the user to approve, through a plan tool
  print(plan("set_field", document="Viaje", refs=["s3.w2"], field="upos", value="AUX"))
'''


def view(doc: UdDoc) -> Dict[str, Any]:
    sentences = []
    for s in doc.sentences:
        words = []
        for w in s.words:
            review = {f: prov_state(sp.metadata) for f, sp in w.fields.items() if f != 'form' and sp.value}
            if w.relation_id:
                review['deprel'] = prov_state(w.relation_metadata)
            words.append({
                'ref': word_ref(s, w), 'form': w.form, 'lemma': w.value('lemma'),
                'upos': w.value('upos'), 'xpos': w.value('xpos'), 'feats': w.value('features'),
                'head': w.head, 'deprel': w.deprel or '', 'token': w.token.surface if w.token else w.form,
                'mwt': w.is_part_of_mwt, 'review': review})
        sentences.append({'ref': f's{s.index}', 'text': s.text, 'metadata': dict(s.metadata or {}),
                          'words': words})
    return {'id': doc.id, 'name': doc.name, 'metadata': dict(doc.metadata or {}), 'sentences': sentences}


def api(ws: Workspace) -> Dict[str, Callable]:
    from .query import _layer_index, _display

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
            return run_query(ws.client, rewrite(parsed, idx, _display(idx), docs), ws.project.id)
        except QueryRefused as e:
            raise ValueError(str(e))

    return {'documents': documents, 'load': load, 'query': query,
            'plan': sandbox.plan_proxy(ws, call_tool, WRITE_TOOLS)}


def t_run_code(ws: Workspace, code: str = None) -> str:
    if getattr(ws, 'code', None) is None:
        ws.code = sandbox.Session()
    try:
        return sandbox.run(code, api(ws), on_progress=ws.on_progress, session=ws.code)
    except sandbox.CodeError as e:
        raise ToolError(str(e))


def t_code_help(ws: Workspace) -> str:
    return sandbox.help_text(UD_HELP)
