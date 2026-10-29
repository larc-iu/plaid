"""Plan-only tools that compute their targets corpus-wide, so a project-wide
edit is one call instead of a loop over references: field replace, respell,
orthography copy, apply-analysis-everywhere, and the lexicon / document
operations (merge, delete, rename). Everything lands in the turn's plan and
is applied only after approval."""

import copy
import json
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.igt import precedence
from plaid_client.workflows.igt.senses import morpheme_morph_type
from plaid_client.workflows.igt.interlinear import choose_type

from ..core import keep as _keep, rules, work
from ..core.bidi import plain_quote, qv
from ..core.workspace import name_fold
from ..core.limits import SAMPLE_LINES
from ..core.plan import PLAN_MAX_OPS, by_document, change_of, labelled
from ..core.replace import replacer as _replacer
from ..core.provenance import unmark
from .plan import KIND, REPAIR_OF, SCOPES, analysed_morphemes, move_phrase, removed_entries, settle_merges
from .project import join_morphemes, word_ref
from ..core.tools import ToolError
from .lexicon import _meta_patch, _refuse_doomed_entry, _refuse_removing_survivor
from .tools import (parse_analysis, analysis_op, stage_equals, no_scope_reaches, refuse_shape_and_analysis,
                    edit_planned_morpheme, left_for_analysis, _planned_place)
from .lexview import entry_line
from .workspace import Workspace, _matcher, op_target
from .vocab import morph_type_of, plan_delete_refs, plan_merge_refs, ref_ids, stored_entry_form


def _bulk_note(ws: Workspace, ops: List[Dict[str, Any]], what: str) -> str:
    """What a bulk tool says back: the count, how many land in each
    document, and a sample. The counts are exact, since a model given only a
    sample made up a breakdown of its own."""
    n = len(ops)
    if not n:
        return f'Nothing to change: no {what} matched.'
    return (ws.planned_note(n) + _by_document(ws, ops) + '\n  '
            + '\n  '.join(op['label'] for op in ops[:SAMPLE_LINES])
            + (f'\n  … {n - SAMPLE_LINES} more (plan_status lists them all)' if n > SAMPLE_LINES else ''))


def _by_document(ws: Workspace, ops: List[Dict[str, Any]]) -> str:
    """The per-document count line for these ops, or ''. An op on no
    document (a lexicon headword) is not counted here."""
    from .changes import _doc_of
    names: List[str] = []
    seen: Dict[str, str] = {}
    for op in ops:
        did = op.get('doc') or _doc_of(ws, op)
        if not did:
            continue
        if did not in seen:
            seen[did] = ws.doc_label(did)
        names.append(seen[did])
    line = by_document(names)
    return '\n' + line if line else ''


def _doc_of_op(ws: Workspace, op: Dict[str, Any]) -> Optional[str]:
    from .changes import _doc_of
    return op.get('doc') or _doc_of(ws, op)


def _check_cap(n: int):
    if n > PLAN_MAX_OPS:
        raise ToolError(f'That would change {n} items, more than the {PLAN_MAX_OPS} one plan may hold. '
                        f'Narrow it (a document, a stricter pattern) and go in passes.', kind='too-large')


def t_replace_in_field(ws: Workspace, field: str, pattern: str, replacement: str, regex: bool = False,
                       whole: bool = False, document: Optional[str] = None,
                       case_sensitive: bool = True, where: Optional[dict] = None) -> str:
    """PLAN: substitute inside every EXISTING value of a field (substring,
    whole value, or regex with backreferences), project-wide or in one
    document. Empty cells are not filled: use set_field_for_form for that.
    ``field`` may also name the stored morpheme forms (Bulk Edit's morpheme
    domain) when no field is so named. Case counts unless the model asks
    otherwise (``case_sensitive=false``): a label pattern in capitals never
    meets an English gloss in lower case by accident (H12-RULES-1).

    Staged as one rule (``core.rules``), found again when approved. Its card
    and its result list every distinct change it makes, the surprising ones
    first (``rules.transitions``), and say how it matches. ``where`` holds it to values on
    words that meet one word's conditions, as sequence_search takes them
    (:func:`condition_of`), still one rule (survey item 4)."""
    forms = _names_morpheme_forms(ws, field)
    cond = condition_of(where)
    if not forms:
        replacement = unmark(replacement, 'replacement')
    # A pattern that cannot be read is refused here, before anything is staged.
    _replacer(pattern, replacement, bool(regex), bool(whole), bool(case_sensitive))
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'field': field, 'pattern': pattern, 'replacement': replacement, 'regex': regex,
                            'whole': whole, 'case_sensitive': case_sensitive, 'document': doc_id},
                           ('regex', 'whole', 'case_sensitive'))
    args['replacement'] = replacement or ''
    if cond:
        args['where'] = cond
    shown, still_regex = rules.pattern_words(pattern, bool(regex))
    mode = rules.match_mode(pattern, bool(regex), bool(whole), bool(case_sensitive))
    case = 'case-sensitive' if case_sensitive else 'ignoring case'
    # Said once: a pattern read as a whole word or value already says where.
    how = (f' (regex, {case})' if still_regex else f' ({case})' if shown != qv(pattern) else f' ({mode})') \
        if regex else f' ({mode})'
    if forms:
        name, unit = 'morpheme form', ('morpheme form', 'morpheme forms')
    else:
        f = ws.project.field(field)
        name, unit = f.name, ('value', 'values')
    held = condition_words(cond)
    return _stage_rule(ws, 'replace_in_field', args, unit,
                       change=f'{name} {shown} → {qv(replacement)}{held}',
                       head=f'{name}: replace {shown} with {qv(replacement)}{how}{held}',
                       what='morpheme forms' if forms else f'{name} values', mode=mode)


# --- a condition on the word (survey item 4) -------------------------------------

def condition_of(where) -> Optional[Dict[str, str]]:
    """A corpus-wide change's ``where`` as stored: one word's conditions, as a
    sequence_search step takes them ({"form": "di"}, {"Gloss (Morpheme)":
    "CAUS"}), each value a whole value, ignoring case. None for none."""
    if where is None or where == {} or where == '':
        return None
    if not isinstance(where, dict):
        raise ToolError('where is one word\'s conditions, as sequence_search takes them: e.g. {"form": "di"} or '
                        '{"Gloss (Morpheme)": "CAUS"}.', kind='invalid-argument')
    out = {}
    for k, v in where.items():
        if not isinstance(k, str) or not k.strip() or v is None or isinstance(v, (dict, list)):
            raise ToolError(f'where: {k!s} must name a key with one value, e.g. {{"form": "di"}}.',
                            kind='invalid-argument')
        if not str(v).strip():
            # An empty value matches nothing, silently (H16-REVIEW-7).
            raise ToolError(f'where: {k.strip()} is empty, which matches nothing. A condition is a value the word '
                            'holds. For the words with no value in a field use worklist.', kind='invalid-argument')
        out[k.strip()] = str(v)
    return out


def condition_words(cond: Optional[Dict[str, str]]) -> str:
    """A condition as the card and the result say it: ``, where form is "di"``."""
    if not cond:
        return ''
    return ', where ' + ' and '.join(f'{k} is {qv(v)}' for k, v in cond.items()) + ' (ignoring case)'


def _planned_meeting(ws: Workspace, cond, f, scope: str) -> Optional[set]:
    """The targets of the plan's own changes to field ``f`` that meet
    ``cond``, or None without a condition (everything does)."""
    if not cond or f is None:
        return None
    from .queries import condition_holds
    ids = [b.get('token_id') for b in map(asked_of, ws.ops)
           if b is not None and b.get('kind') == 'set_span' and b.get('layer_id') == f.layer_id]
    return condition_holds(ws, cond, scope, ids)


# --- corpus-wide changes as ONE op ----------------------------------------------
#
# Each corpus-wide tool is a function of (workspace, args, cap) that returns the
# per-span ops it would stage (``SCOPED``). The plan holds ONE rule naming the
# tool and its arguments (``core.rules``), and the same function runs again at
# approval (igt.plan.resolve_scopes), which refuses the plan if it finds
# anything other than what was counted.

# Candidates one pass may consider; past it, narrow and go in passes. Not
# the same number as UD's REPLACE_MAX, which counts the CHANGES one plan
# makes: most candidates here turn out to need no change at all.
CANDIDATE_MAX = 20000


def _scoped_replace(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_replace_in_field, q_morpheme_forms, rx
    rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                    bool(a.get('case_sensitive')))
    spec = rx(a['pattern'], regex=bool(a.get('regex')), whole=bool(a.get('whole')),
              case_sensitive=bool(a.get('case_sensitive')))
    cond = a.get('where') or None
    if _names_morpheme_forms(ws, a['field']):
        return q_morpheme_forms(ws, rep, spec, cap, cond, getattr(ws, RULES_BEFORE, None) or [])
    f = ws.project.field(a['field'])
    found = q_replace_in_field(ws, f, rep, spec, cap, cond)
    return found + _chained(ws, f, rep, found, a.get('document'), cond)


def _chained(ws: Workspace, f, rep, found: List[Dict[str, Any]], document: Optional[str],
             cond: Optional[dict] = None) -> List[Dict[str, Any]]:
    """The values an earlier rule of the plan leaves on the field that this
    replacement changes in turn, where the stored value did not match it
    ("A" → "B", then "B" → "C"). Rules compose in plan order. With a
    condition, only those on a word that meets it."""
    from .queries import condition_holds
    have = {op.get('token_id') for op in found}
    left = {(layer, token): v for (layer, token), v in ws.rule_values().items()
            if layer == f.layer_id and token not in have and not (document and v[1].get('doc') != document)}
    meets = condition_holds(ws, cond, f.scope, [t for _l, t in left]) if cond and left else None
    out = []
    for (layer, token), (value, earlier) in left.items():
        if meets is not None and token not in meets:
            continue
        new = rep(value)
        if new == value or value == '':
            continue
        at = earlier.get('change_at') or 0
        head = (earlier.get('label') or '')[:max(0, at - 2)]
        # From the value stored, before any rule, to the one written.
        stored = ws.stored_values.get((layer, token), value)
        line = f'{f.name} {qv(stored)} → {qv(new)}' if stored != '' else f'{f.name} = {qv(new)}'
        out.append({**{k: v for k, v in earlier.items() if k not in ('label', 'change_at')}, 'value': new,
                    **labelled(head, line + (' (cleared)' if new == '' else ''))})
    return out


