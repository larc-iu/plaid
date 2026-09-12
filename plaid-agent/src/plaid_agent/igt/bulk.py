"""Plan-only tools that compute their targets corpus-wide, so a project-wide
edit is one call instead of a loop over references: field replace, respell,
orthography copy, apply-analysis-everywhere, and the lexicon / document
operations (merge, delete, rename). Everything lands in the turn's plan and
is applied only after approval."""

import re
from typing import Any, Dict, List, Optional

from .project import word_ref
from .tools import (Workspace, ToolError, t_set_analysis, entry_line, check_respell_overlap, span_op,
                    has_own_form, morpheme_form_op, parse_analysis, analysis_op, _meta_patch,
                    _refuse_doomed, _refuse_removing_survivor)
from .vocab import plan_delete_refs, plan_merge_refs, ref_ids
from .stats import _analyzed, _docs

MAX_BULK = 3000


def _replacer(pattern: str, replacement: str, regex: bool, whole_value: bool, case_sensitive: bool = False):
    """Case-insensitive by default, like search, so what search found is what
    the replacement hits. Regex replacement errors (bad backreferences) are
    reported on the first value rather than crashing mid-plan."""
    if not pattern:
        raise ToolError('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        rx = re.compile(pattern if regex else re.escape(pattern), flags)
    except re.error as e:
        raise ToolError(f'Bad regex: {e}')
    if whole_value:
        return lambda v: replacement if rx.fullmatch(v) else v

    def sub(v):
        try:
            return rx.sub(replacement, v)
        except re.error as e:
            raise ToolError(f'Bad replacement: {e}')
    return sub


def _bulk_note(ws: Workspace, n: int, labels: List[str], what: str) -> str:
    if not n:
        return f'Nothing to change: no {what} matched.'
    head = ws.planned_note(n)
    return head + '\n  ' + '\n  '.join(labels[:8]) + (f'\n  … {n - 8} more (plan_status lists them all)' if n > 8 else '')


def _check_cap(n: int):
    if n > MAX_BULK:
        raise ToolError(f'That would change {n} items, more than the {MAX_BULK} one plan may hold. '
                        f'Narrow it (a document, a stricter pattern) and go in passes.')


def t_replace_in_field(ws: Workspace, field: str, pattern: str, replacement: str, regex: bool = False,
                       whole_value: bool = False, document: Optional[str] = None,
                       case_sensitive: bool = False) -> str:
    """PLAN: substitute inside every EXISTING value of a field (substring,
    whole value, or regex with backreferences), project-wide or in one
    document. Empty cells are not filled: use set_field_for_form for that.
    ``field`` may also name the stored morpheme forms (Bulk Edit's morpheme
    domain) when no field is so named."""
    rep = _replacer(pattern, replacement, bool(regex), bool(whole_value), bool(case_sensitive))
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
    if not ws.use_scan(document) and not _names_morpheme_forms(ws, field):
        from .corpus import q_replace_in_field
        f = ws.project.field(field)
        staged = q_replace_in_field(ws, f, rep, MAX_BULK)
        _check_cap(len(staged))
        ws.add_ops(staged)
        return _bulk_note(ws, len(staged), [op['label'] for op in staged], f'{f.name} values')
    if _names_morpheme_forms(ws, field):
        for doc in _docs(ws, document):
            for s in doc.sentences:
                for w in s.words:
                    for m in w.morphemes:
                        if not has_own_form(m):
                            continue  # a derived form is the word's surface: respell_all's job
                        new = rep(m.form)
                        if new == m.form:
                            continue
                        if not new.strip():
                            raise ToolError(f'{ws.doc_label(doc.id)} {word_ref(s, w)}.m{m.index}: "{m.form}" would become empty')
                        op = morpheme_form_op(ws, doc, word_ref(s, w), w, m, new)
                        staged.append(op)
                        labels.append(op['label'])
        _check_cap(len(staged))
        ws.add_ops(staged)
        return _bulk_note(ws, len(labels), labels, 'morpheme forms')
    f = ws.project.field(field)
    for doc in _docs(ws, document):
        for s in doc.sentences:
            if f.scope == 'Sentence':
                units = [(s, f's{s.index}', s.text)]
            elif f.scope == 'Word':
                units = [(w, word_ref(s, w), w.surface) for w in s.words]
            else:
                units = [(m, f'{word_ref(s, w)}.m{m.index}', m.form) for w in s.words for m in w.morphemes]
            for u, ref, what in units:
                sp = u.fields.get(f.name)
                cur = ws.planned_span_value(f.layer_id, u.id, sp.value if sp else '')
                if cur == '':
                    continue
                new = rep(cur)
                if new == cur:
                    continue
                label = f'{ws.doc_label(doc.id)} {ref} "{what[:30]}": {f.name} "{cur}" → "{new}"' + (' (cleared)' if new == '' else '')
                staged.append({'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': u.id,
                               'span_id': sp.id if sp else None, 'value': new, 'label': label})
                labels.append(label)
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(labels), labels, f'{f.name} values')


