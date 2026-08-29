"""The tools the model sees, and the per-request workspace they run against.

Everything is deliberately IGT-shaped and id-free on the model's side: it
reads compact interlinear views, addresses things positionally (``s3.w2.m1``),
names fields, orthographies, and lexicon entries by name, and never sees a
layer or token id. The workspace resolves all of that against the live
project and caches what it loads for the length of one turn.

Read tools answer immediately. Write tools do not write: they append resolved
operations to the workspace's plan (see :mod:`plan`), which the service returns
with the turn for the user to approve.
"""

import copy
import json
import re
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional

from .project import (IgtProject, IgtDoc, Sentence, Word, Morpheme, load_document, resolve,
                      render_document, render_overview, render_sentence, render_word,
                      segmentation, word_ref)

MAX_RESULT_CHARS = 12000
MAX_DOCS_PER_SEARCH = 200


class ToolError(Exception):
    """A tool-level failure whose message goes back to the model as the result."""


class Workspace:
    def __init__(self, client, project: IgtProject, on_progress=None):
        self.client = client
        self.project = project
        self.on_progress = on_progress or (lambda msg: None)
        self._doc_list: Optional[List[dict]] = None
        self._docs: Dict[str, IgtDoc] = {}
        self._lexicons: Dict[str, List[dict]] = {}
        self.ops: List[Dict[str, Any]] = []
        self.new_entries: Dict[str, dict] = {}  # key -> {form, vocab_id, metadata}

    # --- loading ---------------------------------------------------------

    def documents(self) -> List[dict]:
        if self._doc_list is None:
            self._doc_list = list(self.client.projects.list_documents(self.project.id) or [])
        return self._doc_list

    def resolve_document_id(self, document: str) -> str:
        """Accept a document id or a unique document name."""
        if not document:
            raise ToolError('Name a document (id or exact name); project_overview lists them.')
        docs = self.documents()
        for d in docs:
            if d['id'] == document:
                return d['id']
        by_name = [d for d in docs if (d.get('name') or '').lower() == document.lower()]
        if len(by_name) == 1:
            return by_name[0]['id']
        if len(by_name) > 1:
            raise ToolError(f'Several documents are named "{document}"; use an id: '
                            + ', '.join(d['id'] for d in by_name))
        starts = [d for d in docs if (d.get('name') or '').lower().startswith(document.lower())]
        if len(starts) == 1:
            return starts[0]['id']
        raise ToolError(f'No document "{document}". Documents: '
                        + ', '.join(f'"{d.get("name")}"' for d in docs[:50]))

    def doc(self, document: str) -> IgtDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            name = next((d.get('name') for d in self.documents() if d['id'] == did), did)
            self.on_progress(f'Reading "{name}"…')
            self._docs[did] = load_document(self.client, self.project, did)
        return self._docs[did]

    def all_docs(self) -> List[IgtDoc]:
        docs = self.documents()
        if len(docs) > MAX_DOCS_PER_SEARCH:
            raise ToolError(f'{len(docs)} documents is too many to scan at once; name a document.')
        return [self.doc(d['id']) for d in docs]

    def lexicon(self, vocab: dict) -> List[dict]:
        if vocab['id'] not in self._lexicons:
            self.on_progress(f'Reading lexicon "{vocab["name"]}"…')
            layer = self.client.vocab_layers.get(vocab['id'], include_items=True)
            self._lexicons[vocab['id']] = list(layer.get('items') or [])
        return self._lexicons[vocab['id']]

    def find_entry(self, form: Optional[str], lexicon: Optional[str], entry_id: Optional[str]):
        """-> ('existing', item) | ('new', key). Errors list candidates."""
        if entry_id:
            for key, e in self.new_entries.items():
                if key == entry_id:
                    return 'new', key
            for v in self.project.vocabs:
                for it in self.lexicon(v):
                    if it['id'] == entry_id:
                        return 'existing', it
            raise ToolError(f'No lexicon entry with id {entry_id}')
        if not form:
            raise ToolError('Give entry_form (or entry_id).')
        vocabs = [self.project.vocab(lexicon)] if lexicon else self.project.vocabs
        if not vocabs:
            raise ToolError('This project has no lexicon.')
        hits = []
        for v in vocabs:
            for it in self.lexicon(v):
                if (it.get('form') or '').lower() == form.lower():
                    hits.append((v, it))
        news = [(k, e) for k, e in self.new_entries.items()
                if e['form'].lower() == form.lower() and (not lexicon or e['vocab_id'] == vocabs[0]['id'])]
        if len(hits) + len(news) == 1:
            return ('existing', hits[0][1]) if hits else ('new', news[0][0])
        if not hits and not news:
            raise ToolError(f'No lexicon entry "{form}". Use read_lexicon to look, or create_entry to add one.')
        lines = [f'Several entries match "{form}"; pass entry_id to pick one:']
        for v, it in hits:
            lines.append(f'  id={it["id"]} {entry_line(it)} ({v["name"]})')
        for k, e in news:
            lines.append(f'  id={k} {e["form"]} (new in this plan)')
        raise ToolError('\n'.join(lines))

    # --- plan --------------------------------------------------------------

    def add_op(self, op: Dict[str, Any]) -> None:
        self.ops.append(op)

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .plan import summarize
        # A snapshot: the payload must not alias the live list (discard_plan
        # clears it) since it is what the user approves later.
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in self.ops], 'ops': copy.deepcopy(self.ops)}

    def planned_note(self, n: int) -> str:
        return (f'Planned {n} change{"s" if n != 1 else ""} (nothing is written until the user approves; '
                f'the plan now holds {len(self.ops)}). Describe the plan to the user in your reply.')


