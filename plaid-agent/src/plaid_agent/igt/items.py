"""Many values or many links in one call of a job's piece (BRIEF SP item 2).

A piece's set_field and link_entry take ``items``: a list of what one call
of the single form takes for one reference, ``{"ref": ..., <its other
arguments>}``. Each item is run AS that single call (the same tool, through
the same path, so every guard, refusal, keep rule and count is the single
call's), on its own: one refused item never loses the rest. The answer says
how many were staged, then each item that was refused or staged nothing, by
its number and reference, with the single call's own answer.

Only a job's pieces are offered the form (``toolkit.job_piece_tools``). A
chat's set_field and link_entry are unchanged, and refuse ``items`` as any
argument they do not take.
"""

from typing import Any, Callable, Dict, List, Optional

from ..core.limits import JOB_ITEMS_MAX
from ..core.refs import read_ref
from ..core.tools import Refusal, refused
from ..core.trace import plural
from .workspace import _refs

#: The end of a job's "Staged ..." answer (``JobWorkspace.planned_note``):
#: what an item's answer says beyond it is kept in the batch's answer.
STAGED_TAIL = ' staged in all, applied when you end.'

#: The tools that take ``items``, each with the arguments an item may give
#: besides ``ref`` (the single form's, ``document`` and ``refs`` aside),
#: and those that may not stand beside ``items``.
ITEM_ARGS = {
    'set_field': ('field', 'value'),
    'link_entry': ('entry_form', 'entry_id', 'entry_gloss', 'lexicon'),
}
NOT_BESIDE = {
    'set_field': ('refs', 'value', 'values'),
    'link_entry': ('refs',),
}

#: What each tool's schema gains in a job's piece.
ITEMS_SCHEMA = {
    'set_field': {
        'type': 'array',
        'items': {'type': 'object', 'properties': {'ref': {'type': 'string'}, 'field': {'type': 'string'},
                                                   'value': {'type': 'string'}}, 'required': ['ref']},
        'description': f'Many values in one call, in place of refs and value, e.g. [{{"ref": "s1.w2", "field": '
                       f'"Gloss", "value": "dog"}}]. A field given beside items is that of every item naming '
                       f'none. Each is staged or refused on its own. At most {JOB_ITEMS_MAX}.'},
    'link_entry': {
        'type': 'array',
        'items': {'type': 'object', 'properties': {'ref': {'type': 'string'}, 'entry_form': {'type': 'string'},
                                                   'entry_id': {'type': 'string'},
                                                   'entry_gloss': {'type': 'string'}}, 'required': ['ref']},
        'description': f'Many links in one call, in place of refs, e.g. [{{"ref": "s1.w2.m1", "entry_form": '
                       f'"ka#2"}}]: each item names its entry as a call does. Each is staged or refused on its '
                       f'own. At most {JOB_ITEMS_MAX}.'},
}


#: What set_field's ``values`` says of a value per ref, and what a job's
#: piece reads in its place.
ONE_CALL_PER_REF = 'A value of its own on each ref takes one call per ref.'
PER_REF_ITEMS = 'A value of its own on each ref: items.'


def with_items(t: Dict[str, Any]) -> Dict[str, Any]:
    """``t``'s schema as a job's piece is offered it: with ``items`` where
    the tool takes them, ``refs`` then no longer required."""
    name = t['function']['name']
    if name not in ITEMS_SCHEMA:
        return t
    params = t['function']['parameters']
    properties = dict(params['properties'])
    if 'values' in properties:
        said = properties['values'].get('description') or ''
        assert ONE_CALL_PER_REF in said, said
        properties['values'] = {**properties['values'], 'description': said.replace(ONE_CALL_PER_REF, PER_REF_ITEMS)}
    params = {**params, 'properties': {**properties, 'items': ITEMS_SCHEMA[name]},
              'required': [r for r in params.get('required') or [] if r != 'refs']}
    return {**t, 'function': {**t['function'], 'parameters': params}}


def takes_items(name: str, args: Any) -> bool:
    """Whether a piece's call is the items form."""
    return name in ITEM_ARGS and isinstance(args, dict) and 'items' in args


def _ref_text(ref: Any) -> str:
    return ref if isinstance(ref, str) else str(ref)