def _lexicon_renames(ws: Workspace, rep, earlier=()) -> List[Dict[str, Any]]:
    """The headwords a respelling carries into, from the plan's own view so a
    respelling does not rename an entry a merge or a delete earlier in the
    same plan takes away: the removals before the rule in plan order
    (``ws.rule_removed``), at staging and at approval alike. A headword an
    ``earlier`` rule renames is read as it leaves it, as the words are. A
    lexicon the user does not maintain is left as it is (`_kept_lexicons`
    says so), since only a maintainer may rename."""
    from .queries import STORED, respelled_before
    _w, _m, renamed = respelled_before(earlier)
    out = []
    gone = ws.rule_removed if ws.rule_removed is not None else ws.doomed_entries()
    for v in ws.project.vocabs:
        if not ws.can_manage_vocab(v):
            continue
        for it in ws.view(v, removed=True).items:
            if it['id'] in gone:
                continue
            stored = it.get('form') or ''
            before = renamed.get(it['id']) or {}
            old = (before.get('form') or '') if it['id'] in renamed else stored
            # The entry's own type, as Bulk Edit reads it, or the one an
            # earlier rule gave it.
            own = before.get('morph_type') or (it.get('metadata') or {}).get('morphType')
            spelled = rep(old)
            if spelled == old or not spelled.strip():
                continue
            # Stored as every entry writer stores it (R27, Bulk Edit's
            # collectLexiconRows): without markers, the type they name where
            # the entry has none (R38).
            new, typed = stored_entry_form(spelled, own)
            extra = {'morph_type': typed} if typed and typed != own else {}
            if new == old and not extra:
                continue
            out.append({'kind': 'rename_entry', 'item_id': it['id'], 'form': new, **extra, STORED: stored,
                        **labelled(v['name'], f'rename entry {qv(stored)} → {qv(new)}{_typed_label(extra)}')})
    return out


def _kept_lexicons(ws: Workspace, rep) -> str:
    """The note on a respelling that leaves the headwords of a lexicon the
    user does not maintain as they are, or ''."""
    kept = []
    for v in ws.project.vocabs:
        if ws.can_manage_vocab(v):
            continue
        n = sum(1 for it in ws.view(v).items
                if (it.get('form') or '') != rep(it.get('form') or '') and rep(it.get('form') or '').strip())
        if n:
            kept.append(f'{n} in "{v["name"]}"')
    if not kept:
        return ''
    return ('\nHeadwords left as they are, since only a maintainer of their lexicon can rename them: '
            + ', '.join(kept) + '. Tell the user.')


def _scoped_respell(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_respell_all, rx
    # Ignoring case, the replacement takes each match's capitals, as the
    # Respell screen writes it: "a" → "ä" respells "Ali" as "Äli".
    rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                    bool(a.get('case_sensitive')), keep_case=True)
    spec = rx(a['pattern'], regex=bool(a.get('regex')), whole=bool(a.get('whole')),
              case_sensitive=bool(a.get('case_sensitive')))
    earlier = getattr(ws, RULES_BEFORE, None) or []
    staged, n_words, _n = q_respell_all(ws, rep, spec, bool(a.get('morpheme_forms')), cap, earlier)
    if n_words > cap:
        raise ToolError(f'More than {cap} words match, which is more than one pass may consider. '
                        f'Narrow it (a document, a stricter pattern) and go in passes.', kind='too-large')
    if a.get('lexicon'):
        staged = staged + _lexicon_renames(ws, rep, earlier)
    return staged