# --- helpers -----------------------------------------------------------------

def entry_line(it: dict) -> str:
    meta = it.get('metadata') or {}
    parts = [it.get('form') or '']
    if meta.get('morphType'):
        parts.append(f'type={meta["morphType"]}')
    for k, v in meta.items():
        if k in ('morphType',) or k.startswith('prov') or v in (None, '', [], {}):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        parts.append(f'{k}={v}')
    return ' | '.join(parts)


def _refs(refs) -> List[str]:
    if refs is None:
        return []
    if isinstance(refs, str):
        return [r.strip() for r in re.split(r'[,\s]+', refs) if r.strip()]
    return [str(r).strip() for r in refs if str(r).strip()]


def _matcher(pattern: str, regex: bool):
    if regex:
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            raise ToolError(f'Bad regex: {e}')
        return lambda s: bool(rx.search(s or ''))
    p = (pattern or '').casefold()
    return lambda s: p in (s or '').casefold()


def _truncate(s: str) -> str:
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS] + f'\n... [truncated: {len(s) - MAX_RESULT_CHARS} more characters; narrow the request]'


def _sentence_of(doc: IgtDoc, w: Word) -> Sentence:
    for s in doc.sentences:
        if w in s.words:
            return s
    raise ToolError('internal: word not in document')


# --- read tools ---------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    return render_overview(ws.project, ws.documents())


def t_read_document(ws: Workspace, document: str, from_sentence: int = 1, to_sentence: Optional[int] = None) -> str:
    doc = ws.doc(document)
    return render_document(doc, ws.project, start=int(from_sentence or 1),
                           end=int(to_sentence) if to_sentence else None)


def t_search(ws: Workspace, pattern: str = '', where: str = 'baseline', document: Optional[str] = None,
             regex: bool = False, limit: int = 40, missing: bool = False) -> str:
    if missing:
        return t_missing(ws, where, document, limit)
    if not pattern:
        raise ToolError('Give a pattern (or missing=true with a field name to find items without a value).')
    match = _matcher(pattern, bool(regex))
    limit = max(1, min(int(limit or 40), 200))
    where_l = (where or 'baseline').lower()
    if where_l.startswith('field:'):
        where_l = where_l[6:]
    out: List[str] = []
    total = 0

    if where_l == 'lexicon':
        for v in ws.project.vocabs:
            for it in ws.lexicon(v):
                line = entry_line(it)
                if match(line):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{line} ({v["name"]})')
        return _finish(out, total, limit, 'lexicon entries')

    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where)
    docs = [ws.doc(document)] if document else ws.all_docs()
    for doc in docs:
        tag = f'"{doc.name}" ' if len(docs) > 1 else ''
        for s in doc.sentences:
            if field and field.scope == 'Sentence':
                sp = s.fields.get(field.name)
                if sp and match(sp.value):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}s{s.index} {field.name}={sp.value} | {s.text}')
                continue
            for w in s.words:
                hit = False
                if where_l == 'baseline':
                    hit = match(w.surface)
                elif where_l == 'morpheme':
                    hit = any(match(m.form) for m in w.morphemes)
                elif field.scope == 'Word':
                    sp = w.fields.get(field.name)
                    hit = bool(sp and match(sp.value))
                else:
                    hit = any(match(m.fields[field.name].value) for m in w.morphemes if field.name in m.fields)
                if hit:
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    return _finish(out, total, limit, 'hits')


