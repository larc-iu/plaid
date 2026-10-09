"""Plan-only tools that compute their targets corpus-wide, so a project-wide
edit is one call instead of a loop over references: field replace, respell,
orthography copy, apply-analysis-everywhere, and the lexicon / document
operations (merge, delete, rename). Everything lands in the turn's plan and
is applied only after approval."""

from typing import Any, Dict, List, Optional

from plaid_client.workflows.igt import precedence

from ..core import rules, work
from ..core.bidi import qv
from ..core.limits import SAMPLE_LINES
from ..core.plan import PLAN_MAX_OPS, by_document, change_of, labelled
from ..core.replace import replacer as core_replacer
from ..core.provenance import unmark
from .plan import KIND, SCOPES, analysed_morphemes, move_phrase, settle_merges
from .project import join_morphemes, word_ref
from ..core.tools import ToolError
from .lexicon import _meta_patch, _refuse_doomed_entry, _refuse_removing_survivor
from .tools import (t_set_analysis, check_respell_overlap, span_op, has_own_form, morpheme_form_op,
                    parse_analysis, analysis_op, no_scope_reaches, refuse_shape_and_analysis,
                    edit_planned_morpheme, left_for_analysis, _planned_place)
from .lexview import entry_line
from .workspace import Workspace, _matcher, op_target
from .vocab import plan_delete_refs, plan_merge_refs, ref_ids
from .stats import _analyzed, _docs

def _replacer(pattern: str, replacement: str, regex: bool, whole: bool, case_sensitive: bool = False):
    """The substitution, in the tools' own words when it cannot be built."""
    return core_replacer(pattern, replacement, regex, whole, case_sensitive, ToolError)


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
                        f'Narrow it (a document, a stricter pattern) and go in passes.')


def t_replace_in_field(ws: Workspace, field: str, pattern: str, replacement: str, regex: bool = False,
                       whole: bool = False, document: Optional[str] = None,
                       case_sensitive: bool = True) -> str:
    """PLAN: substitute inside every EXISTING value of a field (substring,
    whole value, or regex with backreferences), project-wide or in one
    document. Empty cells are not filled: use set_field_for_form for that.
    ``field`` may also name the stored morpheme forms (Bulk Edit's morpheme
    domain) when no field is so named. Case counts unless the model asks
    otherwise (``case_sensitive=false``): a label pattern in capitals never
    meets an English gloss in lower case by accident (H12-RULES-1).

    Staged as one rule (``core.rules``), found again when approved. Its card
    and its result list every distinct change it makes, the surprising ones
    first (``rules.transitions``), and say how it matches."""
    forms = _names_morpheme_forms(ws, field)
    if not forms:
        replacement = unmark(replacement, 'replacement')
    rep = _replacer(pattern, replacement, bool(regex), bool(whole), bool(case_sensitive))
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'field': field, 'pattern': pattern, 'replacement': replacement, 'regex': regex,
                            'whole': whole, 'case_sensitive': case_sensitive, 'document': doc_id},
                           ('regex', 'whole', 'case_sensitive'))
    args['replacement'] = replacement or ''
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

    def restate(op, _found):
        # An earlier planned value on the field is rewritten in place, as the
        # value the plan would leave there, in the document named if one is.
        if forms or op.get('kind') != 'set_span' or op.get('layer_id') != f.layer_id:
            return None
        if doc_id is not None and _doc_of_op(ws, op) != doc_id:
            return None
        new = rep(op.get('value') or '')
        return new if new != (op.get('value') or '') and (op.get('value') or '') != '' else None
    return _stage_rule(ws, 'replace_in_field', args, unit,
                       change=f'{name} {shown} → {qv(replacement)}',
                       head=f'{name}: replace {shown} with {qv(replacement)}{how}',
                       what='morpheme forms' if forms else f'{name} values', restate=restate, mode=mode)


# --- corpus-wide changes as ONE op ----------------------------------------------
#
# Each corpus-wide tool's query path is a function of (workspace, args, cap)
# that returns the per-span ops it would stage. Under PLAN_MAX_OPS those ops are
# staged as they are, in step with the scan path. Past it, the plan holds ONE
# `bulk_scope` op naming the tool and its arguments, and the same function
# runs again at approval (igt.plan.resolve_scopes), with every document the
# preview matched pinned by version so what is found then is what was counted.

# Candidates one pass may consider; past it, narrow and go in passes. Not
# the same number as UD's REPLACE_MAX, which counts the CHANGES one plan
# makes: most candidates here turn out to need no change at all.
CANDIDATE_MAX = 20000


