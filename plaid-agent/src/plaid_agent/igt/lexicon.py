"""The plan tools that change a lexicon: entries, senses, and the examples
promoted onto them.

Every one of them names an entry the way the read tools print it ("gam#2",
"kwatha#1.2"), resolves it against the lexicon as the plan will leave it, and
proposes a metadata patch. The shapes they write are :mod:`.vocab`, which
mirrors the app's own vocabDictionary.js.
"""

import re
from typing import Any, Dict, Optional

from ..core.args import whole
from ..core.tools import ToolError

from .project import word_ref
from .reads import _example_line
from .lexview import entry_line, morph_type
from .vocab import (FIELD_ITEM, FIELD_TEXT, SCOPE_ENTRY, SCOPE_SENSE, SENSE_ORDER_KEY, all_examples,
                    descendants_of, field_by_name, homograph_group, homograph_of,
                    is_reserved_field_name, next_sense_order, parent_of, plan_homograph_order,
                    plan_sense_set_number, ref_ids, vocab_field_summary, with_example_added,
                    with_example_removed, with_parent, with_ref_ids)
from .workspace import Workspace, _hits_in, _meta_of, _words_of


def t_create_entry(ws: Workspace, form: str, lexicon: Optional[str] = None, fields: Optional[dict] = None,
                   type: Optional[str] = None) -> str:
    return _create_entry(ws, ws.project.vocab(lexicon), form, fields, type, None)


def _create_entry(ws: Workspace, v: dict, form: str, fields: Optional[dict],
                  morph: Optional[str], parent: Optional[dict]) -> str:
    """A new entry, or a new sense when ``parent`` is the entry it sits under."""
    form = (form or '').strip()
    if not form:
        raise ToolError('form must not be empty')
    view = ws.view(v)
    metadata: dict = {}
    for k, val in (fields or {}).items():
        f = lexicon_field(v, k)
        if parent is not None and f['scope'] == SCOPE_ENTRY:
            # The HEADWORD the sense will sit under, which is not the parent
            # when the parent is itself a sense: naming the parent sends the
            # reader to something that refuses the same write.
            head = view.tree.root_of.get(parent['id']) or parent['id']
            raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense, so a new sense '
                            f'cannot carry it. Set it on {view.label(head)}.')
        metadata = _entry_field_write(ws, v, f, val, metadata, None)
    if morph:
        metadata['morphType'] = morph_type(morph)
    if parent is not None:
        # The tree is the lexicon as the SERVER has it, so the senses this plan
        # has already added to the same entry are counted here as well: without
        # that, two add_sense calls in one plan both take the same number.
        planned = sum(1 for e in ws.new_entries.values()
                      if (e.get('metadata') or {}).get('parent') == parent['id'])
        metadata = with_parent(metadata, parent['id'],
                               next_sense_order(view.tree, parent['id']) + planned)
    # The key is a handle the model passes back. It must not contain spaces
    # (a phrase entry's form does).
    # CI runs Python 3.11, which refuses a backslash inside an f-string
    # expression, so the slug is made first.
    slug = re.sub(r'\s+', '_', form)
    key = f'new:{v["id"]}:{slug}#{len(ws.new_entries) + 1}'
    ws.new_entries[key] = {'form': form, 'vocab_id': v['id'], 'metadata': metadata}
    what = (f'new sense of {view.label(parent["id"])} ' if parent is not None else 'new entry ')
    ws.add_op({'kind': 'create_entry', 'vocab_id': v['id'], 'form': form, 'metadata': metadata, 'key': key,
               'label': f'{v["name"]}: ' + what + entry_line({'form': form, 'metadata': metadata}, view)})
    return ws.planned_note(1) + f'\nentry_id: {key}  (use it to link this entry in the same plan)'


# Which tool owns each reserved key, for the refusal when one is set as a field.
_RESERVED_HINTS = {
    'parent': 'Where an entry sits is changed with add_sense, make_sense_of or free_sense.',
    'senseorder': 'A sense is renumbered with move_sense.',
    'examples': 'Usage examples are added with promote_example and dropped with remove_example.',
    'form': 'A headword is changed with rename_entry.',
    'homograph': 'The order of entries spelled the same is set with order_homographs.',
}

_FREE_FIELD = {'name': '', 'inline': False, 'immutable': False, 'tagset': None, 'lang': None,
               'type': FIELD_TEXT, 'many': False, 'scope': SCOPE_SENSE}


