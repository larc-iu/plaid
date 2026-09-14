"""The plan tools that annotate: field values, analyses, spellings, lexicon
links, confirmations, comments, and a document restore.

A tool here writes nothing. It resolves what the model named against the
workspace and appends operations to the plan (see :mod:`.plan`), which the
service returns with the turn for the user to approve. The refusals a plan
owes itself live with the workspace and with the registry; the ones that are
about interlinear text (a word cannot be reshaped and re-analysed at once, a
respelling cannot overlap another) live here.
"""

import re
from typing import Any, Dict, List, Optional

from plaid_client.provenance import prov_state, MACHINE

from ..core import opkind
from ..core.args import clamp_limit, whole
from ..core.limits import READ_LIMITS
from ..core.tools import ToolError, truncate

from .plan import ANALYSIS, KIND, TEXT_SHAPE, WORD_SHAPE, reshaped_subjects
from .project import (IgtDoc, Sentence, Word, Morpheme, Link, resolve, mwe_ref, REVIEWABLE,
                      segmentation, split_sentences, split_words, word_ref)
from .lexview import morph_type
from .reads import t_plan_status
from .workspace import Workspace, _need, _refs, _sentence_of, _words_of


# --- write tools (plan only) ---------------------------------------------------

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
        staged.append(span_op(ws, doc, ref, what, f, obj.id, old, value))
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def span_op(ws: Workspace, doc, ref: str, what: str, f, token_id: str, old, value: str) -> Dict[str, Any]:
    """A set_span op with its human label. ``old`` is the current Span or None."""
    return {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': token_id,
            'span_id': old.id if old else None, 'value': value,
            'label': f'{ws.doc_label(doc.id)} {ref} "{what[:40]}": {f.name} '
                     + (f'"{old.value}" → "{value}"' if old and old.value != '' else f'= "{value}"')
                     + (' (cleared)' if value == '' else '')}


MAX_ANALYSES_PER_CALL = 200


def t_set_analysis(ws: Workspace, document: str, ref: Optional[str] = None, morphemes: Optional[list] = None,
                   analyses: Optional[list] = None) -> str:
    """PLAN: one word's analysis (``ref`` + ``morphemes``), or several words'
    at once (``analyses``: a list of {ref, morphemes}), so a whole sentence
    is one call. Staged together: a bad item leaves nothing planned."""
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.')
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    items = list(analyses or [])
    if ref or morphemes:
        items.insert(0, {'ref': ref, 'morphemes': morphemes})
    if not items:
        raise ToolError('Give ref and morphemes, or analyses (a list of {ref, morphemes}).')
    if len(items) > MAX_ANALYSES_PER_CALL:
        raise ToolError(f'At most {MAX_ANALYSES_PER_CALL} analyses per call; split the list.')
    staged: List[Dict[str, Any]] = []
    notes: List[str] = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not item.get('ref'):
            raise ToolError('each analysis needs a ref (sN.wN) and morphemes')
        r = str(item['ref']).strip()
        w = _need(resolve(doc, r), Word, r)
        if w.id in seen:
            raise ToolError(f'{r} is analysed twice in one call')
        seen.add(w.id)
        refuse_shape_and_analysis(ws, w.id, r, analysing=True)
        out = parse_analysis(ws, item.get('morphemes'))
        existing = [{'id': m.id, 'span_ids': [sp.id for sp in m.fields.values()]} for m in w.morphemes]
        had_values = sum(1 for m in w.morphemes for sp in m.fields.values() if sp.value != '')
        op, note = analysis_op(ws, f'{ws.doc_label(doc.id)} {r} "{w.surface}"', w.surface, w.id, w.text_id, w.begin,
                               w.end, existing, segmentation(w) if w.morphemes else '', had_values, out)
        staged.append(op)
        if note:
            notes.append(f'{r}{note}' if len(items) > 1 else note)
    ws.add_ops(staged)
    return ws.planned_note(len(staged)) + (' ' + ' '.join(notes) if notes else '')


# A word's BOUNDARIES change (a split, a merge, a delete, a text edit over it)
# or its MORPHEME CHAIN does. Never both in one plan. Both sets are the
# registry's shape tags, so a new kind of either joins them by being declared.
_ANALYSIS_KINDS = opkind.shaped(KIND, ANALYSIS)


def _reshaped_words(ws: Workspace) -> set:
    """Words a planned op re-cuts: what a word-shape op splits, merges or
    deletes (the keys its kind declares), and what a text edit names as gone.
    The second set carries the edit's morphemes too, which no caller's word
    ids can collide with."""
    return reshaped_subjects(ws.ops, WORD_SHAPE) | _text_edit_names(ws)


