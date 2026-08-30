"""Plan-only tools that compute their targets corpus-wide, so a project-wide
edit is one call instead of a loop over references: field replace, respell,
orthography copy, apply-analysis-everywhere, and the lexicon / document
operations (merge, delete, rename). Everything lands in the turn's plan and
is applied only after approval."""

import re
from typing import Any, Dict, List, Optional

from .project import Word, Sentence, Morpheme, segmentation, word_ref
from .tools import Workspace, ToolError, t_set_analysis, entry_line, check_respell_overlap
from .stats import _analyzed, _docs, _tag

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
    document. Empty cells are not filled: use set_field_for_form for that."""
    f = ws.project.field(field)
    rep = _replacer(pattern, replacement, bool(regex), bool(whole_value), bool(case_sensitive))
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
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
                label = f'{doc.name} {ref} "{what[:30]}": {f.name} "{cur}" → "{new}"' + (' (cleared)' if new == '' else '')
                staged.append({'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': u.id,
                               'span_id': sp.id if sp else None, 'value': new, 'label': label})
                labels.append(label)
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(labels), labels, f'{f.name} values')


def t_respell_all(ws: Workspace, pattern: str, replacement: str, regex: bool = False,
                  whole_word: bool = False, document: Optional[str] = None,
                  case_sensitive: bool = False) -> str:
    """PLAN: change the baseline spelling of every word matching a pattern
    (orthography migration). Each word is replaced whole, so its analysis,
    glosses, and links survive. Patterns apply within a word, never across
    word boundaries."""
    rep = _replacer(pattern, replacement, bool(regex), bool(whole_word), bool(case_sensitive))
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
    for doc in _docs(ws, document):
        for s in doc.sentences:
            for w in s.words:
                new = rep(w.surface)
                if new == w.surface:
                    continue
                if not new.strip():
                    raise ToolError(f'{doc.name} {word_ref(s, w)}: "{w.surface}" would become empty; there is no delete-word tool')
                check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{doc.name} {word_ref(s, w)}')
                label = f'{doc.name} {word_ref(s, w)}: respell "{w.surface}" → "{new}"'
                staged.append({'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new,
                               'label': label})
                labels.append(label)
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(labels), labels, 'words')


def t_copy_to_orthography(ws: Workspace, orthography: str, source: str = 'baseline',
                          document: Optional[str] = None, overwrite: bool = False) -> str:
    """PLAN: fill an orthography from the baseline (or another orthography)
    for every word lacking a value (or all words with overwrite=true), as a
    starting point for a transcription tier."""
    target = ws.project.orthography(orthography)
    src = None if (source or 'baseline').lower() == 'baseline' else ws.project.orthography(source)
    labels: List[str] = []
    staged: List[Dict[str, Any]] = []
    for doc in _docs(ws, document):
        for s in doc.sentences:
            for w in s.words:
                cur = w.orthographies.get(target, '')
                if cur and not overwrite:
                    continue
                value = w.surface if src is None else w.orthographies.get(src, '')
                if not value or value == cur:
                    continue
                label = f'{doc.name} {word_ref(s, w)} "{w.surface}": {target} = "{value}"'
                staged.append({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{target}', 'value': value, 'label': label})
                labels.append(label)
    _check_cap(len(staged))
    ws.add_ops(staged)
    return _bulk_note(ws, len(labels), labels, 'words')


def t_set_analysis_for_form(ws: Workspace, form: str, morphemes: list, document: Optional[str] = None,
                            skip_analyzed: bool = False) -> str:
    """PLAN: apply one analysis (segmentation + morpheme fields) to every
    occurrence of a word form. With skip_analyzed=true, words that already
    have an analysis are left alone."""
    key = (form or '').strip().casefold()
    if not key:
        raise ToolError('Give a form.')
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


# --- lexicon and document operations ----------------------------------------------

def _existing(ws: Workspace, form, lexicon, entry_id) -> dict:
    kind, target = ws.find_entry(form, lexicon, entry_id)
    if kind == 'new':
        raise ToolError('That entry is new in this plan; approve the plan first, then merge or rename it.')
    return target


def _links_to(ws: Workspace, item_id: str) -> List[Dict[str, str]]:
    out = []
    for doc in ws.all_docs():
        for s in doc.sentences:
            for w in s.words:
                if w.link and w.link.item_id == item_id:
                    out.append({'link_id': w.link.id, 'token_id': w.id})
                for m in w.morphemes:
                    if m.link and m.link.item_id == item_id:
                        out.append({'link_id': m.link.id, 'token_id': m.id})
    return out


def t_merge_entries(ws: Workspace, keep_form: Optional[str] = None, remove_form: Optional[str] = None,
                    lexicon: Optional[str] = None, keep_id: Optional[str] = None,
                    remove_id: Optional[str] = None) -> str:
    """PLAN: fold one lexicon entry into another: every link to the removed
    entry is moved to the kept one, then the removed entry is deleted. The
    kept entry's fields are untouched."""
    keep = _existing(ws, keep_form, lexicon, keep_id)
    remove = _existing(ws, remove_form, lexicon, remove_id)
    if keep['id'] == remove['id']:
        raise ToolError('keep and remove are the same entry')
    doomed = {op.get('remove_id') for op in ws.ops if op.get('kind') == 'merge_entries'} | \
        {op.get('item_id') for op in ws.ops if op.get('kind') == 'delete_entry'}
    if keep['id'] in doomed:
        raise ToolError(f'"{keep.get("form")}" is already being merged away or deleted in this plan; merge into the surviving entry instead')
    if remove['id'] in doomed:
        raise ToolError(f'"{remove.get("form")}" is already being merged away or deleted in this plan')
    links = _links_to(ws, remove['id'])
    ws.add_op({'kind': 'merge_entries', 'keep_id': keep['id'], 'remove_id': remove['id'], 'links': links,
               'label': f'Merge entry {entry_line(remove)} into {entry_line(keep)}: move {len(links)} link{"s" if len(links) != 1 else ""}, delete the former'})
    return ws.planned_note(1) + f' {len(links)} link(s) will move.'


