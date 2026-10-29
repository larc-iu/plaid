"""The plan tools that annotate: field values, analyses, spellings, lexicon
links, confirmations, comments, and a document restore.

A tool here writes nothing. It resolves what the model named against the
workspace and appends operations to the plan (see :mod:`.plan`), which the
service returns with the turn for the user to approve. The refusals a plan
owes itself live with the workspace and with the registry; the ones that are
about interlinear text (a word cannot be reshaped and re-analysed at once, a
respelling cannot overlap another) live here.
"""

import copy
from typing import Any, Dict, List, Optional

from plaid_client.constraints import value_set_allows
from plaid_client.provenance import prov_state, is_machine, needs_review, CONTRIBUTED_STATE
from plaid_client.workflows.igt.config import orthography_key
from plaid_client.workflows.igt.interlinear import choose_type, clitic_types

from ..core import history, keep, opkind
from ..core.keep import is_keep
from ..core.bidi import plain_quote, qv
from ..core.workspace import name_fold
from ..core.scope import review_documents
from ..core.plan import by_document, change_of, confirm_preview, held_changes, labelled
from ..core.provenance import unmark
from ..core.refs import read_ref, same_form
from ..core.tools import ToolError, kind_of

from .plan import ANALYSIS, KIND, TEXT_SHAPE, WORD_SHAPE, analysed_morphemes, reshaped_subjects
from .project import (IgtDoc, Sentence, Word, Morpheme, Link, MARKERS, parse_ref, resolve, mwe_ref,
                      join_morphemes, plain_ref, planned_word_count, segmentation, split_sentences, word_ref)
from .lexview import morph_type
from .workspace import Workspace, _need, _refs, _sentence_of, _words_of


# --- write tools (plan only) ---------------------------------------------------

def t_set_field(ws: Workspace, document: str, refs, field: Optional[str] = None, value: Optional[str] = None,
                values: Optional[dict] = None) -> str:
    """PLAN: one field's value on ``refs``, or several fields at once
    (``values``: field name to value), each on the refs of its own scope, so
    retagging a word and its morpheme is one call (survey item 3). One plan
    step per field and target, staged together: a bad field or ref leaves
    nothing planned."""
    # A ref named twice is one target (H16-IGT-TOOLS-9).
    refs = list(dict.fromkeys(_refs(refs)))
    if values is not None:
        if not isinstance(values, dict) or not values:
            raise ToolError('values maps field names to values, e.g. {"Gloss": "conj", "POS": "conj"}.',
                            kind='invalid-argument')
        if field is not None or value is not None:
            raise ToolError('Give field and value, or values, not both.', kind='invalid-argument')
        pairs, named = [], {}
        for name, val in values.items():
            f = _field_named(ws, name)
            if val is None:
                raise ToolError(f'values: "{name}" has no value. Give it one ("" clears the field).',
                                kind='invalid-argument')
            if f.layer_id in named:
                raise ToolError(f'values: "{named[f.layer_id]}" and "{name}" both name the field {f.name}. '
                                'Give it once.', kind='invalid-argument')
            named[f.layer_id] = name
            pairs.append((f, val))
    else:
        if field is None:
            raise ToolError('Give field and value, or values (a map of field names to values).',
                            kind='invalid-argument')
        if value is None:
            raise ToolError('Give value ("" clears the field).', kind='invalid-argument')
        pairs = [(_field_named(ws, field), value)]
    doc = ws.doc(document)
    several = values is not None
    if several:
        _refuse_unmatched_scopes(doc, refs, [f for f, _ in pairs])
    staged: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    kept: List[str] = []
    took: List[str] = []
    already: List[str] = []
    edits = 0
    with ws.staging():
        for f, val in pairs:
            val = '' if val is None else unmark(str(val), f.name)
            kind = {'Word': Word, 'Morpheme': Morpheme, 'Sentence': Sentence}[f.scope]
            for ref in refs:
                if several and _scope_of(doc, ref) != f.scope:
                    continue
                # A morpheme of a word whose analysis the plan writes is one of
                # the PLANNED chain, and its value goes into that analysis.
                place = _planned_place(ws, doc, ref) if f.scope == 'Morpheme' else None
                if place is not None:
                    edits += edit_planned_morpheme(ws, doc, ref, place, field=f, value=val)
                    continue
                obj = _need(resolve(doc, ref), kind, ref)
                old = obj.fields.get(f.name)
                what = obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)
                target = ('span', f.layer_id, obj.id)
                mine = [op for op in ws.ops if ws.op_target(op) == target]
                if (old.value if old else '') == val:
                    # What it holds already. Planning it again would restate it
                    # and restamp its provenance as the plan's (Eline
                    # 2026-10-07), so it is left out, and set back to what is
                    # stored the earlier planned change is taken back. A rule
                    # of the plan that would change it is the one exception:
                    # the user is keeping it out of that rule, which a keep
                    # says without writing (core.keep, Luke 2026-10-16).
                    # An empty value is kept as well: a rule that fills
                    # empty fields would write it (REV2-AGENT-1).
                    from .bulk import rule_taking
                    shown = qv(val) if val else 'empty'
                    # A keep a rule left of a named change (bulk.ASKED) is
                    # that change: named now, it is kept for good.
                    from .bulk import ASKED
                    if rule_taking(ws, target) is not None:
                        if not any(is_keep(op) and not op.get(ASKED) for op in mine):
                            lab = labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(what[:40])}', f'{f.name} stays {shown}')
                            staged.append(keep.op(target, lab['label'], change_at=lab['change_at'],
                                                  layer_id=f.layer_id, token_id=obj.id))
                            kept.append(f'{f.name} {shown} on {ref}')
                        else:
                            already.append(f'{f.name} {shown} on {ref}')
                    elif mine:
                        dropped += mine
                        # A keep left with nothing to keep the value out of
                        # goes quietly: it planned nothing to take back.
                        if any(not is_keep(op) or op.get(ASKED) for op in mine):
                            took.append(f'{f.name} on {ref}')
                    continue
                if any(op.get('kind') == 'set_span' and (op.get('value') or '') == val and not op.get('asked')
                       for op in mine):
                    continue
                staged.append(span_op(ws, doc, ref, what, f, obj.id, old, val))
        ws.add_ops(staged)
        ws.take_back(dropped)
        # A keep staged, taken back or superseded by a value named on the
        # same target changes what a later rule reads (REV3-AGENT-2).
        from .bulk import sync_rules
        sync_rules(ws)
    n = len([op for op in staged if not is_keep(op)]) + edits
    if not (n or kept or took):
        if already:
            return (f'Nothing to change: the plan already keeps {", ".join(already)} out of the corpus-wide '
                    'change.')
        return 'Nothing to change: every value named already holds what was given.' + ws.superseded_note()
    said, line = [], []
    if n:
        said.append(ws.planned_note(n))
    if kept:
        said.append(f'Kept {", ".join(kept)}: the corpus-wide change in the plan leaves '
                    f'{"it" if len(kept) == 1 else "them"} out, and approval writes nothing to '
                    f'{"it" if len(kept) == 1 else "them"}.')
        line.append(f'Kept {", ".join(kept)}')
    if took:
        said.append(f'Took back the planned change to {", ".join(took)}: '
                    f'{"it keeps its" if len(took) == 1 else "they keep their"} stored value.')
        line.append(f'Took back the planned change to {", ".join(took)}')
    if line:
        ws.step_label = '. '.join(([f'Planned {n} change{"s" if n != 1 else ""}'] if n else []) + line)
    if not n:
        held = held_changes(ws)
        said.append(f'The plan now holds {held} change{"s" if held != 1 else ""}.')
    return ' '.join(said)