def refuse_shape_and_analysis(ws: Workspace, word_id, ref: str, *, analysing: bool) -> None:
    """A word's boundaries and its morpheme chain cannot both change in one plan.

    A reshape deletes the word's morphemes by the ids it read before the plan
    ran, and an analysis op reuses the first of those ids and deletes the rest.
    So whichever goes second asks the server to delete a morpheme that is
    already gone, and the batch it shares fails atomically, after the user has
    approved the plan. The analysis also leaves a morpheme the reshape does not
    know about, for the server to cascade-split into nonsense, which is the
    very thing a reshape deletes them to prevent.
    """
    ids = {word_id} if isinstance(word_id, str) else set(word_id or ())
    if analysing:
        if ids & _reshaped_words(ws):
            raise ToolError(f'{ref} is split, merged, deleted or retyped in this plan, so its analysis cannot '
                            'also change: a boundary change deletes the word\'s morphemes. discard_plan to '
                            'start over, or plan the two in separate turns.')
    elif any(op.get('kind') in _ANALYSIS_KINDS and op.get('word_id') in ids for op in ws.ops):
        raise ToolError(f'{ref} has an analysis change in this plan, so its boundaries cannot also change: a '
                        'boundary change deletes the morphemes that analysis writes. discard_plan to start '
                        'over, or plan the two in separate turns.')


# A text edit names every word and morpheme of the region it rewrites, and
# the plan treats all of them as deleted. It is a GUESS: the edit goes through
# the server's diffing text update, so an unchanged word keeps its token and
# its analysis, and which words those are is not known until the edit runs.
_TEXT_SHAPE_KINDS = opkind.shaped(KIND, TEXT_SHAPE)


def _text_edit_names(ws: Workspace) -> set:
    """Words and morphemes a text edit in the plan names as deleted."""
    return opkind.removed_tokens(KIND, [op for op in ws.ops if op.get('kind') in _TEXT_SHAPE_KINDS])


def refuse_comment_and_text_edit(ws: Workspace, ids, where: str, *, commenting: bool) -> None:
    """A comment and a text edit over the word it is anchored to cannot share
    one plan.

    `normalize_ops` drops an op that names something the plan deletes, so the
    comment disappeared with a note after the user had approved a card
    promising it, in both orders. The edit's word ids are a guess and the
    word usually survives, but the plan cannot tell, and every other guard
    over a text edit treats those ids as deleted too
    (:func:`refuse_shape_and_analysis`). So the two are refused here, where
    the model can still put them in separate turns.
    """
    ids = {ids} if isinstance(ids, str) else set(ids or ())
    if commenting:
        clash = ids & _text_edit_names(ws)
    else:
        clash = ids & {op.get('entity_id') for op in ws.ops if op.get('kind') == 'add_comment'}
    if clash:
        raise ToolError(f'{where}: this plan rewrites the text over a word it also comments on, and the '
                        'rewrite may take the word the comment is anchored to. discard_plan to start over, '
                        'or plan the two in separate turns.')


def parse_analysis(ws: Workspace, morphemes: list) -> List[Dict[str, Any]]:
    """The validated morpheme list of a set_analysis call."""
    if not morphemes or not isinstance(morphemes, list):
        raise ToolError('morphemes must be a non-empty list of {form, type?, fields?}')
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
    return out


def analysis_op(ws: Workspace, head: str, surface: str, word_id: str, text_id: str, begin: int, end: int,
                existing: List[Dict[str, Any]], current_seg: str, had_values: int, out: List[Dict[str, Any]]):
    """A set_analysis op with its label, and the allomorphy note if the forms
    do not add up to the surface."""
    joined = ''.join(m['form'] for m in out)
    if joined.replace(' ', '') != surface.replace(' ', ''):
        note = f' (note: forms "{joined}" differ from the surface "{surface}"; that is allowed for allomorphy)'
    else:
        note = ''
    desc = '-'.join(m['form'] for m in out)
    gloss_bits = []
    for f in ws.project.fields_by_scope('Morpheme'):
        vals = [next((fv['value'] for fv in m['fields'] if fv['layer_id'] == f.layer_id), '_') for m in out]
        if any(v not in ('', '_') for v in vals):
            gloss_bits.append(f'{f.name} {"-".join(v or "_" for v in vals)}')
    op = {'kind': 'set_analysis', 'word_id': word_id, 'text_id': text_id, 'begin': begin, 'end': end,
          'morpheme_layer_id': ws.project.morpheme_layer_id, 'existing': existing, 'morphemes': out,
          'label': f'{head}: ' + (f'{current_seg} → ' if current_seg else '')
                   + desc + (', ' + ', '.join(gloss_bits) if gloss_bits else '')
                   + (f' (replaces {had_values} existing morpheme value{"s" if had_values != 1 else ""})' if had_values else '')}
    return op, note


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
                       'label': f'{ws.doc_label(doc.id)} {ref} "{w.surface}": {o} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def has_own_form(m: Morpheme) -> bool:
    """A morpheme whose form is stored (not derived from the word's surface)."""
    return (m.metadata or {}).get('form') not in (None, '')