def t_missing(ws: Workspace, field: str, document: Optional[str], limit: int) -> str:
    """Items that have NO value for `field` (the unglossed words, the
    untranslated sentences), by positional reference."""
    if not field or field.lower() in ('baseline', 'morpheme', 'lexicon'):
        raise ToolError('missing=true needs a field name in `where` (e.g. "Gloss").')
    f = ws.project.field(field)
    limit = max(1, min(int(limit or 40), 200))
    docs = [ws.doc(document)] if document else ws.all_docs()
    out: List[str] = []
    total = 0
    for doc in docs:
        tag = f'"{doc.name}" ' if len(docs) > 1 else ''
        for s in doc.sentences:
            if f.scope == 'Sentence':
                sp = s.fields.get(f.name)
                if not sp or sp.value == '':
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}s{s.index} | {s.text}')
                continue
            for w in s.words:
                if f.scope == 'Word':
                    sp = w.fields.get(f.name)
                    if not sp or sp.value == '':
                        total += 1
                        if len(out) < limit:
                            out.append(f'{tag}{word_ref(s, w)} {w.surface} || {s.text}')
                else:
                    empties = [m for m in w.morphemes if not m.fields.get(f.name) or m.fields[f.name].value == '']
                    if empties or not w.morphemes:
                        total += 1
                        if len(out) < limit:
                            which = ', '.join(f'm{m.index} {m.form}' for m in empties) if empties else 'no morphemes yet'
                            out.append(f'{tag}{word_ref(s, w)} {w.surface} ({which}) || {s.text}')
    return _finish(out, total, limit, f'items without a {f.name} value')


def _finish(out, total, limit, noun):
    if not out:
        return f'No {noun}.'
    head = f'{total} {noun}' + (f' (showing {limit})' if total > limit else '') + ':'
    return _truncate('\n'.join([head] + out))


def t_field_values(ws: Workspace, field: str, document: Optional[str] = None, limit: int = 40) -> str:
    f = ws.project.field(field)
    docs = [ws.doc(document)] if document else ws.all_docs()
    counts: Counter = Counter()
    empty = 0
    for doc in docs:
        for s in doc.sentences:
            if f.scope == 'Sentence':
                sp = s.fields.get(f.name)
                if sp and sp.value != '':
                    counts[sp.value] += 1
                else:
                    empty += 1
                continue
            for w in s.words:
                units = [w] if f.scope == 'Word' else w.morphemes
                for u in units:
                    sp = u.fields.get(f.name)
                    if sp and sp.value != '':
                        counts[sp.value] += 1
                    else:
                        empty += 1
    limit = max(1, min(int(limit or 40), 500))
    lines = [f'{f.name} ({f.scope} field): {sum(counts.values())} values, {len(counts)} distinct, {empty} empty']
    for v, n in counts.most_common(limit):
        lines.append(f'  {n}\t{v}')
    if len(counts) > limit:
        lines.append(f'  ... {len(counts) - limit} more distinct values')
    return _truncate('\n'.join(lines))


def t_read_lexicon(ws: Workspace, lexicon: Optional[str] = None, pattern: Optional[str] = None,
                   limit: int = 80) -> str:
    vocabs = [ws.project.vocab(lexicon)] if lexicon else ws.project.vocabs
    if not vocabs:
        return 'This project has no lexicon.'
    match = _matcher(pattern, False) if pattern else (lambda s: True)
    limit = max(1, min(int(limit or 80), 500))
    lines = []
    for v in vocabs:
        items = sorted(ws.lexicon(v), key=lambda it: (it.get('form') or '').casefold())
        hits = [it for it in items if match(entry_line(it))]
        lines.append(f'Lexicon "{v["name"]}": {len(items)} entries' + (f', {len(hits)} matching' if pattern else ''))
        for it in hits[:limit]:
            lines.append('  ' + entry_line(it))
        if len(hits) > limit:
            lines.append(f'  ... {len(hits) - limit} more (narrow with pattern)')
    return _truncate('\n'.join(lines))