def _field_named(ws: Workspace, name: str):
    """The field ``name`` names, or a refusal that points an orthography's
    name to set_orthography."""
    try:
        return ws.project.field(name)
    except ValueError as e:
        try:
            ortho = ws.project.orthography(name)
        except ValueError:
            raise e from None
        raise ToolError(f'"{ortho}" is an orthography, not a field: set it with set_orthography.',
                        kind='invalid-argument') from None


def _scope_of(doc, ref: str) -> str:
    """The scope a reference names: Sentence, Word or Morpheme. A morpheme of
    a planned analysis need not exist yet, so the shape of the reference
    decides, and resolving it is left to the caller."""
    r = read_ref(ref, 'wm')
    if r is None or r.by_form:
        obj = resolve(doc, ref)
        return 'Sentence' if isinstance(obj, Sentence) else 'Word' if isinstance(obj, Word) else 'Morpheme'
    _wi, mi = r.parts
    return 'Sentence' if _wi is None else 'Word' if mi is None else 'Morpheme'


def _refuse_unmatched_scopes(doc, refs: List[str], fields) -> None:
    """With several fields, each goes to the refs of its scope. A field with
    no ref of its scope, or a ref no field applies to, is a mistake to say
    rather than skip."""
    scopes = {ref: _scope_of(doc, ref) for ref in refs}
    for f in fields:
        if f.scope not in scopes.values():
            raise ToolError(f'"{f.name}" is a {f.scope} field and no ref is a {f.scope.lower()} '
                            f'({_REF_SHAPE[f.scope]}). Refs given: {", ".join(refs) or "none"}.',
                            kind='invalid-argument')
    named = {f.scope for f in fields}
    for ref, scope in scopes.items():
        if scope not in named:
            raise ToolError(f'{ref} is a {scope.lower()}, and no field in values is a {scope} field. Fields given: '
                            + ', '.join(f'{f.name} ({f.scope})' for f in fields) + '.', kind='invalid-argument')


_REF_SHAPE = {'Sentence': 'sN', 'Word': 'sN.wN', 'Morpheme': 'sN.wN.mN'}


def span_op(ws: Workspace, doc, ref: str, what: str, f, token_id: str, old, value: str) -> Dict[str, Any]:
    """A set_span op with its human label. ``old`` is the current Span or None."""
    return {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': token_id,
            'span_id': old.id if old else None, 'value': value,
            **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(what[:40])}',
                       f'{f.name} ' + (f'{qv(old.value)} → {qv(value)}' if old and old.value != '' else f'= {qv(value)}')
                       + (' (cleared)' if value == '' else ''))}


MAX_ANALYSES_PER_CALL = 200


def t_set_analysis(ws: Workspace, document: str, ref: Optional[str] = None, morphemes: Optional[list] = None,
                   analyses: Optional[list] = None) -> str:
    """PLAN: one word's analysis (``ref`` + ``morphemes``), or several words'
    at once (``analyses``: a list of {ref, morphemes}), so a whole sentence
    is one call. Staged together: a bad item leaves nothing planned."""
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.', kind='not-found')
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    items = list(analyses or [])
    if ref or morphemes:
        items.insert(0, {'ref': ref, 'morphemes': morphemes})
    if not items:
        raise ToolError('Give ref and morphemes, or analyses (a list of {ref, morphemes}).', kind='invalid-argument')
    if len(items) > MAX_ANALYSES_PER_CALL:
        raise ToolError(f'At most {MAX_ANALYSES_PER_CALL} analyses per call; split the list.', kind='too-large')
    staged: List[Dict[str, Any]] = []
    notes: List[str] = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not item.get('ref'):
            raise ToolError('each analysis needs a ref (sN.wN) and morphemes', kind='invalid-argument')
        r = str(item['ref']).strip()
        w = _need(resolve(doc, r), Word, r)
        if w.id in seen:
            raise ToolError(f'{r} is analysed twice in one call', kind='invalid-argument')
        seen.add(w.id)
        refuse_shape_and_analysis(ws, w.id, r, analysing=True)
        out = stage_equals([(x.form, x.equals_before) for x in w.morphemes if not x.virtual],
                           parse_analysis(ws, item.get('morphemes')))
        # A derived morpheme (an unsegmented word's) is stored nowhere, so
        # there is nothing for the analysis to keep or delete.
        existing = [{'id': m.id, 'span_ids': [sp.id for sp in m.fields.values()]} for m in w.morphemes
                    if not m.virtual]
        had_values = sum(1 for m in w.morphemes for sp in m.fields.values() if sp.value != '')
        op, note = analysis_op(ws, f'{ws.doc_label(doc.id)} {r} {qv(w.surface)}', w.surface, w.id, w.text_id, w.begin,
                               w.end, existing, segmentation(w) if existing else '', had_values, out)
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
                            'start over, or plan the two in separate turns.', kind='conflict')
    elif any(op.get('kind') in _ANALYSIS_KINDS and op.get('word_id') in ids for op in ws.ops):
        raise ToolError(f'{ref} has an analysis change in this plan, so its boundaries cannot also change: a '
                        'boundary change deletes the morphemes that analysis writes. discard_plan to start '
                        'over, or plan the two in separate turns.', kind='conflict')


# A text edit names every word and morpheme of the region it rewrites, and
# the plan treats all of them as deleted. It is a GUESS: the edit goes to the
# server as the stretches that changed, so an unchanged word keeps its token
# and its analysis, and which words those are is not known until the edit runs.
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
                        'or plan the two in separate turns.', kind='conflict')