def morpheme_form_op(ws: Workspace, doc, ref: str, w: Word, m: Morpheme, new: str) -> Dict[str, Any]:
    return {'kind': 'set_morpheme_form', 'morpheme_id': m.id, 'form': new,
            'label': f'{ws.doc_label(doc.id)} {ref}.m{m.index} (in "{w.surface}"): morpheme form "{m.form}" → "{new}"'}


def t_respell(ws: Workspace, document: str, ref: str, new_text: str, morpheme_forms: bool = True) -> str:
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    new_text = (new_text or '').strip()
    if not new_text:
        raise ToolError('new_text must not be empty (to remove a word from the text, retype_sentence without it; '
                        'delete_word removes only the token)')
    if new_text == w.surface:
        return ws.planned_note(0)
    check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{ws.doc_label(doc.id)} {ref}')
    staged = [{'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new_text,
               'label': f'{ws.doc_label(doc.id)} {ref}: respell "{w.surface}" → "{new_text}"'}]
    # A single-morpheme own form spelt like the word follows it. A longer
    # chain cannot be re-derived from a whole-word replacement.
    kept = []
    for m in w.morphemes:
        if not has_own_form(m):
            continue
        if morpheme_forms and m.form == w.surface:
            staged.append(morpheme_form_op(ws, doc, ref, w, m, new_text))
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
    no_scope_reaches(ws, next((d.id for d in ws._docs.values() if d.text_id == text_id), None), where)


def reshape_guards(ws: Workspace, doc, where: Optional[str] = None) -> None:
    """The refusals every tool that reshapes text or words owes, whichever
    tool stages it.

    Kept in one place because the hole they leave is invisible: four of the
    nine kinds plan.RESHAPES names reached a document without passing through
    here, so a sentence split or an analysis could join a plan holding a
    corpus-wide change that reaches the same document, and the two met for the
    first time inside the batch, after the user had approved it.
    """
    no_scope_reaches(ws, doc.id, where or ws.doc_label(doc.id))


def no_scope_reaches(ws: Workspace, doc_id: Optional[str], where: str) -> None:
    """A corpus-wide change stored as one op (bulk.scope_reaches) is resolved
    to words only at approval, so nothing that reshapes a document it reaches
    can share its plan: the two would meet for the first time in the batch."""
    from .bulk import scope_reaches
    if scope_reaches(ws, doc_id):
        raise ToolError(f'{where}: this plan already holds a corpus-wide change that reaches this document. '
                        'Apply it first, then plan this (plan_status, drop_planned).')


def t_link_entry(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                 lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                 entry_gloss: Optional[str] = None) -> str:
    doc = ws.doc(document)
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    staged: List[Dict[str, Any]] = []
    inside: List[str] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            raise ToolError(f'{ref}: link words (sN.wN) or morphemes (sN.wN.mN), not sentences')
        if _planned_phrase_over(ws, obj.id):
            raise ToolError(f'{ref} is part of a multi-word expression planned in this turn; a word keeps its own '
                            'link inside one, so drop that plan first if you meant to replace it')
        if kind == 'existing' and obj.link and obj.link.item_id == target['id']:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        if isinstance(obj, Word) and obj.mwes:
            inside.append(f'{ref} stays inside ' + ', '.join(f'"{l.form}"' for l in obj.mwes))
        staged.append({'kind': 'link', 'token_id': obj.id,
                       'item_id': target['id'] if kind == 'existing' else None,
                       'new_entry_key': target if kind == 'new' else None,
                       'existing_link_id': obj.link.id if obj.link else None,
                       'label': f'{ws.doc_label(doc.id)} {ref} "{what}": link ' + (f'"{obj.link.form}" → ' if obj.link else '') + f'"{form}"'})
    ws.add_ops(staged)
    note = ws.planned_note(len(staged))
    if inside:
        note += ' (' + '; '.join(inside) + ': a word\'s own link and a multi-word expression are separate; unlink_phrase removes the latter)'
    return note


