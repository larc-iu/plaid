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

from .project import (IgtProject, IgtDoc, Sentence, Word, Morpheme, load_document, resolve,
                      render_document, render_overview, render_sentence, render_word,
                      segmentation, joiner, word_ref)

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
        if k in ('morphType',) or k.startswith('prov') or k.startswith('flex') or v in (None, '', [], {}):
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


def _is_break_char(c: str, cfg) -> bool:
    """Does this character end a word (mirrors shouldTokenizeCharacter)?
    Unicode punctuation, or any ASCII symbol, unless whitelisted; or, under a
    blacklist config, exactly the listed characters."""
    cat = unicodedata.category(c)
    punct = cat.startswith('P') or (ord(c) < 128 and cat.startswith('S'))
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
        key = pattern.casefold()
        match = lambda s: (s or '').casefold() == key  # noqa: E731
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
                    key = seg if hit is None else f'{seg}' + (f'  {glosses}' if glosses else '')
                    patterns[key] += 1
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
                    entry_id: Optional[str] = None, examples: int = 3) -> str:
    """One lexicon entry in full: every field, where it is linked (words vs
    morphemes, how many), and example occurrences."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id)
    if kind == 'new':
        e = ws.new_entries[target]
        return f'Entry "{e["form"]}" is new in this plan (not written yet): ' + entry_line({'form': e['form'], 'metadata': e['metadata']})
    meta = target.get('metadata') or {}
    lines = [f'Entry "{target.get("form")}" (id {target["id"]})']
    for k, v in meta.items():
        if k.startswith('prov') or k.startswith('flex') or v in (None, '', [], {}):
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
        if ws.project.vocabs:
            lines.append(f'{unlinked_n} annotated but not linked to the lexicon'
                         + (': ' + '; '.join(unlinked) + (' …' if unlinked_n > len(unlinked) else '') if unlinked else '.'))
            lines.append(f'{linked_empty_n} linked but with no {f.name} value'
                         + (': ' + '; '.join(linked_empty) + (' …' if linked_empty_n > len(linked_empty) else '') if linked_empty else '.'))
    return _truncate('\n'.join(lines))


def t_recent_changes(ws: Workspace, document: Optional[str] = None, limit: int = 20) -> str:
    """The newest entries of the audit log: who changed what, when, under
    which operation label (the assistant's own applied plans included)."""
    limit = max(1, min(int(limit or 20), 100))
    ws.on_progress('Reading the change history…')
    if document:
        did = ws.resolve_document_id(document)
        entries = ws.client.documents.audit(did)
    else:
        entries = ws.client.projects.audit(ws.project.id)
    entries = sorted(entries or [], key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        return 'No changes recorded.'
    lines = [f'{len(entries)} most recent change{"s" if len(entries) != 1 else ""} (newest first):']
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
    if any((d.get('name') or '') == name for d in ws.documents()):
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
         'examples': {'type': 'integer', 'description': 'Example occurrences to show (default 3).'}},
        []),
    _fn('check_consistency',
        'A consistency report for a field: values that are case/spelling variants of one another, forms that carry '
        'several different values, and items annotated but not linked to the lexicon (or linked but empty).',
        {'field': {'type': 'string'}, 'document': _DOC}, ['field']),
    _fn('recent_changes',
        'The newest entries of the change history: who changed what and when, including plans this assistant applied.',
        {'document': _DOC, 'limit': {'type': 'integer', 'description': 'Entries to show (default 20, max 100).'}}, []),
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
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'field_values': t_field_values, 'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
    'concordance': t_concordance, 'analyses_of': t_analyses_of, 'lexicon_entry': t_lexicon_entry,
    'check_consistency': t_check_consistency, 'recent_changes': t_recent_changes, 'plan_status': t_plan_status,
    'set_document_metadata': t_set_document_metadata, 'create_document': t_create_document,
}

WRITE_TOOLS = {'set_field', 'set_analysis', 'set_orthography', 'respell', 'link_entry', 'unlink_entry',
               'create_entry', 'set_entry_field', 'set_document_metadata', 'create_document'}


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