def t_delete_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                   entry_id: Optional[str] = None) -> str:
    """PLAN: delete a lexicon entry and its links (the words and morphemes
    stay, just unlinked)."""
    it = _existing(ws, entry_form, lexicon, entry_id)
    links = _links_to(ws, it['id'])
    ws.add_op({'kind': 'delete_entry', 'item_id': it['id'], 'links': [l['link_id'] for l in links],
               'label': f'Delete entry {entry_line(it)} ({len(links)} link{"s" if len(links) != 1 else ""} removed)'})
    return ws.planned_note(1) + f' {len(links)} link(s) would be removed.'


def t_rename_entry(ws: Workspace, new_form: str, entry_form: Optional[str] = None,
                   lexicon: Optional[str] = None, entry_id: Optional[str] = None) -> str:
    """PLAN: change an entry's headword form (links are unaffected)."""
    new_form = (new_form or '').strip()
    if not new_form:
        raise ToolError('new_form must not be empty')
    it = _existing(ws, entry_form, lexicon, entry_id)
    if it.get('form') == new_form:
        return ws.planned_note(0)
    ws.add_op({'kind': 'rename_entry', 'item_id': it['id'], 'form': new_form,
               'label': f'Rename entry "{it.get("form")}" → "{new_form}"'})
    return ws.planned_note(1)


def t_rename_document(ws: Workspace, document: str, new_name: str) -> str:
    """PLAN: rename a document."""
    new_name = (new_name or '').strip()
    if not new_name:
        raise ToolError('new_name must not be empty')
    doc = ws.doc(document)
    if doc.name == new_name:
        return ws.planned_note(0)
    ws.add_op({'kind': 'rename_document', 'document_id': doc.id, 'name': new_name,
               'label': f'Rename document "{doc.name}" → "{new_name}"'})
    return ws.planned_note(1)