def parse_analysis(ws: Workspace, morphemes: list) -> List[Dict[str, Any]]:
    """The validated morpheme list of a set_analysis call."""
    if not morphemes or not isinstance(morphemes, list):
        raise ToolError('morphemes must be a non-empty list of {form, type?, fields?}', kind='invalid-argument')
    out = []
    for i, m in enumerate(morphemes):
        if not isinstance(m, dict) or not (m.get('form') or '').strip():
            raise ToolError('each morpheme needs a non-empty form', kind='invalid-argument')
        if i == len(morphemes) - 1 and isinstance(m.get('form'), str):
            # A read marks a segmentation once, after its last form.
            m = {**m, 'form': unmark(m['form'], 'form')}
        if m.get('type'):
            m = {**m, 'type': morph_type(m['type'])}
        fvals = []
        for name, val in (m.get('fields') or {}).items():
            f = ws.project.field(name)
            if f.scope != 'Morpheme':
                raise ToolError(f'"{f.name}" is a {f.scope} field, not a morpheme field; use set_field for it',
                                kind='invalid-argument')
            fvals.append({'layer_id': f.layer_id, 'value': '' if val is None else unmark(str(val), f.name)})
        out.append({'form': m['form'].strip(), 'morph_type': m.get('type') or None, 'fields': fvals,
                    **({'equals': m['equals']} if isinstance(m.get('equals'), bool) else {})})
    return out


def stage_equals(chain, out: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The typed "=" of one word's new analysis (REV-CLITIC CL-12), as the
    grid keeps them, for set_analysis and set_analysis_for_form alike.
    ``chain`` is the word's stored morphemes as ``(form, equals before)``
    pairs, ``out`` what parse_analysis read. A morpheme's ``equals`` states a
    "=" before it, and without it the morpheme keeps the "=" the chain had at
    the same place (the forms before it the same). The pieces nobody typed are
    then typed by the grid's rule (``clitic_types``), with its record. Returns
    a copy: one ``out`` serves every word of a bulk call."""
    kept, prefix = set(), ''
    for i, (form, before) in enumerate(chain):
        if before and i > 0:
            kept.add(prefix)
        prefix += form or ''
    staged, befores, prefix = [], [], ''
    for j, m in enumerate(out):
        m = dict(m)
        stated = m.pop('equals', None)
        befores.append(j > 0 and (stated if stated is not None else prefix in kept))
        prefix += m['form']
        staged.append(m)
    types = clitic_types(['=' if b else '-' for b in befores[1:]], [m['form'] for m in staged])
    for m, before, rule in zip(staged, befores, types):
        if before:
            m['equals_before'] = True
        if rule and not m.get('morph_type'):
            m['morph_type'] = m['type_from_equals'] = rule
    return staged


def analysis_op(ws: Workspace, head: str, surface: str, word_id: str, text_id: str, begin: int, end: int,
                existing: List[Dict[str, Any]], current_seg: str, had_values: int, out: List[Dict[str, Any]]):
    """A set_analysis op with its label, and the allomorphy note if the forms
    do not add up to the surface."""
    joined = ''.join(m['form'] for m in out)
    if joined.replace(' ', '') != surface.replace(' ', ''):
        note = f' (note: forms "{joined}" differ from the surface "{surface}"; that is allowed for allomorphy)'
    else:
        note = ''
    types = [m.get('morph_type') for m in out]
    befores = [m.get('equals_before') is True for m in out]
    desc = join_morphemes(list(zip([m['form'] for m in out], types, befores)))
    gloss_bits = []
    for f in ws.project.fields_by_scope('Morpheme'):
        vals = [next((fv['value'] for fv in m['fields'] if fv['layer_id'] == f.layer_id), '_') for m in out]
        if any(v not in ('', '_') for v in vals):
            gloss_bits.append(f'{f.name} {join_morphemes(list(zip([v or "_" for v in vals], types, befores)))}')
    op = {'kind': 'set_analysis', 'word_id': word_id, 'text_id': text_id, 'begin': begin, 'end': end,
          'morpheme_layer_id': ws.project.morpheme_layer_id, 'existing': existing, 'morphemes': out,
          **labelled(head, (f'{current_seg} → ' if current_seg else '')
                     + desc + (', ' + ', '.join(gloss_bits) if gloss_bits else '')
                     + (f' (replaces {had_values} existing morpheme value{"s" if had_values != 1 else ""})'
                        if had_values else ''))}
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
        staged.append({'kind': 'set_orthography', 'word_id': w.id, 'key': orthography_key(o), 'value': value or '',
                       **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(w.surface)}',
                                  f'{o} ' + (f'{qv(old)} → {qv(value)}' if old else f'= {qv(value)}'))})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def has_own_form(m: Morpheme) -> bool:
    """A morpheme whose form is stored (not derived from the word's surface)."""
    return (m.metadata or {}).get('form') not in (None, '')


def morpheme_form_op(ws: Workspace, doc, ref: str, w: Word, m: Morpheme, new: str) -> Dict[str, Any]:
    return {'kind': 'set_morpheme_form', 'morpheme_id': m.id, 'form': new,
            **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)}.m{m.index} (in {qv(w.surface)})',
                       f'morpheme form {qv(m.form)} → {qv(new)}')}


def t_respell(ws: Workspace, document: str, ref: str, new_text: str, morpheme_forms: bool = True) -> str:
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    new_text = (new_text or '').strip()
    if not new_text:
        raise ToolError('new_text must not be empty (to remove a word from the text, retype_sentence without it; '
                        'delete_word removes only the token)', kind='invalid-argument')
    if new_text == w.surface:
        return ws.planned_note(0)
    check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{ws.doc_label(doc.id)} {ref}')
    staged = [{'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new_text,
               'doc': doc.id, **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)}', f'respell {qv(w.surface)} → {qv(new_text)}')}]
    # A single-morpheme own form spelt like the word follows it. A longer
    # chain cannot be re-derived from a whole-word replacement.
    kept = []
    analysed = analysed_morphemes(ws.ops)
    for m in w.morphemes:
        # A morpheme the planned analysis rewrites takes the form it gives.
        if not has_own_form(m) or m.id in analysed:
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
                            f'discard_plan or narrow the pattern', kind='conflict')
    for op in ws.ops:
        if op.get('kind') == 'edit_text' and op.get('text_id') == text_id and op['begin'] < end:
            raise ToolError(f'{where}: a sentence before or at this point is retyped or appended in this plan; '
                            'respell it in a separate plan', kind='conflict')
    doc = next((d for d in ws._docs.values() if d.text_id == text_id), None)
    # A word this plan splits, merges or deletes is cut again before the
    # respelling lands, and the respelling replaces the range as read: a
    # respelling of one of two merged words wrote "silinasxwt.asxwt." (bench
    # q38-2). The two go in plans of their own, in either order (the shape
    # tools refuse the reverse, ``refuse_shape_and_respell``).
    reshaped = reshaped_subjects(ws.ops, WORD_SHAPE)
    if doc is not None and reshaped:
        for sentence in doc.sentences:
            for w in sentence.words:
                if w.id in reshaped and w.begin < end and begin < w.end:
                    raise ToolError(f'{where}: this plan already splits, merges or deletes this word. Plan the '
                                    'respelling on its own once that is applied.', kind='conflict')
    no_scope_reaches(ws, doc.id if doc is not None else None, where, placed=True)


