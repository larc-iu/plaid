"""IGT's half of run_code: what a document looks like to the code, and how
the code reaches the project. The harness is :mod:`plaid_agent.core.sandbox`.

The view is plain data: sentences, words and morphemes with their fields by
display name, orthographies, lexicon links, and the review state of each
value. The one id in it is an entry's, which is what joins a word's link to
lexicon() and what plan(..., entry_id=...) takes."""

import json
from collections import Counter
from typing import Any, Callable, Dict, List, Optional

from plaid_client.provenance import PROVENANCE_KEYS, prov_state

from ..core import filetools, sandbox
from ..core.tools import ToolError
from .lexview import LexView
from .project import IgtDoc, word_ref
from .vocab import RESERVED_ITEM_KEYS, item_ref_fields, morph_type_of, ref_ids
from .workspace import Workspace

IGT_SHAPE = '''\
A LOADED DOCUMENT IN SHORT (dicts and lists, keys also read as attributes):
  doc = load("Text 1")          # or load(d) for d in documents()
  s = doc["sentences"][2]       # {"ref": "s3", "text", "fields", "words"}
  w = s["words"][1]             # {"ref": "s3.w2", "surface", "fields", "link", "morphemes", ...}
  m = w["morphemes"][0]         # {"ref": "s3.w2.m1", "form", "type", "fields", "link", "review"}
  {example}  # a field by its exact name, "" when empty
  # a ref ("s3", "s3.w2") is unique only within its document: key a collection over several
  # documents by (doc["name"], ref), or "s12" of one document merges with "s12" of another
This project's fields, spelled as the code must spell them: {fields}
'''


def _shape(ws: Workspace) -> str:
    """The short shape with this project's own field names in it. A model
    copies the example's name, and .get() on a name the project does not
    have answers None, so a walk keyed "POS" on a project whose field is
    "POS (Word)" counted nothing and said nothing (2026-10-12 log)."""
    project = ws.project
    m, w = project.gloss_field('Morpheme'), project.gloss_field('Word')
    example = (f'm["fields"].get({json.dumps(m.name)})' if m
               else f'w["fields"].get({json.dumps(w.name)})' if w else 'w["fields"].get("Gloss")')
    return IGT_SHAPE.replace('{example}', example).replace('{fields}', project.field_list())

# What lexicon() returns, in the help and in the answer to code that reads it
# as a dict (twice on the bench: lexicon()["entries"]).
LEXICON_RETURNS = '''\
  [{"id", "lexicon", "form", "address", "type", "fields": {"<entry field>": ...}, "parent": "<id>" or None,
    "senses": ["<id>", ...], "links": n}, ...]'''