def _scoped_replace(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_replace_in_field, q_morpheme_forms, rx
    rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                    bool(a.get('case_sensitive')))
    document = a.get('document')
    if _names_morpheme_forms(ws, a['field']):
        if ws.use_scan(document):
            return _scan_morpheme_forms(ws, rep, document)
        spec = rx(a['pattern'], regex=bool(a.get('regex')), whole=bool(a.get('whole')),
                  case_sensitive=bool(a.get('case_sensitive')))
        return q_morpheme_forms(ws, rep, spec, cap, document)
    f = ws.project.field(a['field'])
    if ws.use_scan(document):
        found = _scan_replace(ws, f, rep, document)
    else:
        spec = rx(a['pattern'], regex=bool(a.get('regex')), whole=bool(a.get('whole')),
                  case_sensitive=bool(a.get('case_sensitive')))
        found = q_replace_in_field(ws, f, rep, spec, cap, document)
    return found + _chained(ws, f, rep, found, document)


def _scan_replace(ws: Workspace, f, rep, document: Optional[str]) -> List[Dict[str, Any]]:
    """A replacement over the field's values, read from the documents (one,
    or all when the workspace cannot query)."""
    out: List[Dict[str, Any]] = []
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
                cur = ws.planned_value(f.layer_id, u.id, sp.value if sp else '')
                if cur == '':
                    continue
                new = rep(cur)
                if new == cur:
                    continue
                stored = sp.value if sp else ''
                ws.note_stored(f.layer_id, u.id, stored)
                out.append({'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': u.id,
                            'span_id': sp.id if sp else None, 'value': new, 'doc': doc.id,
                            **labelled(f'{ws.doc_label(doc.id)} {ref} {qv(what[:30])}',
                                       f'{f.name} {qv(stored or cur)} → {qv(new)}'
                                       + (' (cleared)' if new == '' else ''))})
    return out


