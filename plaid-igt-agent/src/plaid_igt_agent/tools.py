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

import unicodedata

from plaid_client.provenance import prov_state, MACHINE

from .project import (IgtProject, IgtDoc, Sentence, Word, Morpheme, load_document, resolve,
                      render_document, render_overview, render_sentence, render_word,
                      segmentation, joiner, word_ref, is_unicode_punctuation)

MAX_RESULT_CHARS = 12000
MAX_DOCS_PER_SEARCH = 1000


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
        self.replaced = 0  # ops superseded by a later op on the same target this turn
        self.new_entries: Dict[str, dict] = {}  # key -> {form, vocab_id, metadata}
        self._doc_ids: Dict[str, set] = {}  # document id -> every id the document contains

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

    def find_entry(self, form: Optional[str], lexicon: Optional[str], entry_id: Optional[str],
                   gloss: Optional[str] = None):
        """-> ('existing', item) | ('new', key). Errors list candidates.
        ``gloss`` narrows homographs to entries with that value in any field."""
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
        # "ама#2" picks homograph 2 (the entry's `homograph` metadata).
        homograph = None
        if '#' in form:
            form, _, hn = form.rpartition('#')
            homograph = hn.strip()
        g = (gloss or '').strip().casefold()

        def has_gloss(meta):
            return not g or any(isinstance(v, str) and v.strip().casefold() == g for v in (meta or {}).values())
        hits = []
        for v in vocabs:
            for it in self.lexicon(v):
                if (it.get('form') or '').lower() != form.lower():
                    continue
                if homograph is not None and str((it.get('metadata') or {}).get('homograph', '')) != homograph:
                    continue
                if not has_gloss(it.get('metadata')):
                    continue
                hits.append((v, it))
        news = [(k, e) for k, e in self.new_entries.items()
                if e['form'].lower() == form.lower() and (not lexicon or e['vocab_id'] == vocabs[0]['id'])
                and has_gloss(e.get('metadata'))]
        if len(hits) + len(news) == 1:
            return ('existing', hits[0][1]) if hits else ('new', news[0][0])
        if not hits and not news:
            raise ToolError(f'No lexicon entry "{form}"' + (f' with a field valued "{gloss}"' if g else '')
                            + '. Use read_lexicon to look, or create_entry to add one.')
        lines = [f'Several entries match "{form}"; pass entry_id, entry_gloss (a field value that singles one out), '
                 f'or entry_form "{form}#<homograph number>" where one is shown:']
        for v, it in hits:
            hn = (it.get('metadata') or {}).get('homograph')
            lines.append(f'  id={it["id"]}' + (f' form={form}#{hn}' if hn not in (None, '') else '') + f' {entry_line(it)} ({v["name"]})')
        for k, e in news:
            lines.append(f'  id={k} {e["form"]} (new in this plan)')
        raise ToolError('\n'.join(lines))

    # --- plan --------------------------------------------------------------

    def add_op(self, op: Dict[str, Any]) -> None:
        """Append a plan op. An op on a target the plan already touches
        REPLACES the earlier op (last wins), so a corrected instruction never
        yields two writes to one span, token, or entry. The target key is
        derived from the op's kind."""
        key = op_target(op)
        if key is not None:
            for i, prev in enumerate(self.ops):
                if op_target(prev) == key:
                    self.ops[i] = op
                    self.replaced += 1
                    return
        self.ops.append(op)

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        for op in ops:
            self.add_op(op)

    def planned_span_value(self, layer_id: str, token_id: str, current: str) -> str:
        """The value a span will have once the plan runs (a planned op wins
        over the stored value), so bulk tools compose with earlier plans."""
        for op in self.ops:
            if op.get('kind') == 'set_span' and op.get('layer_id') == layer_id and op.get('token_id') == token_id:
                return op.get('value') or ''
        return current

    def planned_respells(self, text_id: str) -> List[tuple]:
        return [(op['begin'], op['end']) for op in self.ops if op.get('kind') == 'respell' and op.get('text_id') == text_id]

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .plan import summarize
        # A snapshot: the payload must not alias the live list (discard_plan
        # clears it) since it is what the user approves later.
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in self.ops], 'ops': copy.deepcopy(self.ops),
                'documents': self.touched_documents()}

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan's ops refer to, with the version each was
        read at, so approval can refuse a plan made against stale data (ops
        carry ids and character offsets from plan time)."""
        out = []
        for did, doc in self._docs.items():
            ids = self._doc_ids.get(did)
            if ids is None:
                ids = {doc.id, doc.text_id}
                for s in doc.sentences:
                    ids.add(s.id)
                    ids.update(sp.id for sp in s.fields.values())
                    for w in s.words:
                        ids.add(w.id)
                        ids.update(sp.id for sp in w.fields.values())
                        if w.link:
                            ids.add(w.link.id)
                        for m in w.morphemes:
                            ids.add(m.id)
                            ids.update(sp.id for sp in m.fields.values())
                            if m.link:
                                ids.add(m.link.id)
                ids.discard(None)
                self._doc_ids[did] = ids
            if any(_op_mentions(op, ids) for op in self.ops):
                out.append({'id': doc.id, 'name': doc.name, 'version': doc.version})
        return out

    def planned_note(self, n: int) -> str:
        note = (f'Planned {n} change{"s" if n != 1 else ""} (nothing is written until the user approves; '
                f'the plan now holds {len(self.ops)}). Describe the plan to the user in your reply.')
        if self.replaced:
            note += f' {self.replaced} earlier planned change{"s" if self.replaced != 1 else ""} on the same target{"s" if self.replaced != 1 else ""} superseded.'
            self.replaced = 0
        return note


def _op_mentions(value, ids: set) -> bool:
    if isinstance(value, str):
        return value in ids
    if isinstance(value, dict):
        return any(_op_mentions(v, ids) for k, v in value.items() if k != 'label')
    if isinstance(value, list):
        return any(_op_mentions(v, ids) for v in value)
    return False


def op_target(op: Dict[str, Any]):
    """What an op writes to, for last-wins replacement within one plan."""
    k = op.get('kind')
    if k == 'set_span':
        return ('span', op.get('layer_id'), op.get('token_id'))
    if k in ('set_analysis', 'discard_analysis'):
        return ('analysis', op.get('word_id'))
    if k == 'set_orthography':
        return ('orth', op.get('word_id'), op.get('key'))
    if k == 'set_morpheme_form':
        return ('morph_form', op.get('morpheme_id'))
    if k in ('split_word', 'merge_words', 'delete_word'):
        return ('word_shape', op.get('word_id'))
    if k in ('split_sentence', 'merge_sentences'):
        return ('sentence_shape', op.get('sentence_id'))
    if k == 'edit_text':
        return ('edit_text', op.get('text_id'), op.get('begin'), op.get('end'))
    if k == 'respell':
        return ('respell', op.get('text_id'), op.get('begin'), op.get('end'))
    if k in ('link', 'unlink'):
        return ('link', op.get('token_id') if k == 'link' else op.get('token_id_hint'))
    if k == 'set_entry_field':
        return ('entry_field', op.get('item_id'), op.get('field'))
    if k == 'rename_entry':
        return ('rename_entry', op.get('item_id'))
    if k == 'delete_entry':
        return ('delete_entry', op.get('item_id'))
    if k == 'set_doc_metadata':
        return ('doc_meta', op.get('document_id'), op.get('field'))
    if k == 'rename_document':
        return ('rename_document', op.get('document_id'))
    if k == 'create_document':
        return ('create_document', op.get('name'))
    return None


# --- helpers -----------------------------------------------------------------

def entry_line(it: dict) -> str:
    meta = it.get('metadata') or {}
    parts = [it.get('form') or '']
    if meta.get('morphType'):
        parts.append(f'type={meta["morphType"]}')
    for k, v in meta.items():
        if k in ('morphType', 'flexEntry', 'flexSense') or k.startswith('prov') or v in (None, '', [], {}):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        parts.append(f'{k}={v}')
    return ' | '.join(parts)


_REF_TOKEN = re.compile(r's\d+(?:\.w\d+(?:\.m\d+)?)?')


def _refs(refs) -> List[str]:
    """References as the model passes them: a list or a string, possibly
    prefixed with the document name the read tools print ('"Text 1" s3.w2')."""
    if refs is None:
        return []
    items = [refs] if isinstance(refs, str) else [str(r) for r in refs]
    out: List[str] = []
    for item in items:
        found = _REF_TOKEN.findall(item)
        if not found and item.strip():
            raise ToolError(f'Bad reference "{item.strip()}": use sN, sN.wN, or sN.wN.mN')
        out.extend(found)
    return out


def _matcher(pattern: str, regex: bool):
    if regex:
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            raise ToolError(f'Bad regex: {e}')
        return lambda s: bool(rx.search(s or ''))
    p = (pattern or '').casefold()
    return lambda s: p in (s or '').casefold()


def _is_break_char(c: str, cfg) -> bool:
    """Does this character end a word (the editor's shouldTokenizeCharacter,
    with its exact punctuation class)? Unless whitelisted; or, under a
    blacklist config, exactly the listed characters."""
    punct = is_unicode_punctuation(c)
    if not cfg:
        return punct
    if cfg.get('type') == 'unicodePunctuation':
        return punct and c not in (cfg.get('whitelist') or [])
    if cfg.get('type') == 'blacklist':
        return c in (cfg.get('blacklist') or [])
    return punct


def split_sentences(text: str) -> List[tuple]:
    """(begin, end) code-point ranges, one sentence per line (newline plus
    following whitespace is the boundary), as the editor does."""
    out = []
    i, n = 0, len(text)
    start = 0
    while i <= n:
        if i == n or text[i] == '\n':
            if text[start:i].strip():
                out.append((start, i))
            i += 1
            while i < n and text[i].isspace():
                i += 1
            start = i
        else:
            i += 1
    return out


def split_words(text: str, begin: int, end: int, cfg) -> List[tuple]:
    """(begin, end) word ranges inside one sentence: whitespace and break
    characters separate words; break characters are not tokens (they stay in
    the gap), as in the editor."""
    out = []
    i = begin
    cur = begin
    while i < end:
        c = text[i]
        if c.isspace() or _is_break_char(c, cfg):
            if i > cur and text[cur:i].strip():
                out.append(_trimmed(text, cur, i))
            i += 1
            while i < end and text[i].isspace():
                i += 1
            cur = i
        else:
            i += 1
    if cur < end and text[cur:end].strip():
        out.append(_trimmed(text, cur, end))
    return out


def _trimmed(text, b, e):
    while b < e and text[b].isspace():
        b += 1
    while e > b and text[e - 1].isspace():
        e -= 1
    return (b, e)


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
             regex: bool = False, limit: int = 40) -> str:
    if not pattern:
        raise ToolError('Give a pattern (to list items LACKING a value, use worklist).')
    match = _matcher(pattern, bool(regex))
    limit = max(1, min(int(limit or 40), 200))
    where_name = (where or 'baseline').strip()
    if where_name.lower().startswith('field:'):
        where_name = where_name[6:].strip()
    where_l = where_name.lower()
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
        field = ws.project.field(where_name)
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


def _finish(out, total, limit, noun):
    if not out:
        return f'No {noun}.'
    head = f'{total} {noun}' + (f' (showing {limit})' if total > limit else '') + ':'
    return _truncate('\n'.join([head] + out))


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


def _bracket_line(w: Word, hit: Morpheme, field: Optional[str]) -> str:
    """The word's segmentation (field=None) or one morpheme field's values,
    joined as in the interlinear view, with the hit morpheme in [brackets]."""
    out = ''
    for i, m in enumerate(w.morphemes):
        if i:
            out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
        if field is None:
            piece = m.form
        else:
            sp = m.fields.get(field)
            piece = sp.value if sp and sp.value != '' else '_'
        out += f'[{piece}]' if m is hit else piece
    return out


def t_concordance(ws: Workspace, pattern: str, where: str = 'morpheme', document: Optional[str] = None,
                  regex: bool = False, limit: int = 60) -> str:
    """Every occurrence of a morpheme form, word form, or field value with
    its aligned context: the containing word's segmentation and morpheme
    glosses (hit in brackets) and the neighbouring words, plus a tally of the
    distinct word patterns the hit occurs in. Built for morphotactic
    questions (what precedes/follows X, does X vary by context)."""
    if not pattern:
        raise ToolError('Give a pattern.')
    # Whole-form match by default (a concordance of "ar" must not include
    # "para"); regex for anything looser.
    if regex:
        match = _matcher(pattern, True)
    else:
        wanted = pattern.casefold()
        match = lambda s: (s or '').casefold() == wanted  # noqa: E731
    limit = max(1, min(int(limit or 60), 300))
    where_l = (where or 'morpheme').lower()
    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where)
        if field.scope == 'Sentence':
            raise ToolError('concordance works on words and morphemes; use search for sentence fields')
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    docs = [ws.doc(document)] if document else ws.all_docs()
    hits: List[str] = []
    patterns: Counter = Counter()
    total = 0
    for doc in docs:
        tag = f'"{doc.name}" ' if len(docs) > 1 else ''
        for s in doc.sentences:
            for wi, w in enumerate(s.words):
                hit_morphs: List[Morpheme] = []
                if where_l == 'baseline':
                    if not match(w.surface):
                        continue
                elif where_l == 'morpheme':
                    hit_morphs = [m for m in w.morphemes if match(m.form)]
                    if not hit_morphs:
                        continue
                elif field.scope == 'Word':
                    sp = w.fields.get(field.name)
                    if not (sp and match(sp.value)):
                        continue
                else:
                    hit_morphs = [m for m in w.morphemes
                                  if field.name in m.fields and match(m.fields[field.name].value)]
                    if not hit_morphs:
                        continue
                prev = s.words[wi - 1].surface if wi > 0 else '#'
                nxt = s.words[wi + 1].surface if wi + 1 < len(s.words) else '#'
                for hit in (hit_morphs or [None]):
                    total += 1
                    seg = _bracket_line(w, hit, None) if w.morphemes else w.surface
                    glosses = ' | '.join(f'{f}={_bracket_line(w, hit, f)}' for f in mfields
                                         if any(f in m.fields for m in w.morphemes))
                    pattern_key = seg if hit is None else f'{seg}' + (f'  {glosses}' if glosses else '')
                    patterns[pattern_key] += 1
                    if len(hits) < limit:
                        wf = ' | '.join(f'{f.name}={w.fields[f.name].value}' for f in ws.project.fields_by_scope('Word')
                                        if f.name in w.fields and w.fields[f.name].value != '')
                        hits.append(f'{tag}{word_ref(s, w)} {prev} [{w.surface}] {nxt} | seg={seg}'
                                    + (f' | {glosses}' if glosses else '') + (f' | {wf}' if wf else '')
                                    + f' || {s.text}')
    if not total:
        return f'No occurrences of "{pattern}".'
    lines = [f'{total} occurrence{"s" if total != 1 else ""} of "{pattern}" in {where_l if not field else field.name}'
             + (f' (showing {limit})' if total > limit else '') + '.',
             'Word patterns (hit in [brackets]), by frequency:']
    for key, n in patterns.most_common(25):
        lines.append(f'  {n}\t{key}')
    if len(patterns) > 25:
        lines.append(f'  ... {len(patterns) - 25} more patterns')
    lines.append('Occurrences (previous [word] next | segmentation | morpheme fields || sentence):')
    lines.extend('  ' + h for h in hits)
    return _truncate('\n'.join(lines))


def t_analyses_of(ws: Workspace, form: str, document: Optional[str] = None) -> str:
    """How a word form and/or a morpheme form has been analyzed so far: the
    distinct analyses with counts and an example reference each. The same
    evidence the editor's precedent ranking uses."""
    form = (form or '').strip()
    if not form:
        raise ToolError('Give a form.')
    key = form.casefold()
    docs = [ws.doc(document)] if document else ws.all_docs()
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    wfields = [f.name for f in ws.project.fields_by_scope('Word')]
    word_tally: Dict[str, List[str]] = {}
    morph_tally: Dict[str, List[str]] = {}
    for doc in docs:
        tag = f'"{doc.name}" ' if len(docs) > 1 else ''
        for s in doc.sentences:
            for w in s.words:
                ref = f'{tag}{word_ref(s, w)}'
                if w.surface.casefold() == key:
                    parts = []
                    seg = segmentation(w)
                    if len(w.morphemes) > 1 or (w.morphemes and seg != w.surface):
                        parts.append('seg=' + seg)
                        for f in mfields:
                            line = _bracket_line(w, None, f)
                            if line.replace('_', '').replace('-', '').replace('=', ''):
                                parts.append(f'{f}={line}')
                        types = [m.morph_type for m in w.morphemes if m.morph_type]
                        if types:
                            parts.append('types=' + ','.join(m.morph_type or '?' for m in w.morphemes))
                    for f in wfields:
                        sp = w.fields.get(f)
                        if sp and sp.value != '':
                            parts.append(f'{f}={sp.value}')
                    if w.link:
                        parts.append(f'link={w.link.form}')
                    mlinks = [f'm{m.index}:{m.link.form}' for m in w.morphemes if m.link]
                    if mlinks:
                        parts.append('mlinks=' + ' '.join(mlinks))
                    word_tally.setdefault(' | '.join(parts) or '(unanalyzed)', []).append(ref)
                for m in w.morphemes:
                    if m.form.casefold() == key:
                        parts = []
                        if m.morph_type:
                            parts.append(f'type={m.morph_type}')
                        for f in mfields:
                            sp = m.fields.get(f)
                            if sp and sp.value != '':
                                parts.append(f'{f}={sp.value}')
                        if m.link:
                            parts.append(f'link={m.link.form}')
                        pos = 'only' if len(w.morphemes) == 1 else ('first' if m.index == 1 else
                                                                   'last' if m.index == len(w.morphemes) else 'middle')
                        morph_tally.setdefault((' | '.join(parts) or '(unglossed)') + f'  [{pos} in word]', []
                                               ).append(f'{ref}.m{m.index} ({segmentation(w)})')
    lines = []
    for title, tally in ((f'Word "{form}"', word_tally), (f'Morpheme "{form}"', morph_tally)):
        if not tally:
            lines.append(f'{title}: no occurrences.')
            continue
        n = sum(len(v) for v in tally.values())
        lines.append(f'{title}: {n} occurrence{"s" if n != 1 else ""}, {len(tally)} distinct analys{"es" if len(tally) != 1 else "is"}:')
        for analysis, refs in sorted(tally.items(), key=lambda kv: -len(kv[1])):
            lines.append(f'  {len(refs)}\t{analysis}  e.g. {", ".join(refs[:3])}')
    return _truncate('\n'.join(lines))