IGT_HELP = '''
THE SHAPE load(document) RETURNS:
  {"id", "name", "metadata": {...}, "segments": [{"start": 12.3, "end": 15.0, "speaker": "...", "text": "..."}, ...],
   "sentences": [
     {"ref": "s3", "text": "...", "time": [12.3, 15.0] or None, "fields": {"Translation": "...", ...}, "words": [
        {"ref": "s3.w2", "surface": "...", "orthographies": {"<name>": "..."}, "fields": {"<word field>": "..."},
         "link": "<lexicon headword>" or None, "link_id": "<its entry's id>" or None, "mwes": ["<headword>", ...],
         "review": {"<field>": "human"|"machine"|"contributed"|"verified"},
         "morphemes": [{"ref": "s3.w2.m1", "form": "...", "type": "stem"|"prefix"|"suffix"|..., "fields": {...},
                        "link": "<headword>" or None, "link_id": ..., "review": {...}}, ...]}, ...]}, ...]}
  Field names are the project's own (project_overview lists them; a name shared by a word field and a
  morpheme field is written "Gloss (Word)" and "Gloss (Morpheme)"). A missing value is "". review names,
  per field, who made the value and whether it has been confirmed. "segments" is the time alignment, in seconds
  (empty without one); a sentence's "time" spans the segments inside it, or the one segment around it.
  recording(document) -> the length in seconds of the document's recording, None without one or when its
  length cannot be read. Minutes transcribed: sum(g["end"] - g["start"] for g in load(d)["segments"]).

THE LEXICON
  lexicon(name=None) -> every entry of the named lexicon, or of every lexicon, as the plan would leave it:
{lexicon_returns}
  "address" is the form a tool takes ("gam#2" where several entries share a form), "type" the morph type,
  "fields" every entry field by its exact name ("" when empty, a list of entry ids for a reference field),
  "links" the words and morphemes linked to the entry itself (not its senses). A word's or morpheme's
  "link_id" in load() is an entry's "id". Stage entry changes by id, which never names two entries:
  untagged = [e for e in lexicon() if e["links"] and not e["fields"].get({pos})]
  for e in untagged:
      plan("set_entry_field", entry_id=e["id"], field={pos}, value="n")
{entry_fields}
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
                    'link': m.link.form if m.link else None,
                    'link_id': m.link.item_id if m.link else None, 'review': _review(m.fields)})
            words.append({
                'ref': word_ref(s, w), 'surface': w.surface,
                'orthographies': dict(w.orthographies or {}),
                'fields': {name: sp.value or '' for name, sp in w.fields.items()},
                'link': w.link.form if w.link else None,
                'link_id': w.link.item_id if w.link else None,
                'mwes': [l.form for l in (w.mwes or [])],
                'review': _review(w.fields), 'morphemes': morphemes})
        time = doc.sentence_time(s) if doc.segments else None
        sentences.append({'ref': f's{s.index}', 'text': s.text, 'time': list(time) if time else None,
                          'fields': {name: sp.value or '' for name, sp in s.fields.items()},
                          'words': words})
    return {'id': doc.id, 'name': doc.name, 'metadata': dict(doc.metadata or {}),
            'segments': [{'start': g.start, 'end': g.stop, 'speaker': g.speaker, 'text': g.text}
                         for g in doc.segments],
            'sentences': sentences}


def recording_api(ws: Workspace) -> Callable:
    """``recording(document)``: the length in seconds of a document's
    recording as core stored it at upload (media.py), None without one or
    when its length is unknown."""
    from .media import recording_of

    def recording(document) -> Optional[float]:
        # An entry of documents() names its document, as load() takes it.
        if isinstance(document, dict) and ('id' in document or 'name' in document):
            document = document.get('id') or document.get('name')
        return recording_of(ws, ws.resolve_document_id(document))[1]
    return recording


def entry(view: LexView, it: dict, links: int) -> Dict[str, Any]:
    """One lexicon entry as plain data. Its fields are the ones the app's
    entry form shows on it, then any other key it holds, as read_lexicon
    lists them, so a field read by name is never a KeyError for an entry
    that leaves it empty."""
    meta = it.get('metadata') or {}
    hidden = view.hidden_fields(it)
    refs = {f['name']: f for f in item_ref_fields(view.fields)}
    fields = {}
    for f in view.fields:
        if f['name'] == 'morphType' or f['name'] in hidden:
            continue
        fields[f['name']] = ref_ids(it, f) if f['name'] in refs else _plain(meta.get(f['name']))
    for k, v in meta.items():
        if k not in fields and k not in RESERVED_ITEM_KEYS and k != 'morphType' and k not in hidden \
                and k not in PROVENANCE_KEYS and v not in (None, '', [], {}):
            fields[k] = _plain(v)
    iid = it['id']
    return {'id': iid, 'lexicon': view.vocab['name'], 'form': it.get('form') or '',
            'address': view.address(iid), 'type': morph_type_of(view.tree, iid),
            'fields': fields, 'parent': view.tree.parent_of.get(iid) or None,
            'senses': [s['id'] for s in view.tree.senses_of(iid)], 'links': links}


def _plain(v) -> Any:
    return '' if v is None else v


def link_counts(ws: Workspace, vocab: dict) -> Counter:
    """How many words and morphemes link to each entry of a lexicon: one
    grouped query per level, never a walk."""
    c = ws.corpus
    base = [['vocab', '?v', {'layer': vocab['id']}], ['vocab-link', '?t', '?v']]
    out: Counter = Counter()
    for tok in [c.word('?t')] + ([c.morph('?t')] if c.M else []):
        for iid, n in c.group(base + [tok], ['?v']):
            out[iid] += n
    return out


def lexicon_api(ws: Workspace) -> Callable:
    """``lexicon(name=None)`` for the sandbox. The link counts are read once
    per run_code call and lexicon, the entries every time, so an entry a
    plan() call changed reads changed."""
    from ..core.reach import target
    counts: Dict[tuple, Counter] = {}

    def lexicon(name: Optional[str] = None, project=None) -> List[Dict[str, Any]]:
        try:
            w = target(ws, project)
            p = w.project
            vocabs = [p.vocab(name)] if name else list(p.vocabs)
        except (ToolError, ValueError) as e:
            raise ValueError(str(e))
        out = []
        for v in vocabs:
            key = (id(w), v['id'])
            if key not in counts:
                counts[key] = link_counts(w, v)
            view = w.view(v)
            out.extend(entry(view, it, counts[key][it['id']]) for it in view.items)
        return out
    return lexicon


def api(ws: Workspace) -> Dict[str, Callable]:
    # The toolkit is the last module imported (it reads every tool module, this
    # one included), so it is asked for here rather than at the top.
    from ..core.query import display as _display
    from .query import _layer_index
    from .toolkit import WRITE_TOOLS, call_tool
    return {**sandbox.api(ws, view, call_tool, WRITE_TOOLS, _layer_index, _display),
            'lexicon': lexicon_api(ws), 'recording': recording_api(ws)}


def t_run_code(ws: Workspace, code: str = None) -> str:
    return sandbox.run_tool(ws, code, api, _shape(ws), counted={'lexicon': 'entry'},
                            returns={'lexicon': LEXICON_RETURNS})


def _lexicon_help(ws: Workspace) -> str:
    """The help's lexicon example in this project's own spelling of the POS
    field, and each lexicon's entry fields, for the reason :func:`_shape`
    spells the document's."""
    vocabs = ws.project.vocabs
    pos = next((f for f in (ws.project.lexicon_field(v, 'pos') for v in vocabs) if f), 'pos')
    names = [f'  {json.dumps(v["name"])}: ' + ', '.join(json.dumps(f['name']) for f in v.get('fields') or []
                                                       if f['name'] != 'morphType') for v in vocabs]
    listed = ('  Entry fields by lexicon, spelled as the code must spell them:\n' + '\n'.join(names) + '\n'
              if names else '  This project has no lexicon yet.\n')
    return IGT_HELP.replace('{lexicon_returns}', LEXICON_RETURNS).replace('{pos}', json.dumps(pos)).replace('{entry_fields}', listed)


def t_code_help(ws: Workspace) -> str:
    return sandbox.help_text(_lexicon_help(ws), filetools.code_help(ws), ws, _shape(ws))