# --- write tools (plan only) ---------------------------------------------------

def _need(obj, kind, ref):
    if not isinstance(obj, kind):
        want = {Sentence: 'a sentence (sN)', Word: 'a word (sN.wN)', Morpheme: 'a morpheme (sN.wN.mN)'}[kind]
        raise ToolError(f'{ref} is not {want}')
    return obj


def t_set_field(ws: Workspace, document: str, refs, field: str, value: str) -> str:
    f = ws.project.field(field)
    doc = ws.doc(document)
    value = '' if value is None else str(value)
    kind = {'Word': Word, 'Morpheme': Morpheme, 'Sentence': Sentence}[f.scope]
    n = 0
    for ref in _refs(refs):
        obj = _need(resolve(doc, ref), kind, ref)
        old = obj.fields.get(f.name)
        if (old.value if old else '') == value:
            continue
        what = obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)
        target_id = obj.id
        ws.add_op({'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': target_id,
                   'span_id': old.id if old else None, 'value': value,
                   'label': f'{doc.name} {ref} "{what[:40]}": {f.name} '
                            + (f'"{old.value}" → "{value}"' if old and old.value != '' else f'= "{value}"')
                            + (' (cleared)' if value == '' else '')})
        n += 1
    return ws.planned_note(n)


def t_set_analysis(ws: Workspace, document: str, ref: str, morphemes: list) -> str:
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.')
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    if not morphemes or not isinstance(morphemes, list):
        raise ToolError('morphemes must be a non-empty list of {form, type?, fields?}')
    mfields = ws.project.fields_by_scope('Morpheme')
    out = []
    for m in morphemes:
        if not isinstance(m, dict) or not (m.get('form') or '').strip():
            raise ToolError('each morpheme needs a non-empty form')
        fvals = []
        for name, val in (m.get('fields') or {}).items():
            f = ws.project.field(name)
            if f.scope != 'Morpheme':
                raise ToolError(f'"{f.name}" is a {f.scope} field, not a morpheme field; use set_field for it')
            fvals.append({'layer_id': f.layer_id, 'value': '' if val is None else str(val)})
        out.append({'form': m['form'].strip(), 'morph_type': m.get('type') or None, 'fields': fvals})
    joined = ''.join(m['form'] for m in out)
    if joined.replace(' ', '') != w.surface.replace(' ', ''):
        note = f' (note: forms "{joined}" differ from the surface "{w.surface}"; that is allowed for allomorphy)'
    else:
        note = ''
    existing = [{'id': m.id, 'span_ids': [sp.id for sp in m.fields.values()]} for m in w.morphemes]
    desc = '-'.join(m['form'] for m in out)
    gloss_bits = []
    for f in mfields:
        vals = [next((fv['value'] for fv in m['fields'] if fv['layer_id'] == f.layer_id), '_') for m in out]
        if any(v not in ('', '_') for v in vals):
            gloss_bits.append(f'{f.name} {"-".join(v or "_" for v in vals)}')
    ws.add_op({'kind': 'set_analysis', 'word_id': w.id, 'text_id': w.text_id, 'begin': w.begin, 'end': w.end,
               'morpheme_layer_id': ws.project.morpheme_layer_id, 'existing': existing, 'morphemes': out,
               'label': f'{doc.name} {ref} "{w.surface}": ' + (f'{segmentation(w)} → ' if w.morphemes else '')
                        + desc + (', ' + ', '.join(gloss_bits) if gloss_bits else '')})
    return ws.planned_note(1) + note


