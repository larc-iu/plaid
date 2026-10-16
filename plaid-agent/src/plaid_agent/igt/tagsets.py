"""Setting up tagsets: the controlled value lists a project holds its fields to.

One tool, ``tagsets``, behind a short description, because most conversations
never touch a tagset and every turn pays for every schema. Its ``help`` action
is where the model reads how the rest works, the way ``query_help`` comes before
``query``. Changes are planned like every other change and written when the
user approves.

The configuration is the app's (plaid-client ``workflows.igt.tagsets`` reads
it): a project's tagsets by name under ``config.igt.tagsets``, a field naming
one on its span layer, a document metadata field naming one in
``config.igt.documentMetadata``, and a lexicon keeping its own tagsets and its
entry fields' references in its own config. A closed tagset is also a rule core
holds on each annotation field it governs (``field_constraints``), so approval
declares it in the batch that writes the configuration, as the igt Settings
page does, and core refuses the batch when stored values break it.
"""

import json
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.constraints import value_parts, value_set_allows
from plaid_client.workflows.igt.glossing import is_lexical_part
from plaid_client.workflows.igt.tagsets import CLOSED, MIXED, MODES, field_constraints, mode_rule, normalize_tagset

from ..core.bidi import qv
from ..core.tools import ToolError
from .vocab import CORE_VOCAB_FIELDS

PROJECT = 'project'
SPAN, METADATA, ENTRY_FIELD = 'span', 'metadata', 'entry_field'

# Unlisted parts and refused values a check shows per field.
SHOWN = 40
# The brackets a part may hold when the delimiters do not split on them.
_PAIRS = ('()', '[]', '{}')
_BRACKETS = frozenset(''.join(_PAIRS))

HELP = '''Tagsets are the value lists fields are held to. Each has a mode:
- suggest: the list is offered and any value is accepted;
- mixed: grammatical tags must be listed and lexical glosses (lowercase words) may be anything;
- closed: only listed values are accepted.
delimiters are the characters that join a composite value's parts ("1SG.NOM" with "." is two parts), and a list holds the parts.
A project has its own tagsets for annotation fields and document metadata fields. A lexicon has its own for its entry fields: pass lexicon= for those.

Actions of the tagsets tool:
- check (tagset, optional field): the fields the tagset governs, the parts their stored values use that it does not list, with counts, and the stored values core would refuse if it were closed. A field named with field= is checked as though the tagset governed it.
- edit (tagset, changes): plans a new tagset, or a change to one. changes holds any of:
  mode, delimiters,
  add: values, as strings or {"value", "description"}; a listed value takes the new description,
  remove: values,
  add_used: "tags" or "all", to add every unlisted part the fields hold ("tags" leaves out lexical glosses),
  from_fields: the fields add_used reads, by default the ones the tagset governs,
  rename_to: a new name, and fields that use the tagset follow it,
  delete: true, only for a tagset no field uses.
- assign (field, tagset): plans a field's tagset. Pass tagset "" for none. field is an annotation field, a document metadata field, or with lexicon= a lexicon entry field.

Tagset changes are settings: they are a plan of their own, which holds no other change, and only a maintainer may approve one.
Core refuses to close a list, or to assign a closed list, while a stored value in an annotation field that a person or an approved plan wrote breaks it, and then nothing in the plan is written. It lets stay a value an import, a document copy or a restore set, and an unconfirmed machine value. check and edit say which values core would refuse: tell the user, and plan fixes to them first, as a separate plan the user approves, then the close.'''


def t_tagsets(ws, action: str, tagset: Optional[str] = None, field: Optional[str] = None,
              lexicon: Optional[str] = None, changes: Optional[Dict[str, Any]] = None) -> str:
    """PLAN: tagset setup, behind one action argument (see HELP)."""
    act = (action or '').strip().lower()
    if act == 'help':
        return HELP
    if act == 'check':
        return _check(ws, _need(tagset, 'tagset'), field, lexicon)
    if act == 'edit':
        return _edit(ws, _need(tagset, 'tagset'), lexicon, changes or {})
    if act == 'assign':
        if tagset is None:
            raise ToolError('assign needs tagset: a tagset name, or "" for none.')
        return _assign(ws, _need(field, 'field'), tagset, lexicon)
    raise ToolError('action is one of help, check, edit, assign. Call with action "help" first.')


def _need(value, name: str) -> str:
    v = (value or '').strip() if isinstance(value, str) else ''
    if not v:
        raise ToolError(f'This action needs {name}.')
    return v


# --- the state the plan leaves -------------------------------------------------------

def _owner(ws, lexicon: Optional[str]) -> Tuple[str, str, Optional[dict]]:
    """(owner key, words for it, the lexicon or None)."""
    if lexicon:
        try:
            v = ws.project.vocab(lexicon)
        except ValueError as e:
            raise ToolError(str(e))
        return v['id'], f'lexicon {qv(v["name"])}', v
    return PROJECT, 'the project', None


def _stored_tagsets(ws, owner: str) -> Dict[str, dict]:
    if owner == PROJECT:
        return dict(ws.project.tagsets)
    v = next(v for v in ws.project.vocabs if v['id'] == owner)
    return dict(v.get('all_tagsets') or {})


def _ops(ws, kind: str, owner: str) -> List[dict]:
    return [op for op in ws.ops if op.get('kind') == kind and op.get('owner') == owner]


def planned_tagsets(ws, owner: str) -> Dict[str, dict]:
    """The owner's tagsets by name once the plan is applied."""
    out = _stored_tagsets(ws, owner)
    for op in _ops(ws, 'set_tagset', owner):
        out.pop(op['was'], None)
        if op.get('after') is not None:
            out[op['name']] = {**op['after'], 'name': op['name']}
    return out