def _names_morpheme_forms(ws: Workspace, field: str) -> bool:
    """Whether ``field`` addresses the stored morpheme forms rather than a
    field: one of a few spellings, and no field literally so named."""
    name = (field or '').strip().casefold()
    if name not in ('morpheme form', 'morpheme forms', 'morph form', 'form', 'forms', 'morpheme'):
        return False
    return not any(f.name.casefold() == name for f in ws.project.fields.values())


def t_respell_all(ws: Workspace, pattern: str, replacement: str, regex: bool = False,
                  whole_word: bool = False, document: Optional[str] = None,
                  case_sensitive: bool = False, morpheme_forms: bool = True, lexicon: bool = True) -> str:
    """PLAN: change the baseline spelling of every word matching a pattern
    (orthography migration). Each word is replaced whole, so its analysis,
    glosses, and links survive. Patterns apply within a word, never across
    word boundaries. As in the editor's Bulk Edit, the replacement is carried
    into the stored morpheme forms of the respelled words and into every
    lexicon headword it matches, unless switched off."""
    rep = _replacer(pattern, replacement, bool(regex), bool(whole_word), bool(case_sensitive))
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
    n_words = n_morphs = n_entries = 0
    if not ws.use_scan(document):
        from .corpus import q_respell_all, rx
        staged, n_words, n_morphs = q_respell_all(ws, rep, rx(pattern, regex=bool(regex), whole=bool(whole_word),
                                                              case_sensitive=bool(case_sensitive)), bool(morpheme_forms), MAX_BULK)
        labels = [op['label'] for op in staged]
    for doc in (_docs(ws, document) if ws.use_scan(document) else []):
        for s in doc.sentences:
            for w in s.words:
                new = rep(w.surface)
                if new == w.surface:
                    continue
                if not new.strip():
                    raise ToolError(f'{ws.doc_label(doc.id)} {word_ref(s, w)}: "{w.surface}" would become empty; '
                                    'a respelling cannot remove a word (retype_sentence can)')
                check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{ws.doc_label(doc.id)} {word_ref(s, w)}')
                label = f'{ws.doc_label(doc.id)} {word_ref(s, w)}: respell "{w.surface}" → "{new}"'
                staged.append({'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new,
                               'label': label})
                labels.append(label)
                n_words += 1
                if not morpheme_forms:
                    continue
                for m in w.morphemes:
                    if not has_own_form(m):
                        continue
                    nm = rep(m.form)
                    if nm == m.form or not nm.strip():
                        continue
                    op = morpheme_form_op(ws, doc, word_ref(s, w), w, m, nm)
                    staged.append(op)
                    labels.append(op['label'])
                    n_morphs += 1
    if lexicon:
        for v in ws.project.vocabs:
            # The plan's own view, so a respelling does not rename an entry a
            # merge or a delete earlier in the same plan takes away.
            for it in ws.view(v).items:
                old = it.get('form') or ''
                new = rep(old)
                if new == old or not new.strip():
                    continue
                label = f'{v["name"]}: rename entry "{old}" → "{new}"'
                staged.append({'kind': 'rename_entry', 'item_id': it['id'], 'form': new, 'label': label})
                labels.append(label)
                n_entries += 1
    _check_cap(len(staged))
    ws.add_ops(staged)
    out = _bulk_note(ws, len(labels), labels, 'words')
    if labels:
        out += (f'\n({n_words} words, {n_morphs} morpheme forms, {n_entries} lexicon headwords.)')
    return out