def refuse_shape_and_respell(ws: Workspace, words, where: str) -> None:
    """A split, merge or delete of a word a planned respelling covers: the
    other order of :func:`check_respell_overlap`'s refusal."""
    for w in words:
        for b, e in ws.planned_respells(w.text_id):
            if b < w.end and w.begin < e:
                raise ToolError(f'{where}: this plan already respells this word. Plan the split, merge or '
                                'delete on its own once that is applied.', kind='conflict')


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


def no_scope_reaches(ws: Workspace, doc_id: Optional[str], where: str, placed: bool = False) -> None:
    """A corpus-wide change stored as one op (bulk.scope_reaches) is resolved
    to words only at approval, so nothing that reshapes a document it reaches
    can share its plan: the two would meet for the first time in the batch.

    Approval (``plan.validate_ops``) reads a reshape that names no document
    as one in every document, and only a respelling names its own
    (``placed``), so any other reshape is refused here while such a change is
    planned anywhere, as approval would refuse it (REV8-PLAN-5)."""
    from .bulk import scope_reaches
    if scope_reaches(ws, doc_id if placed else None):
        what = ('reaches this document' if scope_reaches(ws, doc_id)
                else 'rewrites text, which nothing that reshapes words can share a plan with')
        raise ToolError(f'{where}: this plan already holds a corpus-wide change that {what}. '
                        'Apply it first, then plan this.', kind='conflict')


def _entry_named(ws: Workspace, entry_form, lexicon, entry_id, entry_gloss):
    """The entry a link names. A read marks a link's entry ("link=Ali^"), so a
    form copied from one names the entry without its mark, unless an entry is
    spelled with that last character itself."""
    try:
        return ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    except ToolError:
        bare = unmark(entry_form, 'entry form') if isinstance(entry_form, str) and not entry_id else entry_form
        if bare == entry_form:
            raise
        return ws.find_entry(bare, lexicon, entry_id, entry_gloss)


def t_link_entry(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                 lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                 entry_gloss: Optional[str] = None) -> str:
    doc = ws.doc(document)
    kind, target = _entry_named(ws, entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    shown = ws.entry_shown(target['id'], form) if kind == 'existing' else form
    staged: List[Dict[str, Any]] = []
    inside: List[str] = []
    # Links back to the entry a thing is already linked to: whatever the plan
    # holds for that link (a link to another entry, an unlink) comes out, and
    # nothing is written, so a person's link stays theirs.
    back: List[tuple] = []
    # Morphemes spelled otherwise than the entry (morpheme i, entry t), said
    # as set_analysis says it: a link to the wrong entry went unseen (bench
    # q38-2).
    unlike: List[str] = []
    for ref in _refs(refs):
        place = _planned_place(ws, doc, ref)
        if place is not None:
            op = _planned_link_op(ws, doc, ref, place, kind, target, form, shown)
            if op.get('existing_link_id') and kind == 'existing' and place.kept.link.item_id == target['id']:
                back.append((ref, ws.op_target(op)))
            else:
                staged.append(op)
            continue
        obj = _resolve_for_link(doc, ref)
        if isinstance(obj, Sentence):
            raise ToolError(f'{ref}: link words (sN.wN) or morphemes (sN.wN.mN), not sentences',
                            kind='invalid-argument')
        if _planned_phrase_over(ws, obj.id):
            raise ToolError(f'{ref} is part of a multi-word expression planned in this turn; a word keeps its own '
                            'link inside one, so discard_plan first if you meant to replace it', kind='conflict')
        if kind == 'existing' and obj.link and obj.link.item_id == target['id']:
            back.append((ref, ws.op_target({'kind': 'link', 'token_id': obj.id})))
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        if not isinstance(obj, Word) and _bare_form(what) != _bare_form(form):
            unlike.append(f'{ref} {qv(what)}')
        if isinstance(obj, Word) and obj.mwes:
            inside.append(f'{ref} stays inside ' + ', '.join(f'"{l.form}"' for l in obj.mwes))
        staged.append({'kind': 'link', 'token_id': obj.id,
                       'item_id': target['id'] if kind == 'existing' else None,
                       'new_entry_key': target if kind == 'new' else None,
                       'existing_link_id': obj.link.id if obj.link else None, 'entry_form': form,
                       **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(what)}',
                                  'link ' + (f'{qv(_linked(ws, obj.link))} → ' if obj.link else '') + qv(shown))})
    with ws.staging():
        taken = _take_out(ws, [key for _, key in back])
        ws.add_ops(staged)
    note = ws.planned_note(len(staged))
    if taken:
        note += (f' {", ".join(ref for ref, key in back if key in taken)} already linked to "{form}": the '
                 'planned change to that link was taken out of the plan.')
    if inside:
        note += ' (' + '; '.join(inside) + ': a word\'s own link and a multi-word expression are separate; unlink_phrase removes the latter)'
    if unlike:
        note += (f' {", ".join(unlike)} {"is" if len(unlike) == 1 else "are"} not spelled as the entry '
                 f'{qv(shown)}: check that it is the entry meant.')
    return note


def _bare_form(form: Optional[str]) -> str:
    """A form without its affix marks and case, to tell a morpheme spelled
    like its entry (di, -di) from one spelled otherwise."""
    return (form or '').strip().strip('-=~').casefold()


def _take_out(ws: Workspace, targets) -> set:
    """Take out of the plan every op on one of ``targets``. The targets that
    had one."""
    wanted = set(targets) - {None}
    if not wanted:
        return set()
    hit = {ws.op_target(op) for op in ws.ops} & wanted
    if hit:
        ws.ops[:] = [op for op in ws.ops if ws.op_target(op) not in hit]
        ws._gone_at = -1
    return hit


def _planned_analysis_of(ws: Workspace, word_id: str) -> Optional[Dict[str, Any]]:
    return next((op for op in ws.ops if op.get('kind') == 'set_analysis' and op.get('word_id') == word_id), None)


class _Place:
    """Morpheme ``index`` of the analysis ``analysis`` this plan writes for
    ``word``: ``morpheme`` is its planned {form, ...}, and ``kept`` the stored
    morpheme the analysis keeps in that place (the first, when the word was
    analysed before), or None for one the analysis creates."""

    def __init__(self, word: Word, analysis: Dict[str, Any], index: int, kept: Optional[Morpheme]):
        self.word, self.analysis, self.index, self.kept = word, analysis, index, kept
        self.morpheme = analysis['morphemes'][index - 1]