def _planned_phrase_over(ws: Workspace, token_id: str) -> bool:
    return any(op.get('kind') == 'link_phrase' and token_id in (op.get('token_ids') or []) for op in ws.ops)


def _mwe_desc(l: Link, s: Sentence) -> str:
    return f'"{l.form}" ({mwe_ref(l, s.index)})'


def t_unlink_entry(ws: Workspace, document: str, refs) -> str:
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    only_mwe: List[str] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            continue
        if not obj.link:
            if isinstance(obj, Word) and obj.mwes:
                s = _sentence_of(doc, obj)
                only_mwe.append(f'{ref} has no link of its own; it is a member of the multi-word expression '
                                + ', '.join(_mwe_desc(l, s) for l in obj.mwes) + ' (unlink_phrase removes that)')
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        staged.append({'kind': 'unlink', 'link_id': obj.link.id, 'token_id_hint': obj.id,
                       'label': f'{ws.doc_label(doc.id)} {ref} "{what}": unlink "{obj.link.form}"'})
    if only_mwe and not staged:
        raise ToolError('; '.join(only_mwe))
    ws.add_ops(staged)
    return ws.planned_note(len(staged)) + (' ' + '; '.join(only_mwe) if only_mwe else '')


def t_link_phrase(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                  lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                  entry_gloss: Optional[str] = None) -> str:
    """PLAN: one lexicon link over two or more words (a multi-word
    expression), the editor's gather-and-link gesture. The words keep their
    own links; a multi-word expression already over exactly these words is
    replaced, any other one they belong to stays."""
    doc = ws.doc(document)
    words = _words_of(doc, refs)
    if len(words) < 2:
        raise ToolError('A multi-word expression needs two or more distinct words, e.g. ["s3.w2", "s3.w3"]')
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    token_ids = [w.id for _, _, w in words]
    existing = None
    for _, _, w in words:
        for l in w.mwes:
            if sorted(l.tokens) == sorted(token_ids):
                existing = l
    if existing is not None and kind == 'existing' and existing.item_id == target['id']:
        return ws.planned_note(0)
    s = words[0][1]
    surfaces = ' '.join(w.surface for _, _, w in words)
    where = '+'.join(f'w{w.index}' for _, _, w in words) if all(sn is s for _, sn, _ in words) \
        else '+'.join(word_ref(sn, w) for _, sn, w in words)
    # A planned unlink of the link being replaced would delete it twice.
    if existing is not None:
        before = len(ws.ops)
        ws.ops = [op for op in ws.ops if not (op.get('kind') == 'unlink' and op.get('link_id') == existing.id)]
        ws.replaced += before - len(ws.ops)
    ws.add_op({'kind': 'link_phrase', 'token_ids': token_ids,
               'item_id': target['id'] if kind == 'existing' else None,
               'new_entry_key': target if kind == 'new' else None,
               'existing_link_id': existing.id if existing is not None else None,
               'label': f'{ws.doc_label(doc.id)} s{s.index} {where} "{surfaces}": link phrase '
                        + (f'"{existing.form}" → ' if existing is not None else '') + f'"{form}"'})
    return ws.planned_note(1)


def t_unlink_phrase(ws: Workspace, document: str, refs) -> str:
    """PLAN: remove a multi-word expression (the link shared by its member
    words); the words' own links stay. Name any member, or several members
    where a word sits in more than one expression."""
    doc = ws.doc(document)
    words = _words_of(doc, refs)
    if not words:
        raise ToolError('Name at least one member word, e.g. ["s3.w2"]')
    named = {w.id for _, _, w in words}
    candidates: Dict[str, Link] = {}
    for _, _, w in words:
        for l in w.mwes:
            candidates[l.id] = l
    s = words[0][1]
    if not candidates:
        raise ToolError(', '.join(r for r, _, _ in words) + ' belong to no multi-word expression'
                        + (' (unlink_entry removes a word\'s own link)' if any(w.link for _, _, w in words) else ''))
    # Every named word must be a member. Among the expressions they name,
    # the one containing all of them wins, else ask.
    full = [l for l in candidates.values() if named <= set(l.tokens)]
    if len(full) != 1:
        raise ToolError('Several multi-word expressions include those words: '
                        + '; '.join(_mwe_desc(l, s) for l in candidates.values())
                        + '. Name a member set that belongs to just one of them.')
    l = full[0]
    ws.add_op({'kind': 'unlink', 'link_id': l.id, 'token_id_hint': l.tokens[0], 'token_ids': list(l.tokens),
               'label': f'{ws.doc_label(doc.id)} s{s.index} {mwe_ref(l, s.index)}: unlink phrase "{l.form}"'})
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
               'label': f'{ws.doc_label(doc.id)}: {name} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
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