def t_copy_to_orthography(ws: Workspace, orthography: str, source: str = 'baseline',
                          document: Optional[str] = None, overwrite: bool = False) -> str:
    """PLAN: fill an orthography from the baseline (or another orthography)
    for every word lacking a value (or all words with overwrite=true), as a
    starting point for a transcription tier."""
    target = ws.project.orthography(orthography)
    src = None if (source or 'baseline').lower() == 'baseline' else ws.project.orthography(source)
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
    if not ws.use_scan(document):
        from .corpus import q_copy_to_orthography
        staged = q_copy_to_orthography(ws, target, src, bool(overwrite), MAX_BULK)
        labels = [op['label'] for op in staged]
    for doc in (_docs(ws, document) if ws.use_scan(document) else []):
        for s in doc.sentences:
            for w in s.words:
                cur = w.orthographies.get(target, '')
                if cur and not overwrite:
                    continue
                value = w.surface if src is None else w.orthographies.get(src, '')
                if not value or value == cur:
                    continue
                label = f'{ws.doc_label(doc.id)} {word_ref(s, w)} "{w.surface}": {target} = "{value}"'
                staged.append({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{target}', 'value': value, 'label': label})
                labels.append(label)
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(labels), labels, 'words')


def t_set_field_for_form(ws: Workspace, form: str, field: str, value: str, only_empty: bool = True,
                         document: Optional[str] = None) -> str:
    """PLAN: one field value on every occurrence of a form (morpheme form for
    a morpheme field, word form for a word field)."""
    f = ws.project.field(field)
    if f.scope == 'Sentence':
        raise ToolError(f'"{f.name}" is a sentence field; use set_field with sentence references')
    key = (form or '').strip().casefold()
    if not key:
        raise ToolError('Give a form.')
    value = '' if value is None else str(value)
    staged: List[Dict[str, Any]] = []
    if not ws.use_scan(document):
        from .corpus import q_set_field_for_form
        staged = q_set_field_for_form(ws, form, f, value, bool(only_empty), MAX_BULK)
    for doc in (_docs(ws, document) if ws.use_scan(document) else []):
        for s in doc.sentences:
            for w in s.words:
                if f.scope == 'Word':
                    units = [(w, word_ref(s, w), w.surface)] if w.surface.casefold() == key else []
                else:
                    units = [(m, f'{word_ref(s, w)}.m{m.index}', m.form) for m in w.morphemes if m.form.casefold() == key]
                for u, ref, what in units:
                    old = u.fields.get(f.name)
                    cur = ws.planned_span_value(f.layer_id, u.id, old.value if old else '')
                    if cur == value or (only_empty and cur != ''):
                        continue
                    staged.append(span_op(ws, doc, ref, what, f, u.id, old, value))
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(staged), [op['label'] for op in staged], f'occurrences of "{form}"'
                      + (' without a value' if only_empty else ''))


def t_set_analysis_for_form(ws: Workspace, form: str, morphemes: list, document: Optional[str] = None,
                            skip_analyzed: bool = False) -> str:
    """PLAN: apply one analysis (segmentation + morpheme fields) to every
    occurrence of a word form. With skip_analyzed=true, words that already
    have an analysis are left alone."""
    key = (form or '').strip().casefold()
    if not key:
        raise ToolError('Give a form.')
    if not ws.use_scan(document):
        return _set_analysis_for_form_q(ws, form, morphemes, bool(skip_analyzed))
    targets = []
    for doc in _docs(ws, document):
        for s in doc.sentences:
            for w in s.words:
                if w.surface.casefold() != key:
                    continue
                if skip_analyzed and _analyzed(w):
                    continue
                targets.append((doc, s, w))
    _check_cap(len(targets))
    # Plan into a scratch workspace view so a failure part-way leaves nothing
    # behind, then adopt the ops in one go.
    saved = ws.ops
    ws.ops = []
    first_note = ''
    try:
        for doc, s, w in targets:
            note = t_set_analysis(ws, doc.id, word_ref(s, w), morphemes)
            if not first_note and 'differ from the surface' in note:
                first_note = note[note.index('(note'):]
        staged = ws.ops
    finally:
        ws.ops = saved
    ws.add_ops(staged)
    labels = [op['label'] for op in staged]
    return _bulk_note(ws, len(staged), labels, f'occurrences of "{form}"') + (' ' + first_note if first_note else '')