def _renames(ws, owner: str) -> Dict[str, str]:
    return {op['was']: op['name'] for op in _ops(ws, 'set_tagset', owner)
            if op.get('after') is not None and op['was'] != op['name']}


def _fields(ws, owner: str) -> List[dict]:
    """Every field the owner's tagsets may govern, as {kind, key, name,
    tagset}, ``tagset`` the name it references once the plan is applied."""
    renames = _renames(ws, owner)
    out = []
    if owner == PROJECT:
        for f in ws.project.fields.values():
            out.append({'kind': SPAN, 'key': f.layer_id, 'name': f.name, 'tagset': f.tagset_name, 'field': f})
        for name in ws.project.document_metadata:
            out.append({'kind': METADATA, 'key': name, 'name': f'document metadata {name}',
                        'tagset': ws.project.metadata_tagset_names.get(name)})
    else:
        v = next(v for v in ws.project.vocabs if v['id'] == owner)
        for spec in v.get('fields') or []:
            out.append({'kind': ENTRY_FIELD, 'key': spec['name'], 'name': f'entry field {spec["name"]}',
                        'tagset': spec.get('tagset'), 'vocab': v})
    for f in out:
        f['tagset'] = renames.get(f['tagset'], f['tagset'])
    for op in _ops(ws, 'assign_tagset', owner):
        for f in out:
            if f['kind'] == op['field_kind'] and f['key'] == op['key']:
                f['tagset'] = op.get('after')
    return out


def _find(tagsets: Dict[str, dict], name: str) -> Optional[str]:
    """The tagset name as stored, matched case-insensitively."""
    if name in tagsets:
        return name
    return next((n for n in tagsets if n.casefold() == name.casefold()), None)


def _no_tagset(name: str, where: str, tagsets: Dict[str, dict]) -> ToolError:
    return ToolError(f'{where.capitalize()} has no tagset {qv(name)}. Tagsets: '
                     + (', '.join(qv(n) for n in tagsets) or '(none)'))


# --- what the fields hold ---------------------------------------------------------

