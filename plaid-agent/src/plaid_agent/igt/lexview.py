"""A lexicon as one turn reads it, and the morph types an entry may carry.

:mod:`.vocab` is the model, mirrored function for function from the app's own
vocabDictionary.js. What is here is the reading of it the tools need: the sense
tree and the numbers a user is shown, over the entries the plan will leave
behind, plus the one line an entry is printed as.
"""

import json
from collections import Counter
from typing import List, Optional

from ..core.tools import ToolError

from .vocab import (PARENT_KEY, RESERVED_ITEM_KEYS, all_examples, build_item_numbers,
                    build_sense_tree, descendants_of, fields_for_item, item_ref_fields, ref_ids)


FLEX_MORPH_TYPES = ['stem', 'bound stem', 'root', 'bound root', 'prefix', 'suffix', 'infix', 'circumfix',
                    'simulfix', 'suprafix', 'infixing interfix', 'prefixing interfix', 'suffixing interfix',
                    'clitic', 'enclitic', 'proclitic', 'particle', 'phrase', 'discontiguous phrase']


def morph_type(t: str) -> str:
    """The editor's controlled morph-type vocabulary (FLEx's inventory)."""
    k = (t or '').strip().lower()
    if k in FLEX_MORPH_TYPES:
        return k
    raise ToolError(f'Unknown morph type "{t}". Types: ' + ', '.join(FLEX_MORPH_TYPES))

# --- the lexicon as one turn reads it ----------------------------------------
class LexView:
    """A lexicon's items and the sense tree over them."""

    __slots__ = ('vocab', 'items', 'tree', 'fields', 'ref_fields', 'numbers', 'shared')

    def __init__(self, vocab: dict, items: List[dict]):
        self.vocab = vocab
        self.items = items
        self.fields = vocab.get('fields') or []
        self.ref_fields = item_ref_fields(self.fields)
        self.tree = build_sense_tree(items)
        # The number the USER sees beside a form, which is what a "#" suffix
        # has to mean.
        self.numbers = build_item_numbers(items)
        # Headwords that share their form with another. A lone headword with
        # senses is numbered 1, which says nothing in prose, so only these
        # carry their number when a line names them.
        counts = Counter((r.get('form') or '') for r in self.tree.roots)
        self.shared = {r['id'] for r in self.tree.roots if counts[r.get('form') or ''] > 1}

    def number(self, item_id: str) -> str:
        return self.numbers.get(item_id, '')

    def hidden_fields(self, item: dict) -> set:
        """Field names the app's entry form does not show on this item. A
        headword-only field sits on the headword, so reporting it on a sense
        offers the model a value the user cannot see and set_entry_field will
        refuse to write.

        Asked of the TREE, not of the raw metadata: a parent naming nothing
        makes an item a root here and in the app, whose load-time repair
        clears such a parent on sight. Reading the raw key would call that
        item a sense and hide fields it is free to carry.
        """
        parent = self.tree.parent_of.get(item['id'])
        as_placed = {'metadata': {PARENT_KEY: parent} if parent else {}}
        shown = {f['name'] for f in fields_for_item(self.fields, as_placed)}
        return {f['name'] for f in self.fields} - shown

    def is_sense(self, item_id: str) -> bool:
        return self.tree.is_sense(item_id)

    def tree_has_form(self, form: str) -> bool:
        return any((r.get('form') or '').lower() == (form or '').lower() for r in self.tree.roots)

    def head_of(self, item_id: str) -> str:
        """The headword an item sits under, which is its own when it is an entry."""
        it = self.tree.by_id.get(item_id)
        root = self.tree.entry_of(item_id) if it is not None else None
        return ((root or it) or {}).get('form') or ''

    def label(self, item_id: str) -> str:
        """How a line names an entry, always spelled the way a tool takes it
        back, so a line can be copied into one: "kwatha", "gam#2" for the
        second entry spelled that way, "kwatha#1.2" for a sense.

        Never "gam (2)" or "kwatha" sense 1.2, which read as prose and then
        fail as input. A lone headword keeps its bare form, since the number
        it would carry is always 1 and says nothing.
        """
        it = self.tree.by_id.get(item_id)
        if it is None:
            return f'a deleted entry ({item_id})'
        if self.is_sense(item_id):
            return f'"{self.address(item_id)}"'
        num = self.number(item_id) if item_id in self.shared else ''
        form = it.get('form') or ''
        return f'"{form}#{num}"' if num else f'"{form}"'

    def address(self, item_id: str) -> str:
        """The entry_form that names this item back to a tool: "kwatha", or
        "kwatha#1.2" for a sense, or "gam#2" for the second entry of that form.
        Always the number the user is shown, never an internal one."""
        it = self.tree.by_id.get(item_id)
        if it is None:
            return item_id
        head = self.head_of(item_id) if self.is_sense(item_id) else (it.get('form') or '')
        num = self.number(item_id)
        return f'{head}#{num}' if num else head

    def ref_summary(self, it: dict) -> List[str]:
        """The reference fields an entry carries, as forms rather than ids."""
        out = []
        for f in self.ref_fields:
            ids = ref_ids(it, f)
            if ids:
                out.append(f'{f["name"]}=' + ', '.join(self.label(x) for x in ids))
        return out