def t_lexicon_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, examples: int = 3, entry_gloss: Optional[str] = None) -> str:
    """One lexicon entry in full: every field, where it is linked (words vs
    morphemes, how many), and example occurrences."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'new':
        e = ws.new_entries[target]
        return f'Entry "{e["form"]}" is new in this plan (not written yet): ' + entry_line({'form': e['form'], 'metadata': e['metadata']})
    meta = target.get('metadata') or {}
    lines = [f'Entry "{target.get("form")}" (id {target["id"]})']
    for k, v in meta.items():
        if k in ('flexEntry', 'flexSense') or k.startswith('prov') or v in (None, '', [], {}):
            continue
        lines.append(f'  {k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v}')
    word_links, morph_links, exs = 0, 0, []
    examples = max(0, min(int(examples or 3), 20))
    for doc in ws.all_docs():
        tag = f'"{doc.name}" ' if True else ''
        for s in doc.sentences:
            for w in s.words:
                hit = False
                if w.link and w.link.item_id == target['id']:
                    word_links += 1
                    hit = True
                for m in w.morphemes:
                    if m.link and m.link.item_id == target['id']:
                        morph_links += 1
                        hit = True
                if hit and len(exs) < examples:
                    exs.append(f'  {tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    lines.append(f'Linked from {word_links} word{"s" if word_links != 1 else ""} and {morph_links} morpheme{"s" if morph_links != 1 else ""}.')
    if exs:
        lines.append('Examples:')
        lines.extend(exs)
    return _truncate('\n'.join(lines))


def _norm_value(v: str) -> str:
    v = unicodedata.normalize('NFKC', v or '').casefold()
    return ''.join(ch for ch in v if ch.isalnum())


def t_check_consistency(ws: Workspace, field: str, document: Optional[str] = None) -> str:
    """A deterministic consistency report for one field: values that are
    spelling/case variants of each other, forms carrying several different
    values, and items annotated in this field but not linked to the lexicon
    (or linked but empty)."""
    f = ws.project.field(field)
    docs = [ws.doc(document)] if document else ws.all_docs()
    values: Counter = Counter()
    by_form: Dict[str, Counter] = {}
    unlinked: List[str] = []
    unlinked_n = 0
    linked_empty: List[str] = []
    linked_empty_n = 0
    for doc in docs:
        tag = f'"{doc.name}" ' if len(docs) > 1 else ''
        for s in doc.sentences:
            if f.scope == 'Sentence':
                sp = s.fields.get(f.name)
                if sp and sp.value != '':
                    values[sp.value] += 1
                continue
            for w in s.words:
                units = [(w, w.surface, f'{tag}{word_ref(s, w)}')] if f.scope == 'Word' else \
                    [(m, m.form, f'{tag}{word_ref(s, w)}.m{m.index}') for m in w.morphemes]
                for u, form, ref in units:
                    sp = u.fields.get(f.name)
                    val = sp.value if sp else ''
                    if val != '':
                        values[val] += 1
                        by_form.setdefault(form.casefold(), Counter())[val] += 1
                        if not u.link:
                            unlinked_n += 1
                            if len(unlinked) < 15:
                                unlinked.append(f'{ref} {form} ({val})')
                    elif u.link:
                        linked_empty_n += 1
                        if len(linked_empty) < 15:
                            linked_empty.append(f'{ref} {form} → {u.link.form}')
    lines = [f'Consistency of {f.name} ({f.scope} field): {sum(values.values())} values, {len(values)} distinct.']
    groups: Dict[str, List[str]] = {}
    for v in values:
        groups.setdefault(_norm_value(v), []).append(v)
    variants = [g for g in groups.values() if len(g) > 1]
    if variants:
        lines.append(f'{len(variants)} value{"s" if len(variants) != 1 else ""} spelled more than one way:')
        for g in sorted(variants, key=lambda g: -sum(values[v] for v in g))[:40]:
            lines.append('  ' + ' / '.join(f'{v} ({values[v]})' for v in sorted(g, key=lambda v: -values[v])))
    else:
        lines.append('No spelling or case variants among values.')
    if f.scope != 'Sentence':
        multi = {form: c for form, c in by_form.items() if len(c) > 1}
        if multi:
            lines.append(f'{len(multi)} {"morpheme" if f.scope == "Morpheme" else "word"} form{"s" if len(multi) != 1 else ""} with several {f.name} values (homonymy or inconsistency):')
            for form, c in sorted(multi.items(), key=lambda kv: -sum(kv[1].values()))[:40]:
                lines.append(f'  {form}: ' + ', '.join(f'{v} ({n})' for v, n in c.most_common()))
        else:
            lines.append(f'Every form carries a single {f.name} value.')
        by_value: Dict[str, Counter] = {}
        for form, c in by_form.items():
            for v, n in c.items():
                by_value.setdefault(v, Counter())[form] += n
        shared = {v: c for v, c in by_value.items() if len(c) > 1}
        if shared:
            lines.append(f'{len(shared)} {f.name} value{"s" if len(shared) != 1 else ""} carried by several forms (allomorphy or a gloss collision):')
            for v, c in sorted(shared.items(), key=lambda kv: -len(kv[1]))[:25]:
                lines.append(f'  {v}: ' + ', '.join(f'{form} ({n})' for form, n in c.most_common(8)) + (' …' if len(c) > 8 else ''))
        if ws.project.vocabs:
            lines.append(f'{unlinked_n} annotated but not linked to the lexicon'
                         + (': ' + '; '.join(unlinked) + (' …' if unlinked_n > len(unlinked) else '') if unlinked else '.'))
            lines.append(f'{linked_empty_n} linked but with no {f.name} value'
                         + (': ' + '; '.join(linked_empty) + (' …' if linked_empty_n > len(linked_empty) else '') if linked_empty else '.'))
    return _truncate('\n'.join(lines))


def t_recent_changes(ws: Workspace, document: Optional[str] = None, limit: int = 20,
                     since: Optional[str] = None, user: Optional[str] = None) -> str:
    """The newest entries of the audit log: who changed what, when, under
    which operation label (the assistant's own applied plans included).
    `since` is a date (YYYY-MM-DD) or timestamp; `user` matches the actor's
    name or email."""
    limit = max(1, min(int(limit or 20), 100))
    ws.on_progress('Reading the change history…')
    start = None
    if since:
        start = since.strip()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
            start += 'T00:00:00Z'
    if document:
        did = ws.resolve_document_id(document)
        entries = ws.client.documents.audit(did, start_time=start)
    else:
        entries = ws.client.projects.audit(ws.project.id, start_time=start)
    if user:
        u = user.casefold()
        entries = [e for e in entries or []
                   if u in ((e.get('user') or {}).get('display_name') or '').casefold()
                   or u in ((e.get('user') or {}).get('id') or '').casefold()]
    entries = sorted(entries or [], key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        return 'No changes recorded.'
    lines = [f'{len(entries)} most recent change{"s" if len(entries) != 1 else ""}'
             + (f' since {since}' if since else '') + (f' by "{user}"' if user else '') + ' (newest first):']
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        when = (e.get('time') or '')[:16].replace('T', ' ')
        ops = e.get('ops') or []
        kinds: Counter = Counter(o.get('type') for o in ops)
        what = e.get('message') or (ops[0].get('description') if len(ops) == 1 and ops else
                                    ', '.join(f'{n}× {k}' for k, n in kinds.most_common(4)))
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])[:3])
        lines.append(f'  {when}  {who}: {what}' + (f'  [{docs}]' if docs else '') + (f'  ({len(ops)} ops)' if len(ops) > 1 else ''))
    return _truncate('\n'.join(lines))


def t_plan_status(ws: Workspace) -> str:
    if not ws.ops:
        return 'The plan is empty.'
    lines = [f'{len(ws.ops)} planned change{"s" if len(ws.ops) != 1 else ""} (nothing written yet):']
    lines.extend(f'  {i + 1}. {op["label"]}' for i, op in enumerate(ws.ops[:200]))
    if len(ws.ops) > 200:
        lines.append(f'  ... {len(ws.ops) - 200} more')
    return '\n'.join(lines)


# --- write tools (plan only) ---------------------------------------------------

FLEX_MORPH_TYPES = ['stem', 'bound stem', 'root', 'bound root', 'prefix', 'suffix', 'infix', 'circumfix',
                    'simulfix', 'suprafix', 'infixing interfix', 'prefixing interfix', 'suffixing interfix',
                    'clitic', 'enclitic', 'proclitic', 'particle', 'phrase', 'discontiguous phrase']


def morph_type(t: str) -> str:
    """The editor's controlled morph-type vocabulary (FLEx's inventory)."""
    k = (t or '').strip().lower()
    if k in FLEX_MORPH_TYPES:
        return k
    raise ToolError(f'Unknown morph type "{t}". Types: ' + ', '.join(FLEX_MORPH_TYPES))


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
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        obj = _need(resolve(doc, ref), kind, ref)
        old = obj.fields.get(f.name)
        if (old.value if old else '') == value:
            continue
        what = obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)
        staged.append(span_op(doc, ref, what, f, obj.id, old, value))
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def span_op(doc, ref: str, what: str, f, token_id: str, old, value: str) -> Dict[str, Any]:
    """A set_span op with its human label. ``old`` is the current Span or None."""
    return {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': token_id,
            'span_id': old.id if old else None, 'value': value,
            'label': f'{doc.name} {ref} "{what[:40]}": {f.name} '
                     + (f'"{old.value}" → "{value}"' if old and old.value != '' else f'= "{value}"')
                     + (' (cleared)' if value == '' else '')}


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
        if m.get('type'):
            m = {**m, 'type': morph_type(m['type'])}
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
    had_values = sum(1 for m in w.morphemes for sp in m.fields.values() if sp.value != '')
    ws.add_op({'kind': 'set_analysis', 'word_id': w.id, 'text_id': w.text_id, 'begin': w.begin, 'end': w.end,
               'morpheme_layer_id': ws.project.morpheme_layer_id, 'existing': existing, 'morphemes': out,
               'label': f'{doc.name} {ref} "{w.surface}": ' + (f'{segmentation(w)} → ' if w.morphemes else '')
                        + desc + (', ' + ', '.join(gloss_bits) if gloss_bits else '')
                        + (f' (replaces {had_values} existing morpheme value{"s" if had_values != 1 else ""})' if had_values else '')})
    return ws.planned_note(1) + note


def t_set_orthography(ws: Workspace, document: str, refs, orthography: str, value: str) -> str:
    o = ws.project.orthography(orthography)
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        w = _need(resolve(doc, ref), Word, ref)
        old = w.orthographies.get(o, '')
        if old == (value or ''):
            continue
        staged.append({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{o}', 'value': value or '',
                       'label': f'{doc.name} {ref} "{w.surface}": {o} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def has_own_form(m: Morpheme) -> bool:
    """A morpheme whose form is stored (not derived from the word's surface)."""
    return (m.metadata or {}).get('form') not in (None, '')


def morpheme_form_op(doc, ref: str, w: Word, m: Morpheme, new: str) -> Dict[str, Any]:
    return {'kind': 'set_morpheme_form', 'morpheme_id': m.id, 'form': new,
            'label': f'{doc.name} {ref}.m{m.index} (in "{w.surface}"): morpheme form "{m.form}" → "{new}"'}


def t_respell(ws: Workspace, document: str, ref: str, new_text: str, morpheme_forms: bool = True) -> str:
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    new_text = (new_text or '').strip()
    if not new_text:
        raise ToolError('new_text must not be empty (there is no delete-word tool)')
    if new_text == w.surface:
        return ws.planned_note(0)
    check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{doc.name} {ref}')
    staged = [{'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new_text,
               'label': f'{doc.name} {ref}: respell "{w.surface}" → "{new_text}"'}]
    # A single-morpheme own form spelt like the word follows it; a longer
    # chain cannot be re-derived from a whole-word replacement.
    kept = []
    for m in w.morphemes:
        if not has_own_form(m):
            continue
        if morpheme_forms and m.form == w.surface:
            staged.append(morpheme_form_op(doc, ref, w, m, new_text))
        else:
            kept.append(m.form)
    ws.add_ops(staged)
    note = ws.planned_note(len(staged))
    if kept:
        note += (f' Morpheme forms {", ".join(kept)} are kept as they are; use set_analysis to respell them, '
                 'or respell_all with a pattern to carry the change into morpheme forms.')
    return note


def check_respell_overlap(ws: Workspace, text_id: str, begin: int, end: int, where: str) -> None:
    """A respell may repeat an already planned range (last wins) but never
    overlap a different one: the server applies text edits sequentially and
    overlapping ranges would corrupt the text."""
    for b, e in ws.planned_respells(text_id):
        if (b, e) != (begin, end) and b < end and begin < e:
            raise ToolError(f'{where}: overlaps a respelling already planned for {b}-{e} in the same text; '
                            f'discard_plan or narrow the pattern')
    for op in ws.ops:
        if op.get('kind') == 'edit_text' and op.get('text_id') == text_id and op['begin'] < end:
            raise ToolError(f'{where}: a sentence before or at this point is retyped or appended in this plan; '
                            'respell it in a separate plan')


def t_link_entry(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                 lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                 entry_gloss: Optional[str] = None) -> str:
    doc = ws.doc(document)
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            raise ToolError(f'{ref}: link words (sN.wN) or morphemes (sN.wN.mN), not sentences')
        if kind == 'existing' and obj.link and obj.link.item_id == target['id']:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        staged.append({'kind': 'link', 'token_id': obj.id,
                       'item_id': target['id'] if kind == 'existing' else None,
                       'new_entry_key': target if kind == 'new' else None,
                       'existing_link_id': obj.link.id if obj.link else None,
                       'label': f'{doc.name} {ref} "{what}": link ' + (f'"{obj.link.form}" → ' if obj.link else '') + f'"{form}"'})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def t_unlink_entry(ws: Workspace, document: str, refs) -> str:
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence) or not obj.link:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        staged.append({'kind': 'unlink', 'link_id': obj.link.id, 'token_id_hint': obj.id,
                       'label': f'{doc.name} {ref} "{what}": unlink "{obj.link.form}"'})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def t_create_entry(ws: Workspace, form: str, lexicon: Optional[str] = None, fields: Optional[dict] = None,
                   type: Optional[str] = None) -> str:
    form = (form or '').strip()
    if not form:
        raise ToolError('form must not be empty')
    v = ws.project.vocab(lexicon)
    metadata = {lexicon_field(v, k): ('' if val is None else str(val)) for k, val in (fields or {}).items()}
    if type:
        metadata['morphType'] = morph_type(type)
    key = f'new:{v["id"]}:{form}#{len(ws.new_entries) + 1}'
    ws.new_entries[key] = {'form': form, 'vocab_id': v['id'], 'metadata': metadata}
    ws.add_op({'kind': 'create_entry', 'vocab_id': v['id'], 'form': form, 'metadata': metadata, 'key': key,
               'label': f'{v["name"]}: new entry ' + entry_line({'form': form, 'metadata': metadata})})
    return ws.planned_note(1) + f'\nentry_id: {key}  (use it to link this entry in the same plan)'