def _needs_review(meta) -> bool:
    """Unconfirmed machine output, or a contributor's unreviewed work."""
    return prov_state(meta) in REVIEWABLE


PIECE_KEYS = ('span_ids', 'token_ids', 'link_ids')


def _empty_pieces() -> Dict[str, Any]:
    return {'span_ids': [], 'token_ids': [], 'link_ids': [], 'on': {}}


def _has_pieces(pieces) -> bool:
    return any(pieces[k] for k in PIECE_KEYS)


def _review_pieces(obj, f=None, into=None) -> Dict[str, list]:
    """Ids of the pieces of a sentence, word, or morpheme (a sentence includes
    its words) that await review: spans (only field ``f`` when given), links,
    multi-word expressions, and token metadata (only when no field is named).
    A multi-word expression is listed once however many members are seen."""
    out = into if into is not None else _empty_pieces()
    for name, sp in obj.fields.items():
        if (f is None or name == f.name) and _needs_review(sp.metadata):
            out['span_ids'].append(sp.id)
            # Which token carries it. A span on a token another op in the plan
            # deletes is gone without ever being named, and confirming it after
            # the delete fails the whole batch.
            out['on'][sp.id] = obj.id
    if isinstance(obj, Sentence):
        if f is None or f.scope != 'Sentence':
            for w in obj.words:
                _review_pieces(w, f, out)
        return out
    if f is None:
        if obj.link and _needs_review(obj.link.metadata):
            out['link_ids'].append(obj.link.id)
            out['on'][obj.link.id] = obj.id
        for l in getattr(obj, 'mwes', ()):
            if _needs_review(l.metadata) and l.id not in out['link_ids']:
                out['link_ids'].append(l.id)
        if _needs_review(obj.metadata):
            out['token_ids'].append(obj.id)
    if isinstance(obj, Word):
        for m in obj.morphemes:
            _review_pieces(m, f, out)
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


MAX_CONFIRM_DOCS = 100


def _document_confirm_op(ws: Workspace, doc: IgtDoc, f) -> Optional[Dict[str, Any]]:
    pieces = _empty_pieces()
    for s in doc.sentences:
        _review_pieces(s, f, pieces)
    if not _has_pieces(pieces):
        return None
    return {'kind': 'confirm', **pieces, 'doc': doc.id,
            'label': f'{ws.doc_label(doc.id)}: confirm {_pieces_label(pieces)}' + (f' ({f.name})' if f else '')}


def t_confirm(ws: Workspace, document: Optional[str] = None, refs=None, field: Optional[str] = None,
              documents=None) -> str:
    """PLAN: mark annotations awaiting review (machine-made and unconfirmed,
    or a contributor's) as verified, after checking them. `documents` names
    several, or "all" for every document with such material: a plan over
    the whole project is asked for in words, never staged by omission."""
    f = ws.project.field(field) if field else None
    staged: List[Dict[str, Any]] = []
    refs = _refs(refs)
    if refs and not document:
        raise ToolError('refs need a document')
    if isinstance(documents, list) and len(documents) == 1 and str(documents[0]).strip().lower() == 'all':
        documents = 'all'
    # Only the WORD "all" means the whole project. The branch below tested the
    # type alone, so documents="Text 3" staged a review of every document that
    # had anything waiting, which is the plan the explicit-all ruling exists to
    # stop being staged by accident. A bare name is one document, as in UD.
    if isinstance(documents, str) and documents.strip().lower() != 'all':
        documents = [documents]
    if not document and not documents:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'annotations awaiting review.')
    if not document:
        # The documents with reviewable spans or morphemes by query, then
        # each is read so links and multi-word expressions count too.
        if isinstance(documents, str):
            if ws.prefer_scan:
                docs = ws.all_docs()
            else:
                from .queries import q_review_docs
                ids = q_review_docs(ws, f)
                if len(ids) > MAX_CONFIRM_DOCS:
                    raise ToolError(f'{len(ids)} documents have annotations awaiting review, more than the '
                                    f'{MAX_CONFIRM_DOCS} one plan covers; confirm document by document, or narrow with field.')
                docs = [ws.doc(i) for i in ids]
        else:
            # By id, so a list that names one document twice (by name and by
            # id, or by two spellings of the name) reviews it once.
            ids = []
            for d in documents:
                did = ws.resolve_document_id(str(d))
                if did not in ids:
                    ids.append(did)
            if len(ids) > MAX_CONFIRM_DOCS:
                raise ToolError(f'{len(ids)} documents, more than the {MAX_CONFIRM_DOCS} one plan covers.')
            docs = [ws.doc(did) for did in ids]
        for doc in docs:
            op = _document_confirm_op(ws, doc, f)
            if op:
                staged.append(op)
    elif refs:
        doc = ws.doc(document)
        for ref in refs:
            obj = resolve(doc, ref)
            pieces = _review_pieces(obj, f)
            if not _has_pieces(pieces):
                continue
            # `named`: the model chose this material by reference, so it is a
            # write to it, and a change in the same plan that deletes any of it
            # is refused as the plan is built. A confirmation of a whole
            # document names nothing and carries no such flag.
            staged.append({'kind': 'confirm', **pieces, 'named': True,
                           'label': f'{ws.doc_label(doc.id)} {ref} "{_what(obj)[:40]}": confirm {_pieces_label(pieces)}'
                                    + (f' ({f.name})' if f else '')})
    else:
        op = _document_confirm_op(ws, ws.doc(document), f)
        if op:
            staged.append(op)
    ws.add_ops(staged)
    n = sum(len(v) for op in staged for k, v in op.items() if k.endswith('_ids'))
    if not staged:
        return 'Nothing to confirm: no annotations awaiting review there.'
    return ws.planned_note(len(staged)) + f' ({n} annotation{"s" if n != 1 else ""} will be marked verified' \
        + (f' across {len(staged)} documents' if not document and len(staged) > 1 else '') + '.)'