def _num_key(num: str):
    """A dotted number as a sort key, so "2.10" follows "2.9"."""
    return tuple(int(p) for p in (num or '').split('.') if p.isdigit())


def _dict_hits(view: LexView, form: str, suffix: Optional[str], deep: bool = False) -> List[dict]:
    """The items a form names in a lexicon. Senses share their entry's headword,
    so a bare form means the ENTRY (or the entries, where several share it) and
    never the pile of its senses; a "#" suffix is the number the user sees,
    which tells apart both the senses under an entry ("kwatha#1.2") and entries
    that share a form ("gam#2"). A form that heads no entry falls back to any
    item carrying it, so a sense renamed away from its headword stays
    reachable.

    ``deep`` widens a bare form to the senses as well. It is for a caller that
    has something else to tell them apart with, such as entry_gloss: the gloss
    that singles one out usually IS a sense's."""
    roots = [r for r in view.tree.roots if (r.get('form') or '').lower() == (form or '').lower()]
    if not roots:
        others = [it for it in view.items if (it.get('form') or '').lower() == (form or '').lower()]
        return others if suffix is None else [it for it in others if view.number(it['id']) == suffix]
    family = list(roots)
    for r in roots:
        family.extend(descendants_of(view.tree, r['id']))
    if suffix is None:
        return family if deep else roots
    hits = [it for it in family if view.number(it['id']) == suffix]
    # A lone headword with no senses is shown with no number at all, and "#1"
    # is what the prompt teaches for a headword, so it names that one rather
    # than failing with a complaint about senses it does not have.
    if not hits and suffix == '1' and len(roots) == 1 and not view.number(roots[0]['id']):
        return roots
    return hits


def entry_line(it: dict, view: Optional[LexView] = None) -> str:
    """One entry as a line: its form, then its fields. The reserved keys are
    never fields (they are the sense tree and the promoted examples), so they
    are left out here and said in words instead when a view is at hand."""
    meta = it.get('metadata') or {}
    parts = [it.get('form') or '']
    # An entry this plan is creating has no id yet: it is placed by its
    # metadata alone, and its references still read as the entries they name.
    placed = view is not None and bool(it.get('id'))
    if placed and view.is_sense(it['id']):
        parts.append(f'sense {view.number(it["id"])} of "{view.head_of(it["id"])}"')
    if meta.get('morphType'):
        parts.append(f'type={meta["morphType"]}')
    ref_names = {f['name'] for f in (view.ref_fields if view is not None else [])}
    hidden = (view.hidden_fields(it) if placed
              else {f['name'] for f in (view.fields if view is not None else [])}
              - {f['name'] for f in fields_for_item(view.fields if view is not None else [], it)})
    for k, v in meta.items():
        if (k in RESERVED_ITEM_KEYS or k == 'morphType' or k in ref_names or k in hidden
                or k.startswith('prov') or v in (None, '', [], {})):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        parts.append(f'{k}={v}')
    if view is not None:
        parts.extend(view.ref_summary(it))
    n_ex = len(all_examples(it))
    if n_ex:
        parts.append(f'{n_ex} example{"s" if n_ex != 1 else ""}')
    if placed:
        n_s = len(view.tree.senses_of(it['id']))
        if n_s:
            parts.append(f'{n_s} sense{"s" if n_s != 1 else ""} below')
    return ' | '.join(parts)