def lexicon_field(vocab: dict, name: str) -> str:
    """A lexicon's configured entry field, by case-insensitive name; any name
    when the lexicon declares no schema. morphType is always allowed."""
    fields = vocab.get('fields') or []
    if not fields or name == 'morphType':
        return name
    for f in fields:
        if f.lower() == (name or '').lower():
            return f
    raise ToolError(f'"{vocab["name"]}" has no entry field "{name}". Fields: ' + ', '.join(fields))


def t_set_entry_field(ws: Workspace, field: str, value: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                      entry_gloss: Optional[str] = None) -> str:
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    vocab = next((v for v in ws.project.vocabs if v['id'] == (ws.new_entries[target]['vocab_id'] if kind == 'new' else target.get('layer'))), None)
    if vocab:
        field = lexicon_field(vocab, field)
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


def t_set_document_metadata(ws: Workspace, document: str, field: str, value: str) -> str:
    names = ws.project.document_metadata
    name = next((n for n in names if n.lower() == (field or '').lower()), None)
    if not name:
        raise ToolError(f'No document metadata field "{field}". Fields: ' + (', '.join(names) or '(none configured)'))
    doc = ws.doc(document)
    old = doc.metadata.get(name, '')
    value = '' if value is None else str(value)
    if (old or '') == value:
        return ws.planned_note(0)
    ws.add_op({'kind': 'set_doc_metadata', 'document_id': doc.id, 'field': name, 'value': value,
               'label': f'{doc.name}: {name} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    return ws.planned_note(1)


def t_create_document(ws: Workspace, name: str, text: str, metadata: Optional[dict] = None) -> str:
    """PLAN: a new document from raw text. One sentence per line; words are
    split on whitespace and punctuation the way the editor's tokenizer does."""
    name = (name or '').strip()
    if not name:
        raise ToolError('name must not be empty')
    if any((d.get('name') or '').casefold() == name.casefold() for d in ws.documents()):
        raise ToolError(f'A document named "{name}" already exists.')
    text = (text or '').replace('\r\n', '\n')
    if not text.strip():
        raise ToolError('text must not be empty')
    meta = {}
    for k, v in (metadata or {}).items():
        n = next((x for x in ws.project.document_metadata if x.lower() == k.lower()), None)
        if not n:
            raise ToolError(f'No document metadata field "{k}". Fields: ' + (', '.join(ws.project.document_metadata) or '(none)'))
        meta[n] = '' if v is None else str(v)
    sents = split_sentences(text)
    words = sum(len(split_words(text, b, e, ws.project.ignored_cfg)) for b, e in sents)
    ws.add_op({'kind': 'create_document', 'name': name, 'text': text, 'metadata': meta,
               'label': f'New document "{name}": {len(sents)} sentence{"s" if len(sents) != 1 else ""}, {words} words'})
    return ws.planned_note(1) + f' ({len(sents)} sentences, {words} words will be tokenized.)'


def _is_machine(meta) -> bool:
    return prov_state(meta) == MACHINE


def _machine_pieces(obj, f=None, into=None) -> Dict[str, list]:
    """Ids of the machine-made, unconfirmed pieces of a sentence, word, or
    morpheme (a sentence includes its words): spans (only field ``f`` when
    given), links and token metadata (only when no field is named)."""
    out = into if into is not None else {'span_ids': [], 'token_ids': [], 'link_ids': []}
    for name, sp in obj.fields.items():
        if (f is None or name == f.name) and _is_machine(sp.metadata):
            out['span_ids'].append(sp.id)
    if isinstance(obj, Sentence):
        if f is None or f.scope != 'Sentence':
            for w in obj.words:
                _machine_pieces(w, f, out)
        return out
    if f is None:
        if obj.link and _is_machine(obj.link.metadata):
            out['link_ids'].append(obj.link.id)
        if _is_machine(obj.metadata):
            out['token_ids'].append(obj.id)
    if isinstance(obj, Word):
        for m in obj.morphemes:
            _machine_pieces(m, f, out)
    return out


def _pieces_label(pieces: Dict[str, list]) -> str:
    bits = []
    for key, noun in (('span_ids', 'value'), ('link_ids', 'link'), ('token_ids', 'segmentation')):
        n = len(pieces[key])
        if n:
            bits.append(f'{n} {noun}{"s" if n != 1 else ""}')
    return ', '.join(bits)


def _what(obj) -> str:
    return obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)


def t_confirm(ws: Workspace, document: str, refs=None, field: Optional[str] = None) -> str:
    """PLAN: mark machine-made annotations as verified, after checking them."""
    doc = ws.doc(document)
    f = ws.project.field(field) if field else None
    staged: List[Dict[str, Any]] = []
    refs = _refs(refs)
    if refs:
        for ref in refs:
            obj = resolve(doc, ref)
            pieces = _machine_pieces(obj, f)
            if not any(pieces.values()):
                continue
            staged.append({'kind': 'confirm', **pieces,
                           'label': f'{doc.name} {ref} "{_what(obj)[:40]}": confirm {_pieces_label(pieces)}'
                                    + (f' ({f.name})' if f else '')})
    else:
        pieces = {'span_ids': [], 'token_ids': [], 'link_ids': []}
        for s in doc.sentences:
            _machine_pieces(s, f, pieces)
        if any(pieces.values()):
            staged.append({'kind': 'confirm', **pieces,
                           'label': f'{doc.name}: confirm {_pieces_label(pieces)}' + (f' ({f.name})' if f else '')})
    ws.add_ops(staged)
    n = sum(len(v) for op in staged for k, v in op.items() if k.endswith('_ids'))
    if not staged:
        return 'Nothing to confirm: no machine-made, unconfirmed annotations there.'
    return ws.planned_note(len(staged)) + f' ({n} annotation{"s" if n != 1 else ""} will be marked verified.)'


def t_discard_analysis(ws: Workspace, document: str, refs) -> str:
    """PLAN: delete a word's unverified machine-made analysis (the editor's
    discard gesture): its machine links, values, and morphemes go; human and
    verified pieces stay."""
    doc = ws.doc(document)
    words: List[tuple] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            words.extend((f'{ref}.{w.ref}', w) for w in obj.words)
        elif isinstance(obj, Word):
            words.append((ref, obj))
        else:
            raise ToolError(f'{ref}: discard_analysis works on words (sN.wN), not single morphemes')
    staged: List[Dict[str, Any]] = []
    for ref, w in words:
        link_ids, span_ids, morpheme_ids = [], [], []
        reset_first = None

        def attached(t):
            if t.link and _is_machine(t.link.metadata):
                link_ids.append(t.link.id)
            span_ids.extend(sp.id for sp in t.fields.values() if _is_machine(sp.metadata))
        attached(w)
        survivors = []
        for i, m in enumerate(w.morphemes):
            if _is_machine(m.metadata) and i > 0:
                morpheme_ids.append(m.id)  # spans and links cascade with the token
                continue
            survivors.append(m)
            attached(m)
            if _is_machine(m.metadata):
                reset_first = m.id
        renumber = [{'id': m.id, 'precedence': i + 1} for i, m in enumerate(survivors) if m.index != i + 1]
        if not (link_ids or span_ids or morpheme_ids or reset_first):
            continue
        bits = _pieces_label({'span_ids': span_ids, 'link_ids': link_ids, 'token_ids': []})
        if morpheme_ids or reset_first:
            bits = (bits + ', ' if bits else '') + 'the segmentation'
        staged.append({'kind': 'discard_analysis', 'word_id': w.id, 'link_ids': link_ids, 'span_ids': span_ids,
                       'morpheme_ids': morpheme_ids, 'reset_first_id': reset_first, 'renumber': renumber,
                       'label': f'{doc.name} {ref} "{w.surface}": discard unverified {bits}'})
    ws.add_ops(staged)
    if not staged:
        return 'Nothing to discard: no machine-made, unconfirmed analysis there.'
    return ws.planned_note(len(staged))


def t_discard_plan(ws: Workspace) -> str:
    n = len(ws.ops)
    ws.ops.clear()
    ws.new_entries.clear()
    return f'Discarded {n} planned change{"s" if n != 1 else ""}.'


def t_drop_planned(ws: Workspace, indexes) -> str:
    """Drop some planned changes by their plan_status numbers, keeping the rest."""
    if isinstance(indexes, (int, str)):
        indexes = [indexes]
    try:
        wanted = {int(i) for i in (indexes or [])}
    except (TypeError, ValueError):
        raise ToolError('indexes must be the numbers shown by plan_status, e.g. [2, 5]')
    bad = sorted(i for i in wanted if not 1 <= i <= len(ws.ops))
    if bad:
        raise ToolError(f'No planned change number {", ".join(map(str, bad))}; the plan holds {len(ws.ops)} (see plan_status)')
    if not wanted:
        raise ToolError('Give at least one number.')
    dropped = [ws.ops[i - 1] for i in sorted(wanted)]
    # A dropped new entry takes the links to it along: they could not be written.
    keys = {op['key'] for op in dropped if op.get('kind') == 'create_entry'}
    for k in keys:
        ws.new_entries.pop(k, None)
    ws.ops = [op for i, op in enumerate(ws.ops, start=1)
              if i not in wanted and not (op.get('kind') == 'link' and op.get('new_entry_key') in keys)]
    return f'Dropped {len(dropped)} planned change{"s" if len(dropped) != 1 else ""}.' + \
        (' Links to the dropped new entries were dropped with them.' if keys else '') + '\n' + t_plan_status(ws)


# --- schema + dispatch ----------------------------------------------------------

def _fn(name, description, properties, required):
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_GLOSS = {'type': 'string', 'description': 'Singles out one of several entries with the same form: a value one of '
                                           'its fields has (e.g. its gloss).'}
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
        'document unless one is named. (For items LACKING a value use worklist; for aligned context use concordance.)',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"baseline" (word forms, default), "morpheme" (morpheme forms), '
                                                    '"lexicon" (entries), or a field name (e.g. "Gloss", "Translation").'},
         'document': _DOC,
         'regex': {'type': 'boolean', 'description': 'Treat pattern as a regular expression.'},
         'limit': {'type': 'integer', 'description': 'Max hits to return (default 40, max 200).'}},
        ['pattern']),
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
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. REPLACES the word\'s whole chain: every existing '
        'morpheme field value on it, human-made ones included, is dropped. To change one morpheme\'s value keep the '
        'chain and use set_field with sN.wN.mN. Types: stem, root, prefix, suffix, infix, enclitic, proclitic, ...',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}},
        ['document', 'ref', 'morphemes']),
    _fn('set_orthography',
        'PLAN: set an orthography value (an alternative transcription tier, not the baseline) on words.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the BASELINE spelling of one word (its analysis, glosses, and links are kept; a lone '
        'morpheme form spelt like the word follows it unless morpheme_forms=false). For an alternative '
        'transcription tier use set_orthography.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'}, 'new_text': {'type': 'string'},
         'morpheme_forms': {'type': 'boolean'}},
        ['document', 'ref', 'new_text']),
    _fn('link_entry',
        'PLAN: link words or morphemes to a lexicon entry, by the entry\'s form ("ама", or "ама#2" for homograph 2), '
        'or entry_id (also the id returned by create_entry). Replaces an existing link.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
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
         'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['field', 'value']),
    _fn('concordance',
        'Every occurrence of a morpheme form (default), word form, or field value (whole-form match, case-insensitive; '
        'regex=true for partial matches), with aligned context: the '
        'word\'s segmentation and morpheme glosses with the hit in [brackets], the neighbouring words, and a '
        'tally of the distinct word patterns the hit appears in. Use this for morphotactic and distributional '
        'questions (what precedes/follows X, does X vary by context) instead of reading whole documents.',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"morpheme" (default), "baseline" (word forms), or a Word/Morpheme field name.'},
         'document': _DOC, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer', 'description': 'Max occurrences to list (default 60); the pattern tally always covers all.'}},
        ['pattern']),
    _fn('analyses_of',
        'How a form has been analyzed so far, as a word (segmentation, glosses, links) and as a morpheme (type, '
        'glosses, link, position in the word): each distinct analysis with its count and example references. '
        'Check this before proposing an analysis, and follow the majority unless there is reason not to.',
        {'form': {'type': 'string'}, 'document': _DOC}, ['form']),
    _fn('lexicon_entry',
        'One lexicon entry in full: all its fields, how many words and morphemes link to it, and example occurrences.',
        {'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
         'entry_gloss': _GLOSS, 'examples': {'type': 'integer', 'description': 'Example occurrences to show (default 3).'}},
        []),
    _fn('check_consistency',
        'A consistency report for a field: values that are case/spelling variants of one another, forms that carry '
        'several different values, and items annotated but not linked to the lexicon (or linked but empty).',
        {'field': {'type': 'string'}, 'document': _DOC}, ['field']),
    _fn('recent_changes',
        'The newest entries of the change history: who changed what and when, including plans this assistant applied.',
        {'document': _DOC, 'limit': {'type': 'integer', 'description': 'Entries to show (default 20, max 100).'},
         'since': {'type': 'string', 'description': 'Only changes at or after this date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Only changes by this person (name or email substring).'}}, []),
    _fn('plan_status', 'List the changes planned so far in this turn.', {}, []),
    _fn('set_document_metadata',
        'PLAN: set one of the project\'s document metadata fields (see project_overview) on a document.',
        {'document': _DOC, 'field': {'type': 'string'}, 'value': {'type': 'string'}}, ['document', 'field', 'value']),
    _fn('create_document',
        'PLAN: create a new document from raw text, one sentence per line; words are tokenized like the editor does. '
        'metadata maps document metadata field names to values.',
        {'name': {'type': 'string'}, 'text': {'type': 'string'},
         'metadata': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
        ['name', 'text']),
    _fn('discard_plan', 'Drop every change planned so far in this turn.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their plan_status numbers; the rest stay.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
    _fn('confirm',
        'PLAN: mark machine-made annotations (from other services or earlier assistant plans; see worklist '
        'kind="unverified") as verified, after checking them. refs: sentences, words, or morphemes (a sentence '
        'covers its words); field: only that field\'s values; neither: the whole document.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}}, ['document']),
    _fn('discard_analysis',
        'PLAN: delete the unverified machine-made analysis of words (their machine links, values, and morphemes); '
        'human-made and verified pieces stay. refs: words or sentences.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
    'concordance': t_concordance, 'analyses_of': t_analyses_of, 'lexicon_entry': t_lexicon_entry,
    'check_consistency': t_check_consistency, 'recent_changes': t_recent_changes, 'plan_status': t_plan_status,
    'set_document_metadata': t_set_document_metadata, 'create_document': t_create_document,
    'confirm': t_confirm, 'discard_analysis': t_discard_analysis, 'drop_planned': t_drop_planned,
}

WRITE_TOOLS = {'set_field', 'set_analysis', 'set_orthography', 'respell', 'link_entry', 'unlink_entry',
               'create_entry', 'set_entry_field', 'set_document_metadata', 'create_document', 'confirm',
               'discard_analysis'}


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool; every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    try:
        return _truncate(fn(ws, **(args or {})))
    except (ToolError, ValueError) as e:  # ValueError: a name/reference lookup failed, message is for the model
        return f'Error: {e}'
    except (TypeError, AttributeError) as e:
        return f'Error: an argument has the wrong type ({e}); check the tool\'s parameter types'
    except Exception as e:  # noqa: BLE001 - the model gets the failure as text; the log gets the trace
        import traceback
        traceback.print_exc()
        return f'Error: {type(e).__name__}: {e}'


# --- corpus-wide reads and bulk plan tools live in their own modules --------------
from .stats import (t_corpus_stats, t_frequency_list, t_worklist, t_check_lexicon,  # noqa: E402
                    t_check_integrity, t_sequence_search)
from .bulk import (t_replace_in_field, t_respell_all, t_copy_to_orthography, t_set_analysis_for_form,  # noqa: E402
                   t_set_field_for_form, t_merge_entries, t_delete_entry, t_rename_entry, t_rename_document)

_ENTRY = {'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
          'entry_gloss': _GLOSS}

TOOLS += [
    _fn('corpus_stats',
        'Totals and coverage: documents, sentences, words, distinct forms, hapax, type/token ratio, morphemes, the '
        'share of words analysed and linked, and every field\'s fill rate. by="document" gives a per-document '
        'table (with metadata columns); by=<metadata field> (e.g. "Genre") breaks the corpus down by that field.',
        {'document': _DOC, 'by': {'type': 'string'}}, []),
    _fn('frequency_list',
        'Ranked counts with document dispersion for wordforms (default), morpheme forms, or a field\'s values.',
        {'what': {'type': 'string', 'description': '"wordform" (default), "morpheme", or a field name.'},
         'document': _DOC, 'limit': {'type': 'integer', 'description': 'Rows (default 100, max 1000).'},
         'min_count': {'type': 'integer'}}, []),
    _fn('worklist',
        'The unfinished work, grouped by form and ordered by frequency: kind="unlinked" (no lexicon link), '
        '"unglossed" (no value in `field`, default the first morpheme field), "unanalyzed" (no analysis at all), or '
        '"unverified" (machine-made annotations nobody confirmed). Use this to decide what to do next.',
        {'kind': {'type': 'string', 'enum': ['unlinked', 'unglossed', 'unanalyzed', 'unverified']},
         'field': {'type': 'string'},
         'level': {'type': 'string', 'enum': ['word', 'morpheme'], 'description': 'For unlinked: which level to list (default morpheme when there is a morpheme layer). For unglossed the field\'s scope decides.'},
         'document': _DOC, 'limit': {'type': 'integer'}}, []),
    _fn('check_lexicon',
        'Lexicon hygiene report, worst first with counts. section: "unused" (entries never linked), "fields" (missing '
        'gloss/pos), "homographs" (same form; groups with the same gloss first), "near" (forms one character apart), '
        '"glosses" (lexicon gloss disagrees with the corpus), "spread" (one corpus gloss over several entries), '
        '"stale" (link form no longer contains the entry form), "single" (attested in one document), or "all" (default, '
        'each section capped).',
        {'lexicon': {'type': 'string'}, 'section': {'type': 'string'}}, []),
    _fn('check_integrity',
        'Data-shape report: segmentations that do not add up to the word, duplicate and empty sentences, non-NFC '
        'text, mixed apostrophe characters, and unusual characters in the baseline.',
        {'document': _DOC}, []),
    _fn('sequence_search',
        'Sentences containing a sequence of words, each described by conditions on its form, morphemes, morph type, '
        'or field values, e.g. [{"POS":"v"},{"POS":"n"}] or [{"Gloss":"ERG"},{"form":"ava"}]; conditions match whole '
        'values (regex=true for patterns). adjacent=false lets other words come between, in order. Counts are '
        'sentences (first match per sentence). For constituent-order and construction questions.',
        {'sequence': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
         'adjacent': {'type': 'boolean'}, 'document': _DOC, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer'}}, ['sequence']),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of a field, project-wide or in one document: substring by default, '
        'whole_value=true for exact values, regex=true for patterns with backreferences (\\1). field="morpheme form" '
        'rewrites stored morpheme forms instead of a field. One call plans every change; the plan lists each.',
        {'field': {'type': 'string'}, 'pattern': {'type': 'string'}, 'replacement': {'type': 'string'},
         'regex': {'type': 'boolean'}, 'whole_value': {'type': 'boolean'}, 'document': _DOC},
        ['field', 'pattern', 'replacement']),
    _fn('respell_all',
        'PLAN: change the baseline spelling of every word matching a pattern (an orthography change), keeping each '
        'word\'s analysis, glosses, and links. The same replacement is carried into the stored morpheme forms of '
        'those words (morpheme_forms=false to leave them) and into lexicon headwords (lexicon=false to leave them; '
        'the pattern is applied to every entry, not only linked ones). Patterns apply within words only.',
        {'pattern': {'type': 'string'}, 'replacement': {'type': 'string'}, 'regex': {'type': 'boolean'},
         'whole_word': {'type': 'boolean'}, 'document': _DOC, 'morpheme_forms': {'type': 'boolean'},
         'lexicon': {'type': 'boolean'}}, ['pattern', 'replacement']),
    _fn('copy_to_orthography',
        'PLAN: fill an orthography for every word that lacks a value, from the baseline or another orthography.',
        {'orthography': {'type': 'string'}, 'source': {'type': 'string'}, 'document': _DOC,
         'overwrite': {'type': 'boolean'}}, ['orthography']),
    _fn('set_field_for_form',
        'PLAN: set a field value on every occurrence of a form: a morpheme form for a morpheme field, a word form for '
        'a word field (e.g. Gloss (Morpheme) = "OBL" on every morpheme "ди"). only_empty=true (default) fills gaps '
        'and leaves existing values alone; false overwrites them.',
        {'form': {'type': 'string'}, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'only_empty': {'type': 'boolean'}, 'document': _DOC}, ['form', 'field', 'value']),
    _fn('set_analysis_for_form',
        'PLAN: apply one analysis (same shape as set_analysis\'s morphemes) to every occurrence of a word form; '
        'skip_analyzed=true leaves already-analysed words alone.',
        {'form': {'type': 'string'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}},
         'document': _DOC, 'skip_analyzed': {'type': 'boolean'}}, ['form', 'morphemes']),
    _fn('merge_entries',
        'PLAN: fold one lexicon entry into another (links move to the kept entry, the other is deleted).',
        {'keep_form': {'type': 'string'}, 'remove_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'keep_id': {'type': 'string'}, 'remove_id': {'type': 'string'},
         'keep_gloss': _GLOSS, 'remove_gloss': _GLOSS}, []),
    _fn('delete_entry', 'PLAN: delete a lexicon entry and its links; the words and morphemes stay, unlinked.',
        _ENTRY, []),
    _fn('rename_entry', 'PLAN: change a lexicon entry\'s headword form.',
        {'new_form': {'type': 'string'}, **_ENTRY}, ['new_form']),
    _fn('rename_document', 'PLAN: rename a document.',
        {'document': _DOC, 'new_name': {'type': 'string'}}, ['document', 'new_name']),
]
_IMPL.update({
    'corpus_stats': t_corpus_stats, 'frequency_list': t_frequency_list, 'worklist': t_worklist,
    'check_lexicon': t_check_lexicon, 'check_integrity': t_check_integrity, 'sequence_search': t_sequence_search,
    'replace_in_field': t_replace_in_field, 'respell_all': t_respell_all, 'copy_to_orthography': t_copy_to_orthography,
    'set_analysis_for_form': t_set_analysis_for_form, 'set_field_for_form': t_set_field_for_form, 'merge_entries': t_merge_entries, 'delete_entry': t_delete_entry,
    'rename_entry': t_rename_entry, 'rename_document': t_rename_document,
})
WRITE_TOOLS |= {'replace_in_field', 'respell_all', 'copy_to_orthography', 'set_analysis_for_form', 'set_field_for_form', 'merge_entries',
                'delete_entry', 'rename_entry', 'rename_document'}

from .shape import (t_split_word, t_merge_words, t_delete_word, t_split_sentence,  # noqa: E402
                    t_merge_sentences, t_append_text, t_retype_sentence)

TOOLS += [
    _fn('split_word',
        'PLAN: split one word token into two. at: the left part ("Ali") or the number of characters in it. The '
        'word\'s morpheme analysis is deleted (re-analyse both parts after); its values and link stay on the left part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'at': {'type': 'string', 'description': 'The left part, or its length.'}}, ['document', 'ref', 'at']),
    _fn('merge_words',
        'PLAN: merge adjacent words of one sentence into one token. Their morpheme analyses are deleted; word '
        'values are combined losslessly (distinct values joined with " | "); one lexicon link is kept.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('delete_word',
        'PLAN: delete word tokens. The text is unchanged (use respell to change spelling); the words\' analyses, '
        'values, and links go with them.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('split_sentence',
        'PLAN: split a sentence so that word before_word starts a new sentence. Words and their analyses are '
        'untouched; sentence values (translation) stay with the first part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'},
         'before_word': {'type': 'integer', 'description': 'Number of the word that starts the new sentence (2 or more).'}},
        ['document', 'ref', 'before_word']),
    _fn('merge_sentences',
        'PLAN: merge a sentence into the one before it. Sentence values are combined losslessly.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The later sentence, sN (N ≥ 2).'}},
        ['document', 'ref']),
    _fn('append_text',
        'PLAN: add text at the end of a document, one sentence per line, tokenized into words like the editor.',
        {'document': _DOC, 'text': {'type': 'string'}}, ['document', 'text']),
    _fn('retype_sentence',
        'PLAN: replace the baseline text of one sentence (fix a transcript: insert, remove, or respell words). '
        'Unchanged words keep their analyses; changed text is re-tokenized without analysis; the sentence\'s '
        'own fields stay. Newlines in the new text split it into several sentences.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'}, 'text': {'type': 'string'}},
        ['document', 'ref', 'text']),
]
_IMPL.update({'split_word': t_split_word, 'merge_words': t_merge_words, 'delete_word': t_delete_word,
              'split_sentence': t_split_sentence, 'merge_sentences': t_merge_sentences,
              'append_text': t_append_text, 'retype_sentence': t_retype_sentence})
WRITE_TOOLS |= {'split_word', 'merge_words', 'delete_word', 'split_sentence', 'merge_sentences', 'append_text',
                'retype_sentence'}

from .query import t_query, t_query_help  # noqa: E402

TOOLS += [
    _fn('query_help',
        'The reference for the query language used by `query`, plus the layer names of this project. Call it once '
        'before writing a query; it is long, so only when the other tools cannot express the question.',
        {}, []),
    _fn('query',
        'Run a read-only query in Plaid\'s query language over this project (structure across layers, joins, '
        'negation, aggregates). Name layers by their names from query_help. Prefer the specialised tools when they '
        'fit; this is the escape hatch for questions they cannot express.',
        {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, order_by.'},
         'limit': {'type': 'integer', 'description': 'Rows to show (default 50, max 500).'}},
        ['query']),
]
_IMPL.update({'query_help': t_query_help, 'query': t_query})