def _set_analysis_for_form_q(ws: Workspace, form: str, morphemes: list, skip_analyzed: bool) -> str:
    """The query path: word occurrences and their morpheme chains by query,
    then one set_analysis op per word."""
    from .corpus import q_analysis_targets, _docs_of
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.')
    out = parse_analysis(ws, morphemes)
    words, chains, spans = q_analysis_targets(ws, form, skip_analyzed, MAX_BULK)
    _check_cap(len(words))
    budget = _docs_of([[w] for w in words])
    staged = []
    first_note = ''
    for w in words:
        chain = sorted(chains.get(w['id']) or [], key=lambda m: (m.get('precedence') or 0, m.get('id')))
        existing = [{'id': m['id'], 'span_ids': spans.get(m['id']) or []} for m in chain]
        seg = '-'.join(((m.get('metadata') or {}).get('form') or m.get('value') or '') for m in chain) if chain else ''
        had_values = sum(len(spans.get(m['id']) or []) for m in chain)
        head = ws.corpus.label_ref(w['document'], w['id'], budget) + f' "{w.get("value") or ""}"'
        op, note = analysis_op(ws, head, w.get('value') or '', w['id'], w['text'], w['begin'], w['end'],
                               existing, seg, had_values, out)
        op['doc'] = w['document']
        staged.append(op)
        if not first_note and note:
            first_note = note.strip()
    ws.add_ops(staged)
    return _bulk_note(ws, len(staged), [op['label'] for op in staged], f'occurrences of "{form}"') + (' ' + first_note if first_note else '')


# --- lexicon and document operations ----------------------------------------------

def _existing(ws: Workspace, form, lexicon, entry_id, gloss=None, what: str = 'be changed') -> dict:
    kind, target = ws.find_entry(form, lexicon, entry_id, gloss)
    if kind == 'new':
        raise ToolError('That entry is new in this plan; approve the plan first, then merge or rename it.')
    _refuse_doomed(ws, target, what)
    return target


def links_to_in(doc, item_id: str) -> List[Dict[str, Any]]:
    """[{link_id, token_ids}] for an entry's links in one parsed document:
    words' own links, multi-word expressions (once each, with every member),
    and morpheme links."""
    out: List[Dict[str, Any]] = []
    seen = set()
    for s in doc.sentences:
        for w in s.words:
            for l in [w.link] + list(w.mwes) + [m.link for m in w.morphemes]:
                if l and l.item_id == item_id and l.id not in seen:
                    seen.add(l.id)
                    out.append({'link_id': l.id, 'token_ids': list(l.tokens)})
    return out


def _links_to(ws: Workspace, item_id: str) -> List[Dict[str, Any]]:
    if not ws.prefer_scan:
        from .corpus import q_entry_links
        return q_entry_links(ws, item_id)
    out = []
    for doc in ws.all_docs():
        out.extend(links_to_in(doc, item_id))
    return out


def _ref_repair_ops(ws: Workspace, view, planner, *args) -> List[Dict[str, Any]]:
    """The metadata changes a delete or a merge drags behind it inside the
    lexicon: an entry's senses are freed or moved to the survivor, and a
    reference field naming it is cleared or repointed. The app does exactly
    this in the same operation (planDeleteRefs / planMergeRefs), and without it
    the vocabulary is left holding ids that no longer resolve until a
    maintainer next opens it and the load-time repair throws the structure away.
    """
    if view is None:
        return []
    ops = []
    for patch in planner(view.items, view.fields, *args):
        item = view.tree.by_id.get(patch['id'])
        if item is None:
            continue
        before = ws.item_patches.get(patch['id'], item.get('metadata') or {})
        after = patch['metadata']
        if before == after:
            continue
        ws.patch_item(patch['id'], after)
        ops.append({'kind': 'set_entry_metadata', 'item_id': patch['id'],
                    'patch': _meta_patch(before, after),
                    'label': f'entry {view.label(patch["id"])}: ' + _repair_says(before, after, view)})
    return ops


def _repair_says(before: dict, after: dict, view) -> str:
    """What one repair does, for the line the user approves."""
    bits = []
    if before.get('parent') and not after.get('parent'):
        bits.append('becomes a headword of its own')
    elif before.get('parent') != after.get('parent') and after.get('parent'):
        bits.append(f'becomes a sense of {view.label(after["parent"])}')
    for f in view.ref_fields:
        if before.get(f['name']) != after.get(f['name']):
            kept = ref_ids({'metadata': after}, f)
            bits.append(f'{f["name"]} ' + (', '.join(view.label(x) for x in kept) if kept else 'cleared'))
    return '; '.join(bits) or 'reference updated'



def _name(view, it: dict) -> str:
    """An entry the way a tool takes it back ("gam#2", "kwatha#1.2"), with its
    gloss beside it so a reader knows which it is; the bare form when the
    lexicon has no view to number it by."""
    if view is None:
        return entry_line(it)
    gloss = (it.get('metadata') or {}).get('gloss')
    return view.label(it['id']) + (f' ({gloss})' if isinstance(gloss, str) and gloss else '')