def lexicon_field(vocab: dict, name: str) -> dict:
    """A lexicon's configured entry field, by case-insensitive name, as its full
    spec; any name when the lexicon declares no schema. morphType is always
    allowed. A reserved key is never a field, and says which tool owns it."""
    if is_reserved_field_name(name):
        hint = _RESERVED_HINTS.get(str(name).strip().lower(),
                                   'It is structure the app keeps on an entry, not a field.')
        raise ToolError(f'"{name}" is not an entry field. {hint}')
    fields = vocab.get('fields') or []
    hit = field_by_name(fields, name)
    if hit:
        return hit
    # A lexicon that declares nothing has no schema to break, so any name goes.
    # The core inventory rides along on every vocabulary and never counts as one.
    if not any(f.get('declared') for f in fields) or name == 'morphType':
        return {**_FREE_FIELD, 'name': name}
    raise ToolError(f'"{vocab["name"]}" has no entry field "{name}". Fields: '
                    + ', '.join(vocab_field_summary(vocab)))


def _resolve_ref(ws: Workspace, vocab: dict, field: dict, value: str, own_id: Optional[str]) -> str:
    """The id of the entry a reference field should hold, from a form or an id.
    References never cross vocabularies, so only this lexicon is searched."""
    view = ws.view(vocab)
    if value in view.tree.by_id:
        target = value
    elif value in ws.new_entries:
        raise ToolError(f'"{field["name"]}" must name an entry that already exists. "{value}" is created by this '
                        'same plan and has no id until it is approved: approve the plan, then set the reference.')
    else:
        form, suffix = value, None
        if '#' in value:
            form, _, suffix = value.rpartition('#')
            suffix = suffix.strip()
        hits = _hits_in(ws, vocab, form, suffix, lambda m, v: True)
        if not hits:
            raise ToolError(f'"{vocab["name"]}" has no entry "{value}" for {field["name"]} to refer to. '
                            'read_lexicon lists them, and a reference always names an entry of the same lexicon.')
        if len(hits) > 1:
            lines = [f'"{value}" names several entries, so {field["name"]} cannot tell which. '
                     'Pass one of these forms, or its id:']
            for it in hits:
                addr = view.address(it['id'])
                shown = f' form={addr}' if addr != (it.get('form') or '') else ''
                lines.append(f'  id={it["id"]}{shown} {entry_line(it, view)}')
            raise ToolError('\n'.join(lines))
        target = hits[0]['id']
    if own_id and target == own_id:
        raise ToolError(f'{view.label(own_id)} cannot refer to itself through {field["name"]}.')
    return target


def _entry_field_write(ws: Workspace, vocab: Optional[dict], field: dict, value,
                       metadata: Optional[dict], own_id: Optional[str]) -> dict:
    """The metadata an entry carries once ``field`` is set to ``value``. A text
    field takes the string. A reference field holds entry ids, so a form is
    resolved to one here; a `many` field appends, and an empty value clears the
    field outright."""
    if field['type'] != FIELD_ITEM or vocab is None:
        return {**(metadata or {}), field['name']: '' if value is None else str(value)}
    v = '' if value is None else str(value).strip()
    if not v:
        return with_ref_ids(metadata, field, [])
    target = _resolve_ref(ws, vocab, field, v, own_id)
    held = ref_ids({'metadata': metadata}, field) if field.get('many') else []
    return with_ref_ids(metadata, field, held + [target])


def t_set_entry_field(ws: Workspace, field: str, value: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                      entry_gloss: Optional[str] = None) -> str:
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'existing':
        _refuse_doomed_entry(ws, target, 'take a value')
    vocab = (next((v for v in ws.project.vocabs if v['id'] == ws.new_entries[target]['vocab_id']), None)
             if kind == 'new' else ws.vocab_of_item(target['id']))
    f = lexicon_field(vocab, field) if vocab else {**_FREE_FIELD, 'name': field}
    if kind == 'new':
        e = ws.new_entries[target]
        if vocab and f['scope'] == SCOPE_ENTRY and parent_of(e):
            raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense.')
        e['metadata'] = _entry_field_write(ws, vocab, f, value, e['metadata'], None)
        for op in ws.ops:
            if op.get('kind') == 'create_entry' and op.get('key') == target:
                op['metadata'] = dict(e['metadata'])
        return ws.planned_note(0) + ' (updated the pending new entry)'
    view = ws.view(vocab) if vocab else None
    if view is not None and f['scope'] == SCOPE_ENTRY and view.is_sense(target['id']):
        head = view.tree.root_of.get(target['id'])
        raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense, and '
                        f'{view.label(target["id"])} is a sense. Set it on {view.label(head)} instead.')
    before = ws.item_patches.get(target['id'], target.get('metadata') or {})
    meta = _entry_field_write(ws, vocab, f, value, before, target['id'])
    ws.patch_item(target['id'], meta)
    new_value = meta.get(f['name'])
    where = view.label(target['id']) if view is not None else f'"{target.get("form")}"'
    if f['type'] == FIELD_ITEM and view is not None:
        shown = ', '.join(view.label(x) for x in ref_ids({'metadata': meta}, f)) or '(cleared)'
    else:
        old = before.get(f['name'], '')
        shown = f'"{old}" → "{value}"' if old else f'= "{value}"'
    ws.add_op({'kind': 'set_entry_field', 'item_id': target['id'], 'field': f['name'],
               'value': new_value if new_value is not None else '',
               'label': f'entry {where}: {f["name"]} {shown}'})
    return ws.planned_note(1)