def t_set_orthography(ws: Workspace, document: str, refs, orthography: str, value: str) -> str:
    o = ws.project.orthography(orthography)
    doc = ws.doc(document)
    n = 0
    for ref in _refs(refs):
        w = _need(resolve(doc, ref), Word, ref)
        old = w.orthographies.get(o, '')
        if old == (value or ''):
            continue
        ws.add_op({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{o}', 'value': value or '',
                   'label': f'{doc.name} {ref} "{w.surface}": {o} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
        n += 1
    return ws.planned_note(n)


def t_respell(ws: Workspace, document: str, ref: str, new_text: str) -> str:
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    new_text = (new_text or '').strip()
    if not new_text:
        raise ToolError('new_text must not be empty (there is no delete-word tool)')
    if new_text == w.surface:
        return ws.planned_note(0)
    ws.add_op({'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new_text,
               'label': f'{doc.name} {ref}: respell "{w.surface}" → "{new_text}"'})
    return ws.planned_note(1)


def t_link_entry(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                 lexicon: Optional[str] = None, entry_id: Optional[str] = None) -> str:
    doc = ws.doc(document)
    kind, target = ws.find_entry(entry_form, lexicon, entry_id)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    n = 0
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            raise ToolError(f'{ref}: link words (sN.wN) or morphemes (sN.wN.mN), not sentences')
        if kind == 'existing' and obj.link and obj.link.item_id == target['id']:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        ws.add_op({'kind': 'link', 'token_id': obj.id,
                   'item_id': target['id'] if kind == 'existing' else None,
                   'new_entry_key': target if kind == 'new' else None,
                   'existing_link_id': obj.link.id if obj.link else None,
                   'label': f'{doc.name} {ref} "{what}": link ' + (f'"{obj.link.form}" → ' if obj.link else '') + f'"{form}"'})
        n += 1
    return ws.planned_note(n)


def t_unlink_entry(ws: Workspace, document: str, refs) -> str:
    doc = ws.doc(document)
    n = 0
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence) or not obj.link:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        ws.add_op({'kind': 'unlink', 'link_id': obj.link.id,
                   'label': f'{doc.name} {ref} "{what}": unlink "{obj.link.form}"'})
        n += 1
    return ws.planned_note(n)


def t_create_entry(ws: Workspace, form: str, lexicon: Optional[str] = None, fields: Optional[dict] = None,
                   type: Optional[str] = None) -> str:
    form = (form or '').strip()
    if not form:
        raise ToolError('form must not be empty')
    v = ws.project.vocab(lexicon)
    metadata = {k: ('' if val is None else str(val)) for k, val in (fields or {}).items()}
    if type:
        metadata['morphType'] = type
    key = f'new:{v["id"]}:{form}#{len(ws.new_entries) + 1}'
    ws.new_entries[key] = {'form': form, 'vocab_id': v['id'], 'metadata': metadata}
    ws.add_op({'kind': 'create_entry', 'vocab_id': v['id'], 'form': form, 'metadata': metadata, 'key': key,
               'label': f'{v["name"]}: new entry ' + entry_line({'form': form, 'metadata': metadata})})
    return ws.planned_note(1) + f' New entries can be linked in this same plan (entry_id="{key}").'


def t_set_entry_field(ws: Workspace, field: str, value: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None) -> str:
    kind, target = ws.find_entry(entry_form, lexicon, entry_id)
    if kind == 'new':
        ws.new_entries[target]['metadata'][field] = '' if value is None else str(value)
        for op in ws.ops:
            if op.get('kind') == 'create_entry' and op.get('key') == target:
                op['metadata'][field] = '' if value is None else str(value)
        return ws.planned_note(0) + ' (updated the pending new entry)'
    old = (target.get('metadata') or {}).get(field, '')
    ws.add_op({'kind': 'set_entry_field', 'item_id': target['id'], 'field': field, 'value': '' if value is None else str(value),
               'label': f'entry "{target.get("form")}": {field} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    return ws.planned_note(1)


def t_discard_plan(ws: Workspace) -> str:
    n = len(ws.ops)
    ws.ops.clear()
    ws.new_entries.clear()
    return f'Discarded {n} planned change{"s" if n != 1 else ""}.'


# --- schema + dispatch ----------------------------------------------------------

def _fn(name, description, properties, required):
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Positional references, e.g. ["s3.w2", "s3.w4"]. Words are sN.wN, morphemes sN.wN.mN, sentences sN.'}

TOOLS = [
    _fn('project_overview',
        'The project: its annotation fields by scope (Word / Morpheme / Sentence), orthographies, lexicons, and the '
        'list of documents. Call this first.', {}, []),
    _fn('read_document',
        'Read a document as compact interlinear text: baseline sentences, sentence fields, and one line per word '
        'with its segmentation, glosses, word fields, orthographies, and lexicon links. Up to 40 sentences per call.',
        {'document': _DOC,
         'from_sentence': {'type': 'integer', 'description': 'First sentence number to show (default 1).'},
         'to_sentence': {'type': 'integer', 'description': 'Last sentence number to show.'}},
        ['document']),
    _fn('search',
        'Find words, morphemes, field values, or lexicon entries matching a pattern (case-insensitive substring, '
        'or a regex). Returns positional references with each hit\'s word line and sentence. Scans every '
        'document unless one is named. With missing=true and a field name in `where`, lists the items that have '
        'NO value for that field (e.g. the unglossed words) instead of matching a pattern.',
        {'pattern': {'type': 'string'},
         'missing': {'type': 'boolean', 'description': 'List items lacking a value for the field named in `where`.'},
         'where': {'type': 'string', 'description': '"baseline" (word forms, default), "morpheme" (morpheme forms), '
                                                    '"lexicon" (entries), or a field name (e.g. "Gloss", "Translation").'},
         'document': _DOC,
         'regex': {'type': 'boolean', 'description': 'Treat pattern as a regular expression.'},
         'limit': {'type': 'integer', 'description': 'Max hits to return (default 40, max 200).'}},
        []),
    _fn('field_values',
        'Count the distinct values of a field (a histogram), across the project or one document. Good for '
        'spotting inconsistencies (e.g. "1SG" vs "1sg").',
        {'field': {'type': 'string'}, 'document': _DOC,
         'limit': {'type': 'integer', 'description': 'Max distinct values to list (default 40).'}},
        ['field']),
    _fn('read_lexicon',
        'List lexicon entries (form, morph type, and their fields such as gloss), optionally filtered by a '
        'substring pattern over the whole entry line.',
        {'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
         'pattern': {'type': 'string'},
         'limit': {'type': 'integer', 'description': 'Max entries (default 80).'}},
        []),
    _fn('set_field',
        'PLAN: set a field\'s value on words, morphemes, or sentences (the references must match the field\'s '
        'scope). Empty value clears it. Nothing is written until the user approves the plan.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'field', 'value']),
    _fn('set_analysis',
        'PLAN: replace a word\'s morpheme segmentation and morpheme-level fields. Morphemes are given in order; '
        'each has a form, an optional type (stem, root, prefix, suffix, infix, enclitic, proclitic, ...), and '
        'fields mapping morpheme field names to values, e.g. [{"form":"kitab","type":"stem","fields":{"Gloss":"book"}}, '
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. Existing morphemes and their field values are replaced.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}},
        ['document', 'ref', 'morphemes']),
    _fn('set_orthography',
        'PLAN: set an orthography (an alternative transcription) value on words.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the baseline spelling of one word (its analysis, glosses, and links are kept).',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'}, 'new_text': {'type': 'string'}},
        ['document', 'ref', 'new_text']),
    _fn('link_entry',
        'PLAN: link words or morphemes to a lexicon entry, by the entry\'s form (or entry_id when ambiguous, or '
        'the id returned by create_entry). Replaces an existing link.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}},
        ['document', 'refs']),
    _fn('unlink_entry', 'PLAN: remove the lexicon link from words or morphemes.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('create_entry',
        'PLAN: add a lexicon entry. fields maps entry field names (e.g. "gloss", "pos") to values; type is the '
        'morph type (stem, suffix, enclitic, ...). The returned entry_id can be used by link_entry in the same plan.',
        {'form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}, 'type': {'type': 'string'}},
        ['form']),
    _fn('set_entry_field', 'PLAN: set a field (e.g. gloss) on a lexicon entry.',
        {'field': {'type': 'string'}, 'value': {'type': 'string'}, 'entry_form': {'type': 'string'},
         'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'}},
        ['field', 'value']),
    _fn('discard_plan', 'Drop every change planned so far in this turn.', {}, []),
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'field_values': t_field_values, 'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
}

WRITE_TOOLS = {'set_field', 'set_analysis', 'set_orthography', 'respell', 'link_entry', 'unlink_entry',
               'create_entry', 'set_entry_field'}


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool; every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    try:
        return _truncate(fn(ws, **(args or {})))
    except (ToolError, ValueError) as e:  # ValueError: a name/reference lookup failed, message is for the model
        return f'Error: {e}'
    except Exception as e:  # noqa: BLE001 - the model gets the failure as text; the log gets the trace
        import traceback
        traceback.print_exc()
        return f'Error: {type(e).__name__}: {e}'
