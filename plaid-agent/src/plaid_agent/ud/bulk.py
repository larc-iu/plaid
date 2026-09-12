"""Changes over the whole corpus at once.

A field-wide replacement is stored as a PREDICATE (the field, the pattern,
the replacement) and resolved to spans when the plan is approved, the same
way a whole-document review is (see :mod:`.review`). Stored per span it
would not fit the record; resolved at approval it is exact, because the plan
pins the version of every document the preview matched and approval
refuses a plan whose documents have moved on.

The engine applies the pattern, so only matches come back and a corpus of
any size can be searched: what is capped is the number of CHANGES one plan
may make, which is what the user has to be able to approve.
"""

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from .corpus import Corpus, rx
from .project import UdProject
from .tools import FIELDS, ToolError, Workspace, _check_value

REPLACE_FIELDS = FIELDS + ('deprel',)
REPLACE_MAX = 5000   # changes one plan may make; past it, narrow and go in passes
SAMPLE = 8


def replacer(pattern: str, replacement: str, regex: bool, whole: bool,
             case_sensitive: bool) -> Callable[[str], str]:
    """Case-insensitive by default, like search, so what search found is what
    the replacement hits. A regex replacement error (a bad backreference) is
    reported on the first value rather than crashing mid-plan."""
    if not pattern:
        raise ToolError('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    flags = 0 if case_sensitive else re.IGNORECASE
    body = pattern if regex else re.escape(pattern)
    try:
        compiled = re.compile(f'^(?:{body})$' if whole else body, flags)
    except re.error as e:
        raise ToolError(f'That is not a valid regular expression: {e}')

    def apply(value: str) -> str:
        try:
            return compiled.sub(replacement if regex else replacement.replace('\\', '\\\\'), value)
        except re.error as e:
            raise ToolError(f'The replacement is not valid for that pattern: {e}')
    return apply


def _where(c: Corpus, field: str, spec: Dict[str, Any], document_id: Optional[str]) -> Tuple[List[Any], List[str]]:
    if field == 'deprel':
        where: List[Any] = [c.dep('?r', value=spec)]
        if document_id:
            where.append(['in', '?r.doc', [document_id]])
        return where, ['?r']
    where = [c.field(field, '?s', value=spec), c.on('?s'), c.word('?t')]
    if document_id:
        where.append(['in', '?s.doc', [document_id]])
    return where, ['?s', '?t']


def matches(c: Corpus, field: str, spec: Dict[str, Any], document_id: Optional[str], cap: int) -> List[list]:
    """The entity rows the pattern matches, ``cap + 1`` at most so the caller
    can tell a capped read from a full one."""
    where, find = _where(c, field, spec, document_id)
    return c.entities(where, find, cap + 1, [[f'{find[-1]}.doc'], [f'{find[-1]}.begin']] if field != 'deprel' else None)


def changes(rows: List[list], field: str, rep: Callable[[str], str]) -> List[Dict[str, Any]]:
    """What a replacement changes, from the rows the engine matched: one
    entry per span or relation whose value actually differs afterwards."""
    out = []
    for row in rows:
        ent = row[0]
        if not isinstance(ent, dict):
            continue
        cur = ent.get('value') or ''
        if cur == '':
            continue
        new = rep(cur)
        if new == cur:
            continue
        entry = {'id': ent['id'], 'document_id': ent.get('document'), 'old': cur, 'new': new}
        if field != 'deprel':
            tok = row[1] if len(row) > 1 and isinstance(row[1], dict) else {}
            entry['token_id'] = tok.get('id')
            entry['layer_id'] = ent.get('layer')
        out.append(entry)
    return out


def spec_of(op: Dict[str, Any]) -> Tuple[Dict[str, Any], Callable[[str], str]]:
    spec = rx(op['pattern'], regex=bool(op.get('regex')), whole=bool(op.get('whole')),
              case_sensitive=bool(op.get('case_sensitive')))
    rep = replacer(op['pattern'], op.get('replacement') or '', bool(op.get('regex')),
                   bool(op.get('whole')), bool(op.get('case_sensitive')))
    return spec, rep


def resolve_replace(client, project: UdProject, op: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The per-span ops a stored replacement stands for, read from the corpus
    NOW. Approval has already refused the plan if a matched document moved,
    so this is what the preview counted."""
    from .tools import Workspace
    ws = Workspace(client, project)
    c = Corpus(ws)
    spec, rep = spec_of(op)
    field = op['field']
    rows = matches(c, field, spec, op.get('document_id'), REPLACE_MAX)
    if len(rows) > REPLACE_MAX:
        raise ValueError(f'the replacement now matches more than {REPLACE_MAX} values')
    out = []
    for ch in changes(rows, field, rep):
        if field == 'deprel':
            out.append({'kind': 'set_deprel', 'relation_id': ch['id'], 'deprel': ch['new'],
                        'document_id': ch['document_id'], 'ref': None,
                        'label': f'deprel "{ch["old"]}" → "{ch["new"]}"'})
        else:
            out.append({'kind': 'set_span', 'layer_id': ch['layer_id'], 'token_id': ch['token_id'],
                        'span_id': ch['id'], 'value': ch['new'], 'field': field,
                        'document_id': ch['document_id'], 'ref': None,
                        'label': f'{field} "{ch["old"]}" → "{ch["new"]}"'})
    return out


def t_replace_in_field(ws: Workspace, field: str = None, pattern: str = None, replacement: str = None,
                       regex: bool = False, whole: bool = False, document: str = None,
                       case_sensitive: bool = False) -> str:
    """PLAN: substitute inside every value of a column that matches, across
    the project or in one document."""
    if field not in REPLACE_FIELDS:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(REPLACE_FIELDS))
    if replacement is None:
        raise ToolError('Give replacement: the text that takes the place of what the pattern matches '
                        '("" clears it).')
    if field == 'deprel' and not (replacement or '').strip():
        raise ToolError('A dependency cannot have an empty label. del_relation removes a head outright.')
    rep = replacer(pattern, replacement, bool(regex), bool(whole), bool(case_sensitive))
    spec = rx(pattern, regex=bool(regex), whole=bool(whole), case_sensitive=bool(case_sensitive))
    document_id = ws.resolve_document_id(document) if document else None
    from .stats import _corpus
    c = _corpus(ws)
    ws.on_progress(f'Finding every {field} matching "{pattern}"…')
    rows = matches(c, field, spec, document_id, REPLACE_MAX)
    if len(rows) > REPLACE_MAX:
        raise ToolError(f'More than {REPLACE_MAX} {field} values match "{pattern}", more than one plan '
                        f'may change. Narrow it (a document, a stricter pattern) and go in passes.')
    found = changes(rows, field, rep)
    if not found:
        return (f'Nothing to change: no {field} matches "{pattern}"' if not rows
                else f'Nothing to change: {len(rows)} {field} value(s) match "{pattern}", but the '
                     f'replacement leaves every one of them as it is')
    # A closed vocabulary refuses what it does not list, whatever the pattern
    # turned the value into.
    if field in ('upos', 'xpos'):
        bad = sorted({ch['new'] for ch in found if ch['new']})
        for value in bad:
            _check_value(ws, field, value)
    docs = sorted({ch['document_id'] for ch in found if ch['document_id']})
    _clear_of_reshapes(ws, docs)
    names = {d['id']: d.get('name') or d['id'] for d in ws.documents()}
    sample = [f'"{names.get(ch["document_id"], ch["document_id"])}": {field} "{ch["old"]}" → "{ch["new"]}"'
              for ch in found[:SAMPLE]]
    where = f' in "{names.get(document_id)}"' if document_id else f' in {len(docs)} document(s)'
    ws.add_op({'kind': 'replace_scope', 'field': field, 'pattern': pattern, 'replacement': replacement,
               'regex': bool(regex), 'whole': bool(whole), 'case_sensitive': bool(case_sensitive),
               'document_id': document_id, 'documents': docs, 'count': len(found), 'ref': None,
               'label': f'{field}: replace "{pattern}" with "{replacement}" on {len(found)} value(s){where}'})
    return (f'Planned {len(found)} {field} change(s){where}, as one planned change. For example:\n  '
            + '\n  '.join(sample) + (f'\n  … {len(found) - SAMPLE} more' if len(found) > SAMPLE else '')
            + '\nsearch shows every match with its reference.')


def _clear_of_reshapes(ws: Workspace, docs: List[str]) -> None:
    """The refusals a corpus-wide change owes, over every document it reaches:
    the same ones `_guards` makes for one document, by id."""
    from .tools import docs_of_op
    reach = set(docs)
    for op in ws.ops:
        kind = op.get('kind')
        if kind == 'restore_document':
            raise ToolError('This plan restores a document, and a restore must be a plan of its own '
                            '(plan_status, drop_planned).')
        if kind in ('run_parse', 'split_sentence', 'merge_sentences', 'set_words') and docs_of_op(op) & reach:
            what = {'run_parse': 'parses', 'set_words': 'reshapes a token in'}.get(kind, 'moves a sentence boundary in')
            raise ToolError(f'This plan already {what} a document this replacement reaches, and that '
                            f'rewrites what the replacement would change. Apply one, then plan the other '
                            f'(plan_status, drop_planned).')