def stage_items(ws, name: str, args: Dict[str, Any], call: Callable[[Any, str, Dict[str, Any]], str]) -> str:
    """Run a piece's ``items`` call of ``name`` as one single call per item
    (``call``, the toolkit's own), and answer for them all."""
    items = args.get('items')
    allowed = ITEM_ARGS[name]
    if not isinstance(items, list) or not items:
        return refused(f'items is a list of {{"ref": ..., {", ".join(allowed[:2])}}} objects, at least one.',
                       'invalid-argument')
    if len(items) > JOB_ITEMS_MAX:
        return refused(f'items takes at most {JOB_ITEMS_MAX} in one call, and {len(items)} were given. Give the '
                       'rest in another call.', 'invalid-argument')
    beside = [k for k in NOT_BESIDE[name] if k in args]
    if beside:
        return refused(f'items goes in place of {", ".join(NOT_BESIDE[name])}: leave out {", ".join(beside)}.',
                       'invalid-argument')
    shared = {k: v for k, v in args.items() if k != 'items'}
    staged: List[str] = []
    # Each staged item's new ops, held, to count at the end those the plan
    # still holds (a later item may supersede or take one back).
    made: List[List[Dict[str, Any]]] = []
    lines: List[str] = []
    refusals: List[Refusal] = []
    others = 0
    calling = getattr(ws, 'calling', None)
    try:
        for i, item in enumerate(items, start=1):
            if not isinstance(item, dict) or not isinstance(item.get('ref'), str) or not item['ref'].strip():
                out = refused(f'give each item a ref and {", ".join(allowed[:2])}.', 'invalid-argument')
                lines.append(f'Refused: item {i}: {_said(out)}')
                refusals.append(out)
                continue
            ref = item['ref']
            unknown = [k for k in item if k != 'ref' and k not in allowed]
            if unknown:
                out = refused(f'an item takes ref, {", ".join(allowed)}, not {", ".join(unknown)}.',
                              'invalid-argument')
                lines.append(f'Refused: item {i} {_ref_text(ref)}: {_said(out)}')
                refusals.append(out)
                continue
            try:
                several = len(_refs([ref])) > 1
            except Exception:  # noqa: BLE001 - a bad reference is the single call's to refuse
                several = False
            if several:
                out = refused(f'one reference per item: give {ref.strip()} each as an item of its own.',
                              'invalid-argument')
                lines.append(f'Refused: item {i} {_ref_text(ref)}: {_said(out)}')
                refusals.append(out)
                continue
            one = {**shared, **{k: v for k, v in item.items() if k != 'ref'}, 'refs': [ref]}
            ws.calling = (name, one)
            before = {id(op) for op in ws.ops}
            # The garble guard a single call meets before its tool runs
            # (core.agent), per item here (``JobWorkspace.garbled``).
            why = ws.garbled(one) if hasattr(ws, 'garbled') else None
            out = refused(why, 'invalid-argument') if why else call(ws, name, one)
            if isinstance(out, Refusal):
                lines.append(f'Refused: item {i} {_ref_text(ref)}: {_said(out)}')
                refusals.append(out)
            elif any(id(op) not in before for op in ws.ops):
                staged.append(ref)
                made.append([op for op in ws.ops if id(op) not in before])
                more = _beyond_staged(str(out))
                if more:
                    lines.append(f'Item {i} {_ref_text(ref)}: {more}')
            else:
                others += 1
                lines.append(f'Not staged: item {i} {_ref_text(ref)}: {_beyond_staged(str(out)) or str(out)}')
    finally:
        ws.calling = calling
    what = 'value' if name == 'set_field' else 'link'
    held = ws.staged_count() if hasattr(ws, 'staged_count') else None
    head = f'Staged {len(staged)} of {plural(len(items), what)}.' + (
        f' {plural(held, "change")}{STAGED_TAIL}' if held is not None else '')
    now = {id(op) for op in ws.ops}
    held_refs = [ref for ref, ops in zip(staged, made) if any(id(op) in now for op in ops)]
    ws.step_label = _label(name, held_refs, len(refusals), others, len(staged) - len(held_refs))
    answer = '\n'.join([head] + lines)
    if not staged and refusals:
        out = refused(answer, refusals[0].kind)
        return out
    return answer


def _said(out: str) -> str:
    """A refusal's text without its "Error: " head."""
    text = str(out)
    return text[len('Error: '):] if text.startswith('Error: ') else text


def _beyond_staged(text: str) -> str:
    """What an item's answer says beyond its "Staged ..." sentence."""
    if STAGED_TAIL in text:
        return text.split(STAGED_TAIL, 1)[1].strip()
    return text.strip()


#: What a reference names, by how deep it goes.
_PLACES = (('sentence', 'sentences'), ('word', 'words'), ('morpheme', 'morphemes'))


def _places(refs: List[str]) -> str:
    """The places ``refs`` name, counted by what they are: "9 morphemes",
    "2 words and 7 morphemes"."""
    tally: Dict[tuple, int] = {}
    for ref in refs:
        r = read_ref(ref, 'wm')
        if r is None:
            place = ('reference', 'references')
        else:
            depth = 2 if r.parts[1] is not None else 1 if (r.parts[0] is not None or r.by_form) else 0
            place = _PLACES[depth]
        tally[place] = tally.get(place, 0) + 1
    parts = [plural(n, one, many) for (one, many), n in tally.items()]
    if not parts:
        return plural(0, 'link')
    return parts[0] if len(parts) == 1 else ', '.join(parts[:-1]) + ' and ' + parts[-1]


def _label(name: str, staged: List[str], refused_n: int, others: int, replaced: int = 0) -> Optional[str]:
    """The step's line: what the call did, in the page's words, counting
    the items whose change the plan holds after the call, with its
    refusals counted ("Set 14 values", "Linked 9 morphemes, 2 refused") and
    the items a later item of the same call superseded or took back
    (REV-SP-4)."""
    did = f'Set {plural(len(staged), "value")}' if name == 'set_field' else f'Linked {_places(staged)}'
    tail = ''.join(f', {n} {w}' for n, w in ((refused_n, 'refused'), (others, 'not staged'),
                                             (replaced, 'replaced in this call')) if n)
    return did + tail