def _planned_place(ws: Workspace, doc: IgtDoc, ref: str) -> Optional[_Place]:
    """What ``sN.wN.mN`` names in a word whose analysis this plan writes, or
    None when ``ref`` is not a morpheme of such a word.

    Most of those morphemes do not exist until the plan is applied, so a
    change to one names the word and the place, and the executor finds the
    morpheme once the analysis has minted it (``plan.planned_morpheme``).
    ``sN.wN.mN`` of such a word means the PLANNED chain: it is the one the
    model just wrote, and the chain as stored is on its way out."""
    r = read_ref(ref, 'wm')
    # A word named by its form is a word, never a place in an analysis. What
    # is not a reference at all is `resolve`'s to refuse.
    if r is None or r.by_form:
        return None
    si, (wi, mi) = r.sentence, r.parts
    if mi is None or wi is None:
        return None
    w = _need(resolve(doc, f's{si}.w{wi}'), Word, ref)
    analysis = _planned_analysis_of(ws, w.id)
    if analysis is None:
        return None
    chain = analysis.get('morphemes') or []
    if not 1 <= mi <= len(chain):
        raise ToolError(f'{ref}: the analysis this plan gives "{w.surface}" has {len(chain)} '
                        f'morpheme{"s" if len(chain) != 1 else ""} (the planned analysis is the one '
                        f'sN.wN.mN names while it is in the plan)', kind='not-found')
    # A form written beside the number is a check, here as in `resolve`.
    given = r.form
    if given and not same_form(given, chain[mi - 1].get('form'), MARKERS):
        raise ToolError(f'{ref}: in the analysis this plan gives "{w.surface}", m{mi} is '
                        f'"{chain[mi - 1].get("form")}", not "{given}".', kind='not-found')
    # The analysis keeps its own first stored morpheme (``existing[0]``) as
    # its first and deletes the rest, so that one is what m1 names, and
    # every later place is a new morpheme with no link yet. Found by the id
    # the analysis names rather than by place in this reading of the word,
    # which the executor would not agree with if the two orders differed.
    first = (analysis.get('existing') or [None])[0]
    kept = None
    if mi == 1 and first:
        kept = next((m for m in w.morphemes if m.id == first['id']), None)
        if kept is None:
            raise ToolError(f'{ref}: the analysis planned for "{w.surface}" was made from another reading of the '
                            'document. Plan the analysis again (set_analysis), then link.', kind='conflict')
    return _Place(w, analysis, mi, kept)


def _linked(ws: Workspace, link: Link) -> str:
    """The entry a stored link names, as a card row shows it."""
    return ws.entry_shown(link.item_id, link.form)


def _planned_link_op(ws: Workspace, doc: IgtDoc, ref: str, place: _Place, kind: str, target, form: str,
                     shown: str):
    """The link op for a morpheme of a planned analysis (see _planned_place).
    ``shown`` is the entry as the card names it (``Workspace.entry_shown``)."""
    old = place.kept.link if place.kept is not None else None
    m = place.morpheme
    return {'kind': 'link', 'token_id': None, 'analysis_word_id': place.word.id, 'morpheme_index': place.index,
            'morpheme_form': m['form'], 'reuses_morpheme_id': place.kept.id if place.kept is not None else None,
            'doc': doc.id,
            'item_id': target['id'] if kind == 'existing' else None,
            'new_entry_key': target if kind == 'new' else None,
            'existing_link_id': old.id if old else None, 'entry_form': form,
            **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(m["form"])}',
                       'link ' + (f'{qv(_linked(ws, old))} → ' if old else '') + f'{qv(shown)}')}


_UNSET = object()


def edit_planned_morpheme(ws: Workspace, doc: IgtDoc, ref: str, place: _Place, *, field=None,
                          value: Optional[str] = None, form: Optional[str] = None, morph_type=_UNSET) -> int:
    """Name a value of ``field``, a ``form`` or a ``morph_type`` (None clears
    it) for morpheme ``place.index`` of the analysis the plan holds for its
    word, in that analysis. 1 when the plan changed, else 0.

    It is a request of its own on the analysis (``bulk.name_on_analysis``):
    a rule staged before it that leaves the plan does not take it back. A
    planned link to that morpheme follows a new form (``plan.planned_morpheme``
    checks the form it read)."""
    from .bulk import FORM, TYPE, name_on_analysis
    k = place.index - 1
    if field is not None:
        what, new = field.layer_id, value or ''
    elif form is not None:
        what, new = FORM, form
    elif morph_type is not _UNSET:
        what, new = TYPE, morph_type or None
    else:
        return 0
    if form is not None and form != place.morpheme['form']:
        # Before the analysis is staged again, which drops a link whose form
        # it no longer finds.
        w = place.word
        si, wi, _mi = parse_ref(ref)
        for i, op in enumerate(ws.ops):
            if (op.get('kind') == 'link' and op.get('analysis_word_id') == w.id
                    and op.get('morpheme_index') == place.index):
                change = change_of(op)
                ws.ops[i] = {**op, 'morpheme_form': form,
                             **(labelled(f'{ws.doc_label(doc.id)} s{si}.w{wi}.m{place.index} {qv(form)}', change)
                                if change is not None else {})}
    return name_on_analysis(ws, place.analysis, k, what, new)


def left_for_analysis(n: int) -> str:
    """What a tool over stored morphemes says about the ones it left alone
    because a planned analysis rewrites them."""
    if not n:
        return ''
    return (f'\n{n} morpheme{"s" if n != 1 else ""} of words whose analysis this plan rewrites '
            f'{"were" if n != 1 else "was"} left as planned: set_field or set_morpheme with sN.wN.mN change the '
            'planned analysis.')


def _resolve_for_link(doc: IgtDoc, ref: str):
    """``resolve``, saying how to link a morpheme that does not exist yet."""
    try:
        return resolve(doc, ref)
    except ValueError as e:
        r = read_ref(ref, 'wm')
        if r is None or r.by_form or r.parts[1] is None:
            raise
        raise ToolError(f'{e}. To link a morpheme the word does not have yet, plan its analysis first '
                        '(set_analysis), then link sN.wN.mN in the same plan.', kind=kind_of(e, 'not-found')) from None


def _planned_phrase_over(ws: Workspace, token_id: str) -> bool:
    return any(op.get('kind') == 'link_phrase' and token_id in (op.get('token_ids') or []) for op in ws.ops)


def _mwe_desc(l: Link, s: Sentence) -> str:
    return f'"{l.form}" ({mwe_ref(l, s.index)})'