def _attested(ws, f: dict) -> List[Tuple[str, int]]:
    """[(value, count)] a field holds."""
    if f['kind'] == SPAN:
        c = ws.corpus
        return [(r[0], r[-1]) for r in c.group([c.span('?s', f['key'])], ['?s.value'])
                if isinstance(r[0], str) and r[0].strip()]
    counts: Dict[str, int] = {}
    if f['kind'] == METADATA:
        values = [(d.get('metadata') or {}).get(f['key']) for d in ws.documents()]
    else:
        values = [(it.get('metadata') or {}).get(f['key']) for it in ws.lexicon(f['vocab'])]
    for v in values:
        for one in (v if isinstance(v, list) else [v]):
            if isinstance(one, str) and one.strip():
                counts[one] = counts.get(one, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def _parts(value: str, delimiters: str) -> List[str]:
    return [p for p in value_parts(value, delimiters) if p]


def _unlisted(attested, t: dict) -> List[Tuple[str, int, bool]]:
    """[(part, count, lexical)] the values use that ``t`` does not list, most
    frequent first. Under mixed a lexical part is accepted, so it is left out."""
    listed = {v['value'] for v in t['values']}
    counts: Dict[str, int] = {}
    for value, n in attested:
        for p in _parts(value, t['delimiters']):
            if p not in listed:
                counts[p] = counts.get(p, 0) + n
    rows = [(p, n, is_lexical_part(p)) for p, n in counts.items()]
    if t['mode'] == MIXED:
        rows = [r for r in rows if not r[2]]
    return sorted(rows, key=lambda r: (-r[1], r[0]))


def _with_empty_part(attested, t: dict) -> List[Tuple[str, int]]:
    """[(value, count)] of the values holding an empty part (a delimiter with
    nothing on one side, as in "V..N"), which a closed list refuses whatever
    it lists, most frequent first."""
    rows = [(v, n) for v, n in attested if isinstance(v, str) and v.strip() and t['delimiters']
            and '' in value_parts(v, t['delimiters'])]
    return sorted(rows, key=lambda r: (-r[1], r[0]))


def _rule(t: Optional[dict]) -> Optional[dict]:
    """The value-set rule a tagset puts on the fields it governs, None unless
    it is closed (``field_constraints``)."""
    if not t or t.get('mode') != CLOSED:
        return None
    return {'values': [v['value'] for v in t['values']], 'delimiters': t['delimiters'] or '', 'parts': 'all'}


def _same_rule(a: Optional[dict], b: Optional[dict]) -> bool:
    if a is None or b is None:
        return a is b
    return (sorted(a.get('values') or []) == sorted(b.get('values') or [])
            and (a.get('delimiters') or '') == (b.get('delimiters') or '')
            and (a.get('parts') or 'all') == (b.get('parts') or 'all'))


def _held(f: dict, t: dict) -> bool:
    """Whether core holds closed ``t``'s list on span field ``f`` (the
    layer's stored rules, not the settings)."""
    rule = _rule(t)
    return rule is not None and any(_same_rule(rule, c) for c in f['field'].value_sets)


def _refused(attested, t: dict) -> List[Tuple[str, int]]:
    """The stored values off a closed ``t``, as core's rule reads them."""
    rule = _rule({**t, 'mode': CLOSED})
    return [(v, n) for v, n in attested if not value_set_allows(rule, v)]


def _core_refused(ws, f: dict, t: dict, limit: int = SHOWN) -> dict:
    """What core answers for span field ``f`` closed to ``t``: the stored
    values a declaration of the list would be refused for, read by core's own
    rule with its exemptions (an unconfirmed machine value, a value an import,
    a document copy or a restore set), as {count, value_count, values}."""
    return ws.client.span_layers.refused_values(f['key'], _rule({**t, 'mode': CLOSED}), limit=limit)


def _part(p: str) -> str:
    """A part as igt's notice names it: an empty one (a delimiter with nothing
    on one side) as "an empty part"."""
    return 'an empty part' if p == '' else qv(p)


def _refused_value(v: dict) -> str:
    """One refused value with its count, and the parts off the list when core
    names fewer than the whole value ("1SG.NOM" (2, "1SG" not listed),
    "V..N" (1, an empty part not listed))."""
    value = v['value']
    parts = [p for p in (v.get('parts') or []) if isinstance(p, str)]
    off = '' if not parts or parts == [value] else ', ' + ', '.join(_part(p) for p in parts) + ' not listed'
    return f'{qv(value) if isinstance(value, str) else value} ({v["count"]}{off})'


def _refused_line(r: dict) -> str:
    """Core's answer for one field, from the count on."""
    n, distinct = r['count'], r['value_count']
    shown = ', '.join(_refused_value(v) for v in r['values'][:SHOWN])
    more = distinct - min(len(r['values']), SHOWN)
    return (_stored_n(n) + (f', {distinct} distinct' if distinct != n else '') + ': ' + shown
            + (f', and {more} more' if more > 0 else ''))


def _let_stay_note(m: int) -> str:
    return (f' Besides, {m} stored value{"s" if m != 1 else ""} off the list that core lets stay (unconfirmed '
            'machine values, or set by an import, a document copy or a restore).' if m > 0 else '')


def _listing(rows, fmt) -> str:
    shown = ', '.join(fmt(r) for r in rows[:SHOWN])
    return shown + (f', and {len(rows) - SHOWN} more' if len(rows) > SHOWN else '')


def _check(ws, name: str, field: Optional[str], lexicon: Optional[str]) -> str:
    owner, where, _ = _owner(ws, lexicon)
    tagsets = planned_tagsets(ws, owner)
    key = _find(tagsets, name)
    if key is None:
        raise _no_tagset(name, where, tagsets)
    t = tagsets[key]
    fields = _fields(ws, owner)
    governed = [f for f in fields if f['tagset'] == key]
    if field:
        governed = [_field(ws, owner, fields, field)]
    old = _stored_tagsets(ws, owner).get(key) if owner == PROJECT else None
    as_stored = old is not None and old == {**t, 'name': old['name']}
    lines = [f'Tagset {qv(key)} of {where} ({"as planned" if _ops(ws, "set_tagset", owner) else "as stored"}): '
             f'{t["mode"]}, {len(t["values"])} values, delimiters {qv(t["delimiters"]) if t["delimiters"] else "none"}. '
             + mode_rule(t)]
    if not governed:
        lines.append('No field uses it. Name one with field= to check it against that field.')
    ws.corpus.forget_clipping()
    for f in governed:
        attested = _attested(ws, f)
        rows = _unlisted(attested, t)
        head = f'{f["name"]}: {sum(n for _, n in attested)} values'
        empty = _with_empty_part(attested, t)
        found = ([f'{len(rows)} unlisted parts'] if rows else []) + (
            [f'{len(empty)} distinct value{"s" if len(empty) != 1 else ""} with an empty part'] if empty else [])
        lines.append(head + (', ' + ' and '.join(found) if found else ', every part listed') + '.')
        if rows:
            words = [r for r in rows if r[2]]
            # Parts core reads that are no tag: a year glossed as itself, or
            # "YON)" of bz(PDIR.YON) when brackets are no delimiter. A close
            # needs them listed all the same.
            bracketed = [r for r in rows if not r[2] and _BRACKETS.intersection(r[0])]
            letterless = [r for r in rows if not r[2] and not any(c.isalpha() for c in r[0])
                          and not _BRACKETS.intersection(r[0])]
            tags = [r for r in rows if not r[2] and r not in bracketed and r not in letterless]
            if tags:
                lines.append('  Tags: ' + _listing(tags, lambda r: f'{r[0]} ({r[1]})'))
            if bracketed:
                held = set(''.join(r[0] for r in bracketed))
                split = ''.join(pair for pair in _PAIRS if held.intersection(pair))
                lines.append(f'  Parts holding a bracket, which the delimiters do not split (add "{split}" to the '
                             'delimiters to split them): ' + _listing(bracketed, lambda r: f'{r[0]} ({r[1]})'))
            if letterless:
                lines.append('  Parts without a letter: ' + _listing(letterless, lambda r: f'{r[0]} ({r[1]})'))
            if words:
                lines.append('  Lexical glosses: ' + _listing(words, lambda r: f'{r[0]} ({r[1]})'))
        if empty:
            # A delimiter with nothing on one side: no list holds an empty
            # part, so a closed list refuses the value whatever it lists.
            lines.append('  An empty part, which a closed list refuses: '
                         + _listing(empty, lambda r: f'{qv(r[0])} ({r[1]})'))
        if f['kind'] != SPAN:
            continue
        if as_stored and _held(f, t):
            # Core holds every write to it, so what is off it now is what core let stay.
            kept = _refused(attested, t)
            if kept:
                lines.append(f'  Off the closed list, kept as core lets them stay: {_stored_n(len(kept))}: '
                             + _listing(kept, lambda r: f'{qv(r[0])} ({r[1]})'))
            continue
        if as_stored and t['mode'] == CLOSED and f['field'].tagset_name == key:
            lines.append(f'  Closed in the settings, but core does not hold the list on {f["name"]}: writes to it '
                         'are not checked against it until a change to the list, or to the field\'s tagset, '
                         'declares it.')
        # Said before any staging: a close that adds every part in use would
        # list the word glosses as tags (the edit refuses that in one call).
        every = _unlisted(attested, {**t, 'mode': CLOSED})
        words_n = sum(1 for r in every if r[2])
        if every and words_n * 2 > len(every):
            lines.append(f'  {words_n} of the {len(every)} unlisted parts of {f["name"]} are word glosses. Closing the '
                         'list with add_used would list them as tags: ask the user whether they mean mixed (tags '
                         'enforced, word glosses free) before planning a close.')
        r = _core_refused(ws, f, t)
        stay = sum(n for _, n in _refused(attested, t)) - r['count']
        if r['count']:
            lines.append('  Closed, core would refuse ' + _refused_line(r) + '.' + _let_stay_note(stay))
        elif stay > 0:
            lines.append('  Closed, core would refuse none.' + _let_stay_note(stay))
    note = ws.corpus.clipped_note()
    return '\n'.join(lines) + (f'\n{note}' if note else '')


def _stored_n(n: int) -> str:
    return f'{n} stored value{"s" if n != 1 else ""}'


def _field(ws, owner: str, fields: List[dict], name: str) -> dict:
    key = name.strip()
    if owner == PROJECT:
        meta = [f for f in fields if f['kind'] == METADATA and f['key'].casefold() == key.casefold()]
        try:
            layer = ws.project.field(key)
        except ValueError as e:
            if meta:
                return meta[0]
            raise ToolError(f'{e} Document metadata fields: '
                            + (', '.join(ws.project.document_metadata) or '(none)'))
        return next(f for f in fields if f['kind'] == SPAN and f['key'] == layer.layer_id)
    hit = [f for f in fields if f['key'].casefold() == key.casefold()]
    if not hit:
        raise ToolError(f'No entry field {qv(key)}. Entry fields: ' + ', '.join(f['key'] for f in fields))
    return hit[0]


# --- planning ------------------------------------------------------------------------

def _require_maintainer(ws, lexicon: Optional[dict]) -> None:
    """Refuse what the requester could not approve: settings are a
    maintainer's. Unknown requesters (no id) are left to the server."""
    uid = getattr(ws, 'requester_id', None)
    if uid is None or ws.requester_is_admin():
        return
    if lexicon is not None:
        maintainers = lexicon.get('maintainers') or []
        what = f'the lexicon {qv(lexicon["name"])}'
    else:
        try:
            maintainers = ws.client.projects.get(ws.project.id).get('maintainers') or []
        except Exception:  # noqa: BLE001 - unreadable: the server decides at approval
            return
        what = 'this project'
    if uid not in maintainers:
        raise ToolError(f'Only a maintainer of {what} may change its tagsets, and the user is not one. '
                        'Tell them who can.')


def _values(raw, name: str) -> List[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ToolError(f'{name} is a list.')
    out = []
    for v in raw:
        if isinstance(v, str):
            v = {'value': v}
        if not isinstance(v, dict) or not isinstance(v.get('value'), str) or not v['value'].strip():
            raise ToolError(f'Each value in {name} is a string or {{"value", "description"}}.')
        # Only what the app writes for a value it is given: a stored value's
        # other keys stay as stored, and approval reads back exactly this.
        rec = {'value': v['value'].strip()}
        if isinstance(v.get('description'), str):
            rec['description'] = v['description']
        out.append(rec)
    return out


EDIT_KEYS = ('mode', 'delimiters', 'add', 'remove', 'add_used', 'from_fields', 'rename_to', 'delete')


def _edit(ws, name: str, lexicon: Optional[str], changes: Dict[str, Any]) -> str:
    if not isinstance(changes, dict):
        raise ToolError('changes is an object. See action "help".')
    unknown = [k for k in changes if k not in EDIT_KEYS]
    if unknown:
        raise ToolError(f'Unknown in changes: {", ".join(unknown)}. They are: {", ".join(EDIT_KEYS)}.')
    owner, where, vocab = _owner(ws, lexicon)
    _require_maintainer(ws, vocab)
    tagsets = planned_tagsets(ws, owner)
    key = _find(tagsets, name)
    fields = _fields(ws, owner)
    prior = next((op for op in _ops(ws, 'set_tagset', owner) if key is not None and op['name'] == key), None)
    if key is None:
        # A stored tagset the plan already renames or deletes, named by its
        # stored name: a rename is edited under its new name, and a deleted
        # one made again is an edit of the stored one.
        gone = next((op for op in _ops(ws, 'set_tagset', owner)
                     if op['was'].casefold() == name.casefold()), None)
        if gone is not None and gone.get('after') is not None:
            raise ToolError(f'This plan renames {qv(gone["was"])} to {qv(gone["name"])}: edit {qv(gone["name"])}.')
        if gone is not None:
            name = gone['was']
    was = prior['was'] if prior else (key or name)
    stored = _stored_tagsets(ws, owner).get(was)
    using = [f for f in fields if key is not None and f['tagset'] == key]
    notes: List[str] = []

    if changes.get('delete'):
        if key is None:
            raise _no_tagset(name, where, tagsets)
        if using:
            raise ToolError(f'{", ".join(f["name"] for f in using)} use {qv(key)}. Assign those fields another '
                            'tagset or none first.')
        return _stage_tagset(ws, owner, was, key, stored, None, f'Delete the tagset {qv(key)}', notes)

    t = dict(tagsets[key]) if key is not None else {'name': name, 'mode': 'suggest', 'delimiters': '', 'values': []}
    new = key is None
    if new and changes.get('rename_to'):
        raise ToolError(f'{where.capitalize()} has no tagset {qv(name)} to rename.')
    said: List[str] = []
    if 'mode' in changes:
        mode = str(changes['mode'] or '').strip().lower()
        if mode == 'open':
            mode = 'suggest'
        if mode not in MODES:
            raise ToolError('mode is suggest, mixed or closed.')
        if mode != t['mode']:
            said.append(f'mode {t["mode"]} → {mode}' if not new else f'mode {mode}')
        t['mode'] = mode
    if 'delimiters' in changes:
        raw = changes['delimiters']
        # A model may list them (['.', ':']) rather than write them as one string.
        raw = ''.join(str(x) for x in raw) if isinstance(raw, list) else str(raw or '')
        d = ''.join(dict.fromkeys(''.join(raw.split())))
        if d != t['delimiters']:
            said.append(f'delimiters {qv(d) if d else "none"}')
        t['delimiters'] = d
    values = [dict(v) for v in t['values']]
    by_value = {v['value']: v for v in values}
    added: List[str] = []
    described: List[str] = []

    def add(rec):
        old = by_value.get(rec['value'])
        if old is None:
            values.append(rec)
            by_value[rec['value']] = rec
            added.append(rec['value'])
        elif rec.get('description') is not None and rec.get('description') != old.get('description'):
            old['description'] = rec['description']
            described.append(rec['value'])

    for rec in _values(changes.get('add'), 'add'):
        add(rec)
    used = changes.get('add_used')
    if used is not None:
        if used not in ('tags', 'all'):
            raise ToolError('add_used is "tags" or "all".')
        sources = using
        if changes.get('from_fields') is not None:
            names = changes['from_fields']
            if not isinstance(names, list) or not names:
                raise ToolError('from_fields is a list of field names.')
            sources = [_field(ws, owner, fields, str(n)) for n in names]
        if not sources:
            raise ToolError(f'No field uses {qv(name)}, so add_used has nothing to read. Name fields in from_fields.')
        ws.corpus.forget_clipping()
        reading = {**t, 'values': values, 'mode': 'suggest'}
        before = len(added)
        skipped = words = 0
        for f in sources:
            for part, _n, lexical in _unlisted(_attested(ws, f), reading):
                if lexical and used == 'tags':
                    skipped += 1
                    continue
                words += lexical and part not in by_value
                add({'value': part})
        clip = ws.corpus.clipped_note()
        notes.append(f'{len(added) - before} values in use added from {", ".join(f["name"] for f in sources)}'
                     + (f', {skipped} lexical glosses left out' if skipped else '') + '.' + (f' {clip}' if clip else ''))
        n_added = len(added) - before
        if words and t['mode'] == CLOSED and 'mode' in changes and words * 2 > n_added:
            # Closed with every part in use at once, most of them word glosses:
            # the user is asked first (bench igt-tagset-close-hard).
            raise ToolError(f'Nothing planned: {words} of the {n_added} values add_used would add are word glosses, '
                            'which a closed list would hold as tags. First ask the user whether they mean mixed (tags '
                            'enforced, word glosses free). Then call again, listing in add the values they want '
                            'listed.')
        if words:
            notes.append(f'{words} of them are ordinary word glosses, which make a tag list a word list: say so '
                         'to the user, and ask before planning it unless they asked for exactly that.')
        joined = [v for v in added[before:] if any(ch in v for ch in '.:')]
        if joined and not t['delimiters']:
            notes.append(f'The tagset has no delimiters, so values such as {qv(joined[0])} are listed whole. '
                         'To list their tags, set delimiters (e.g. ".:") in the same call.')
    removed = []
    for v in _values(changes.get('remove'), 'remove'):
        if v['value'] in by_value:
            values.remove(by_value.pop(v['value']))
            removed.append(v['value'])
        else:
            notes.append(f'{qv(v["value"])} is not listed, so it was not removed.')
    t['values'] = values
    if added:
        said.append(f'add {_few(added)}')
    if described:
        said.append(f'describe {_few(described)}')
    if removed:
        said.append(f'remove {_few(removed)}')
    target = key or name
    rename = changes.get('rename_to')
    if rename is not None:
        rename = str(rename).strip()
        if not rename:
            raise ToolError('rename_to is a name.')
        clash = _find(tagsets, rename)
        if clash is not None and clash != key:
            raise ToolError(f'{where.capitalize()} already has a tagset {qv(clash)}.')
        taken = _find(_stored_tagsets(ws, owner), rename)
        if taken is not None and taken != was:
            raise ToolError(f'{qv(taken)} is a stored tagset\'s name, which this plan frees: a tagset can take it '
                            'in a later plan, once this one is approved.')
        if rename != key:
            said.append(f'rename to {qv(rename)}')
            target = rename
    if not said and not new:
        return 'Nothing to change: the tagset already reads so.' + (' ' + ' '.join(notes) if notes else '')
    after = normalize_tagset(t, target)
    label = (f'New tagset {qv(target)}' if new else f'Tagset {qv(key)}') + (': ' + ', '.join(said) if said else '')
    return _stage_tagset(ws, owner, was, target, stored, after, label, notes)


def _few(values: List[str], n: int = 8) -> str:
    return ', '.join(values[:n]) + (f' and {len(values) - n} more' if len(values) > n else '')


def _stage_tagset(ws, owner, was, name, stored, after, label, notes) -> str:
    rec = None if after is None else {k: v for k, v in after.items() if k != 'name'}
    old_name = next((op['name'] for op in _ops(ws, 'set_tagset', owner) if op['was'] == was), was)
    with ws.staging():
        ws.add_op({'kind': 'set_tagset', 'owner': owner, 'was': was, 'name': name,
                   'before': None if stored is None else {k: v for k, v in stored.items() if k != 'name'},
                   'after': rec, 'label': label})
        # A field this plan assigns the tagset to follows a rename, as a
        # field that stores its name does when the plan is applied.
        if rec is not None and name != old_name:
            for op in _ops(ws, 'assign_tagset', owner):
                if op.get('after') == old_name:
                    field = op['label'].rsplit(': ', 1)[0]
                    ws.add_op({**op, 'after': name, 'label': f'{field}: tagset {qv(name)}'})
    return _planned(ws, owner, notes)


def _assign(ws, field: str, tagset: str, lexicon: Optional[str]) -> str:
    owner, where, vocab = _owner(ws, lexicon)
    _require_maintainer(ws, vocab)
    fields = _fields(ws, owner)
    f = _field(ws, owner, fields, field)
    name = tagset.strip() or None
    if name is not None:
        tagsets = planned_tagsets(ws, owner)
        found = _find(tagsets, name)
        if found is None:
            raise _no_tagset(name, where, tagsets)
        name = found
    if f['tagset'] == name:
        return f'{f["name"]} already ' + (f'uses {qv(name)}.' if name else 'has no tagset.')
    stored = _stored_field_tagset(ws, owner, f)
    ws.add_op({'kind': 'assign_tagset', 'owner': owner, 'field_kind': f['kind'], 'key': f['key'],
               'before': stored, 'after': name,
               'label': f'{f["name"]}: ' + (f'tagset {qv(name)}' if name else 'no tagset')})
    return _planned(ws, owner, [])


def _stored_field_tagset(ws, owner: str, f: dict) -> Optional[str]:
    if f['kind'] == SPAN:
        return f['field'].tagset_name
    if f['kind'] == METADATA:
        return ws.project.metadata_tagset_names.get(f['key'])
    spec = next((s for s in f['vocab'].get('fields') or [] if s['name'] == f['key']), {})
    return spec.get('tagset')


def _planned(ws, owner: str, notes: List[str]) -> str:
    """The planned note, and for the project the stored values a closed list
    the plan puts on an annotation field would have core refuse."""
    out = ws.planned_note(1)
    if notes:
        out += ' ' + ' '.join(notes)
    if owner != PROJECT:
        return out
    tagsets = planned_tagsets(ws, owner)
    stored = _stored_tagsets(ws, owner)
    breaks = []
    words = refused_n = 0
    ws.corpus.forget_clipping()
    for f in _fields(ws, owner):
        t = tagsets.get(f['tagset']) if f['tagset'] else None
        if f['kind'] != SPAN or not t or t['mode'] != CLOSED:
            continue
        old = stored.get(f['field'].tagset_name) if f['field'].tagset_name else None
        # Asked only of a field whose rules approval changes, the ones it
        # declares (queue_settings), and not of one that holds them already.
        if _same_rule(_rule(old), _rule(t)) or _held(f, t):
            continue
        # As many values as core lists, the sample the word glosses are
        # counted on.
        r = _core_refused(ws, f, t, limit=100)
        if not r['count']:
            continue
        refused_n += min(r['value_count'], len(r['values']))
        words += sum(1 for v in r['values'] if isinstance(v['value'], str)
                     and all(is_lexical_part(p) for p in _parts(v['value'], t['delimiters'])))
        breaks.append(f'{f["name"]} ({_refused_line(r)})')
    if breaks:
        out += (' Core will refuse this approval, writing nothing, while these stored values break the closed '
                'list: ' + '; '.join(breaks) + '. Tell the user. Add them to the list, leave it open, or drop '
                'this and plan changes to them first (a plan of their own).')
        if words * 2 > refused_n:
            out += (f' {words} of them are ordinary word glosses: a closed list would have to list every word '
                    'gloss. Ask the user whether they mean mixed (tags enforced, word glosses free) before '
                    'planning more.')
    return out


# --- approval ------------------------------------------------------------------------
#
# What the plan stages is the tagset as it will read and the name each field
# will use. A delegated token may not change a project's or a lexicon's
# settings, nor declare a layer's rules (core, H9-ACL-1), so the app writes them
# with the user's own session when they approve (plaid-igt
# `domain/tagsetPlan.js`), and only then sends the approval. The executor writes
# nothing: it reads the settings and records the plan applied when they read as
# planned (`verify_settings`). `check_settings` and `queue_settings` are the
# app's write in Python, for scripts and tests (`write_settings`).

SETTINGS_APART = ('Tagset changes are settings, a plan of their own: this plan already holds other changes. '
                  'Finish this plan with the user first (approve or discard), then plan the other.')

IGT = 'igt'
REMEDIABLE = frozenset(('coextensive', 'single-span', 'single-link', 'same-ancestor'))
SETTINGS_KINDS = ('set_tagset', 'assign_tagset')


def settings_ops(ops) -> List[dict]:
    return [op for op in ops if op.get('kind') in SETTINGS_KINDS]


def _igt(cfg) -> dict:
    v = (cfg or {}).get(IGT)
    return v if isinstance(v, dict) else {}


def _span_layers(p) -> List[dict]:
    return [sl for tl in p.get('text_layers') or [] for tk in tl.get('token_layers') or []
            for sl in tk.get('span_layers') or [] if _igt(sl.get('config')).get('scope')]


def _norm(raw, name) -> dict:
    return {k: v for k, v in normalize_tagset(raw, name).items() if k != 'name'}


def _comparable(t) -> Optional[dict]:
    """A tagset as approval compares it, as the app does (tagsetPlan.js
    `comparable`): its values by value and description only, a description of
    None as none."""
    if t is None:
        return None
    return {'delimiters': t.get('delimiters') or '', 'mode': t.get('mode'),
            'values': [{'value': v['value'], **({'description': v['description']}
                                                if v.get('description') is not None else {})}
                       for v in t.get('values') or []]}


def _live(client, project, owner: str):
    """(config, span layers or [], the entry fields map or None) as stored now."""
    if owner == PROJECT:
        p = client.projects.get(project.id)
        return p.get('config') or {}, _span_layers(p), None
    v = client.vocab_layers.get(owner)
    fields = _igt(v.get('config')).get('fields')
    return v.get('config') or {}, [], fields if isinstance(fields, dict) else {}


def _reference(cfg, layers, entry_fields, op) -> Optional[str]:
    kind, key = op['field_kind'], op['key']
    if kind == SPAN:
        sl = next((sl for sl in layers if sl.get('id') == key), None)
        name = _igt((sl or {}).get('config')).get('tagset')
    elif kind == METADATA:
        m = next((m for m in _igt(cfg).get('documentMetadata') or [] if isinstance(m, dict) and m.get('name') == key),
                 None)
        name = (m or {}).get('tagset')
    else:
        spec = (entry_fields or {}).get(key)
        name = spec.get('tagset') if isinstance(spec, dict) else None
    return (name.strip() or None) if isinstance(name, str) else None


def check_settings(client, project, ops) -> List[str]:
    """Why the plan's tagset changes can no longer apply as staged: a tagset
    or a field's tagset changed since. Empty when they can."""
    reasons = []
    for owner in dict.fromkeys(op['owner'] for op in settings_ops(ops)):
        cfg, layers, entry_fields = _live(client, project, owner)
        raw = _igt(cfg).get('tagsets')
        raw = raw if isinstance(raw, dict) else {}
        for op in settings_ops(ops):
            if op['owner'] != owner:
                continue
            if op['kind'] == 'set_tagset':
                now = _comparable(_norm(raw[op['was']], op['was'])) if op['was'] in raw else None
                if now != _comparable(op.get('before')):
                    reasons.append(f'the tagset {qv(op["was"])} changed since this plan was made')
                elif op['was'] != op['name'] and op['name'] in raw:
                    reasons.append(f'a tagset named {qv(op["name"])} was made since this plan was')
            elif _reference(cfg, layers, entry_fields, op) != op.get('before'):
                reasons.append(f'the tagset of a field this plan changes ({op["label"].split(":")[0]}) changed '
                               'since this plan was made')
    return reasons


def _canonical(rules) -> str:
    return json.dumps(rules or [], sort_keys=True)


def queue_settings(client, b, project, ops) -> None:
    """Queue on the batcher ``b`` every write the plan's tagset changes make."""
    for owner in dict.fromkeys(op['owner'] for op in settings_ops(ops)):
        mine = [op for op in settings_ops(ops) if op['owner'] == owner]
        cfg, layers, entry_fields = _live(client, project, owner)
        igt = _igt(cfg)
        raw = igt.get('tagsets') if isinstance(igt.get('tagsets'), dict) else None
        new = dict(raw or {})
        renames = {}
        for op in mine:
            if op['kind'] != 'set_tagset':
                continue
            new.pop(op['was'], None)
            if op.get('after') is not None:
                new[op['name']] = op['after']
                if op['was'] != op['name']:
                    renames[op['was']] = op['name']
        assigns = {(op['field_kind'], op['key']): op.get('after') for op in mine if op['kind'] == 'assign_tagset'}

        def final(kind, key, name):
            if (kind, key) in assigns:
                return assigns[(kind, key)]
            return renames.get(name, name)

        owner_api = 'projects' if owner == PROJECT else 'vocab_layers'
        owner_id = project.id if owner == PROJECT else owner
        if new != (raw or {}):
            b.add(lambda batch, v=new, e=raw: getattr(batch, owner_api).set_config(
                owner_id, IGT, 'tagsets', v, expected=e))
        if owner != PROJECT:
            fields = {k: dict(s) if isinstance(s, dict) else s for k, s in entry_fields.items()}
            # A core field the config never named takes its default spec, as
            # the app's field editor writes it, to carry a tagset.
            for (kind, k), name in assigns.items():
                if kind == ENTRY_FIELD and name and k not in fields:
                    fields[k] = {'inline': next((f['inline'] for f in CORE_VOCAB_FIELDS if f['name'] == k), False)}
            for k in list(fields):
                spec = fields[k] if isinstance(fields[k], dict) else {}
                old = (spec['tagset'].strip() or None) if isinstance(spec.get('tagset'), str) else None
                name = final(ENTRY_FIELD, k, old)
                if name != old:
                    spec = {**spec, 'tagset': name} if name else {x: y for x, y in spec.items() if x != 'tagset'}
                    fields[k] = spec
            if fields != entry_fields:
                b.add(lambda batch, v=fields, e=igt.get('fields'): batch.vocab_layers.set_config(
                    owner_id, IGT, 'fields', v, expected=e))
            continue

        meta = igt.get('documentMetadata')
        if isinstance(meta, list):
            new_meta = []
            for m in meta:
                if not isinstance(m, dict) or not m.get('name'):
                    new_meta.append(m)
                    continue
                old = (m['tagset'].strip() or None) if isinstance(m.get('tagset'), str) else None
                name = final(METADATA, m['name'], old)
                m = dict(m)
                if name:
                    m['tagset'] = name
                else:
                    m.pop('tagset', None)
                new_meta.append(m)
            if new_meta != meta:
                b.add(lambda batch, v=new_meta, e=meta: batch.projects.set_config(
                    owner_id, IGT, 'documentMetadata', v, expected=e))

        after_cfg = {**cfg, IGT: {**igt, 'tagsets': new}}
        for sl in layers:
            lcfg = _igt(sl.get('config'))
            old = lcfg.get('tagset') if isinstance(lcfg.get('tagset'), str) else None
            old_name = (old or '').strip() or None
            name = final(SPAN, sl['id'], old_name)
            if name != old_name:
                if name:
                    b.add(lambda batch, i=sl['id'], v=name, e=old: batch.span_layers.set_config(
                        i, IGT, 'tagset', v, expected=e))
                else:
                    b.add(lambda batch, i=sl['id'], e=old: batch.span_layers.delete_config(
                        i, IGT, 'tagset', expected=e))
            layer_after = {**(sl.get('config') or {}), IGT: {**lcfg, 'tagset': name}}
            wanted = field_constraints(layer_after, after_cfg)
            # Only a field whose rules the plan changes is declared, as igt's
            # settings save does: one whose layer holds other rules than its
            # settings ask for is left as it is.
            if _canonical(wanted) == _canonical(field_constraints(sl.get('config') or {}, cfg)):
                continue
            stored = (sl.get('constraints') or {}).get(IGT)
            if _canonical(wanted) == _canonical(stored):
                continue
            # A layer that holds none of IGT's rules yet: what core can
            # repair goes first, as igt's settings save does.
            if not stored and any(r['type'] in REMEDIABLE for r in wanted):
                b.add(lambda batch, i=sl['id'], w=wanted: batch.span_layers.repair_constraints(i, w))
            b.add(lambda batch, i=sl['id'], w=wanted, e=stored: batch.span_layers.set_constraints(
                i, IGT, w, expected=e))


class _Queue:
    """The batcher ``queue_settings`` takes, over one batch of ``client``."""

    def __init__(self):
        self.calls = []

    def add(self, fn) -> None:
        self.calls.append(fn)


def write_settings(client, project, ops) -> None:
    """Write the plan's tagset changes as the app does on approval: refused
    when what they change moved, one atomic batch otherwise."""
    from plaid_agent.core.plan import PlanOutOfDate
    reasons = check_settings(client, project, ops)
    if reasons:
        raise PlanOutOfDate(reasons)
    q = _Queue()
    queue_settings(client, q, project, ops)
    if q.calls:
        with client.batched() as batch:
            for fn in q.calls:
                fn(batch)


def _state(cfg, layers, entry_fields, op) -> str:
    """'after' when the stored settings read as ``op`` leaves them, 'before'
    as it found them, else 'moved'."""
    if op['kind'] == 'assign_tagset':
        now = _reference(cfg, layers, entry_fields, op)
        return 'after' if now == op.get('after') else 'before' if now == op.get('before') else 'moved'
    raw = _igt(cfg).get('tagsets')
    raw = raw if isinstance(raw, dict) else {}
    named = _comparable(_norm(raw[op['name']], op['name'])) if op['name'] in raw else None
    was = _comparable(_norm(raw[op['was']], op['was'])) if op['was'] in raw else None
    renamed = op['was'] != op['name']
    if named == _comparable(op.get('after')) and (not renamed or was is None):
        return 'after'
    if was == _comparable(op.get('before')) and (not renamed or named is None):
        return 'before'
    return 'moved'


def verify_settings(client, project, ops) -> Dict[str, int]:
    """What approval does with a plan of tagset changes: the per-kind counts
    when the settings read as the plan leaves them (the app wrote them), and a
    refusal otherwise, out of date when they moved some other way."""
    from plaid_agent.core.plan import PlanError, PlanOutOfDate
    states = []
    for owner in dict.fromkeys(op['owner'] for op in ops):
        cfg, layers, entry_fields = _live(client, project, owner)
        states.extend((op, _state(cfg, layers, entry_fields, op)) for op in ops if op['owner'] == owner)
    if all(s == 'after' for _, s in states):
        counts: Dict[str, int] = {}
        for op, _ in states:
            noun = "tagset changes" if op['kind'] == 'set_tagset' else "fields' tagsets"
            counts[noun] = counts.get(noun, 0) + 1
        return counts
    if all(s in ('after', 'before') for _, s in states):
        raise PlanError('The tagset changes were not written: the app writes them, with your own sign-in, '
                        'when the plan is approved there. Approve it from the app', 0, len(ops))
    raise PlanOutOfDate(['the tagset settings this plan changes were changed some other way since it was made'])


def refusal_words(error) -> Optional[str]:
    """What to tell the user when core refused the batch because stored
    values break a closed list, or None for any other refusal
    (plaid-igt ``tagsetRefusal``)."""
    from plaid_client.constraints import violations_of
    vs = violations_of(error)
    if not vs or not all(v.get('constraint') == 'value-set' for v in vs):
        return None
    data = getattr(error, 'response_data', None) or {}
    n = data.get('violation-count') or data.get('violation_count') or len(vs)
    fields = list(dict.fromkeys(v.get('layer_name') for v in vs if v.get('layer_name')))
    values = list(dict.fromkeys(v.get('value') for v in vs if isinstance(v.get('value'), str)))
    shown = ', '.join(values[:5]) + (', …' if len(values) > 5 else '')
    return (f'Nothing in the last batch was written: {n} stored value{"s" if n != 1 else ""} in '
            f'{", ".join(fields)} {"are" if n != 1 else "is"} not in the closed tagset: {shown}.')