def _meta_patch(before: dict, after: dict) -> dict:
    """The patch turning one metadata map into another. A key the new map lacks
    is sent as null, which is how the API deletes it."""
    patch = {k: v for k, v in after.items() if before.get(k) != v}
    for k in before:
        if k not in after:
            patch[k] = None
    return patch


def _meta_op(ws: Workspace, item_id: str, before: dict, after: dict, label: str) -> Dict[str, Any]:
    """One entry's metadata change, recorded so later tools in the same turn
    read the tree this plan is building."""
    ws.patch_item(item_id, after)
    return {'kind': 'set_entry_metadata', 'item_id': item_id, 'patch': _meta_patch(before, after),
            'label': label}


def _dict_entry(ws: Workspace, entry_form, lexicon, entry_id, entry_gloss, what: str):
    """The entry a lexicon tool names, with its lexicon's view."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'new':
        raise ToolError(f'"{ws.new_entries[target]["form"]}" is created by this same plan and has no id until it '
                        f'is approved, so it cannot {what} yet.')
    # find_entry found this item by scanning the project's own lexicons, which
    # is the list vocab_of_item scans, so the lookup lands.
    vocab = ws.vocab_of_item(target['id'])
    view = ws.view(vocab)
    _refuse_doomed_entry(ws, target, what)
    return vocab, view, target


def _refuse_doomed_entry(ws: Workspace, item: dict, what: str):
    """A delete already planned takes the entry's senses and references with
    it, so anything hung on it afterwards would be written and then dropped.

    Every lexicon tool that names an existing entry owes this refusal, the
    removals (delete, merge, rename) included: without it the model stages a
    second removal of the same entry, and the plan only refuses itself once
    the user has approved it.
    """
    if item['id'] in ws.doomed_entries():
        raise ToolError(f'{ws.entry_name(item)} is deleted or merged away by this same plan, so it cannot '
                        f'{what}. Drop that change with drop_planned, or work on the entry that survives.')


def _refuse_removing_survivor(ws: Workspace, item: dict, what: str):
    """An entry another op merges INTO cannot also be removed. The merge moves
    links onto it and the removal then takes them with it, and the plan refuses
    itself after the user has approved it."""
    if any(op.get('kind') == 'merge_entries' and op.get('keep_id') == item['id'] for op in ws.ops):
        raise ToolError(f'{ws.entry_name(item)} is what another change in this plan merges into, so it cannot '
                        f'{what}. Drop that merge with drop_planned, or merge into an entry that stays.')


def t_add_sense(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                entry_id: Optional[str] = None, entry_gloss: Optional[str] = None,
                fields: Optional[dict] = None, form: Optional[str] = None,
                type: Optional[str] = None) -> str:
    """PLAN: add a sense under an entry, numbered after the senses it has."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'take a sense')
    # A sense is shown under its entry's headword and carries it unless told
    # otherwise, which is how an imported lexicon reads.
    return _create_entry(ws, vocab, form or target.get('form') or '', fields, type, target)