def t_unlink_entry(ws: Workspace, document: str, refs) -> str:
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    only_mwe: List[str] = []
    # A morpheme of a planned analysis that has no stored link: what comes out
    # is the link the plan holds for it, if any.
    planned: List[tuple] = []
    for ref in _refs(refs):
        place = _planned_place(ws, doc, ref)
        if place is not None:
            kept = place.kept
            if kept is not None and kept.link:
                staged.append({'kind': 'unlink', 'link_id': kept.link.id, 'token_id_hint': kept.id,
                               **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(place.morpheme["form"])}',
                                          f'unlink {qv(_linked(ws, kept.link))}')})
            else:
                planned.append((ref, ws.op_target({'kind': 'link', 'token_id': None, 'analysis_word_id': place.word.id,
                                                   'morpheme_index': place.index,
                                                   'reuses_morpheme_id': kept.id if kept is not None else None})))
            continue
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
                       **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(what)}', f'unlink {qv(_linked(ws, obj.link))}')})
    if only_mwe and not staged and not planned:
        raise ToolError('; '.join(only_mwe), kind='not-found')
    from .shape import restage_merges
    with ws.staging():
        taken = _take_out(ws, [key for _, key in planned])
        ws.add_ops(staged)
        # A planned merge of an unlinked word keeps another link, or none,
        # and runs after the unlink.
        restage_merges(ws, doc, [op['token_id_hint'] for op in staged])
    note = ws.planned_note(len(staged))
    if taken:
        note += (f' The planned link on {", ".join(ref for ref, key in planned if key in taken)} was taken out '
                 'of the plan.')
    return note + (' ' + '; '.join(only_mwe) if only_mwe else '')


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
        raise ToolError('A multi-word expression needs two or more distinct words, e.g. ["s3.w2", "s3.w3"]',
                        kind='invalid-argument')
    kind, target = _entry_named(ws, entry_form, lexicon, entry_id, entry_gloss)
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
    # A planned unlink of the link being replaced would delete it twice. The
    # drop and the op that replaces it are one change or none: a refused
    # add_op used to leave the plan short an unlink nobody had been told about.
    with ws.staging():
        if existing is not None:
            before = len(ws.ops)
            ws.ops[:] = [op for op in ws.ops
                         if not (op.get('kind') == 'unlink' and op.get('link_id') == existing.id)]
            ws.replaced += before - len(ws.ops)
        ws.add_op({'kind': 'link_phrase', 'token_ids': token_ids,
                   'item_id': target['id'] if kind == 'existing' else None,
                   'new_entry_key': target if kind == 'new' else None,
                   'existing_link_id': existing.id if existing is not None else None, 'entry_form': form,
                   **labelled(f'{ws.doc_label(doc.id)} s{s.index} {where} {qv(surfaces)}',
                              'link phrase ' + (f'{qv(_linked(ws, existing))} → ' if existing is not None else '')
                              + '"' + (ws.entry_shown(target['id'], form) if kind == 'existing' else form) + '"')})
    return ws.planned_note(1)


def t_unlink_phrase(ws: Workspace, document: str, refs) -> str:
    """PLAN: remove a multi-word expression (the link shared by its member
    words); the words' own links stay. Name any member, or several members
    where a word sits in more than one expression."""
    doc = ws.doc(document)
    words = _words_of(doc, refs)
    if not words:
        raise ToolError('Name at least one member word, e.g. ["s3.w2"]', kind='invalid-argument')
    named = {w.id for _, _, w in words}
    candidates: Dict[str, Link] = {}
    for _, _, w in words:
        for l in w.mwes:
            candidates[l.id] = l
    s = words[0][1]
    if not candidates:
        raise ToolError(', '.join(r for r, _, _ in words) + ' belong to no multi-word expression'
                        + (' (unlink_entry removes a word\'s own link)' if any(w.link for _, _, w in words) else ''),
                        kind='not-found')
    # Every named word must be a member. Among the expressions they name,
    # the one containing all of them wins, else ask.
    full = [l for l in candidates.values() if named <= set(l.tokens)]
    if len(full) != 1:
        raise ToolError('Several multi-word expressions include those words: '
                        + '; '.join(_mwe_desc(l, s) for l in candidates.values())
                        + '. Name a member set that belongs to just one of them.', kind='ambiguous')
    l = full[0]
    ws.add_op({'kind': 'unlink', 'link_id': l.id, 'token_id_hint': l.tokens[0], 'token_ids': list(l.tokens),
               **labelled(f'{ws.doc_label(doc.id)} s{s.index} {mwe_ref(l, s.index)}',
                          f'unlink phrase {qv(_linked(ws, l))}')})
    return ws.planned_note(1)


def t_set_document_metadata(ws: Workspace, document: str, field: str, value: str) -> str:
    names = ws.project.document_metadata
    name = next((n for n in names if n.lower() == (field or '').lower()), None)
    if not name:
        raise ToolError(f'No document metadata field "{field}". Fields: ' + (', '.join(names) or '(none configured)'),
                        kind='not-found')
    doc = ws.doc(document)
    old = doc.metadata.get(name, '')
    value = '' if value is None else str(value)
    if (old or '') == value:
        return ws.planned_note(0)
    ws.add_op({'kind': 'set_doc_metadata', 'document_id': doc.id, 'field': name, 'value': value,
               **labelled(ws.doc_label(doc.id), f'{name} ' + (f'{qv(old)} → {qv(value)}' if old else f'= {qv(value)}'))})
    return ws.planned_note(1)


def t_create_document(ws: Workspace, name: str, text: str, metadata: Optional[dict] = None) -> str:
    """PLAN: a new document from raw text. One sentence per line, and the words
    a Baseline save gives a first text, which the server makes."""
    name = (name or '').strip()
    if not name:
        raise ToolError('name must not be empty', kind='invalid-argument')
    clash = next((d for d in ws.documents() if name_fold(d.get('name') or '') == name_fold(name)), None)
    if clash is not None:
        raise ToolError(f'A document named {plain_quote(clash.get("name"))} already exists. Pick a different name.',
                        kind='conflict')
    text = (text or '').replace('\r\n', '\n')
    if not text.strip():
        raise ToolError('text must not be empty', kind='invalid-argument')
    meta = {}
    for k, v in (metadata or {}).items():
        n = next((x for x in ws.project.document_metadata if x.lower() == k.lower()), None)
        if not n:
            raise ToolError(f'No document metadata field "{k}". Fields: ' + (', '.join(ws.project.document_metadata) or '(none)'),
                            kind='not-found')
        meta[n] = '' if v is None else str(v)
    sents = split_sentences(text)
    words = planned_word_count(ws.project, text)
    ws.add_op({'kind': 'create_document', 'name': name, 'text': text, 'metadata': meta,
               'label': f'New document {qv(name)}: {len(sents)} sentence{"s" if len(sents) != 1 else ""}, {words} words'})
    return ws.planned_note(1) + f' ({len(sents)} sentences, {words} words will be tokenized.)'


PIECE_KEYS = ('span_ids', 'token_ids', 'link_ids')


def _empty_pieces() -> Dict[str, Any]:
    return {'span_ids': [], 'token_ids': [], 'link_ids': [], 'on': {}, 'left': [], 'contributed': []}


def _has_pieces(pieces) -> bool:
    return any(pieces[k] for k in PIECE_KEYS)