def t_merge_entries(ws: Workspace, keep_form: Optional[str] = None, remove_form: Optional[str] = None,
                    lexicon: Optional[str] = None, keep_id: Optional[str] = None,
                    remove_id: Optional[str] = None, keep_gloss: Optional[str] = None,
                    remove_gloss: Optional[str] = None) -> str:
    """PLAN: fold one lexicon entry into another: every link to the removed
    entry is moved to the kept one, then the removed entry is deleted. The
    kept entry's fields are untouched."""
    keep = _existing(ws, keep_form, lexicon, keep_id, keep_gloss, 'be merged into')
    remove = _existing(ws, remove_form, lexicon, remove_id, remove_gloss, 'be merged away')
    if keep['id'] == remove['id']:
        raise ToolError('keep and remove are the same entry')
    # Merges do not chain: this one's links are the ones the entry holds now,
    # so folding the survivor of an earlier merge into a third entry would
    # leave the links that earlier merge moved on an entry being deleted.
    _refuse_removing_survivor(ws, remove, 'be merged away')
    links = _links_to(ws, remove['id'])
    view = ws.view_of_item(remove['id'])
    # Named the way a tool takes them back, so two entries spelled alike
    # (the very pair a merge is for) read apart on the card.
    ws.add_op({'kind': 'merge_entries', 'keep_id': keep['id'], 'remove_id': remove['id'], 'links': links,
               'label': f'Merge entry {_name(view, remove)} into {_name(view, keep)}: '
                        f'move {len(links)} link{"s" if len(links) != 1 else ""}, delete the former'})
    refs = _ref_repair_ops(ws, view, plan_merge_refs, keep['id'], [remove['id']])
    ws.add_ops(refs)
    note = ws.planned_note(1 + len(refs)) + f' {len(links)} link(s) will move.'
    return note + (f' {len(refs)} entr{"y" if len(refs) == 1 else "ies"} repointed at the survivor.' if refs else '')


def t_delete_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                   entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: delete a lexicon entry and its links (the words and morphemes
    stay, just unlinked)."""
    it = _existing(ws, entry_form, lexicon, entry_id, entry_gloss, 'be deleted')
    _refuse_removing_survivor(ws, it, 'be deleted')
    links = _links_to(ws, it['id'])
    view = ws.view_of_item(it['id'])
    ws.add_op({'kind': 'delete_entry', 'item_id': it['id'], 'links': [l['link_id'] for l in links],
               'label': f'Delete entry {_name(view, it)} '
                        f'({len(links)} link{"s" if len(links) != 1 else ""} removed)'})
    refs = _ref_repair_ops(ws, view, plan_delete_refs, [it['id']])
    ws.add_ops(refs)
    note = ws.planned_note(1 + len(refs)) + f' {len(links)} link(s) would be removed.'
    return note + (f' {len(refs)} entr{"y" if len(refs) == 1 else "ies"} freed or cleared.' if refs else '')


def t_rename_entry(ws: Workspace, new_form: str, entry_form: Optional[str] = None,
                   lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                   entry_gloss: Optional[str] = None) -> str:
    """PLAN: change an entry's headword form (links are unaffected)."""
    new_form = (new_form or '').strip()
    if not new_form:
        raise ToolError('new_form must not be empty')
    it = _existing(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renamed')
    if it.get('form') == new_form:
        return ws.planned_note(0)
    view = ws.view_of_item(it['id'])
    ws.add_op({'kind': 'rename_entry', 'item_id': it['id'], 'form': new_form,
               'label': f'Rename entry {_name(view, it)} → "{new_form}"'})
    return ws.planned_note(1)


def t_rename_document(ws: Workspace, document: str, new_name: str) -> str:
    """PLAN: rename a document."""
    new_name = (new_name or '').strip()
    if not new_name:
        raise ToolError('new_name must not be empty')
    doc = ws.doc(document)
    if doc.name == new_name:
        return ws.planned_note(0)
    clash = [d for d in ws.documents() if d['id'] != doc.id and (d.get('name') or '').casefold() == new_name.casefold()]
    if clash:
        raise ToolError(f'Another document is already named "{new_name}"; two documents with one name can only be '
                        'told apart by id. Pick a different name.')
    ws.add_op({'kind': 'rename_document', 'document_id': doc.id, 'name': new_name,
               'label': f'Rename document {ws.doc_label(doc.id, quote=True)} → "{new_name}"'})
    return ws.planned_note(1)