def _scan_morpheme_forms(ws: Workspace, rep, document: Optional[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
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
                    out.append({**morpheme_form_op(ws, doc, word_ref(s, w), w, m, new), 'doc': doc.id})
    return out


def _chained(ws: Workspace, f, rep, found: List[Dict[str, Any]], document: Optional[str]) -> List[Dict[str, Any]]:
    """The values an earlier rule of the plan leaves on the field that this
    replacement changes in turn, where the stored value did not match it
    ("A" → "B", then "B" → "C"). Rules compose in plan order."""
    have = {op.get('token_id') for op in found}
    out = []
    for (layer, token), (value, earlier) in ws.rule_values().items():
        if layer != f.layer_id or token in have or (document and earlier.get('doc') != document):
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


def _lexicon_renames(ws: Workspace, rep) -> List[Dict[str, Any]]:
    """The headwords a respelling carries into, from the plan's own view so a
    respelling does not rename an entry a merge or a delete earlier in the
    same plan takes away. A lexicon the user does not maintain is left as it
    is (`_kept_lexicons` says so), since only a maintainer may rename."""
    out = []
    for v in ws.project.vocabs:
        if not ws.can_manage_vocab(v):
            continue
        for it in ws.view(v).items:
            old = it.get('form') or ''
            new = rep(old)
            if new == old or not new.strip():
                continue
            out.append({'kind': 'rename_entry', 'item_id': it['id'], 'form': new,
                        **labelled(v['name'], f'rename entry {qv(old)} → {qv(new)}')})
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
    rep = _replacer(a['pattern'], a.get('replacement') or '', bool(a.get('regex')), bool(a.get('whole')),
                    bool(a.get('case_sensitive')))
    spec = rx(a['pattern'], regex=bool(a.get('regex')), whole=bool(a.get('whole')),
              case_sensitive=bool(a.get('case_sensitive')))
    staged, n_words, _n = q_respell_all(ws, rep, spec, bool(a.get('morpheme_forms', True)), cap)
    if n_words > cap:
        raise ToolError(f'More than {cap} words match, which is more than one pass may consider. '
                        f'Narrow it (a document, a stricter pattern) and go in passes.')
    if a.get('lexicon', True):
        staged = staged + _lexicon_renames(ws, rep)
    return staged


def _scoped_copy(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_copy_to_orthography
    target = ws.project.orthography(a['orthography'])
    src = None if (a.get('source') or 'baseline').lower() == 'baseline' else ws.project.orthography(a['source'])
    if ws.use_scan(a.get('document')):
        out = []
        for doc in _docs(ws, a.get('document')):
            for s in doc.sentences:
                for w in s.words:
                    cur = w.orthographies.get(target, '')
                    if cur and not a.get('overwrite'):
                        continue
                    value = w.surface if src is None else w.orthographies.get(src, '')
                    if not value or value == cur:
                        continue
                    out.append({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{target}',
                                'value': value, 'doc': doc.id,
                                **labelled(f'{ws.doc_label(doc.id)} {word_ref(s, w)} {qv(w.surface)}',
                                           f'{target} = {qv(value)}')})
        return out
    staged = q_copy_to_orthography(ws, target, src, bool(a.get('overwrite')), cap, a.get('document'))
    if len(staged) > cap:
        raise ToolError(f'More than {cap} words are candidates, which is more than one pass may consider. '
                        f'Narrow it to a document and go in passes.')
    return staged


def _scoped_set_for_form(ws: Workspace, a: Dict[str, Any], cap: int) -> List[Dict[str, Any]]:
    from .queries import q_set_field_for_form
    f = ws.project.field(a['field'])
    value = '' if a.get('value') is None else str(a['value'])
    only_empty = bool(a.get('only_empty', True))
    if not ws.use_scan(a.get('document')):
        return q_set_field_for_form(ws, a['form'], f, value, only_empty, cap, a.get('document'))
    same = _form_matcher(a['form'])
    out = []
    for doc in _docs(ws, a.get('document')):
        for s in doc.sentences:
            for w in s.words:
                if f.scope == 'Word':
                    units = [(w, word_ref(s, w), w.surface)] if same(w.surface) else []
                else:
                    units = [(m, f'{word_ref(s, w)}.m{m.index}', m.form) for m in w.morphemes if same(m.form)]
                for u, ref, what in units:
                    old = u.fields.get(f.name)
                    cur = ws.planned_value(f.layer_id, u.id, old.value if old else '')
                    if cur == value or (only_empty and cur != ''):
                        continue
                    ws.note_stored(f.layer_id, u.id, old.value if old else '')
                    op = {**span_op(ws, doc, ref, what, f, u.id, old, value), 'doc': doc.id}
                    ws.place_virtual(op)
                    out.append(op)
    return out


SCOPED = {'replace_in_field': _scoped_replace, 'respell_all': _scoped_respell,
          'copy_to_orthography': _scoped_copy, 'set_field_for_form': _scoped_set_for_form}


def _stage(ws: Workspace, tool: str, args: Dict[str, Any], staged: List[Dict[str, Any]], unit: str,
           what: str) -> str:
    """Stage what a corpus-wide tool computed: op by op under the cap, as one
    bulk_scope op past it. Either way the plan is pinned to the documents as
    the query saw them (``note_versions``), and a bulk_scope op carries how
    many of its changes replace a person's work, counted now from the
    provenance the query returned, since it is resolved again only when
    approved."""
    docs = sorted({op['doc'] for op in staged if op.get('doc')})
    ws.note_versions(docs)
    if len(staged) <= PLAN_MAX_OPS:
        # A stored morpheme a planned analysis rewrites is left as that
        # analysis has it, as the scan path leaves it (the funnel would refuse
        # the whole call over it).
        analysed = analysed_morphemes(ws.ops)
        kept = [op for op in staged if not ws.moot_under(op, analysed)]
        ws.add_ops(kept)
        return _bulk_note(ws, kept, what) + left_for_analysis(len(staged) - len(kept))
    _clear_of_reshapes(ws, docs)
    # Staged as one scope, its ops never pass add_op, so the values they would
    # write are held to their layers' lists here, as op by op under the cap.
    for op in staged:
        ws.refuse_off_list(op)
    counts: Dict[str, int] = {}
    for op in staged:
        counts[op['kind']] = counts.get(op['kind'], 0) + 1
    accepted = ws.count_replaced_work(staged)
    ws.add_op({'kind': 'bulk_scope', 'tool': tool, 'args': args, 'counts': counts, 'count': len(staged),
               'documents': docs, work.COUNTED: accepted,
               'label': f'{tool}: {len(staged)} changes in {len(docs)} documents ('
                        + ', '.join(f'{k}={v}' for k, v in args.items() if v not in (None, '', False)) + ')'
                        + work.counted_phrase(accepted)})
    return (ws.planned_note(1) + f'\n  One change covering {len(staged)} changes to {what}.'
            + (f' {accepted} of them replace work a person made or accepted, and the card says so.'
               if accepted else '')
            + _by_document(ws, staged) + '\nFor example:\n  ' + '\n  '.join(op['label'] for op in staged[:SAMPLE_LINES])
            + (f'\n  … {len(staged) - SAMPLE_LINES} more' if len(staged) > SAMPLE_LINES else ''))


def _stage_rule(ws: Workspace, tool: str, args: Dict[str, Any], unit, *, change: str, head: str, what: str,
                restate=None, quiet_when_empty: bool = False, mode: Optional[str] = None) -> str:
    """Stage a corpus-wide change as one rule (``core.rules``): the tool and
    its arguments, what it found now, counted per document with a digest of
    each document's changes, and the card row with a sample. It is found again
    at approval by the same function (``SCOPED``), and the plan is refused if
    it finds anything else.

    ``restate(op, found)`` is the value an earlier enumerated change of the
    plan takes under this rule, or None: a rule applies to the plan's own
    earlier values (an enumerated change staged after it wins at approval).
    """
    key = ('rule', tool, rules.fingerprint_args(args))
    where = f' in {ws.doc_label(args["document"], quote=True)}' if args.get('document') else ''
    op, found, kept, left = _build_rule(ws, tool, args, list(unit), change + where, head + where,
                                        ws.rule_found_before(key), mode)
    explicit = {op_target(o): i for i, o in enumerate(ws.ops) if not rules.is_rule(o)
                and o.get('kind') not in SCOPES}
    explicit.pop(None, None)
    by_target = {op_target(o): o for o in found}
    rewrites = []
    if restate is not None:
        for t, i in explicit.items():
            new = restate(ws.ops[i], by_target.get(t))
            if new is not None:
                rewrites.append((i, new))
    if not kept:
        out = '' if quiet_when_empty and not rewrites else f'Nothing to change: no {what} matched.'
        if rewrites:
            with ws.staging():
                _rewrite_planned(ws, rewrites)
            out = ws.planned_note(0) + f' {_rewritten(len(rewrites))}'
        return out + left_for_analysis(left)
    docs = op['documents']
    _clear_of_reshapes(ws, docs, values_only=_values_only(kept))
    before = ws.rule_found.get(key)
    try:
        with ws.staging():
            _rewrite_planned(ws, rewrites)
            ws.add_op(op)
            ws.rule_found[key] = found
            # An earlier rule leaves to this one what this one changes again,
            # so the plan is measured once every rule is counted as it writes.
            settle_rules(ws)
            full = rules.too_many(KIND, ws.ops)
            if full:
                raise ToolError(full)
    except BaseException:
        if before is None:
            ws.rule_found.pop(key, None)
        else:
            ws.rule_found[key] = before
        raise
    ws.note_versions(docs)
    # as the plan holds it once every rule is counted
    op = next((o for o in ws.ops if rules.is_rule(o) and rules.target(o) == key), op)
    n, accepted = len(kept), op[work.COUNTED]
    sample = [c['label'] for c in op[CARD]['sample']]
    changes = rules.transition_lines(op[CARD].get(rules.TRANSITIONS) or [],
                                     op[CARD].get(rules.TRANSITIONS_MORE) or [0, 0], unit)
    return (ws.planned_note(1) + f'\n  One change covering {rules.count_line(n, unit, len(docs))}.'
            + (f' {accepted} of them replace work a person made or accepted, and the card says so.'
               if accepted else '')
            + (f'\nMatches {mode}.' if mode else '')
            + (('\nEvery distinct change it makes, the card lists the same:\n  ' + '\n  '.join(changes))
               if changes else '')
            + _by_document(ws, kept) + '\nFor example:\n  ' + '\n  '.join(sample)
            + (f'\n  … {n - len(sample)} more' if n > len(sample) else '')
            + '\nStored as one change, found again when the user approves.'
            + (f' {_rewritten(len(rewrites))}' if rewrites else '')
            + left_for_analysis(left))


def _build_rule(ws: Workspace, tool: str, args: Dict[str, Any], unit: list, change: str, head: str, earlier,
                mode: Optional[str] = None):
    """(rule op, what it found, what it writes, how many a planned analysis
    makes moot): the rule resolved now over the values the ``earlier`` rules
    leave, as approval will resolve it."""
    found = resolve_rule(ws, tool, args, earlier)
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
    if ws.prefer_scan:
        # A workspace that cannot query (the tests' fake) found it by reading
        # every document, and approval finds it the same way.
        op['scan'] = True
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
    if op.get('tool') in _TRANSITION_TOOLS:
        a = op.get('args') or {}
        notes = (rules.surprises(a.get('pattern') or '', bool(a.get('regex')), bool(a.get('whole')),
                                 bool(a.get('case_sensitive')))
                 if op.get('tool') == 'replace_in_field' else (lambda v: []))
        rows, more = rules.transitions(kept, lambda o: (_was(ws, o), _becomes(o)), notes)
        out[CARD][rules.TRANSITIONS] = rows
        out[CARD][rules.TRANSITIONS_MORE] = more
    return out


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
        kept = [o for o in writes if op_target(o) not in later]
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


def later_rule_wins(ops: List[Dict[str, Any]], rule_rows: set, row_key: str) -> List[Dict[str, Any]]:
    """``ops`` as approval resolved them, less each change a rule found that
    a later rule changes again (``rule_rows`` are the rules' rows, read from
    ``row_key``). The later one was found over the value the earlier one
    leaves, so it writes the value both make, once."""
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
        out.append(o)
    out.reverse()
    return out


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
            raise ToolError(clash_message(o, merge))


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
                raise ToolError(clash_message(o, merge))


def planned_changes(ws: Workspace) -> List[Dict[str, Any]]:
    """The plan with each rule in its place as the changes it writes now
    (what it found when staged, less what the plan's own changes and later
    rules take, as :func:`settle_rules` counts it), for a reader that wants
    every change one by one."""
    keep = rule_keep(ws, ws.ops)
    later: set = set()
    per: Dict[int, List[Dict[str, Any]]] = {}
    for i in reversed(range(len(ws.ops))):
        op = ws.ops[i]
        if not rules.is_rule(op):
            continue
        writes = [o for o in ws.rule_found.get(rules.target(op), []) if keep(o)]
        per[i] = [o for o in writes if op_target(o) not in later]
        later |= {op_target(o) for o in writes} - {None}
    out: List[Dict[str, Any]] = []
    for i, op in enumerate(ws.ops):
        out.extend(per[i] if i in per else [op])
    return out


def refresh_rules(ws: Workspace) -> None:
    """Resolve every rule of the plan again, in plan order, after a change to
    the plan that one of them may depend on (an earlier rule dropped), so what
    each one stores is what approval will find."""
    for op in list(ws.ops):
        if not rules.is_rule(op) or op.get('head') is None:
            continue
        key = rules.target(op)
        new, found, kept, _left = _build_rule(ws, op['tool'], op['args'], op.get('unit') or ['change', 'changes'],
                                              op.get('change') or '', op['head'], ws.rule_found_before(key))
        i = ws.ops.index(op)
        ws.rule_found[key] = found
        if kept:
            ws.ops[i] = new
        else:
            # Nothing left for it to change: a row of no changes says nothing.
            del ws.ops[i]
            ws._gone_at = -1


#: The key a rule op carries in the turn's plan for its card row, moved into
#: ``changes`` when the plan is packaged and never stored in ``ops``.
CARD = 'card'

# The kinds a rule may write and still share a plan with an analysis of a
# word it reaches: values, which the analysis makes moot where it rewrites
# them, never the text or the words themselves.
VALUE_KINDS = ('set_span', 'set_orthography', 'set_morpheme_form')


def _values_only(ops) -> bool:
    return all(op.get('kind') in VALUE_KINDS for op in ops)


def _rewritten(n: int) -> str:
    return f'{n} planned change{"s" if n != 1 else ""} rewritten by this one.'


def _rewrite_planned(ws: Workspace, rewrites) -> None:
    """Give each earlier enumerated change its new value, with its line."""
    for i, new in rewrites:
        op = ws.ops[i]
        key = 'value' if 'value' in op else 'form'
        old = op.get(key) or ''
        at = op.get('change_at') or 0
        place = (op.get('label') or '')[:max(0, at - 2)]
        line = change_of(op) or ''
        line = line.replace(qv(old), qv(new)) if qv(old) in line else f'{line} → {qv(new)}'
        ws.ops[i] = {**op, key: new, **labelled(place, line)}


def resolve_rule(ws: Workspace, tool: str, args: Dict[str, Any], earlier) -> List[Dict[str, Any]]:
    """What a rule resolves to now: its tool's resolver (``SCOPED``) over
    the stored values as the plan's earlier rules leave them (``earlier``,
    their found changes in plan order), never its enumerated changes. Staging
    and approval both resolve through here, so what approval finds is what
    was counted unless the project changed."""
    fn = SCOPED.get(tool)
    if fn is None:
        raise ToolError(f'unknown corpus-wide tool {tool!r}')
    with ws.resolving_rules(earlier):
        return fn(ws, dict(args), CANDIDATE_MAX)


def scope_reaches(ws: Workspace, doc_id: Optional[str]) -> bool:
    """Whether a corpus-wide change already planned reaches this document (or
    might, when the document is not known). A rule that writes values only
    does not count (``values_rule``)."""
    reach = {d for op in ws.ops if op.get('kind') in SCOPES and not values_rule(op)
             for d in (op.get('documents') or [])}
    return bool(reach) and (doc_id is None or doc_id in reach)


def values_rule(op: Dict[str, Any]) -> bool:
    """Whether ``op`` is a rule that writes values only (``VALUE_KINDS``). It
    may share a plan with anything that reshapes a document it reaches: it
    names what it writes by id, is resolved before anything is written, and
    what it resolves to then passes the checks an enumerated change passes
    (a change on something the plan removes or an analysis rewrites is left
    out), as the same change listed one by one would."""
    return rules.is_rule(op) and _values_only([{'kind': k} for k in (op.get('counts') or {})])


def _clear_of_reshapes(ws: Workspace, docs: List[str], values_only: bool = False) -> None:
    """A corpus-wide replacement reaches every document it matched, so a plan
    that already reshapes text or words in one of them cannot take it, unless
    it writes values only (``values_rule``)."""
    from .plan import RESHAPES
    if values_only:
        return
    reach = set(docs)
    for op in ws.ops:
        if op.get('kind') in RESHAPES and (op.get('doc') in reach or not op.get('doc')):
            raise ToolError('This plan already reshapes text or words in a document this replacement '
                            'reaches. Apply one, then plan the other (plan_status, drop_planned).')


def _names_morpheme_forms(ws: Workspace, field: str) -> bool:
    """Whether ``field`` addresses the stored morpheme forms rather than a
    field: one of a few spellings, and no field literally so named."""
    name = (field or '').strip().casefold()
    if name not in ('morpheme form', 'morpheme forms', 'morph form', 'form', 'forms', 'morpheme'):
        return False
    return not any(f.name.casefold() == name for f in ws.project.fields.values())


def t_respell_all(ws: Workspace, pattern: str, replacement: str, regex: bool = False,
                  whole: bool = False, document: Optional[str] = None,
                  case_sensitive: bool = False, morpheme_forms: bool = True, lexicon: bool = True) -> str:
    """PLAN: change the baseline spelling of every word matching a pattern
    (orthography migration). Each word is replaced whole, so its analysis,
    glosses, and links survive. Patterns apply within a word, never across
    word boundaries. As in the editor's Bulk Edit, the replacement is carried
    into the stored morpheme forms of the respelled words and into every
    lexicon headword it matches, unless switched off."""
    rep = _replacer(pattern, replacement, bool(regex), bool(whole), bool(case_sensitive))
    staged: List[Dict[str, Any]] = []
    n_words = n_morphs = n_entries = 0
    if not ws.use_scan(document):
        args = {'pattern': pattern, 'replacement': replacement, 'regex': bool(regex), 'whole': bool(whole),
                'case_sensitive': bool(case_sensitive), 'morpheme_forms': bool(morpheme_forms), 'lexicon': bool(lexicon)}
        staged = _scoped_respell(ws, args, CANDIDATE_MAX)
        kinds = [op['kind'] for op in staged]
        out = _stage(ws, 'respell_all', args, staged, 'respell', 'words')
        if staged:
            out += (f'\n({kinds.count("respell")} words, {kinds.count("set_morpheme_form")} morpheme forms, '
                    f'{kinds.count("rename_entry")} lexicon headwords.)')
        return out + (_kept_lexicons(ws, rep) if lexicon else '')
    analysed = analysed_morphemes(ws.ops)
    left = 0
    for doc in _docs(ws, document):
        for s in doc.sentences:
            for w in s.words:
                new = rep(w.surface)
                if new == w.surface:
                    continue
                if not new.strip():
                    raise ToolError(f'{ws.doc_label(doc.id)} {word_ref(s, w)}: "{w.surface}" would become empty; '
                                    'a respelling cannot remove a word (retype_sentence can)')
                check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{ws.doc_label(doc.id)} {word_ref(s, w)}')
                staged.append({'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new,
                               'doc': doc.id, **labelled(f'{ws.doc_label(doc.id)} {word_ref(s, w)}', f'respell {qv(w.surface)} → {qv(new)}')})
                n_words += 1
                if not morpheme_forms:
                    continue
                for m in w.morphemes:
                    if not has_own_form(m):
                        continue
                    nm = rep(m.form)
                    if nm == m.form or not nm.strip():
                        continue
                    if m.id in analysed:
                        left += 1
                        continue
                    staged.append(morpheme_form_op(ws, doc, word_ref(s, w), w, m, nm))
                    n_morphs += 1
    if lexicon:
        renames = _lexicon_renames(ws, rep)
        staged += renames
        n_entries = len(renames)
    _check_cap(len(staged))
    ws.add_ops(staged)
    out = _bulk_note(ws, staged, 'words')
    if staged:
        out += (f'\n({n_words} words, {n_morphs} morpheme forms, {n_entries} lexicon headwords.)')
    out += left_for_analysis(left)
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

    def restate(op, found):
        if op.get('kind') != 'set_orthography' or found is None:
            return None
        if op.get('value') and not overwrite:
            return None
        return found.get('value') if found.get('value') != op.get('value') else None
    return _stage_rule(ws, 'copy_to_orthography', args, ('word', 'words'),
                       change=f'{target} copied from {src}',
                       head=f'{target}: copy from {src}' + ('' if overwrite else ', where empty'),
                       what='words', restate=restate)


def _form_matcher(form: str):
    """Whether a value is the form, case folded as the server folds it (Java's
    simple case folding), so a scan of one document reaches the words the
    project-wide query would."""
    return _matcher(form, False, whole=True)


def t_set_field_for_form(ws: Workspace, form: str, field: str, value: str, only_empty: bool = True,
                         document: Optional[str] = None) -> str:
    """PLAN: one field value on every occurrence of a form (morpheme form for
    a morpheme field, word form for a word field). Staged as one rule."""
    f = ws.project.field(field)
    if f.scope == 'Sentence':
        raise ToolError(f'"{f.name}" is a sentence field; use set_field with sentence references')
    form = (form or '').strip()
    if not form:
        raise ToolError('Give a form.')
    value = '' if value is None else unmark(str(value), f.name)
    doc_id = ws.doc(document).id if document else None
    args = rules.normalize({'form': form, 'field': field, 'value': value, 'only_empty': only_empty,
                            'document': doc_id}, ('only_empty',))
    args['value'] = value
    edits = 0
    if ws.use_scan(document):
        # A word whose analysis the plan writes is read as that analysis, and
        # a value on one of its morphemes goes into it (as set_field does).
        same = _form_matcher(form)
        planned = {op.get('word_id'): op for op in ws.ops if op.get('kind') == 'set_analysis'}
        targets = []
        if f.scope != 'Word' and planned:
            for doc in _docs(ws, document):
                for s in doc.sentences:
                    for w in s.words:
                        for k, pm in enumerate((planned.get(w.id) or {}).get('morphemes') or [], start=1):
                            cur = next((fv.get('value') or '' for fv in pm.get('fields') or []
                                        if fv.get('layer_id') == f.layer_id), '')
                            if same(pm.get('form')) and cur != value and not (only_empty and cur):
                                targets.append((doc, f'{word_ref(s, w)}.m{k}'))
        if targets:
            with ws.staging():
                for doc, ref in targets:
                    edit_planned_morpheme(ws, doc, ref, _planned_place(ws, doc, ref), field=f, value=value)
            edits = len(targets)

    def restate(op, found):
        if op.get('kind') != 'set_span' or found is None:
            return None
        if only_empty and (op.get('value') or ''):
            return None
        return value if op.get('value') != value else None
    note = _stage_rule(ws, 'set_field_for_form', args, ('value', 'values'),
                       change=f'{f.name} = {qv(value)} on {qv(form)}',
                       head=f'{f.name}: {qv(value)} on every {qv(form)}' + (' without a value' if only_empty else ''),
                       what=f'occurrences of {qv(form)}' + (' without a value' if only_empty else ''),
                       restate=restate, quiet_when_empty=bool(edits))
    if edits:
        note += f' {edits} more in analyses this plan already holds, changed there.'
    return note


def t_set_analysis_for_form(ws: Workspace, form: str, morphemes: list, document: Optional[str] = None,
                            skip_analyzed: bool = False) -> str:
    """PLAN: apply one analysis (segmentation + morpheme fields) to every
    occurrence of a word form. With skip_analyzed=true, words that already
    have an analysis are left alone."""
    form = (form or '').strip()
    if not form:
        raise ToolError('Give a form.')
    if not ws.use_scan(document):
        return _set_analysis_for_form_q(ws, form, morphemes, bool(skip_analyzed))
    same = _form_matcher(form)
    targets = []
    for doc in _docs(ws, document):
        for s in doc.sentences:
            for w in s.words:
                if not same(w.surface):
                    continue
                if skip_analyzed and _analyzed(w):
                    continue
                targets.append((doc, s, w))
    _check_cap(len(targets))
    # Staged straight onto the real plan, one word at a time. It used to plan
    # into a scratch `ws.ops = []` so a failure part-way left nothing behind,
    # and that hid the plan from every guard `t_set_analysis` makes: a word
    # already being split, a corpus-wide change reaching the document, a
    # restore. Each looks at `ws.ops`, and each saw an empty plan. Instead the
    # whole batch is reserved up front (so the cap still refuses before
    # anything is staged) and the plan is put back as it was if one word
    # fails.
    ws.reserve(len(targets))
    saved_reported = ws.reported_replaced, ws.reported_unlinked
    first_note = ''
    planned = []
    with ws.staging():
        for doc, s, w in targets:
            note = t_set_analysis(ws, doc.id, word_ref(s, w), morphemes)
            planned.append(('analysis', w.id))
            if not first_note and 'differ from the surface' in note:
                first_note = note[note.index('(note'):]
    # Each inner call wrote a note of its own, and each said what it
    # superseded. Those notes are thrown away here, so what they reported
    # belongs to the one note this call does write: running the tool twice
    # over a form said nothing about the first run being replaced, nor about
    # the planned links to morphemes an earlier analysis had and this one
    # does not.
    ws.reported_replaced, ws.reported_unlinked = saved_reported
    # By target, not by position: an analysis already planned for one of these
    # words is REPLACED where it stands rather than appended.
    by_target = {op_target(op): op for op in ws.ops}
    ops = [by_target[t] for t in planned if t in by_target]
    return _bulk_note(ws, ops, f'occurrences of "{form}"') + (' ' + first_note if first_note else '')


def _set_analysis_for_form_q(ws: Workspace, form: str, morphemes: list, skip_analyzed: bool) -> str:
    """The query path: word occurrences and their morpheme chains by query,
    then one set_analysis op per word."""
    from .queries import q_analysis_targets, _docs_of
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.')
    out = parse_analysis(ws, morphemes)
    words, chains, spans = q_analysis_targets(ws, form, skip_analyzed, PLAN_MAX_OPS)
    _check_cap(len(words))
    ws.note_versions(w['document'] for w in words)
    budget = _docs_of([[w] for w in words])
    staged = []
    first_note = ''
    # The same refusals the scan path makes through t_set_analysis. This path
    # built its ops by hand and made none of them, so a plan already reshaping
    # one of these words, or holding a corpus-wide change over their
    # documents, was refused only at approval, if at all.
    for doc_id in sorted({w['document'] for w in words}):
        no_scope_reaches(ws, doc_id, ws.doc_label(doc_id))
    for w in words:
        ref = ws.corpus.label_ref(w['document'], w['id'], budget)
        refuse_shape_and_analysis(ws, w['id'], ref, analysing=True)
    for w in words:
        chain = sorted(chains.get(w['id']) or [], key=lambda m: (precedence(m), m.get('id')))
        existing = [{'id': m['id'], 'span_ids': spans.get(m['id']) or []} for m in chain]
        seg = join_morphemes([((m.get('metadata') or {}).get('form') or m.get('value') or '',
                               (m.get('metadata') or {}).get('morphType')) for m in chain])
        had_values = sum(len(spans.get(m['id']) or []) for m in chain)
        head = ws.corpus.label_ref(w['document'], w['id'], budget) + f' {qv(w.get("value") or "")}'
        op, note = analysis_op(ws, head, w.get('value') or '', w['id'], w['text'], w['begin'], w['end'],
                               existing, seg, had_values, out)
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
        raise ToolError('That entry is new in this plan; approve the plan first, then merge or rename it.')
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
    if not ws.prefer_scan:
        from .queries import q_entry_links
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
    # The merge and the reference repairs it carries are one change or none:
    # a repair refused (the plan is full, it names something else the plan
    # deletes) left the merge staged with the references still pointing at the
    # entry it removes, while the model was told the call had failed.
    with ws.staging():
        ws.add_op({'kind': 'merge_entries', 'keep_id': keep['id'], 'remove_id': remove['id'], 'links': links,
                   'label': f'Merge entry {_name(view, remove)} into {_name(view, keep)}: '
                            f'{move_phrase(len(links))}, delete the former'})
        refs = _ref_repair_ops(ws, view, plan_merge_refs, keep['id'], [remove['id']])
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
               'label': f'Rename entry {_name(view, it)} → {qv(new_form)}'})
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
               'label': f'Rename document {ws.doc_label(doc.id, quote=True)} → {qv(new_name)}'})
    return ws.planned_note(1)