def _review_pieces(obj, f=None, into=None, project=None) -> Dict[str, list]:
    """Ids of the pieces of a sentence, word, or morpheme (a sentence includes
    its words) that await review: spans (only field ``f`` when given), links,
    multi-word expressions, and token metadata (only when no field is named).
    A multi-word expression is listed once however many members are seen.
    Each piece that is a contributor's work, not machine output, is listed
    again under ``contributed``: a contributor's approval leaves it for a
    reviewer (``Stamps.confirm``).

    A value the field's closed tagset does not take is left out and listed
    under ``left`` as ``(value, field, what it is on)``: off the list, a
    machine value is exempt only while it is unreviewed, so confirming it is
    refused, and with it the whole batch. It stays unreviewed, as the app's
    own confirm leaves it."""
    out = into if into is not None else _empty_pieces()
    for name, sp in obj.fields.items():
        if (f is None or name == f.name) and needs_review(sp.metadata):
            field = project.field_by_layer(sp.layer_id) if project is not None else None
            if field is not None and not all(value_set_allows(c, sp.value) for c in field.value_sets):
                out['left'].append((sp.value, name, _what(obj)[:40]))
                continue
            out['span_ids'].append(sp.id)
            _note_contributed(out, sp.id, sp.metadata)
            # Which token carries it. A span on a token another op in the plan
            # deletes is gone without ever being named, and confirming it after
            # the delete fails the whole batch.
            out['on'][sp.id] = obj.id
    if isinstance(obj, Sentence):
        if f is None or f.scope != 'Sentence':
            for w in obj.words:
                _review_pieces(w, f, out, project)
        return out
    if f is None:
        if obj.link and needs_review(obj.link.metadata):
            out['link_ids'].append(obj.link.id)
            _note_contributed(out, obj.link.id, obj.link.metadata)
            out['on'][obj.link.id] = obj.id
        for l in getattr(obj, 'mwes', ()):
            if needs_review(l.metadata) and l.id not in out['link_ids']:
                out['link_ids'].append(l.id)
                _note_contributed(out, l.id, l.metadata)
        if needs_review(obj.metadata):
            out['token_ids'].append(obj.id)
            _note_contributed(out, obj.id, obj.metadata)
    if isinstance(obj, Word):
        for m in obj.morphemes:
            _review_pieces(m, f, out, project)
    return out


def _note_contributed(out, piece_id: str, metadata) -> None:
    if prov_state(metadata) == CONTRIBUTED_STATE:
        out['contributed'].append(piece_id)


def _pieces_label(pieces: Dict[str, list]) -> str:
    bits = []
    for key, noun in (('span_ids', 'value'), ('link_ids', 'link'), ('token_ids', 'segmentation')):
        n = len(pieces[key])
        if n:
            bits.append(f'{n} {noun}{"s" if n != 1 else ""}')
    return ', '.join(bits)


def _what(obj) -> str:
    return obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)


def _left_phrase(left: List[tuple], limit: int = 5) -> str:
    """What a confirmation leaves for being off a closed tagset, each value
    with its field and what it is on: ``PST (Gloss, ka)``. '' for none."""
    if not left:
        return ''
    items = [f'{value} ({field}, {what})' if what else f'{value} ({field})' for value, field, what in left]
    more = f', and {len(items) - limit} more' if len(items) > limit else ''
    return 'Not in the tagset, left unconfirmed: ' + ', '.join(items[:limit]) + more + '.'


def _left_label(left: List[tuple]) -> str:
    return f', {len(left)} not in the tagset left unconfirmed' if left else ''


def _document_confirm_op(ws: Workspace, doc: IgtDoc, f, left: List[tuple]) -> Optional[Dict[str, Any]]:
    pieces = _empty_pieces()
    for s in doc.sentences:
        _review_pieces(s, f, pieces, ws.project)
    mine = pieces.pop('left')
    left.extend(mine)
    if not _has_pieces(pieces):
        return None
    return {'kind': 'confirm', **pieces, 'doc': doc.id,
            **labelled(ws.doc_label(doc.id), f'confirm {_pieces_label(pieces)}' + (f' ({f.name})' if f else '')
                       + _left_label(mine))}