def _scoped_copy(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_copy_to_orthography
    target = ws.project.orthography(a['orthography'])
    src = None if (a.get('source') or 'baseline').lower() == 'baseline' else ws.project.orthography(a['source'])
    return q_copy_to_orthography(ws, target, src, bool(a.get('overwrite')), cap)


def _scoped_set_for_form(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_set_field_for_form
    f = ws.project.field(a['field'])
    value = '' if a.get('value') is None else str(a['value'])
    return q_set_field_for_form(ws, a['form'], f, value, bool(a.get('only_empty', True)), cap, a.get('where') or None)


SCOPED = {'replace_in_field': _scoped_replace, 'respell_all': _scoped_respell,
          'copy_to_orthography': _scoped_copy, 'set_field_for_form': _scoped_set_for_form}


def _stage_rule(ws: Workspace, tool: str, args: Dict[str, Any], unit, *, change: str, head: str, what: str,
                mode: Optional[str] = None) -> str:
    """Stage a corpus-wide change as one rule (``core.rules``): the tool and
    its arguments, what it found now, counted per document with a digest of
    each document's changes, and the card row with a sample. It is found again
    at approval by the same function (``SCOPED``), and the plan is refused if
    it finds anything else.

    A rule applies to the plan's own earlier values too: a value the plan
    names before it is read through it (:func:`settle_named`), and an
    enumerated change staged after it wins at approval. The same rule asked
    again replaces its earlier copy and applies last, after the changes
    planned since: the latest instruction wins (REV4-AGENT-4).

    A rule of :data:`ANALYSIS_TOOLS` also reaches the values of the
    analyses the plan holds (:func:`settle_analyses`), and is staged when it
    sets one there, even if it finds nothing stored.
    """
    key = ('rule', tool, rules.fingerprint_args(args))
    # The plan's rules as they stand and as they count, so this one reads
    # what they leave and the answer can say which it leaves with nothing.
    settle_rules(ws)
    where = f' in {ws.doc_label(args["document"], quote=True)}' if args.get('document') else ''
    saved = ws.snapshot()
    named = named_values(ws)
    was_at = next((i for i, o in enumerate(ws.ops) if rules.is_rule(o) and rules.target(o) == key), None)
    counted = {rules.target(o): _writes(ws, o) for o in ws.ops if rules.is_rule(o) and o.get('head') is not None}
    before = analysis_values(ws)
    try:
        if was_at is not None:
            # Asked again: its earlier copy goes, and it is found after
            # everything planned since.
            del ws.ops[was_at]
            ws.rule_found.pop(key, None)
            ws.rule_basis.pop(key, None)
            ws._gone_at = -1
            sync_rules(ws)
        op, found, kept, left = _build_rule(ws, tool, args, list(unit), change + where, head + where,
                                            ws.rule_found_before(key), mode, removed_entries(ws.ops))
        docs = op['documents']
        # A rule that rewrites the text is held clear of the plan's reshapes
        # where it is found (igt.queries.respell_guard), at approval too.
        ws.add_op(op)
        ws.rule_found[key] = found
        keys = [rules.target(o) for o in ws.ops if rules.is_rule(o) and o.get('head') is not None]
        ws.rule_basis[key] = _basis(keys[:-1], kept_targets(ws.ops), removed_entries(ws.ops[:-1]))
        # An earlier rule leaves to this one what this one changes again,
        # so the plan is measured once every rule is counted as it writes.
        settle_rules(ws)
        # What it sets in the plan's analyses passes the lists those values
        # are held to, as a value named there does.
        edits = ws.analysis_hits.get(key, 0)
        if edits:
            for o in ws.ops:
                if o.get('kind') == 'set_analysis':
                    ws.refuse_off_list(o)
        full = rules.too_many(KIND, ws.ops)
        if full:
            raise ToolError(full, kind='too-large')
    except BaseException:
        ws.restore(saved)
        raise
    rewritten, back = _named_changed(named, named_values(ws))
    held = _held_out(ws, found)
    # What it changes in analyses this plan already holds, once every rule is
    # worked out there: a copy asked again changes only what moving it does.
    edits = values_changed(before, analysis_values(ws)) if edits else 0
    more = (f' {edits} {"value" if edits == 1 else "values"} in analyses this plan already holds, changed there.'
            if edits else '')
    if not kept and not rewritten and not ws.analysis_hits.get(key):
        # It changes nothing, not even a value the plan names: the plan stays
        # as it was, an earlier copy of it included.
        ws.restore(saved)
        settle_rules(ws)
        if was_at is not None:
            return _stays(ws, key, was_at, unit) + left_for_analysis(left)
        out = f'Nothing to change: no {what} matched.'
        if held:
            # It matched only values the plan keeps as they are: said, so
            # "no match" never stands over a value that matches (REV2-AGENT-6).
            out = (f'Nothing to change: the plan keeps every one of the {what} that match ({held}) as it is. '
                   f'For this change to reach {"it" if held == 1 else "them"}, discard_plan and stage it again '
                   f'without {"that keep" if held == 1 else "those keeps"}.')
        if args.get('where'):
            out = _condition_left_none(ws, tool, args, what) or out
        return out + left_for_analysis(left)
    ws.note_versions(docs)
    # as the plan holds it once every rule is counted
    op = next((o for o in ws.ops if rules.is_rule(o) and rules.target(o) == key), op)
    n, accepted = op.get('count') or 0, op[work.COUNTED]
    # What it matches that earlier changes made and it sets back to what is
    # stored: approval writes nothing there (REV4-AGENT-1).
    undone = len(kept) - n
    moved = (f' It was planned already as entry {was_at + 1}: that copy is gone, and this one applies after the '
             'changes planned since.' + _emptied(ws, key, counted)) if was_at is not None and was_at < len(ws.ops) - 1 \
        else ''
    named_line = _rewritten(len(rewritten), back)
    if not kept:
        return (ws.planned_note(0) + (f' {named_line}' if rewritten else '') + more + moved
                + left_for_analysis(left))
    sample = [c['label'] for c in op[CARD]['sample']]
    changes = rules.transition_lines(op[CARD].get(rules.TRANSITIONS) or [],
                                     op[CARD].get(rules.TRANSITIONS_MORE) or [0, 0], unit)
    settled = [o for o in kept if not writes_stored(ws, o)]
    return (ws.planned_note(n, f'{rules.count_line(n, unit, len(op.get("documents") or []))}, as one row on the card')
            + (f' {accepted} of them replace work a person made or accepted, and the card says so.'
               if accepted else '')
            + (f' {undone} {unit[0] if undone == 1 else unit[1]} it matches '
               f'{"goes" if undone == 1 else "go"} back to what is stored, so approval writes nothing there.'
               if undone else '')
            + moved
            + (f'\n{_partial_note(op, unit)}' if op.get('partial') else '')
            + (f'\nMatches {mode}.' if mode else '')
            + (('\nEvery distinct change it makes, the card lists the same:\n  ' + '\n  '.join(changes))
               if changes else '')
            + _by_document(ws, settled)
            + (('\nFor example:\n  ' + '\n  '.join(sample)) if sample else '')
            + (f'\n  … {n - len(sample)} more' if n > len(sample) else '')
            + '\nStored as a rule, found again when the user approves.'
            # A value kept out of it (core.keep) is named with what it holds.
            + (' To leave one value out, set_field it to what it holds now.'
               if set(op.get('counts') or {}) <= {'set_span'} else '')
            # Its field reads the plan's earlier values, its condition the
            # stored ones (H16-IGT-TOOLS-6).
            + (' The condition reads the values stored now, not the ones this plan writes.'
               if args.get('where') and len(ws.ops) > 1 else '')
            + (f' {named_line}' if rewritten else '')
            + (f' {held} more match{"es" if held != 1 else ""} where the plan keeps the value as it is, left out.'
               if held else '')
            + more
            + left_for_analysis(left))


def _stays(ws: Workspace, key: tuple, was_at: int, unit) -> str:
    """What a rule asked again says when, applied last, it would change
    nothing, so its earlier copy stays where it is: what that entry writes
    now, and when that is nothing, why (REV5-AGENT-4)."""
    op = ws.ops[was_at]
    n = _writes(ws, op)
    out = (f'Nothing to change after the changes planned since: this change is entry {was_at + 1} already, which '
           f'stays where it is')
    if n:
        return out + f' and writes {_plural_unit(n, unit)}.'
    found = ws.rule_found.get(key) or []
    held = _held_out(ws, found)
    targets = {op_target(o) for o in found} - kept_targets(ws.ops)
    named = len(targets & {t for t, v in named_values(ws).items() if v is not None})
    why = ([f'the plan keeps {_the(held, unit)} it matches as {"it is" if held == 1 else "they are"}'] if held else []) \
        + ([f'the plan names its own value for {_the(named, unit)} it matches'] if named else [])
    if not why:
        return out + ' and writes nothing now.'
    what = ('that keep' if held == 1 else 'those keeps') if not named else \
        ('that change' if named == 1 else 'those changes') if not held else 'those keeps and changes'
    return (out + ' and writes nothing now: ' + ' and '.join(why) + f'. For this change to reach '
            f'{"it" if held + named == 1 else "them"}, discard_plan and stage it again without {what}.')


def _the(n: int, unit) -> str:
    return f'the {n} {unit[0] if n == 1 else unit[1]}'


def _writes(ws: Workspace, op: Dict[str, Any]) -> int:
    """How many values a rule of the plan writes as the plan stands: those
    it changes as approval finds them, and those of planned analyses it is
    the last to set."""
    return (op.get('count') or 0) + ws.analysis_last.get(rules.target(op), 0)


def _emptied(ws: Workspace, key: tuple, counted: Dict[tuple, int]) -> str:
    """The rules a rule asked again leaves with nothing to change, as it
    moves after them (REV5-AGENT-5), a rule over planned analyses only
    included (REV6-AGENT-7)."""
    out = ''
    for i, o in enumerate(ws.ops, start=1):
        t = rules.target(o) if rules.is_rule(o) else None
        if t is None or t == key or o.get('head') is None or not counted.get(t) or _writes(ws, o):
            continue
        out += f' {o.get("change") or o.get("tool")} now changes nothing (entry {i}), and approval writes nothing for it.'
    return out


def _held_out(ws: Workspace, found: List[Dict[str, Any]]) -> int:
    """How many of what a rule found are values the plan keeps out of
    corpus-wide changes (core.keep), which approval leaves as they are."""
    held = kept_targets(ws.ops)
    return len({op_target(o) for o in found} & held) if held else 0


def _condition_left_none(ws: Workspace, tool: str, args: Dict[str, Any], what: str) -> str:
    """Why a rule with a condition found nothing, when the condition is why:
    how many it finds without it (H16-IGT-TOOLS-5). '' when it finds none
    then either."""
    bare = {k: v for k, v in args.items() if k != 'where'}
    try:
        n = len(resolve_rule(ws, tool, bare, ws.rule_found_before(rules.target({'tool': tool, 'args': bare}))))
    except ToolError:
        return ''
    finally:
        ws.partial_read = None
    if not n:
        return ''
    return (f'Nothing to change: {n} {what} match without the condition, none{condition_words(args["where"])}. '
            'A condition matches a whole value, ignoring case, never as a pattern.')


def _build_rule(ws: Workspace, tool: str, args: Dict[str, Any], unit: list, change: str, head: str, earlier,
                mode: Optional[str] = None, removed: Optional[frozenset] = None):
    """(rule op, what it found, what it writes, how many a planned analysis
    makes moot): the rule resolved now over the values the ``earlier`` rules
    leave and the entries the changes before it remove, as approval will
    resolve it."""
    ws.partial_read = None
    found = resolve_rule(ws, tool, args, earlier, removed=removed)
    partial, ws.partial_read = ws.partial_read, None
    # Staged as one rule, its changes never pass add_op, so the values they
    # would write are held to their layers' lists here.
    for o in found:
        ws.refuse_off_list(o)
    keep = rule_keep(ws, ws.ops)
    kept = [o for o in found if keep(o)]
    analysed = analysed_morphemes(ws.ops)
    left = sum(1 for o in found if ws.moot_under(o, analysed))
    _refuse_merged_away(ws, found)
    op = {'kind': 'bulk_scope', 'tool': tool, 'args': args,
          'matched': rules.matched(KIND, found, lambda o: o.get('doc'), ws.replaces_work),
          'change': change, 'head': head, 'unit': unit}
    if mode:
        op['mode'] = mode
    if partial:
        op['partial'] = partial
    return _counted(ws, op, kept), found, kept, left


def _counted(ws: Workspace, op: Dict[str, Any], kept: List[Dict[str, Any]],
             again: Optional[List[list]] = None) -> Dict[str, Any]:
    """``op`` with what the rule writes (``kept``) counted: its total, the
    count per kind, its documents, how many replace a person's work, its line
    and its card row. ``again`` is ``[[later rule in words, values], ...]``
    for the values it finds that later rules change again, which its line
    and its card say. What it matched (its digest) is left as it is."""
    docs = sorted({o['doc'] for o in kept if o.get('doc')})
    counts: Dict[str, int] = {}
    for o in kept:
        counts[o['kind']] = counts.get(o['kind'], 0) + 1
    accepted = ws.count_replaced_work(kept)
    unit = op.get('unit') or ['change', 'changes']

    def describe(o):
        from .changes import describe_change
        return describe_change(ws, {**o, work.FLAG: ws.replaces_work(o)})
    out = {**op, 'count': len(kept), 'counts': counts, 'documents': docs, work.COUNTED: accepted,
           'label': (f'{op["head"]}, {rules.count_line(len(kept), unit, len(docs), again)}'
                     + work.counted_phrase(accepted))}
    out[CARD] = rules.card(out, kept, lambda o: o.get('doc'), lambda d: ws.corpus.doc_name(d), describe,
                           ws.replaces_work)
    if again:
        out[CARD][rules.CHANGED_AGAIN] = again
    if op.get('mode'):
        out[CARD]['mode'] = op['mode']
    if op.get('partial'):
        out[CARD][rules.PARTIAL] = rules.partial_line(op['partial'], unit)
    if op.get('tool') in _TRANSITION_TOOLS:
        a = op.get('args') or {}
        seen = (rules.surprises(a.get('pattern') or '', bool(a.get('regex')), bool(a.get('whole')),
                                bool(a.get('case_sensitive')))
                if op.get('tool') == 'replace_in_field' else None)
        rows, more = rules.transitions(kept, lambda o: (_was(ws, o), _becomes(o)), seen)
        out[CARD][rules.TRANSITIONS] = rows
        out[CARD][rules.TRANSITIONS_MORE] = more
        out[CARD][rules.UNIT] = list(unit)
    return out


def _partial_note(op: Dict[str, Any], unit) -> str:
    """What the model is told of a rule that read only the first part of what
    it would change: how much, and that the user approves this part and asks
    again for the rest (the card says the same)."""
    read, of = op['partial']
    return (f'Only the first {read:,} of the {of:,} {unit[1]} it would look at were read, in document order: '
            f'this change covers {_plural_unit(op.get("count") or 0, unit)} among them, and the rest are not '
            f'in the plan. Tell the user so: once they approve this, ask again (the same call) for the rest.')


def _plural_unit(n: int, unit) -> str:
    return f'{n:,} {unit[0] if n == 1 else unit[1]}'


#: The rules whose card lists every distinct change they make: a value
#: rewritten, or set over what was there. A copy into an orthography writes
#: each word's own spelling, which its sample shows.
_TRANSITION_TOOLS = ('replace_in_field', 'set_field_for_form')


def _was(ws: Workspace, o: Dict[str, Any]) -> str:
    """The value a change a rule found replaces, as stored."""
    if o.get('kind') == 'set_morpheme_form':
        _, md = ws.metadata_of(o.get('morpheme_id'))
        return ((md or {}).get('form') or '') if isinstance(md, dict) else ''
    return ws.stored_values.get((o.get('layer_id'), o.get('token_id')), '') or ''


def _becomes(o: Dict[str, Any]) -> str:
    return (o.get('form') if o.get('kind') == 'set_morpheme_form' else o.get('value')) or ''


def rule_keep(ws: Workspace, ops: List[Dict[str, Any]]):
    """Whether a change a rule found is one it writes, given the plan
    ``ops``: not when the plan names a change of its own on the same target
    (that change wins, whichever came first), when a planned analysis rewrites
    the morpheme it is on, or when the plan certainly removes what it is on.
    Staging and approval (``igt.plan.resolve_scopes``) ask the same question."""
    from .plan import rule_keep as keep
    return keep(ws, ops)


def settle_rules(ws: Workspace) -> None:
    """Each rule's count, documents, card and line as approval writes it:
    less what a change the plan names sets itself (staged before the rule or
    after it), what the plan removes, what a planned analysis rewrites, and
    what a later rule changes again. That later rule writes the value both
    leave, so a value two rules change is counted once, on the later row.
    What a rule matched, which approval checks, is left as found."""
    # Each rule found as approval finds it, first.
    sync_rules(ws)
    idx = [i for i, op in enumerate(ws.ops) if rules.is_rule(op) and op.get('head') is not None
           and rules.target(op) in ws.rule_found]
    if not idx:
        return
    keep = rule_keep(ws, ws.ops)
    # Each value a later rule writes, with the latest rule that writes it.
    later: Dict[Any, int] = {}
    for i in reversed(idx):
        op = ws.ops[i]
        writes = [o for o in ws.rule_found[rules.target(op)] if keep(o)]
        # A value the rules set back to what is stored is no change: approval
        # writes nothing there (REV4-AGENT-1).
        kept = [o for o in writes if op_target(o) not in later and not writes_stored(ws, o)]
        by: Dict[int, int] = {}
        for o in writes:
            j = later.get(op_target(o))
            if j is not None:
                by[j] = by.get(j, 0) + 1
        again = [[ws.ops[j].get('change') or ws.ops[j].get('tool'), n] for j, n in sorted(by.items())] or None
        for o in writes:
            if op_target(o) is not None:
                later.setdefault(op_target(o), i)
        if op.get('count') == len(kept) and op.get(CARD) is not None \
                and op[CARD].get('total') == len(kept) and op[CARD].get(rules.CHANGED_AGAIN) == again:
            continue
        ws.ops[i] = _counted(ws, op, kept, again)


def later_rule_wins(ops: List[Dict[str, Any]], rule_rows: set, row_key: str,
                    stored=None) -> List[Dict[str, Any]]:
    """``ops`` as approval resolved them, less each change a rule found that
    a later rule changes again (``rule_rows`` are the rules' rows, read from
    ``row_key``). The later one was found over the value the earlier one
    leaves, so it writes the value both make, once. ``stored(op)`` says
    whether a change writes the value stored, which is no change and is left
    out too (:func:`writes_stored`)."""
    if not rule_rows:
        return ops
    later: Dict[Any, Any] = {}
    out: List[Dict[str, Any]] = []
    for o in reversed(ops):
        row = o.get(row_key)
        if row in rule_rows:
            t = op_target(o)
            if t is not None and later.get(t, row) != row:
                continue
            if t is not None:
                later.setdefault(t, row)
            if stored is not None and stored(o):
                continue
        out.append(o)
    out.reverse()
    return out


def writes_stored(ws: Workspace, o: Dict[str, Any]) -> bool:
    """Whether a change a rule found writes the value already stored there:
    rules that end where they began ("C" → "D", then "D" → "C"). It is no
    change, never written or restamped (Eline 2026-10-07)."""
    if o.get('kind') == 'set_span':
        v = ws.stored_values.get((o.get('layer_id'), o.get('token_id')))
        return v is not None and v == (o.get('value') or '')
    if o.get('kind') == 'set_morpheme_form':
        return _was(ws, o) == _becomes(o)
    if o.get('kind') in ('respell', 'rename_entry'):
        # A respelling rule's own (igt.queries.STORED): rules that spell a
        # word or a headword back as stored.
        from .queries import STORED
        was = o.get(STORED)
        return was is not None and was == (o.get('value') if o['kind'] == 'respell' else o.get('form'))
    return False


def _merged_away(ws: Workspace) -> Dict[str, Dict[str, Any]]:
    """The words and sentences a merge in the plan takes away, each with that
    merge. Their values are not removed: the merge joins them into the
    survivor's."""
    out: Dict[str, Dict[str, Any]] = {}
    for op in ws.ops:
        if op.get('kind') == 'merge_words':
            for w in op.get('other_ids') or []:
                out[w] = op
        elif op.get('kind') == 'merge_sentences' and op.get('other_id'):
            out[op['other_id']] = op
    return out


def _refuse_merged_away(ws: Workspace, found: List[Dict[str, Any]]) -> None:
    """A rule may not change a value on a word or sentence a merge in the plan
    takes away: the merge joins that value into the survivor's, so leaving
    the change out would keep the old value there, and what is gone cannot be
    written. Refused as a change named one by one is, in either order
    (:func:`refuse_rule_on_merged`)."""
    gone = _merged_away(ws)
    if not gone:
        return
    for o in found:
        merge = gone.get(o.get('token_id')) if o.get('kind') == 'set_span' else None
        if merge is not None:
            from ..core.opkind import clash_message
            raise ToolError(clash_message(o, merge), kind='conflict')


def refuse_rule_on_merged(ws: Workspace, merge: Dict[str, Any]) -> None:
    """The refusal :func:`_refuse_merged_away` owes the other way round: a
    merge staged after a rule that changes a value on what it takes away."""
    if not any(rules.is_rule(op) for op in ws.ops):
        return
    ids = set(merge.get('other_ids') or []) | ({merge['other_id']} if merge.get('other_id') else set())
    for op in ws.ops:
        if not rules.is_rule(op):
            continue
        for o in ws.rule_found.get(rules.target(op), []):
            if o.get('kind') == 'set_span' and o.get('token_id') in ids:
                from ..core.opkind import clash_message
                raise ToolError(clash_message(o, merge), kind='conflict')


def _basis(earlier: List[tuple], kept: set, removed: frozenset = frozenset()) -> str:
    """What a rule is found over, as :attr:`Workspace.rule_basis` holds it:
    the rules before it, in plan order, the values the plan keeps and the
    lexicon entries the changes before it remove."""
    return json.dumps([[list(k) for k in earlier], sorted(json.dumps(list(t), default=str) for t in kept),
                       sorted(removed)], default=str)


def sync_rules(ws: Workspace) -> None:
    """THE way the plan's rules are found, at staging, after any change to
    the plan, and as approval finds them (``igt.plan.resolve_scopes``):
    each rule in plan order, over the stored values as only the rules BEFORE
    it leave them, a value the plan keeps read as stored (``resolve_rule``).
    Then each value the plan names is read through the rules staged after it
    (:func:`settle_named`).

    A rule is found again when what it was found over changed (the rules
    before it, the values the plan keeps, an earlier rule found again), so
    this may be called after anything that changes the plan, however the op
    list changed: a keep staged, superseded inside a batch, a change named on
    a kept value. Each planned analysis is worked out again from what the
    plan holds (:func:`settle_analyses`). A rule left with nothing to change
    stays on the card, writing nothing."""
    _find_rules(ws)
    settle_named(ws)
    # A named value that now writes nothing is kept, which the rules read as
    # stored: found again once more over it.
    if _find_rules(ws):
        settle_named(ws)
    settle_analyses(ws)


def _find_rules(ws: Workspace) -> bool:
    """Find again each rule whose basis changed (:func:`sync_rules`). True
    when one was."""
    kept = kept_targets(ws.ops)
    earlier: List[tuple] = []
    again = False
    for i, op in enumerate(list(ws.ops)):
        if not rules.is_rule(op) or op.get('head') is None:
            continue
        key = rules.target(op)
        removed = removed_entries(ws.ops[:i])
        basis = _basis(earlier, kept, removed)
        if not again and key in ws.rule_found and ws.rule_basis.get(key) == basis:
            earlier.append(key)
            continue
        again = True
        new, found, _kept, _left = _build_rule(ws, op['tool'], op['args'], op.get('unit') or ['change', 'changes'],
                                               op.get('change') or '', op['head'],
                                               [ws.rule_found[k] for k in earlier], op.get('mode'),
                                               removed=removed)
        if SEQ in op:
            new[SEQ] = op[SEQ]
        ws.ops[ws.ops.index(op)] = new
        ws.rule_found[key] = found
        ws.rule_basis[key] = basis
        earlier.append(key)
    return again


#: The key a rule op carries in the turn's plan for its card row, moved into
#: ``changes`` when the plan is packaged and never stored in ``ops``.
CARD = 'card'

# The kinds a rule may write and still share a plan with an analysis of a
# word it reaches: values, which the analysis makes moot where it rewrites
# them, never the text or the words themselves.
VALUE_KINDS = ('set_span', 'set_orthography', 'set_morpheme_form')


def _values_only(ops) -> bool:
    return all(op.get('kind') in VALUE_KINDS for op in ops)


def _rewritten(n: int, back: int = 0) -> str:
    said = f'{n} planned change{"s" if n != 1 else ""} rewritten by this one'
    if not back:
        return said + '.'
    if back == n:
        return (said + f' back to the value stored: approval leaves {"it as it is" if n == 1 else "them as they are"}.')
    return said + f', {back} of them back to the value stored, which approval leaves as it is.'


# --- the plan's named values under its rules --------------------------------------
#
# A value the plan names (set_field, set_orthography) before a rule is read
# through that rule, as if the rule had been asked first. What the model asked
# is kept on the op (``ASKED``) once a rule rewrites it, and the value is
# worked out again from it after every change to the plan, so a rule asked
# again takes its rewrite with it (REV4-AGENT-2). One that ends on the value stored
# writes nothing: it stands in the plan as a keep, which beats every rule on
# that value and counts as no change (REV4-AGENT-1, Eline 2026-10-07).

#: The change as the model named it, on an op a later rule rewrote.
ASKED = _keep.ASKED
#: When an op was staged, among the plan's named values and rules: a rule
#: rewrites a named value staged before it, never one staged after it,
#: wherever the two stand in the list (a value named again takes its
#: earlier one's place).
SEQ = 'seq'
#: The kinds a rule may rewrite.
NAMED_KINDS = ('set_span', 'set_orthography')


def sequenced(op: Dict[str, Any]) -> bool:
    """Whether ``op`` takes a :data:`SEQ` when staged: a rule, a named
    value, a planned analysis (which the rules staged after it reach)."""
    return rules.is_rule(op) or (op.get('kind') in NAMED_KINDS) or op.get('kind') == 'set_analysis'


def next_seq(ops: List[Dict[str, Any]]) -> int:
    return 1 + max([op.get(SEQ) or 0 for op in ops] + [(op.get(ASKED) or {}).get(SEQ) or 0 for op in ops]
                   + [e[0] for op in ops for e in op.get(NAMED_EDITS) or ()], default=0)


def asked_of(op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The named change ``op`` stands for, as the model asked it, or None
    for an op that is not one."""
    if _keep.is_keep(op):
        return op.get(ASKED)
    if op.get('kind') in NAMED_KINDS and not rules.is_rule(op):
        return op.get(ASKED) or op
    return None


def named_values(ws: Workspace) -> Dict[Any, Any]:
    """What each named change of the plan writes now, by target: its value,
    or None when it writes nothing (a keep)."""
    out = {}
    for op in ws.ops:
        base = asked_of(op)
        if base is not None:
            out[op_target(base)] = None if _keep.is_keep(op) else (op.get('value') or '')
    return out


def _named_changed(before: Dict[Any, Any], after: Dict[Any, Any]) -> tuple:
    """(the targets whose named value changed, how many of them now write
    nothing)."""
    changed = [t for t in after if t in before and after[t] != before[t]]
    return changed, sum(1 for t in changed if after[t] is None)


def _replace_restater(ws: Workspace, a: Dict[str, Any]):
    if _names_morpheme_forms(ws, a['field']):
        return None
    f = ws.project.field(a['field'])
    rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                    bool(a.get('case_sensitive')))
    doc_id = a.get('document')
    meets = _planned_meeting(ws, a.get('where') or None, f, f.scope)

    def restate(op, _found):
        # In the document named if one is, on a word that meets the
        # condition if there is one. An empty value is never replaced.
        if op.get('kind') != 'set_span' or op.get('layer_id') != f.layer_id:
            return None
        if doc_id is not None and _doc_of_op(ws, op) != doc_id:
            return None
        if meets is not None and op.get('token_id') not in meets:
            return None
        old = op.get('value') or ''
        new = rep(old)
        return new if old != '' and new != old else None
    return restate


def _form_restater(ws: Workspace, a: Dict[str, Any]):
    f = ws.project.field(a['field'])
    value = '' if a.get('value') is None else str(a['value'])
    only_empty = bool(a.get('only_empty', True))
    same = _form_matcher(a['form'])
    doc_id = a.get('document')
    meets = _planned_meeting(ws, a.get('where') or None, f, f.scope)

    def restate(op, _found):
        # The form is read on the value's own word or morpheme, whatever is
        # stored there (REV4-AGENT-3).
        if op.get('kind') != 'set_span' or op.get('layer_id') != f.layer_id:
            return None
        cur = op.get('value') or ''
        if cur == value or (only_empty and cur != ''):
            return None
        if meets is not None and op.get('token_id') not in meets:
            return None
        did = _doc_of_op(ws, op)
        if did is None or (doc_id is not None and did != doc_id):
            return None
        hit = ws.doc(did).find(op.get('token_id'))
        if not hit:
            return None
        _s, w, m = hit
        if f.scope == 'Word':
            what = w.surface if w is not None and m is None else None
        else:
            what = m.form if m is not None else None
        return value if what is not None and same(what) else None
    return restate


def _copy_restater(ws: Workspace, a: Dict[str, Any]):
    overwrite = bool(a.get('overwrite'))

    def restate(op, found):
        if op.get('kind') != 'set_orthography' or found is None:
            return None
        if op.get('value') and not overwrite:
            return None
        return found.get('value') if found.get('value') != op.get('value') else None
    return restate


_RESTATERS = {'replace_in_field': _replace_restater, 'set_field_for_form': _form_restater,
              'copy_to_orthography': _copy_restater}


def _stored_value(ws: Workspace, op: Dict[str, Any]) -> Optional[str]:
    """The value stored where a named set_span writes, or None when it
    cannot be read."""
    noted = ws.stored_values.get((op.get('layer_id'), op.get('token_id')))
    if noted is not None:
        return noted
    did = _doc_of_op(ws, op)
    f = ws.project.field_by_layer(op.get('layer_id'))
    if did is None or f is None:
        return None
    hit = ws.doc(did).find(op.get('token_id'))
    if not hit:
        return None
    s, w, m = hit
    obj = m or w or s
    sp = obj.fields.get(f.name)
    return sp.value if sp else ''


def _as_restated(ws: Workspace, base: Dict[str, Any], value: str) -> Dict[str, Any]:
    """The op the named change ``base`` is in the plan once its rules leave
    ``value``: itself, the same change with that value and its line, or a
    keep when that value is the one stored."""
    key = 'value'
    if value == (base.get(key) or ''):
        return base
    at = base.get('change_at') or 0
    place = (base.get('label') or '')[:max(0, at - 2)]
    f = ws.project.field_by_layer(base.get('layer_id')) if base.get('kind') == 'set_span' else None
    if f is not None:
        stored = _stored_value(ws, base)
        if stored is not None and stored == value:
            lab = labelled(place, f'{f.name} stays {qv(value) if value else "empty"}')
            return _keep.op(op_target(base), lab['label'], change_at=lab['change_at'],
                            layer_id=base['layer_id'], token_id=base['token_id'], **{ASKED: base})
        line = (f'{f.name} {qv(stored)} → {qv(value)}' if stored else f'{f.name} = {qv(value)}') \
            + (' (cleared)' if value == '' else '')
    else:
        old = base.get(key) or ''
        line = change_of(base) or ''
        line = line.replace(qv(old), qv(value)) if qv(old) in line else f'{line} → {qv(value)}'
    return {**base, key: value, **labelled(place, line), ASKED: base}


def settle_named(ws: Workspace) -> set:
    """Each named change of the plan as the rules staged after it leave it
    (:data:`SEQ`), worked out from what the model asked (:data:`ASKED`), in
    plan order. Gives the rules that rewrote one."""
    rule_ops = [o for o in ws.ops if rules.is_rule(o) and o.get('head') is not None and o.get('tool') in _RESTATERS]
    if not rule_ops and not any(ASKED in o for o in ws.ops):
        return set()
    chain = []
    for o in rule_ops:
        fn = _RESTATERS[o['tool']](ws, o.get('args') or {})
        if fn is not None:
            found = {op_target(x): x for x in ws.rule_found.get(rules.target(o)) or []}
            chain.append((o.get(SEQ) or 0, fn, found, rules.target(o)))
    used: set = set()
    for i, op in enumerate(ws.ops):
        base = asked_of(op)
        if base is None:
            continue
        t = op_target(base)
        value = base.get('value') or ''
        for seq, fn, found, key in chain:
            if seq <= (base.get(SEQ) or 0):
                continue
            new = fn({**base, 'value': value}, found.get(t))
            if new is not None:
                value = new
                used.add(key)
        want = _as_restated(ws, base, value)
        if want != op:
            ws.ops[i] = want
    return used


def kept_targets(ops: List[Dict[str, Any]]) -> set:
    """What the keeps among ``ops`` hold out of every rule (core.keep)."""
    return {_keep.target(op) for op in ops if _keep.is_keep(op)} - {None}


def resolve_rule(ws: Workspace, tool: str, args: Dict[str, Any], earlier,
                 kept: Optional[set] = None, removed: Optional[frozenset] = None) -> List[Dict[str, Any]]:
    """What a rule resolves to now: its tool's resolver (``SCOPED``) over
    the stored values as the plan's earlier rules leave them (``earlier``,
    their found changes in plan order), never its enumerated changes. Staging
    and approval both resolve through here, so what approval finds is what
    was counted unless the project changed.

    A value the plan keeps (``kept``, by default the keeps of ``ws.ops``) is
    left as stored by the earlier rules too, since approval leaves it so: a
    later rule reads it as it is (REV2-AGENT-6).

    ``removed`` are the lexicon entries the plan's changes before the rule
    take away (``igt.plan.removed_entries``), which a respelling carried into
    the lexicon does not rename; None reads them from the plan as it stands."""
    fn = SCOPED.get(tool)
    if fn is None:
        raise ToolError(f'unknown corpus-wide tool {tool!r}', kind='tool-fault')
    kept = kept_targets(ws.ops) if kept is None else kept
    if kept:
        earlier = [[o for o in found if op_target(o) not in kept] for found in earlier]
    was, ws.rule_removed = ws.rule_removed, removed
    # A rule of the plan found again stands among the corpus-wide changes
    # :func:`scope_reaches` reads: it reads only those before it, as when
    # the rule was staged (REV7-PLAN-1).
    was_at, ws.finding_rule = ws.finding_rule, ('rule', tool, rules.fingerprint_args(args))
    # What the earlier rules found, for a resolver that reads more of it than
    # the values they leave (a respelling reads the words they respell).
    was_earlier = getattr(ws, RULES_BEFORE, None)
    setattr(ws, RULES_BEFORE, earlier)
    try:
        with ws.resolving_rules(earlier), ws.corpus.within(args.get('document')):
            return fn(ws, dict(args), CANDIDATE_MAX)
    finally:
        ws.rule_removed = was
        ws.finding_rule = was_at
        setattr(ws, RULES_BEFORE, was_earlier)


#: Where :func:`resolve_rule` leaves, while a rule is found, what the plan's
#: earlier rules found (in plan order).
RULES_BEFORE = '_rules_before'


def scope_reaches(ws: Workspace, doc_id: Optional[str]) -> bool:
    """Whether a corpus-wide change already planned reaches this document (or
    might, when the document is not known). A rule that writes values only
    does not count (``values_rule``)."""
    ops = ws.ops
    if ws.finding_rule is not None:
        # While a rule of the plan is found again: the changes before it.
        at = next((i for i, op in enumerate(ops) if rules.is_rule(op) and rules.target(op) == ws.finding_rule),
                  None)
        ops = ops if at is None else ops[:at]
    reach = {d for op in ops if op.get('kind') in SCOPES and not values_rule(op)
             for d in (op.get('documents') or [])}
    return bool(reach) and (doc_id is None or doc_id in reach)


def rule_taking(ws: Workspace, target: tuple) -> Optional[Dict[str, Any]]:
    """The rule of the plan that changes what ``target`` names (an op's
    target, ``op_target``) as it stands, or None. A value named with what
    it holds then stands against that rule as a keep (core.keep). A rule
    carried from an earlier turn is found again here (sync_rules)."""
    try:
        sync_rules(ws)
    except ToolError:
        pass
    for op in ws.ops:
        if not rules.is_rule(op) or op.get('head') is None:
            continue
        if any(op_target(o) == target for o in ws.rule_found.get(rules.target(op)) or []):
            return op
    return None


def values_rule(op: Dict[str, Any]) -> bool:
    """Whether ``op`` is a rule that writes values only (``VALUE_KINDS``). It
    may share a plan with anything that reshapes a document it reaches: it
    names what it writes by id, is resolved before anything is written, and
    what it resolves to then passes the checks an enumerated change passes
    (a change on something the plan removes or an analysis rewrites is left
    out), as the same change listed one by one would."""
    return rules.is_rule(op) and _values_only([{'kind': k} for k in (op.get('counts') or {})])


def clear_of_reshapes(ops: List[Dict[str, Any]], docs, what: str) -> None:
    """A corpus-wide change that rewrites the text (a respelling) reaches
    every document it found, so a plan whose ``ops`` already reshape text or
    words in one of them cannot take it. A rule that writes values only
    (``values_rule``) never asks."""
    from .plan import RESHAPES
    reach = set(docs)
    for op in ops:
        if op.get('kind') in RESHAPES and (op.get('doc') in reach or not op.get('doc')):
            raise ToolError(f'This plan already reshapes text or words in a document this {what} '
                            'reaches. Let the user approve one, then plan the other, or discard_plan and plan '
                            'this alone.', kind='conflict')


def _names_morpheme_forms(ws: Workspace, field: str) -> bool:
    """Whether ``field`` addresses the stored morpheme forms rather than a
    field: one of a few spellings, and no field literally so named."""
    name = (field or '').strip().casefold()
    if name not in ('morpheme form', 'morpheme forms', 'morph form', 'form', 'forms', 'morpheme'):
        return False
    return not any(f.name.casefold() == name for f in ws.project.fields.values())


def t_respell_all(ws: Workspace, pattern: str, replacement: str, regex: bool = False,
                  whole: bool = False, document: Optional[str] = None,
                  case_sensitive: bool = False, morpheme_forms: bool = True, lexicon: bool = False) -> str:
    """PLAN: change the baseline spelling of every word matching a pattern
    (orthography migration). Each word is replaced whole, so its analysis,
    glosses, and links survive. Patterns apply within a word, never across
    word boundaries. As in the editor's Bulk Edit, the replacement is carried
    into the stored morpheme forms of the respelled words unless switched
    off, and with ``lexicon`` into every lexicon headword it matches: off by
    default, as igt's Respell screen (ruling 22), since a lexicon can be
    shared. Ignoring case, the
    replacement takes each match's capitals ("Ali" → "Äli" for a → ä).
    Staged as one rule."""
    rep = _replacer(pattern, replacement, bool(regex), bool(whole), bool(case_sensitive))
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'pattern': pattern, 'replacement': replacement, 'regex': regex, 'whole': whole,
                            'case_sensitive': case_sensitive, 'morpheme_forms': morpheme_forms,
                            'lexicon': lexicon, 'document': doc_id},
                           ('regex', 'whole', 'case_sensitive', 'morpheme_forms', 'lexicon'))
    args['replacement'] = replacement or ''
    shown, _ = rules.pattern_words(pattern, bool(regex))
    mode = rules.match_mode(pattern, bool(regex), bool(whole), bool(case_sensitive))
    out = _stage_rule(ws, 'respell_all', args, ('change', 'changes'),
                      change=f'respell {shown} → {qv(replacement)}',
                      head=f'respell {shown} as {qv(replacement)} ({mode})', what='words', mode=mode)
    key = ('rule', 'respell_all', rules.fingerprint_args(args))
    keep = rule_keep(ws, ws.ops)
    kinds = [o['kind'] for o in ws.rule_found.get(key, []) if keep(o) and not writes_stored(ws, o)]
    if kinds and any(rules.is_rule(o) and rules.target(o) == key for o in ws.ops):
        out += (f'\n({kinds.count("respell")} words, {kinds.count("set_morpheme_form")} morpheme forms, '
                f'{kinds.count("rename_entry")} lexicon headwords.)')
    return out + (_kept_lexicons(ws, rep) if lexicon else '')


def t_copy_to_orthography(ws: Workspace, orthography: str, source: str = 'baseline',
                          document: Optional[str] = None, overwrite: bool = False) -> str:
    """PLAN: fill an orthography from the baseline (or another orthography)
    for every word lacking a value (or all words with overwrite=true), as a
    starting point for a transcription tier. Staged as one rule."""
    target = ws.project.orthography(orthography)
    src = 'baseline' if (source or 'baseline').lower() == 'baseline' else ws.project.orthography(source)
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'orthography': orthography, 'source': source or 'baseline', 'overwrite': overwrite,
                            'document': doc_id}, ('overwrite',))

    return _stage_rule(ws, 'copy_to_orthography', args, ('word', 'words'),
                       change=f'{target} copied from {src}',
                       head=f'{target}: copy from {src}' + ('' if overwrite else ', where empty'),
                       what='words')


def _form_matcher(form: str):
    """Whether a value is the form, case folded as the server folds it (Java's
    simple case folding), so a planned morpheme's form matches as the query
    matches a stored one."""
    return _matcher(form, False, whole=True)


def t_set_field_for_form(ws: Workspace, form: str, field: str, value: str, only_empty: bool = True,
                         document: Optional[str] = None, where: Optional[dict] = None) -> str:
    """PLAN: one field value on every occurrence of a form (morpheme form for
    a morpheme field, word form for a word field). Staged as one rule.
    ``where``: only occurrences on a word that meets those conditions."""
    cond = condition_of(where)
    f = ws.project.field(field)
    if f.scope == 'Sentence':
        raise ToolError(f'"{f.name}" is a sentence field; use set_field with sentence references',
                        kind='invalid-argument')
    form = (form or '').strip()
    if not form:
        raise ToolError('Give a form.', kind='invalid-argument')
    value = '' if value is None else unmark(str(value), f.name)
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'form': form, 'field': field, 'value': value, 'only_empty': only_empty,
                            'document': doc_id}, ('only_empty',))
    args['value'] = value
    if cond:
        args['where'] = cond
    held = condition_words(cond)
    note = _stage_rule(ws, 'set_field_for_form', args, ('value', 'values'),
                       change=f'{f.name} = {qv(value)} on {qv(form)}{held}',
                       head=f'{f.name}: {qv(value)} on every {qv(form)}' + (' without a value' if only_empty else '')
                       + held,
                       what=f'occurrences of {qv(form)}' + (' without a value' if only_empty else ''))
    if note.startswith(f'Nothing to change: no occurrences of {qv(form)} matched.'):
        # Occurrences that hold the value already are not "no occurrences"
        # (REV4-AGENT-3).
        have = _occurrences(ws, args)
        if have:
            note = (f'Nothing to change: {"the 1 occurrence" if have == 1 else f"all {have} occurrences"} of '
                    f'{qv(form)} hold{"s" if have == 1 else ""} {f.name} {qv(value) if value else "empty"} '
                    'already.' + note[len(f'Nothing to change: no occurrences of {qv(form)} matched.'):])
    return note


# --- planned analyses under the plan's rules -------------------------------------
#
# A planned analysis (set_analysis) is worked out from the plan's requests, in
# the order they were made (:data:`SEQ`): the analysis as asked
# (:data:`ANALYSIS_ASKED`), each value or form named on one of its morphemes
# since (:data:`NAMED_EDITS`), and each rule of the plan that reaches planned
# analyses (:data:`ANALYSIS_TOOLS`) staged after it. A rule reaches the
# analyses the plan held when it was asked. Whatever leaves the plan, the
# analyses are worked out again from what is left.

#: On a planned analysis that a later request changed: its morphemes as the
#: request gave them. One no later request changed holds them as given.
ANALYSIS_ASKED = 'analysis_asked'
#: On a planned analysis: what was named on its morphemes since, each
#: ``[seq, morpheme index, what, value]``, ``what`` a layer id, :data:`FORM`
#: or :data:`TYPE`.
NAMED_EDITS = 'named_edits'
FORM, TYPE = ':form', ':type'
#: The rules that reach the values of planned analyses.
ANALYSIS_TOOLS = ('set_field_for_form', 'replace_in_field')


def _analysis_rule(ws: Workspace, op: Dict[str, Any]):
    """(layer id, document, condition, fn) for a rule of the plan that
    reaches the values of planned analyses, ``fn(form, value)`` giving the
    value it sets there or None, or None for a rule that reaches none."""
    a = op.get('args') or {}
    tool = op.get('tool')
    if tool not in ANALYSIS_TOOLS or (tool == 'replace_in_field' and _names_morpheme_forms(ws, a.get('field'))):
        return None
    try:
        f = ws.project.field(a['field'])
    except ToolError:
        return None
    if f.scope != 'Morpheme':
        return None
    if tool == 'set_field_for_form':
        value = '' if a.get('value') is None else str(a['value'])
        only_empty = bool(a.get('only_empty', True))
        same = _form_matcher(a['form'])

        def fn(form, cur):
            if not same(form or '') or cur == value or (only_empty and cur):
                return None
            return value
    else:
        rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                        bool(a.get('case_sensitive')))

        def fn(_form, cur):
            # An empty value is never replaced.
            if cur == '':
                return None
            new = rep(cur)
            return new if new != cur else None
    return f.layer_id, a.get('document'), a.get('where') or None, fn


def _analysis_rules(ws: Workspace) -> List[tuple]:
    """(seq, rule target, :func:`_analysis_rule`) for each rule of the plan
    that reaches planned analyses."""
    out = []
    for o in ws.ops:
        if rules.is_rule(o) and o.get('head') is not None and o.get('tool') in ANALYSIS_TOOLS:
            ev = _analysis_rule(ws, o)
            if ev is not None:
                out.append((o.get(SEQ) or 0, rules.target(o), ev))
    return out


def _value_on(pm: Dict[str, Any], layer_id: str) -> str:
    """A planned morpheme's value on a layer, '' for none."""
    return next((fv.get('value') or '' for fv in pm.get('fields') or [] if fv.get('layer_id') == layer_id), '')


def _held(pm: Dict[str, Any], what: str):
    if what == FORM:
        return pm.get('form')
    if what == TYPE:
        return pm.get('morph_type') or None
    return _value_on(pm, what)


def _put(pm: Dict[str, Any], what: str, value) -> None:
    if what == FORM:
        pm['form'] = value
    elif what == TYPE:
        pm['morph_type'] = value or None
    else:
        pm['fields'] = [fv for fv in pm.get('fields') or [] if fv.get('layer_id') != what] + (
            [{'layer_id': what, 'value': value}] if value != '' else [])


def _put_type(ms: List[Dict[str, Any]], k: int, value) -> None:
    """A type named for morpheme ``k`` of a planned analysis, as the grid's
    Type list takes it (``choose_type``, REV-CLITIC CL-15): a chosen type drops
    the rule's record, a clitic's clear takes its "=", and any other clear keeps
    the "=" and the rule reads the chain again."""
    pieces = [{'morph_type': m.get('morph_type'), 'type_from_equals': m.get('type_from_equals'),
               'equals_before': m.get('equals_before')} for m in ms]
    for m, change in zip(ms, choose_type(pieces, k, value or None)):
        for key, v in change.items():
            if key == 'morph_type':
                m[key] = v
            elif v is None:
                m.pop(key, None)
            else:
                m[key] = v


def _meets(ws: Workspace, cond: Dict[str, Any], word_id: str) -> bool:
    """Whether a word meets a rule's condition, asked of the stored project
    once a turn."""
    key = (json.dumps(cond, sort_keys=True), word_id)
    if key not in ws.condition_cache:
        from .queries import condition_holds
        ws.condition_cache[key] = word_id in condition_holds(ws, cond, 'Word', [word_id])
    return ws.condition_cache[key]


def worked_out(ws: Workspace, op: Dict[str, Any], analysis_rules: Optional[List[tuple]] = None) -> tuple:
    """(morphemes, writers, hits) of the planned analysis ``op``: its
    morphemes as its requests leave them, in the order they were made, the
    rule that wrote each (morpheme index, what) last (absent where the
    analysis or a value named on it did), and how many values each rule set
    when it was asked."""
    analysis_rules = _analysis_rules(ws) if analysis_rules is None else analysis_rules
    ms = copy.deepcopy(op.get(ANALYSIS_ASKED) or op.get('morphemes') or [])
    seq0 = op.get(SEQ) or 0
    events = [(e[0], 0, e) for e in op.get(NAMED_EDITS) or []]
    events += [(s, 1, (key, ev)) for s, key, ev in analysis_rules if s > seq0]
    events.sort(key=lambda e: (e[0], e[1]))
    writers: Dict[tuple, tuple] = {}
    hits: Dict[tuple, int] = {}
    did = None
    for _seq, is_rule, e in events:
        if not is_rule:
            _s, k, what, value = e
            if 0 <= k < len(ms) and what == TYPE:
                _put_type(ms, k, value)
            elif 0 <= k < len(ms):
                _put(ms[k], what, value)
                writers.pop((k, what), None)
            continue
        key, (layer_id, doc_id, cond, fn) = e
        if doc_id is not None:
            did = did or _doc_of_op(ws, op)
            if did != doc_id:
                continue
        if cond and not _meets(ws, cond, op.get('word_id')):
            continue
        for k, pm in enumerate(ms):
            new = fn(pm.get('form'), _value_on(pm, layer_id))
            if new is None:
                continue
            _put(pm, layer_id, new)
            writers[(k, layer_id)] = key
            hits[key] = hits.get(key, 0) + 1
    return ms, writers, hits


def _asked(op: Dict[str, Any]) -> Dict[str, Any]:
    """A planned analysis that keeps its morphemes as asked
    (:data:`ANALYSIS_ASKED`) before a later request changes them."""
    if ANALYSIS_ASKED in op:
        return op
    return {**op, ANALYSIS_ASKED: copy.deepcopy(op.get('morphemes') or [])}


def relabelled(ws: Workspace, op: Dict[str, Any], morphemes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The planned analysis ``op`` holding ``morphemes``, its label written
    afresh under the same place."""
    from .tools import analysis_op
    from .project import segmentation
    if morphemes == op.get('morphemes'):
        return op
    did = _doc_of_op(ws, op)
    s, w, _m = ws.doc(did).find(op['word_id']) or (None, None, None)
    if w is None:
        return {**op, 'morphemes': morphemes}
    at = op.get('change_at') or 0
    head = (op.get('label') or '')[:max(0, at - 2)]
    had_values = sum(1 for sm in w.morphemes for sp in sm.fields.values() if sp.value != '')
    rebuilt, _note = analysis_op(ws, head, w.surface, w.id, w.text_id, w.begin, w.end, op.get('existing') or [],
                                 segmentation(w) if op.get('existing') else '', had_values, morphemes)
    return {**op, 'morphemes': morphemes, 'label': rebuilt['label'], 'change_at': rebuilt['change_at']}


def settle_analyses(ws: Workspace) -> None:
    """Each planned analysis as the plan's requests leave it
    (:func:`worked_out`), and per rule how many values it set in planned
    analyses when it was asked (``ws.analysis_hits``) and how many it is the
    last to write (``ws.analysis_last``)."""
    analysis_rules = _analysis_rules(ws)
    hits: Dict[tuple, int] = {}
    last: Dict[tuple, int] = {}
    for i, op in enumerate(ws.ops):
        if op.get('kind') != 'set_analysis':
            continue
        if not analysis_rules and not op.get(NAMED_EDITS) and ANALYSIS_ASKED not in op:
            continue
        ms, writers, h = worked_out(ws, op, analysis_rules)
        for key, n in h.items():
            hits[key] = hits.get(key, 0) + n
        for key in writers.values():
            last[key] = last.get(key, 0) + 1
        if ms != op.get('morphemes'):
            back = not op.get(NAMED_EDITS) and ms == op.get(ANALYSIS_ASKED)
            # Back as asked, it is the analysis as staged again.
            ws.ops[i] = relabelled(ws, {k: v for k, v in op.items() if k != ANALYSIS_ASKED} if back
                                   else _asked(op), ms)
    ws.analysis_hits, ws.analysis_last = hits, last


def analysis_values(ws: Workspace, ops: Optional[List[Dict[str, Any]]] = None) -> Dict[tuple, Any]:
    """Every value of every planned analysis of ``ops`` (the plan's by
    default), by (word id, morpheme index, what), for counting what a change
    to the plan changed there."""
    out: Dict[tuple, Any] = {}
    for op in ws.ops if ops is None else ops:
        if op.get('kind') != 'set_analysis':
            continue
        out[(op.get('word_id'), None, None)] = None
        for k, pm in enumerate(op.get('morphemes') or []):
            for fv in pm.get('fields') or []:
                out[(op.get('word_id'), k, fv.get('layer_id'))] = fv.get('value') or ''
    return out


def values_changed(before: Dict[tuple, Any], after: Dict[tuple, Any]) -> int:
    """How many analysis values differ between two :func:`analysis_values`,
    over the analyses both hold."""
    words = {k[0] for k in after} & {k[0] for k in before}
    keys = {k for k in set(before) | set(after) if k[0] in words and k[1] is not None}
    return sum(1 for k in keys if (before.get(k) or '') != (after.get(k) or ''))


def name_on_analysis(ws: Workspace, analysis: Dict[str, Any], index: int, what: str, value) -> int:
    """Name ``value`` for ``what`` (a layer id, :data:`FORM` or
    :data:`TYPE`) on morpheme ``index`` (0-based) of the planned analysis
    ``analysis``, as a request of its own: it stays when a rule staged before
    it leaves the plan. 1 when the plan changed, else 0. Staged through the
    funnel, as the same change."""
    cur = _held(analysis['morphemes'][index], what)
    # The type the "=" rule gave, chosen as it stands, is the person's from
    # now on (REV-CLITIC CL-15): its record goes, so it is a change.
    ruled = what == TYPE and value and analysis['morphemes'][index].get('type_from_equals') == value
    if cur == value and not ruled:
        # What the analysis holds already: named all the same when a rule set
        # it, which may leave the plan (REV6-AGENT-6).
        _ms, writers, _h = worked_out(ws, analysis)
        if not writers.get((index, what)):
            return 0
    new = {**_asked(analysis), NAMED_EDITS: [*(analysis.get(NAMED_EDITS) or []),
                                             [next_seq(ws.ops), index, what, value]]}
    ms, _w, _h = worked_out(ws, new)
    replaced = ws.replaced
    ws.add_op(relabelled(ws, new, ms) if ms != new.get('morphemes') else {**new, 'morphemes': ms})
    ws.replaced = replaced
    return 1


def _occurrences(ws: Workspace, args: Dict[str, Any]) -> int:
    """How many occurrences of a form rule's form it reads, whatever value
    they hold."""
    try:
        return len(resolve_rule(ws, 'set_field_for_form', {**args, 'value': '\u0000', 'only_empty': False},
                                ws.rule_found_before(None)))
    except ToolError:
        return 0
    finally:
        ws.partial_read = None


def t_set_analysis_for_form(ws: Workspace, form: str, morphemes: list, document: Optional[str] = None,
                            skip_analyzed: bool = False) -> str:
    """PLAN: apply one analysis (segmentation + morpheme fields) to every
    occurrence of a word form (in one document when one is named). With
    skip_analyzed=true, words that already have an analysis are left alone.
    The words and their morpheme chains come by query, then one set_analysis
    op per word."""
    form = (form or '').strip()
    if not form:
        raise ToolError('Give a form.', kind='invalid-argument')
    from .queries import q_analysis_targets, _docs_of
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.', kind='not-found')
    out = parse_analysis(ws, morphemes)
    with ws.corpus.within(document):
        words, chains, spans, entries = q_analysis_targets(ws, form, skip_analyzed, PLAN_MAX_OPS)
    # A linked morpheme goes by its entry's type and stores no copy of it (R2).
    types = ws.corpus.entry_types() if entries else {}
    _check_cap(len(words))
    ws.note_versions(w['document'] for w in words)
    budget = _docs_of([[w] for w in words])
    staged = []
    first_note = ''
    # The refusals t_set_analysis makes. These ops are built by hand, and once
    # made none of them, so a plan already reshaping one of these words, or
    # holding a corpus-wide change over their documents, was refused only at
    # approval, if at all.
    for doc_id in sorted({w['document'] for w in words}):
        no_scope_reaches(ws, doc_id, ws.doc_label(doc_id))
    for w in words:
        ref = ws.corpus.label_ref(w['document'], w['id'], budget)
        refuse_shape_and_analysis(ws, w['id'], ref, analysing=True)
    for w in words:
        chain = sorted(chains.get(w['id']) or [], key=lambda m: (precedence(m), m.get('id')))
        existing = [{'id': m['id'], 'span_ids': spans.get(m['id']) or []} for m in chain]
        # A morpheme with no stored form beside others is a gap, as the editor shows it.
        seg = join_morphemes([((m.get('metadata') or {}).get('form')
                               or ((m.get('value') or '') if len(chain) == 1 else '?'),
                               morpheme_morph_type(m.get('metadata'), types.get(entries.get(m['id']))),
                               (m.get('metadata') or {}).get('equalsBefore') is True)
                              for m in chain])
        had_values = sum(len(spans.get(m['id']) or []) for m in chain)
        head = ws.corpus.label_ref(w['document'], w['id'], budget) + f' {qv(w.get("value") or "")}'
        # The word's typed "=" as set_analysis keeps them (stage_equals).
        staged_out = stage_equals([((m.get('metadata') or {}).get('form'),
                                    (m.get('metadata') or {}).get('equalsBefore') is True) for m in chain], out)
        op, note = analysis_op(ws, head, w.get('value') or '', w['id'], w['text'], w['begin'], w['end'],
                               existing, seg, had_values, staged_out)
        op['doc'] = w['document']
        staged.append(op)
        if not first_note and note:
            first_note = note.strip()
    ws.add_ops(staged)
    return _bulk_note(ws, staged, f'occurrences of "{form}"') + (' ' + first_note if first_note else '')


# --- lexicon and document operations ----------------------------------------------

def _existing(ws: Workspace, form, lexicon, entry_id, gloss=None, what: str = 'be changed') -> dict:
    kind, target = ws.find_entry(form, lexicon, entry_id, gloss)
    if kind == 'new':
        raise ToolError('That entry is new in this plan; approve the plan first, then merge or rename it.',
                        kind='conflict')
    _refuse_doomed_entry(ws, target, what)
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
    from .queries import q_entry_links
    return q_entry_links(ws, item_id)


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
                    **labelled(f'entry {view.label(patch["id"])}', _repair_says(before, after, view))})
    return ops


def _repairs_of(removed: str, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``ops``, the repairs a delete or a merge of entry ``removed`` carries,
    marked as its own: approval writes them in the batch that removes the
    entry, so they stand only if it goes (``plan.REPAIR_OF``)."""
    return [{**op, REPAIR_OF: removed} for op in ops]


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
        raise ToolError('keep and remove are the same entry', kind='invalid-argument')
    # Merges do not chain: this one's links are the ones the entry holds now,
    # so folding the survivor of an earlier merge into a third entry would
    # leave the links that earlier merge moved on an entry being deleted.
    _refuse_removing_survivor(ws, remove, 'be merged away')
    links = _links_to(ws, remove['id'])
    view = ws.view_of_item(remove['id'])
    # Named the way a tool takes them back, so two entries spelled alike
    # (the very pair a merge is for) read apart on the card.
    # The merge and the reference repairs it carries are one change or none:
    # a repair refused (the plan is full, it names something else the plan
    # deletes) left the merge staged with the references still pointing at the
    # entry it removes, while the model was told the call had failed.
    with ws.staging():
        ws.add_op({'kind': 'merge_entries', 'keep_id': keep['id'], 'remove_id': remove['id'], 'links': links,
                   'label': f'Merge entry {_name(view, remove)} into {_name(view, keep)}: '
                            f'{move_phrase(len(links))}, delete the former'})
        refs = _repairs_of(remove['id'], _ref_repair_ops(ws, view, plan_merge_refs, keep['id'], [remove['id']]))
        ws.add_ops(refs)
    # Less any link another change in the plan takes (plan.settle_merges),
    # which the note beside this one names.
    moving = next((len(op['links']) for op in settle_merges(ws.ops)[0] if op.get('kind') == 'merge_entries'
                   and (op['keep_id'], op['remove_id']) == (keep['id'], remove['id'])), len(links))
    note = ws.planned_note(1 + len(refs)) + f' {moving} link(s) will move.'
    return note + (f' {len(refs)} entr{"y" if len(refs) == 1 else "ies"} repointed at the survivor.' if refs else '')


def t_delete_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                   entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: delete a lexicon entry and its links (the words and morphemes
    stay, just unlinked)."""
    it = _existing(ws, entry_form, lexicon, entry_id, entry_gloss, 'be deleted')
    _refuse_removing_survivor(ws, it, 'be deleted')
    links = _links_to(ws, it['id'])
    view = ws.view_of_item(it['id'])
    with ws.staging():
        ws.add_op({'kind': 'delete_entry', 'item_id': it['id'], 'links': [l['link_id'] for l in links],
                   'name': _name(view, it),
                   'label': f'Delete entry {_name(view, it)} '
                            f'({len(links)} link{"s" if len(links) != 1 else ""} removed)'})
        refs = _repairs_of(it['id'], _ref_repair_ops(ws, view, plan_delete_refs, [it['id']]))
        ws.add_ops(refs)
    note = ws.planned_note(1 + len(refs)) + f' {len(links)} link(s) would be removed.'
    return note + (f' {len(refs)} entr{"y" if len(refs) == 1 else "ies"} freed or cleared.' if refs else '')


def _renamed_form(new: str, current: Optional[str]) -> Tuple[str, Dict[str, Any]]:
    """A new headword as an entry stores it (R27): without markers, and the
    ``morph_type`` the rename also writes where the markers name a type and
    the entry has none (R38: a type the entry has is kept)."""
    form, typed = stored_entry_form(new, current)
    return form, ({'morph_type': typed} if typed and typed != current else {})


def _typed_label(typed: Dict[str, Any]) -> str:
    return f' ({typed["morph_type"]})' if typed else ''


def t_rename_entry(ws: Workspace, new_form: str, entry_form: Optional[str] = None,
                   lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                   entry_gloss: Optional[str] = None) -> str:
    """PLAN: change an entry's headword form (links are unaffected)."""
    new_form = (new_form or '').strip()
    if not new_form:
        raise ToolError('new_form must not be empty', kind='invalid-argument')
    it = _existing(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renamed')
    view = ws.view_of_item(it['id'])
    new_form, typed = _renamed_form(new_form, morph_type_of(view.tree, it['id']))
    if it.get('form') == new_form and not typed:
        return ws.planned_note(0)
    ws.add_op({'kind': 'rename_entry', 'item_id': it['id'], 'form': new_form, **typed,
               'label': f'Rename entry {_name(view, it)} → {qv(new_form)}{_typed_label(typed)}'})
    return ws.planned_note(1)


def t_rename_document(ws: Workspace, document: str, new_name: str) -> str:
    """PLAN: rename a document."""
    new_name = (new_name or '').strip()
    if not new_name:
        raise ToolError('new_name must not be empty', kind='invalid-argument')
    doc = ws.doc(document)
    if doc.name == new_name:
        return ws.planned_note(0)
    # Core keeps names apart ignoring case (ruling 5): refused here first,
    # naming the name as the other document spells it.
    clash = [d for d in ws.documents() if d['id'] != doc.id and name_fold(d.get('name') or '') == name_fold(new_name)]
    if clash:
        raise ToolError(f'Another document is already named {plain_quote(clash[0].get("name"))}. Pick a different name.',
                        kind='conflict')
    ws.add_op({'kind': 'rename_document', 'document_id': doc.id, 'name': new_name,
               'label': f'Rename document {ws.doc_label(doc.id, quote=True)} → {qv(new_name)}'})
    return ws.planned_note(1)