def t_discard_analysis(ws: Workspace, document: str, refs) -> str:
    """PLAN: delete a word's unverified machine-made analysis (the editor's
    discard gesture): its machine links, values, and morphemes go; human and
    verified pieces stay."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
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
        refuse_shape_and_analysis(ws, w.id, ref, analysing=True)
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
                       'label': f'{ws.doc_label(doc.id)} {ref} "{w.surface}": discard unverified {bits}'})
    ws.add_ops(staged)
    if not staged:
        return 'Nothing to discard: no machine-made, unconfirmed analysis there.'
    return ws.planned_note(len(staged))


def t_set_morpheme(ws: Workspace, document: str, ref: str, form: Optional[str] = None,
                   type: Optional[str] = None) -> str:
    """PLAN: change one morpheme's form and/or type in place, keeping the
    chain and every value on it (set_analysis replaces the whole chain)."""
    doc = ws.doc(document)
    ref = (ref or '').strip()
    m = _need(resolve(doc, ref), Morpheme, ref)
    word_ref_ = ref.rsplit('.', 1)[0]
    w = resolve(doc, word_ref_)
    if form is None and type is None:
        raise ToolError('Give form and/or type.')
    refuse_shape_and_analysis(ws, w.id, word_ref_, analysing=True)
    staged: List[Dict[str, Any]] = []
    if form is not None:
        new = str(form).strip()
        if not new:
            raise ToolError('form must not be empty (set_analysis to remove a morpheme from the chain)')
        if new != m.form:
            staged.append(morpheme_form_op(ws, doc, word_ref_, w, m, new))
    if type is not None:
        t = morph_type(type) if str(type).strip() else None
        if t != (m.morph_type or None):
            staged.append({'kind': 'set_morph_type', 'morpheme_id': m.id, 'morph_type': t,
                           'label': f'{ws.doc_label(doc.id)} {ref} (in "{w.surface}"): morpheme type '
                                    + (f'"{m.morph_type}" → ' if m.morph_type else '= ') + (f'"{t}"' if t else '(cleared)')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


# --- comments -------------------------------------------------------------------

MAX_COMMENTS = 200


def _anchor(ws: Workspace, doc: IgtDoc, ref: Optional[str], field: Optional[str]) -> tuple:
    """(entity_type, entity_id, caption, what) for a comment on the document,
    a sentence, a word, a morpheme, or one of their field values. The caption
    is the editor's own (commentAnchors.js), so a thread reads the same in
    the Comments tab whoever posted it."""
    if not ref:
        if field:
            raise ToolError('field needs a ref (the annotated sentence, word, or morpheme)')
        return 'document', doc.id, doc.name or 'This document', doc.name
    obj = resolve(doc, ref)
    if isinstance(obj, Sentence):
        s, w, m = obj, None, None
    else:
        s = resolve(doc, ref.split('.')[0])
        w = obj if isinstance(obj, Word) else resolve(doc, ref.rsplit('.', 1)[0])
        m = obj if isinstance(obj, Morpheme) else None
    where = f'sentence {s.index}'
    if field:
        f = ws.project.field(field)
        sp = obj.fields.get(f.name)
        if not sp:
            raise ToolError(f'{ref} has no {f.name} value to comment on')
        if isinstance(obj, Sentence):
            return 'span', sp.id, f'{f.name} of sentence {s.index}', s.text
        head = f'{f.name} of {m.form}' if m else f'{f.name} of {w.surface}'
        detail = f'in {w.surface}, {where}' if m else where
        return 'span', sp.id, f'{head}, {detail}', m.form if m else w.surface
    if isinstance(obj, Sentence):
        return 'token', s.id, f'Sentence {s.index}', s.text
    if m:
        return 'token', m.id, f'{m.form}, in {w.surface}, {where}', m.form
    return 'token', w.id, f'{w.surface}, {where}', w.surface


def t_comments(ws: Workspace, document: Optional[str] = None, ref: Optional[str] = None,
               field: Optional[str] = None, limit: int = 50) -> str:
    """The comments people have left: on one thing (document + ref, and
    field for one of its values), in one document, or in the whole project;
    oldest first, the newest `limit` shown."""
    limit = clamp_limit(limit, *READ_LIMITS['comments'])
    ws.on_progress('Reading the comments…')
    doc = ws.doc(document) if document else None
    if ref and doc is None:
        raise ToolError('ref needs a document')
    if doc is not None and ref:
        etype, eid, caption, _ = _anchor(ws, doc, ref, field)
        rows = ws.client.comments.list(ws.project.id, entity_type=etype, entity_id=eid)
        head = f'on {ws.doc_label(doc.id)} {ref}' + (f' {field}' if field else '')
    elif doc is not None:
        rows = ws.client.comments.list(ws.project.id, document_id=doc.id)
        head = f'in {ws.doc_label(doc.id)}'
    else:
        rows = ws.client.comments.list(ws.project.id)
        head = 'in the project'
    rows = sorted(rows or [], key=lambda c: c.get('created_at') or '')
    total = len(rows)
    rows = rows[-limit:]
    if not rows:
        return f'No comments {head}.'
    lines = [f'{total} comment{"s" if total != 1 else ""} {head}' + (f' (newest {limit} shown)' if total > limit else '')
             + ', oldest first:']
    loaded = set()
    for c in rows:
        when = (c.get('created_at') or '')[:16].replace('T', ' ')
        who = c.get('author_id') or '?'
        anchor = ''
        did = c.get('document_id')
        if did and (did in ws._docs or ws.corpus.may_load(did, loaded)):
            d = ws.doc(did)
            hit = d.find(c.get('entity_id'))
            tag = ws.corpus.tag(d.id)
            if hit:
                s, w, m = hit
                anchor = f'{tag}s{s.index}' + (f'.w{w.index}' if w else '') + (f'.m{m.index}' if m else '')
                if c.get('entity_type') == 'span':
                    anchor += ' ' + (c.get('anchor_label') or 'value')
            elif c.get('entity_type') == 'document' and c.get('entity_id') == did:
                anchor = f'{tag}(the document)'
        if not anchor:
            anchor = (c.get('anchor_label') or c.get('entity_type') or '?') + (' [outdated]' if did else '')
        body = (c.get('body') or '').strip().replace('\n', ' ')
        lines.append(f'  {when}  {who}  @ {anchor}: {body}' + (' (edited)' if c.get('edited') else ''))
    return truncate('\n'.join(lines))


def t_add_comment(ws: Workspace, document: str, body: str, ref: Optional[str] = None,
                  field: Optional[str] = None) -> str:
    """PLAN: post a comment, under the user's name, on a document, a
    sentence, a word, a morpheme, or one of their field values."""
    body = (body or '').strip()
    if not body:
        raise ToolError('body must not be empty')
    if len(body) > 10000:
        raise ToolError('a comment holds at most 10000 characters')
    doc = ws.doc(document)
    # No `reshape_guards` here, deliberately: a comment reshapes nothing, so a
    # corpus-wide change in the same plan cannot collide with it. What CAN
    # collide is its anchor. The server resolves the anchor to find the owner
    # whose permissions apply, and an anchor that does not exist fails closed,
    # so a comment on a word, morpheme or value the same plan deletes would
    # refuse the batch it shares after the user approved it. A comment
    # outlives its anchor once written (that is the ruling), but it cannot be
    # written onto one that is already gone. `normalize_ops` drops such a
    # comment with a note, whichever order the two were planned in. A text
    # edit is the one case where the drop is not right: what it deletes is a
    # guess, so the two are refused here instead.
    etype, eid, caption, what = _anchor(ws, doc, ref, field)
    where = f'{ws.doc_label(doc.id)} {ref} "{(what or "")[:40]}"' if ref else f'"{ws.doc_label(doc.id)}"'
    refuse_comment_and_text_edit(ws, eid, where, commenting=True)
    ws.add_op({'kind': 'add_comment', 'entity_type': etype, 'entity_id': eid, 'body': body, 'anchor_label': caption,
               'document_id': doc.id,
               'label': f'{where}: comment "{body[:60]}{"…" if len(body) > 60 else ""}"'
                        + (f' (on {field})' if field else '')})
    return ws.planned_note(1)


# --- restore ------------------------------------------------------------------------

def _restore_lines(ws: Workspace, summary: dict) -> List[str]:
    """The dry run's counts, one line per kind of change, as the editor's
    restore dialog lists them."""
    def changed(c):
        return sum((c or {}).get(k) or 0 for k in ('inserted', 'updated', 'deleted'))
    roles = {ws.project.sentence_layer_id: 'sentence', ws.project.word_layer_id: 'word',
             ws.project.morpheme_layer_id: 'morpheme'}
    lines = []
    if summary.get('name'):
        lines.append('the document name')
    if changed(summary.get('texts')):
        lines.append('the text')
    for e in (summary.get('tokens') or {}).get('by_layer') or []:
        n = changed(e)
        if n:
            lines.append(f'{n} {roles.get(e.get("layer_id"), "token")}{"s" if n != 1 else ""}')
    for e in (summary.get('spans') or {}).get('by_layer') or []:
        n = changed(e)
        if n:
            f = ws.project.field_by_layer(e.get('layer_id'))
            lines.append(f'{n} {f.name if f else "annotation"} value{"s" if n != 1 else ""}')
    n = changed(summary.get('relations'))
    if n:
        lines.append(f'{n} relation{"s" if n != 1 else ""}')
    n = changed(summary.get('vocab_links'))
    if n:
        lines.append(f'{n} lexicon link{"s" if n != 1 else ""}')
    if summary.get('document_metadata'):
        lines.append('the document metadata')
    for k in summary.get('skipped') or []:
        lines.append(f'{k.get("count")} {k.get("kind")}(s) cannot come back ({k.get("reason")})')
    return lines


def t_restore_document(ws: Workspace, document: str, as_of: str) -> str:
    """PLAN: put a document back as it was at a moment in its history (every
    layer, ids kept), in one operation. The plan shows what would change,
    from the server's dry run. Maintainers only; nothing else can share the
    plan, since the restore rewrites what the other changes would address."""
    as_of = (as_of or '').strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', as_of):
        raise ToolError('as_of must be an ISO-8601 instant, e.g. 2026-09-05T18:45:49Z (recent_changes prints one '
                        'per change as as_of=)')
    if ws.ops:
        raise ToolError('A restore must be a plan of its own: discard_plan first, or let the user approve the '
                        'plan so far and ask for the restore afterwards.')
    doc = ws.doc(document)
    ws.on_progress(f'Checking what a restore of "{doc.name}" would change…')
    try:
        summary = ws.client.documents.restore(doc.id, as_of, dry_run=True)
    except Exception as e:  # noqa: BLE001 - the server's reason is the model's answer
        msg = str(e)
        if '403' in msg or 'orbidden' in msg:
            raise ToolError('Restoring a document needs maintainer access to the project.')
        raise ToolError(f'The restore was refused: {msg[:400]}')
    summary = summary if isinstance(summary, dict) else {}
    total = summary.get('total') or 0
    lines = _restore_lines(ws, summary)
    if not total:
        return f'Nothing to restore: "{doc.name}" is as it was at {as_of}.'
    ws.add_op({'kind': 'restore_document', 'document_id': doc.id, 'as_of': as_of, 'doc': doc.id,
               'label': f'{ws.doc_label(doc.id)}: restore to {as_of} ({total} change{"s" if total != 1 else ""}: '
                        + ', '.join(lines) + ')'})
    return ws.planned_note(1) + '\nWhat changes (from the server\'s dry run): ' + ', '.join(lines) + '.'


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
        wanted = {whole(i) for i in (indexes or [])}
    except (TypeError, ValueError):
        raise ToolError('indexes must be the whole numbers shown by plan_status, e.g. [2, 5]')
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