def t_confirm(ws: Workspace, document: Optional[str] = None, refs=None, field: Optional[str] = None,
              documents=None) -> str:
    """PLAN: mark annotations awaiting review (machine-made and unconfirmed,
    or a contributor's) as verified, after checking them. `documents` names
    several, or "all" for every document with such material: a plan over
    the whole project is asked for in words, never staged by omission."""
    f = ws.project.field(field) if field else None
    staged: List[Dict[str, Any]] = []
    left: List[tuple] = []
    refs = _refs(refs)
    if refs and not document:
        raise ToolError('refs need a document', kind='invalid-argument')
    if not document and not documents:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'annotations awaiting review.', kind='invalid-argument')
    if not document:
        # Only the WORD "all" means the whole project (core.scope.is_all). The
        # documents with reviewable spans or morphemes are found by query, then
        # each is read so links and multi-word expressions count too.
        from .queries import q_review_docs
        ids = review_documents(ws, documents, lambda: q_review_docs(ws, f),
                               'Confirm document by document, or narrow with field.')
        docs = [ws.doc(i) for i in ids]
        for doc in docs:
            op = _document_confirm_op(ws, doc, f, left)
            if op:
                staged.append(op)
    elif refs:
        doc = ws.doc(document)
        for ref in refs:
            obj = resolve(doc, ref)
            pieces = _review_pieces(obj, f, project=ws.project)
            mine = pieces.pop('left')
            left.extend(mine)
            if not _has_pieces(pieces):
                continue
            # `named`: the model chose this material by reference, so it is a
            # write to it, and a change in the same plan that deletes any of it
            # is refused as the plan is built. A confirmation of a whole
            # document names nothing and carries no such flag.
            staged.append({'kind': 'confirm', **pieces, 'named': True,
                           **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(_what(obj)[:40])}',
                                      f'confirm {_pieces_label(pieces)}' + (f' ({f.name})' if f else '')
                                      + _left_label(mine))})
    else:
        op = _document_confirm_op(ws, ws.doc(document), f, left)
        if op:
            staged.append(op)
    ws.add_ops(staged)

    def size(op):
        return sum(len(v) for k, v in op.items() if k.endswith('_ids'))
    n = sum(size(op) for op in staged)
    if not staged:
        if left:
            return _left_phrase(left) + ' Nothing else awaits review there.'
        return 'Nothing to confirm: no annotations awaiting review there.'
    if ws.requester_reviewed():
        theirs = sum(len(op.get('contributed') or []) for op in staged)
        out = ws.planned_note(len(staged)) + f' ({confirm_preview(n - theirs, theirs)})'
    else:
        out = ws.planned_note(len(staged)) + f' ({n} annotation{"s" if n != 1 else ""} will be marked verified.)'
    if left:
        out += ' ' + _left_phrase(left)
    if not document and len(staged) > 1:
        out += '\n' + by_document([ws.doc_label(op['doc']) for op in staged for _ in range(size(op))])
    return out


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
            raise ToolError(f'{ref}: discard_analysis works on words (sN.wN), not single morphemes',
                            kind='invalid-argument')
    staged: List[Dict[str, Any]] = []
    for ref, w in words:
        refuse_shape_and_analysis(ws, w.id, ref, analysing=True)
        link_ids, span_ids, morpheme_ids = [], [], []
        reset_first = None

        def attached(t):
            if t.link and is_machine(t.link.metadata):
                link_ids.append(t.link.id)
            span_ids.extend(sp.id for sp in t.fields.values() if is_machine(sp.metadata))
        attached(w)
        survivors = []
        for i, m in enumerate(w.morphemes):
            if is_machine(m.metadata) and i > 0:
                morpheme_ids.append(m.id)  # spans and links cascade with the token
                continue
            survivors.append(m)
            attached(m)
            if is_machine(m.metadata):
                reset_first = m.id
        renumber = [{'id': m.id, 'precedence': i + 1} for i, m in enumerate(survivors) if m.index != i + 1]
        if not (link_ids or span_ids or morpheme_ids or reset_first):
            continue
        bits = _pieces_label({'span_ids': span_ids, 'link_ids': link_ids, 'token_ids': []})
        if morpheme_ids or reset_first:
            bits = (bits + ', ' if bits else '') + 'the segmentation'
        staged.append({'kind': 'discard_analysis', 'word_id': w.id, 'link_ids': link_ids, 'span_ids': span_ids,
                       'morpheme_ids': morpheme_ids, 'reset_first_id': reset_first, 'renumber': renumber,
                       **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} {qv(w.surface)}', f'discard unverified {bits}')})
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
    if form is None and type is None:
        raise ToolError('Give form and/or type.', kind='invalid-argument')
    new = None
    if form is not None:
        new = str(form).strip()
        if not new:
            raise ToolError('form must not be empty (set_analysis to remove a morpheme from the chain)',
                            kind='invalid-argument')
    t = (morph_type(type) if str(type).strip() else None) if type is not None else None
    if _planned_place(ws, doc, ref) is not None:
        # A morpheme of the analysis this plan writes for the word: the
        # change goes into that analysis (the stored morpheme is on its way
        # out, or is the first one the analysis keeps and rewrites).
        n = 0
        with ws.staging():
            if new is not None:
                n += edit_planned_morpheme(ws, doc, ref, _planned_place(ws, doc, ref), form=new)
            if type is not None:
                n += edit_planned_morpheme(ws, doc, ref, _planned_place(ws, doc, ref), morph_type=t)
        return ws.planned_note(n)
    m = _need(resolve(doc, ref), Morpheme, ref)
    if type is not None and m.link is not None:
        # A linked morpheme's type is its entry's, as the editor's type row
        # edits the entry: a type planned on the morpheme would change nothing
        # anyone sees.
        vocab = next((v for v in ws.project.vocabs if v['id'] == m.link.vocab_id), None)
        entry = ws.view(vocab).label(m.link.item_id) if vocab else 'a lexicon entry'
        goes = f'goes by its type {qv(m.entry_type)}' if m.entry_type else 'has no type'
        raise ToolError(f'{ref} is linked to {entry}, which {goes}, and a linked morpheme\'s type is its '
                        f'entry\'s. Set it with set_entry_field (field "morphType") on {entry}, or '
                        f'unlink_entry first to give this morpheme a type of its own.', kind='conflict')
    word_ref_ = ref.rsplit('.', 1)[0]
    w = resolve(doc, word_ref_)
    refuse_shape_and_analysis(ws, w.id, word_ref_, analysing=True)
    staged: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    if new is not None and new != m.form:
        # A correction of this one morpheme: stamped when applied, unlike a
        # respelling carried into the forms.
        staged.append({**morpheme_form_op(ws, doc, word_ref_, w, m, new), 'restamp': True})
    if type is not None:
        op = {'kind': 'set_morph_type', 'morpheme_id': m.id, 'morph_type': t,
              **labelled(f'{ws.doc_label(doc.id)} {plain_ref(doc, ref)} (in {qv(w.surface)})',
                         'morpheme type ' + (f'{qv(m.morph_type)} → ' if m.morph_type else '= ')
                         + (qv(t) if t else '(cleared)'))}
        if t is None:
            # As the grid's Type list does (choose_type, REV-CLITIC CL-9,
            # CL-16): clearing a clitic's type takes back the "=" that types
            # it, and clearing any other type keeps the "=", which then types
            # this morpheme unless its entry has a type.
            k = next(i for i, x in enumerate(w.morphemes) if x.id == m.id)
            changes = choose_type([{'morph_type': x.morph_type, 'entry_type': x.entry_type,
                                    'type_from_equals': (x.metadata or {}).get('morphTypeFromEquals'),
                                    'equals_before': x.equals_before} for x in w.morphemes], k, None)
            taken = [w.morphemes[j].id for j, c in enumerate(changes) if 'equals_before' in c]
            if taken:
                op['equals_taken'] = taken
            if changes[k].get('morph_type'):
                op['equals_type'] = changes[k]['morph_type']
                op['label'] += f' (its "=" makes it {op["equals_type"]})'
        # The type the "=" rule gave, chosen as it stands, loses its record.
        ruled = t is not None and (m.metadata or {}).get('morphTypeFromEquals') == t
        if t != (m.morph_type or None) or ruled:
            staged.append(op)
        elif (at := ws.replacing(op)) is not None:
            # Set back to what it holds: the type change planned for it goes.
            dropped.append(ws.ops[at])
    ws.add_ops(staged)
    ws.take_back(dropped)
    if dropped:
        return (f'Took back the planned type change to {ref}: it keeps its stored type. '
                + ws.planned_note(len(staged)))
    return ws.planned_note(len(staged))


# --- comments -------------------------------------------------------------------


# --- restore ------------------------------------------------------------------------

def _restore_lines(ws: Workspace, summary: dict) -> List[str]:
    """The dry run's counts, as the editor's restore dialog lists them, in
    this app's names for its layers."""
    roles = {ws.project.sentence_layer_id: 'sentence', ws.project.word_layer_id: 'word',
             ws.project.morpheme_layer_id: 'morpheme'}

    def span_phrase(layer_id, n):
        f = ws.project.field_by_layer(layer_id)
        return f'{n} {f.name if f else "annotation"} value{"s" if n != 1 else ""}'

    return history.restore_lines(
        summary,
        tokens=lambda layer_id, n: f'{n} {roles.get(layer_id, "token")}{"s" if n != 1 else ""}',
        spans=span_phrase,
        relations=lambda n: f'{n} relation{"s" if n != 1 else ""}',
        links=lambda n: f'{n} lexicon link{"s" if n != 1 else ""}')


def t_restore_document(ws: Workspace, document: str, as_of: str) -> str:
    """PLAN: put a document back as it was at a moment in its history. Shared
    with every app (core/history.py), naming this one's layers."""
    return history.restore_document(ws, document, as_of, lines=lambda s: _restore_lines(ws, s),
                                    extra=lambda doc: {'doc': doc.id})