def t_move_sense(ws: Workspace, number, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                 entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: put a sense at the number it should be shown with, among its siblings."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renumbered')
    if not view.is_sense(target['id']):
        raise ToolError(f'{view.label(target["id"])} is a headword, and a headword is not numbered among '
                        'senses. make_sense_of moves it under another entry.')
    was = view.number(target['id'])
    # A sense is shown with a dotted number ("2.1.3"), but it moves among its
    # own siblings, so only the last segment says where it should land.
    raw = str(number).strip().rsplit('.', 1)[-1]
    try:
        wanted = whole(raw, 'number')
    except ValueError:
        raise ToolError(f'"{number}" is not a sense number. Give the place among the senses of '
                        f'{view.label(view.tree.root_of.get(target["id"]) or target["id"])}, '
                        'counting from 1.') from None
    patches = plan_sense_set_number(view.tree, target['id'], wanted)
    if not patches:
        sibs = len(view.tree.senses_of(view.tree.parent_of[target['id']]))
        return ws.planned_note(0) + (f' {view.label(target["id"])} is already sense {was}'
                                     + (' and has no siblings to move among.' if sibs < 2 else '.'))
    by_id = {x['id']: x for x in patches}
    # A number past either end lands at the nearest one, so the plan says where
    # the sense actually goes rather than what was asked for.
    landed = (by_id.get(target['id']) or {}).get('metadata', {}).get(SENSE_ORDER_KEY, wanted)
    # Said as the DOTTED number the user will see, not the raw order: a move
    # only ever changes the last segment, so "1.1" going to place 2 is "1.2".
    landed_shown = '.'.join(was.split('.')[:-1] + [str(landed)])
    # The entry's own name, not its bare form: two entries can share the form.
    head = view.label(view.tree.root_of.get(target['id']) or target['id'])
    others = len(patches) - 1
    moved = f'entry {head}: sense {was} becomes sense {landed_shown}'
    ops = []
    for x in patches:
        # The line describing the move belongs on the sense that moves, not on
        # whichever sibling the renumbering happens to list first.
        if x['id'] == target['id']:
            label = moved + (f' ({others} sibling{"s" if others != 1 else ""} renumbered)'
                             if others else '')
        else:
            label = f'entry {head}: sense {view.number(x["id"])} renumbered'
        ops.append(_meta_op(ws, x['id'], _meta_of(ws, view.tree.by_id[x['id']]), x['metadata'], label))
    ws.add_ops(ops)
    # A sense already carrying the order it lands on gets no patch of its own,
    # so nothing above would say it moved. It did: the siblings around it are
    # what changed, and the plan has to name the gesture that caused them.
    if target['id'] not in by_id:
        ops[0]['label'] = f'{moved} ({ops[0]["label"]})' if ops else moved
    return ws.planned_note(len(ops))


def t_make_sense_of(ws: Workspace, under_form: Optional[str] = None, under_id: Optional[str] = None,
                    entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: move an entry (with everything under it) to be a sense of another."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be moved')
    _, under_view, under = _dict_entry(ws, under_form, lexicon, under_id, None, 'take a sense')
    if under_view.vocab['id'] != vocab['id']:
        raise ToolError('A sense sits under an entry of the same lexicon; these are in different ones.')
    if under['id'] == target['id']:
        raise ToolError('An entry cannot be a sense of itself.')
    if under['id'] in {d['id'] for d in descendants_of(view.tree, target['id'])}:
        raise ToolError(f'{under_view.label(under["id"])} is already below {view.label(target["id"])}, so moving '
                        'it there would make a loop. Free it first.')
    before = _meta_of(ws, target)
    # Senses this same plan adds under the entry take the orders after its
    # own, so two writes never claim one place.
    planned = sum(1 for e in ws.new_entries.values()
                  if (e.get('metadata') or {}).get('parent') == under['id'])
    after = with_parent(before, under['id'], next_sense_order(view.tree, under['id']) + planned)
    if before.get('parent') == under['id']:
        return ws.planned_note(0) + f' {view.label(target["id"])} is already a sense of {view.label(under["id"])}.'
    kept = len(descendants_of(view.tree, target['id']))
    # A headword-only field's value stays on the entry but is shown on a
    # headword alone, so the card says which values go out of sight.
    hidden = sorted(k for k in view.hidden_fields({**target, 'metadata': after})
                    if before.get(k) not in (None, ''))
    ws.add_op(_meta_op(ws, target['id'], before, after,
                       f'{view.label(target["id"])} becomes a sense of {view.label(under["id"])}'
                       + (f' (with {kept} below it)' if kept else '')
                       + (f'; {", ".join(hidden)} shown on a headword only' if hidden else '')))
    return ws.planned_note(1)


def t_free_sense(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                 entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: make a sense a headword of its own, keeping everything under it."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be freed')
    if not view.is_sense(target['id']):
        return ws.planned_note(0) + f' {view.label(target["id"])} is already a headword of its own.'
    before = _meta_of(ws, target)
    kept = len(descendants_of(view.tree, target['id']))
    ws.add_op(_meta_op(ws, target['id'], before, with_parent(before, None, None),
                       f'{view.label(target["id"])} becomes a headword of its own'
                       + (f' (with {kept} sense{"s" if kept != 1 else ""} below it)' if kept else '')))
    return ws.planned_note(1)


def t_order_homographs(ws: Workspace, order, entry_form: Optional[str] = None,
                       lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                       entry_gloss: Optional[str] = None) -> str:
    """PLAN: set the order of the entries spelled the same, which is the first
    segment of the number every one of their senses is shown with."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renumbered')
    group = homograph_group(view.items, target['id'])
    if not group:
        raise ToolError(f'{view.label(target["id"])} is the only headword spelled that way, so there is '
                        'no order to set.')
    wanted = [str(x).strip() for x in (order if isinstance(order, list) else [order]) if str(x).strip()]
    by_num = {view.number(r['id']): r for r in group}
    ids = []
    for token in wanted:
        # Each entry is named by the number it is shown with now, or by its id.
        r = by_num.get(token.rpartition('#')[2] or token) or next(
            (x for x in group if x['id'] == token), None)
        if r is None:
            raise ToolError(f'"{token}" is not one of the {len(group)} headwords spelled '
                            f'"{group[0].get("form")}". They are numbered '
                            + ', '.join(view.number(r['id']) for r in group) + '.')
        if r['id'] in ids:
            raise ToolError(f'"{token}" is named twice; give each entry once.')
        ids.append(r['id'])
    if len(ids) != len(group):
        raise ToolError(f'Give all {len(group)} headwords spelled "{group[0].get("form")}" in the order they '
                        'should be numbered; ' + str(len(ids)) + ' were given.')
    patches = plan_homograph_order(group, ids)
    if not patches:
        return ws.planned_note(0) + ' They already stand in that order.'
    ops = []
    for x in patches:
        item = view.tree.by_id[x['id']]
        before = _meta_of(ws, item)
        # The STORED number, which is what changes: the number shown is the
        # entry's place in the group, and the write is what puts it there.
        was = homograph_of(item)
        ops.append(_meta_op(ws, x['id'], before, x['metadata'],
                            f'{view.label(x["id"])}: homograph number {was if was is not None else "none"} → '
                            f'{x["metadata"]["homograph"]}'))
    ws.add_ops(ops)
    return ws.planned_note(len(ops))


def t_promote_example(ws: Workspace, document: str, ref: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                      entry_gloss: Optional[str] = None) -> str:
    """PLAN: mark a word in a document as a usage example of an entry."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'take an example')
    doc = ws.doc(document)
    found = _words_of(doc, ref)
    if len(found) != 1:
        raise ToolError('Give one word reference, e.g. "s3.w2".')
    _, sent, word = found[0]
    before = _meta_of(ws, target)
    after = with_example_added(before, {'document': doc.id, 'token': word.id})
    if after == before:
        return ws.planned_note(0) + f' {view.label(target["id"])} already has that example.'
    ws.add_op(_meta_op(ws, target['id'], before, after,
                       f'entry {view.label(target["id"])}: usage example '
                       f'{ws.doc_label(doc.id, quote=True)} {word_ref(sent, word)} "{word.surface}"'))
    return ws.planned_note(1)


def t_remove_example(ws: Workspace, index: int, entry_form: Optional[str] = None,
                     lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                     entry_gloss: Optional[str] = None) -> str:
    """PLAN: drop one of an entry's usage examples, by its position."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'lose an example')
    before = _meta_of(ws, target)
    exs = all_examples({'metadata': before})
    if not exs:
        raise ToolError(f'{view.label(target["id"])} has no usage examples.')
    # One sentence for a number out of range and for something that is not a
    # number at all: int() answered the second with its own error text, and
    # cut 1.5 down to example 1 for an argument that named no example.
    try:
        i = whole(index, 'index')
    except ValueError:
        i = None
    if i is None or i < 0 or i >= len(exs):
        raise ToolError(f'"{index}" is not one of {view.label(target["id"])}\'s {len(exs)} example(s), which are '
                        f'numbered 0 to {len(exs) - 1}. lexicon_entry lists them with their numbers.')
    ws.add_op(_meta_op(ws, target['id'], before, with_example_removed(before, i),
                       f'entry {view.label(target["id"])}: drop usage example [{i}] '
                       + _example_line(ws, exs[i])))
    return ws.planned_note(1)

