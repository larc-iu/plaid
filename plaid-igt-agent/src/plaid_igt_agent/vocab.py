"""The vocabulary domain as the agent reads it: the field schema, and the
dictionary side of a vocabulary with Lexicography Mode on (the sense tree,
references from one entry to another, promoted examples).

A port of plaid-igt/src/domain/vocabFields.js and vocabDictionary.js, which is
where the app writes all of this. The two must stay in step: these shapes are
read back by the same screens, and the app's load-time validator
(validateVocabRefs) repairs on sight anything that does not match.

The public surface deliberately mirrors those modules name for name, including
a few pieces nothing here calls yet, so the two can be read side by side and
checked against each other. Keep it that way: a mirror that is missing is a
divergence waiting to happen, not dead weight.

Nothing on the dictionary side applies to a vocabulary whose Lexicography Mode
switch (``config.igt.dictionary``) is off: it is the flat list it always was.

Reserved item keys, which are never fields:
  parent      the id of the entry this one is a sense of. An item with no
              parent is an ENTRY: its form is the headword. Its senses are
              numbered 1, 2, ..., theirs 1.1, 1.2. The entry has no sense
              number of its own.
  senseOrder  an integer ordering an item among its siblings. Missing orders
              sort after the numbered ones, in creation order.
  homograph   an integer ordering an ENTRY among the entries spelled the same.
              Same fallback.
  examples    a list of {document, token} references. A FLEx import stores
              {text, translation} entries in the same list; those are text.

A field of type ``item`` holds a reference (or, with ``many``, a list of them)
to another entry of the SAME vocabulary. References never cross vocabularies.
"""

import math
from typing import Dict, List, Optional, Tuple

IGT_NAMESPACE = 'igt'

PARENT_KEY = 'parent'
SENSE_ORDER_KEY = 'senseOrder'
# The order of an entry among the entries that share its form. A FLEx import
# writes FLEx's homograph number here; reordering in the app rewrites it 1..n.
HOMOGRAPH_KEY = 'homograph'
EXAMPLES_KEY = 'examples'
DICTIONARY_KEY = 'dictionary'

# The editorial status field a dictionary vocabulary is seeded with.
STATUS_FIELD = 'status'
STATUS_TAGSET = 'Status'
STATUS_VALUES = ('draft', 'reviewed', 'published')

# Keys an entry may carry that are never fields. A schema can never shadow one.
RESERVED_ITEM_KEYS = frozenset({'form', 'parent', 'senseOrder', 'examples',
                                'flexEntry', 'flexSense', 'homograph'})

FIELD_TEXT = 'text'
FIELD_ITEM = 'item'
SCOPE_ENTRY = 'entry'
SCOPE_SENSE = 'sense'

CORE_VOCAB_FIELDS = (
    {'name': 'morphType', 'inline': False, 'immutable': True},
    {'name': 'gloss', 'inline': True, 'immutable': True},
    {'name': 'pos', 'inline': True, 'immutable': False},
    {'name': 'definition', 'inline': False, 'immutable': False},
)
_IMMUTABLE = tuple(f['name'] for f in CORE_VOCAB_FIELDS if f['immutable'])
_CORE_BY_NAME = {f['name']: f for f in CORE_VOCAB_FIELDS}


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ''


def _is_id(v) -> bool:
    return isinstance(v, str) and v.strip() != ''


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_reserved_field_name(name) -> bool:
    n = str(name or '').strip().lower()
    return any(k.lower() == n for k in RESERVED_ITEM_KEYS)


# ---- the field schema -------------------------------------------------------

def normalize_vocab_fields(raw: Optional[dict]) -> List[dict]:
    """A vocab layer's ``igt.fields`` config as an ordered list of field specs,
    tolerating the legacy boolean format and guaranteeing the immutable core
    fields are present. Mirrors normalizeVocabFields in vocabFields.js, so the
    agent sees exactly the fields the app's own editor does."""
    out: List[dict] = []
    seen = set()
    declared = set(raw.keys()) if isinstance(raw, dict) else set()

    def add(name, cfg):
        if not name or is_reserved_field_name(name) or name in seen:
            return
        seen.add(name)
        obj = cfg if isinstance(cfg, dict) else None
        inline = bool(obj.get('inline')) if obj else bool(cfg)
        immutable = name in _IMMUTABLE
        # The core fields hold text whatever the config says.
        ftype = FIELD_TEXT if immutable else (
            FIELD_ITEM if _str((obj or {}).get('type')) == FIELD_ITEM else FIELD_TEXT)
        out.append({
            'name': name,
            'inline': inline,
            'immutable': immutable,
            'tagset': _str((obj or {}).get('tagset')) or None,
            'lang': _str((obj or {}).get('lang')) or None,
            'type': ftype,
            'many': ftype == FIELD_ITEM and bool((obj or {}).get('many')),
            'scope': SCOPE_ENTRY if _str((obj or {}).get('scope')) == SCOPE_ENTRY else SCOPE_SENSE,
            # False for an immutable field the config never named: the app shows
            # it, but it is not what this vocabulary chose to record.
            'declared': name in declared,
        })

    if isinstance(raw, dict):
        for name, cfg in raw.items():
            add(name, cfg)
    for name in _IMMUTABLE:
        if name not in seen:
            add(name, {'inline': _CORE_BY_NAME[name]['inline']})

    def core_idx(name):
        for i, f in enumerate(CORE_VOCAB_FIELDS):
            if f['name'] == name:
                return i
        return len(CORE_VOCAB_FIELDS) + 1
    pinned = sorted([f for f in out if f['immutable']], key=lambda f: core_idx(f['name']))
    return pinned + [f for f in out if not f['immutable']]


def field_by_name(fields: List[dict], name) -> Optional[dict]:
    """A field spec by case-insensitive name."""
    key = str(name or '').strip().lower()
    return next((f for f in fields or [] if f['name'].lower() == key), None)


def item_ref_fields(fields: List[dict]) -> List[dict]:
    """The fields that hold references to other entries."""
    return [f for f in fields or [] if f.get('type') == FIELD_ITEM]


def fields_for_item(fields: List[dict], item: dict, dictionary: bool) -> List[dict]:
    """The fields that belong on an item: entry-scope fields only on an entry."""
    if not dictionary:
        return list(fields or [])
    return [f for f in fields or [] if f.get('scope') != SCOPE_ENTRY or not parent_of(item)]


def dictionary_enabled(config: Optional[dict]) -> bool:
    """Whether a vocabulary's Lexicography Mode switch is on."""
    return ((config or {}).get(IGT_NAMESPACE) or {}).get(DICTIONARY_KEY) is True


# ---- reserved keys on an item ------------------------------------------------

def parent_of(item: Optional[dict]) -> Optional[str]:
    """The id this item is a sense of, or None."""
    v = ((item or {}).get('metadata') or {}).get(PARENT_KEY)
    return v if _is_id(v) else None


def sense_order_of(item: Optional[dict]):
    """The item's order among its siblings, or None when unnumbered."""
    v = ((item or {}).get('metadata') or {}).get(SENSE_ORDER_KEY)
    return v if _is_num(v) else None


def ref_ids(item: dict, field: dict) -> List[str]:
    """The ids a reference field holds on an item, always as a list."""
    v = ((item or {}).get('metadata') or {}).get(field['name'])
    if field.get('many'):
        return [x for x in v if _is_id(x)] if isinstance(v, list) else []
    return [v] if _is_id(v) else []


def with_ref_ids(metadata: Optional[dict], field: dict, ids) -> dict:
    """The ids written back onto a metadata map, key dropped when empty."""
    nxt = dict(metadata or {})
    clean = list(dict.fromkeys(x for x in (ids or []) if _is_id(x)))
    if not clean:
        nxt.pop(field['name'], None)
    else:
        nxt[field['name']] = clean if field.get('many') else clean[0]
    return nxt


def with_parent(metadata: Optional[dict], parent_id: Optional[str], order) -> dict:
    nxt = dict(metadata or {})
    if parent_id:
        nxt[PARENT_KEY] = parent_id
    else:
        nxt.pop(PARENT_KEY, None)
    if parent_id and _is_num(order):
        nxt[SENSE_ORDER_KEY] = order
    elif not parent_id:
        nxt.pop(SENSE_ORDER_KEY, None)
    return nxt


def example_refs(item: Optional[dict]) -> List[dict]:
    """Promoted example references on an item, {document, token} only."""
    v = ((item or {}).get('metadata') or {}).get(EXAMPLES_KEY)
    return [e for e in v if isinstance(e, dict) and _is_id(e.get('document')) and _is_id(e.get('token'))] \
        if isinstance(v, list) else []


def all_examples(item: Optional[dict]) -> List[dict]:
    """The whole examples list, references and imported text alike, in order."""
    v = ((item or {}).get('metadata') or {}).get(EXAMPLES_KEY)
    if not isinstance(v, list):
        return []
    return [e for e in v if isinstance(e, dict) and
            ((_is_id(e.get('document')) and _is_id(e.get('token'))) or isinstance(e.get('text'), str))]


def with_example_added(metadata: Optional[dict], ref: dict) -> dict:
    """The examples list with one reference added (a duplicate is ignored)."""
    lst = all_examples({'metadata': metadata})
    if any(e.get('document') == ref['document'] and e.get('token') == ref['token'] for e in lst):
        return dict(metadata or {})
    return {**(metadata or {}), EXAMPLES_KEY: lst + [{'document': ref['document'], 'token': ref['token']}]}


def with_example_removed(metadata: Optional[dict], index: int) -> dict:
    """The examples list with the example at ``index`` gone, key dropped when empty."""
    lst = [e for i, e in enumerate(all_examples({'metadata': metadata})) if i != index]
    nxt = dict(metadata or {})
    if lst:
        nxt[EXAMPLES_KEY] = lst
    else:
        nxt.pop(EXAMPLES_KEY, None)
    return nxt


# ---- the sense tree ----------------------------------------------------------

class SenseTree:
    """The tree over a vocabulary's items, built by :func:`build_sense_tree`.

    ``items`` come in creation order (as the server returns them), which is what
    unnumbered siblings fall back to. A parent that is not among the items counts
    as none, and so does a parent chain that loops: those items are roots, and
    the app's validator clears the references that put them there.
    """

    __slots__ = ('by_id', 'children_of', 'parent_of', 'roots', 'number_of', 'depth_of', 'root_of')

    def __init__(self, by_id, children_of, parent_of, roots, number_of, depth_of, root_of):
        self.by_id = by_id
        self.children_of = children_of
        self.parent_of = parent_of
        self.roots = roots
        self.number_of = number_of
        self.depth_of = depth_of
        self.root_of = root_of

    def number(self, item_id: str) -> str:
        """An item's place in its own entry's sense hierarchy: "" for an entry,
        then "1", "2", "1.1" below it. This is the PATH only. The number the
        user is shown also carries the entry's homograph segment in front of
        it, which is what :func:`build_item_numbers` assembles."""
        return self.number_of.get(item_id, '')

    def is_sense(self, item_id: str) -> bool:
        return bool(self.parent_of.get(item_id))

    def entry_of(self, item_id: str) -> Optional[dict]:
        """The entry (root) an item belongs to."""
        return self.by_id.get(self.root_of.get(item_id))

    def senses_of(self, item_id: str) -> List[dict]:
        return list(self.children_of.get(item_id) or [])


def build_sense_tree(items: Optional[List[dict]]) -> SenseTree:
    """Mirrors buildSenseTree in vocabDictionary.js, cycle handling included."""
    lst = list(items or [])
    by_id = {it['id']: it for it in lst}
    position = {it['id']: i for i, it in enumerate(lst)}
    parents: Dict[str, Optional[str]] = {}
    children: Dict[str, List[dict]] = {it['id']: [] for it in lst}
    for it in lst:
        p = parent_of(it)
        ok = bool(p) and p != it['id'] and p in by_id
        parents[it['id']] = p if ok else None
    root_of: Dict[str, str] = {}
    depth_of: Dict[str, int] = {}

    def resolve(start: str):
        if start in root_of:
            return root_of[start]
        chain: List[str] = []
        cur: Optional[str] = start
        seen = set()
        while cur and cur not in root_of:
            if cur in seen:
                # A cycle: cut every link on it, as the validator will.
                for c in chain:
                    parents[c] = None
                    root_of[c] = c
                    depth_of[c] = 0
                return root_of.get(start)
            seen.add(cur)
            chain.append(cur)
            cur = parents.get(cur)
        base = root_of.get(cur) if cur else None
        base_depth = depth_of.get(cur, 0) if cur else -1
        # The chain's root: what the resolved ancestor rolls up to, or, with no
        # resolved ancestor, the chain's own top. Every link on the chain shares
        # it (a sense listed before its headword resolves the two together).
        root_id = base if base is not None else chain[-1]
        for i in range(len(chain) - 1, -1, -1):
            c = chain[i]
            root_of[c] = root_id
            depth_of[c] = base_depth + (len(chain) - i)
        return root_of.get(start)

    for it in lst:
        resolve(it['id'])
    # Children are collected after any cycle cut, then ordered.
    for it in lst:
        p = parents.get(it['id'])
        if p:
            children[p].append(it)

    def order_key(it):
        o = sense_order_of(it)
        # Numbered siblings first, in order; unnumbered after, in creation order.
        return (0, o, position[it['id']]) if o is not None else (1, 0, position[it['id']])
    for l in children.values():
        l.sort(key=order_key)
    roots = [it for it in lst if not parents.get(it['id'])]
    number_of: Dict[str, str] = {}

    def number(it, prefix):
        number_of[it['id']] = prefix
        for i, c in enumerate(children[it['id']]):
            number(c, f'{prefix}.{i + 1}' if prefix else str(i + 1))
    for r in roots:
        number(r, '')
    return SenseTree(by_id, children, parents, roots, number_of, depth_of, root_of)


def descendants_of(tree: SenseTree, item_id: str) -> List[dict]:
    """Every item under ``item_id``, depth-first in sense order."""
    out: List[dict] = []

    def walk(x):
        for c in tree.children_of.get(x) or []:
            out.append(c)
            walk(c['id'])
    walk(item_id)
    return out


def next_sense_order(tree: SenseTree, parent_id: str) -> int:
    """One past the largest numbered sibling, or past the count when none is."""
    sibs = tree.children_of.get(parent_id) or []
    largest = max([0] + [sense_order_of(s) or 0 for s in sibs])
    return int(max(largest, len(sibs))) + 1


def with_parent_set(tree: SenseTree, item: dict, parent_id: Optional[str]) -> dict:
    """Metadata for ``item`` made a sense of ``parent_id`` (appended last), or
    its own entry again when ``parent_id`` is None."""
    return with_parent(item.get('metadata'), parent_id,
                       next_sense_order(tree, parent_id) if parent_id else None)


def _renumbered(sibs: List[dict], parent_id: str) -> List[dict]:
    """Patches renumbering ``sibs`` 1..n under a parent, for those that change."""
    out = []
    for k, s in enumerate(sibs):
        meta = with_parent(s.get('metadata'), parent_id, k + 1)
        if sense_order_of(s) != meta[SENSE_ORDER_KEY]:
            out.append({'id': s['id'], 'metadata': meta})
    return out


def plan_sense_drop(tree: SenseTree, item_id: str, target: Optional[dict]) -> List[dict]:
    """Where a moved item lands, as [{id, metadata}] patches:
      {kind: 'root'}                its own entry (parent and order cleared)
      {kind: 'into', id}            last sense of that item
      {kind: 'before'|'after', id}  a sibling of that item, just before or after

    A move onto itself, or into its own subtree, moves nothing. Before or after
    an ENTRY means into it, first or last: entries have no order among
    themselves. Siblings are renumbered densely. Mirrors planSenseDrop, which
    is the app's own reordering gesture.
    """
    if not target or item_id not in tree.by_id:
        return []
    item = tree.by_id[item_id]
    in_subtree = {item_id} | {d['id'] for d in descendants_of(tree, item_id)}
    kind = target.get('kind')
    if kind == 'root':
        if not tree.parent_of.get(item_id):
            return []
        return [{'id': item_id, 'metadata': with_parent(item.get('metadata'), None, None)}]
    tid = target.get('id')
    if tid not in tree.by_id or tid in in_subtree:
        return []
    if kind == 'into' or not tree.parent_of.get(tid):
        parent = tid
        sibs = [s for s in (tree.children_of.get(parent) or []) if s['id'] != item_id]
        at = 0 if kind == 'before' else len(sibs)
    else:
        parent = tree.parent_of.get(tid)
        sibs = [s for s in (tree.children_of.get(parent) or []) if s['id'] != item_id]
        at = next((k for k, s in enumerate(sibs) if s['id'] == tid), -1) + (1 if kind == 'after' else 0)
    sibs.insert(at, item)
    moved = tree.parent_of.get(item_id) != parent
    patches = _renumbered(sibs, parent)
    # A sibling list that already stood in this order yields no patch for the
    # moved item, so make sure its new parent is written.
    if moved and not any(p['id'] == item_id for p in patches):
        patches.append({'id': item_id,
                        'metadata': with_parent(item.get('metadata'), parent, sense_order_of(item))})
    return patches


def plan_sense_set_number(tree: SenseTree, item_id: str, shown) -> List[dict]:
    """The sibling list with ``item_id`` placed at the position it should be
    shown at among its siblings, counting from 1. Out-of-range numbers land at
    the nearest end, and the whole list is renumbered densely.

    The app dropped its own version of this when senses became draggable, and
    dragging is not a gesture an assistant has. The write is the same dense
    renumbering :func:`plan_sense_drop` produces, so the two agree.
    """
    p = tree.parent_of.get(item_id)
    if not p:
        return []
    sibs = list(tree.children_of.get(p) or [])
    i = next((k for k, s in enumerate(sibs) if s['id'] == item_id), -1)
    try:
        n = int(round(float(shown)))
    except (TypeError, ValueError):
        return []
    if i < 0:
        return []
    j = max(0, min(len(sibs) - 1, n - 1))
    if j == i:
        return []
    moved = sibs.pop(i)
    sibs.insert(j, moved)
    return _renumbered(sibs, p)


def arrange_as_tree(listed: List[dict], tree: SenseTree) -> List[Tuple[dict, int, bool]]:
    """Lay out a (filtered, sorted) list as a tree for display: a hit is shown
    under the entry it belongs to, and the entries above it come along as
    CONTEXT so a sense is never printed as though it were a headword. A context
    row is one that did not match itself; the third element of each tuple says
    which. Mirrors arrangeAsTree, so the agent's listing matches the app's By
    entry view."""
    shown = {it['id'] for it in listed}
    placed = set()
    out: List[Tuple[dict, int, bool]] = []

    def place(it, depth, context=False):
        if it['id'] in placed:
            return
        placed.add(it['id'])
        out.append((it, depth, context))
        for c in tree.children_of.get(it['id']) or []:
            # A child comes along when it matched, or when something under it did.
            if c['id'] in shown or any(d['id'] in shown for d in descendants_of(tree, c['id'])):
                place(c, depth + 1, c['id'] not in shown)

    for it in listed:
        if it['id'] in placed:
            continue
        # Start from the top of its chain, so the hit sits under its context.
        chain = []
        cur = it
        while cur:
            chain.insert(0, cur)
            p = tree.parent_of.get(cur['id'])
            cur = tree.by_id.get(p) if p else None
        place(chain[0], 0, chain[0]['id'] not in shown)
    return out


def references_to(items: List[dict], fields: List[dict], item_id: str) -> List[dict]:
    """What refers to ``item_id``, as [{item, field}]: ``field`` is a reference
    field, or None when the item is a sense of it."""
    out = []
    ref_fields = item_ref_fields(fields)
    for it in items or []:
        if it['id'] == item_id:
            continue
        if parent_of(it) == item_id:
            out.append({'item': it, 'field': None})
        for f in ref_fields:
            if item_id in ref_ids(it, f):
                out.append({'item': it, 'field': f})
    return out


# ---- integrity ---------------------------------------------------------------

def plan_delete_refs(items: List[dict], fields: List[dict], deleted_ids) -> List[dict]:
    """Patches for the items that refer to entries about to be deleted: their
    senses become entries of their own, and references to them are dropped.
    Mirrors planDeleteRefs, which is what the app's own delete does."""
    gone = set(deleted_ids or [])
    ref_fields = item_ref_fields(fields)
    patches = []
    for it in items or []:
        if it['id'] in gone:
            continue
        meta = it.get('metadata') or {}
        changed = False
        p = parent_of(it)
        if p and p in gone:
            meta = with_parent(meta, None, None)
            changed = True
        for f in ref_fields:
            ids = ref_ids(it, f)
            kept = [x for x in ids if x not in gone]
            if len(kept) != len(ids):
                meta = with_ref_ids(meta, f, kept)
                changed = True
        if changed:
            patches.append({'id': it['id'], 'metadata': meta})
    return patches


def plan_merge_refs(items: List[dict], fields: List[dict], survivor_id: str, loser_ids) -> List[dict]:
    """Patches for a merge: every reference to a losing entry now names the
    survivor, the losers' senses become the survivor's, and a survivor whose own
    parent was a loser takes that loser's parent. Losers get no patch (they are
    deleted). Mirrors planMergeRefs, which is what Bulk Edit's merge does."""
    losers = set(loser_ids or [])
    losers.discard(survivor_id)
    ref_fields = item_ref_fields(fields)
    tree = build_sense_tree(items)
    patches = []
    order = next_sense_order(tree, survivor_id)
    for it in items or []:
        if it['id'] in losers:
            continue
        meta = it.get('metadata') or {}
        changed = False
        p = parent_of(it)
        if p and p in losers:
            if it['id'] == survivor_id:
                # Walk up past every losing ancestor, through the tree rather
                # than the raw metadata: a self-parent or a cycle never ends.
                up = p
                while up and (up in losers or up == survivor_id):
                    up = tree.parent_of.get(up)
                meta = with_parent(meta, up or None, next_sense_order(tree, up) if up else None)
            else:
                meta = with_parent(meta, survivor_id, order)
                order += 1
            changed = True
        for f in ref_fields:
            ids = ref_ids(it, f)
            if not any(x in losers for x in ids):
                continue
            mapped = [survivor_id if x in losers else x for x in ids]
            meta = with_ref_ids(meta, f, [x for x in mapped if x != it['id']])
            changed = True
        if changed:
            patches.append({'id': it['id'], 'metadata': meta})
    return patches


def validate_vocab_refs(items: List[dict], fields: List[dict]) -> Tuple[List[dict], List[dict]]:
    """Every reference that points nowhere, or in a circle, as (patches,
    findings): an item whose parent is gone becomes an entry, a reference to a
    missing entry is dropped. An empty result means the vocabulary is sound.

    Mirrors validateVocabRefs, which the app runs on load for anyone who can
    write. The agent only READS this, to report what is dangling; the repair
    itself stays the app's, so it happens once and under its own operation.
    """
    lst = list(items or [])
    by_id = {it['id']: it for it in lst}
    ref_fields = item_ref_fields(fields)
    patches: List[dict] = []
    findings: List[dict] = []
    # Parent chains that never reach a root.
    on_cycle = set()
    for it in lst:
        seen = []
        seen_set = set()
        cur = it['id']
        while cur:
            if cur in seen_set:
                on_cycle.update(seen_set)
                break
            seen_set.add(cur)
            seen.append(cur)
            p = parent_of(by_id.get(cur))
            cur = p if (p and p in by_id) else None
    for it in lst:
        meta = it.get('metadata') or {}
        changed = False
        why: List[str] = []
        p = parent_of(it)
        if p and (p == it['id'] or p not in by_id):
            meta = with_parent(meta, None, None)
            changed = True
            why.append('its parent entry no longer exists')
        elif it['id'] in on_cycle:
            meta = with_parent(meta, None, None)
            changed = True
            why.append('its parent chain looped back on itself')
        elif not p and meta.get(SENSE_ORDER_KEY) is not None:
            # A stray order on an entry: harmless, cleared quietly.
            meta = with_parent(meta, None, None)
            changed = True
        for f in ref_fields:
            ids = ref_ids(it, f)
            live = [x for x in ids if x != it['id'] and x in by_id]
            raw = meta.get(f['name'])
            raw_ok = raw is None or (all(_is_id(x) for x in raw) if isinstance(raw, list)
                                     else _is_id(raw)) if f.get('many') else (raw is None or _is_id(raw))
            if f.get('many') and raw is not None and not isinstance(raw, list):
                raw_ok = False
            if len(live) != len(ids) or not raw_ok:
                meta = with_ref_ids(meta, f, live)
                changed = True
                why.append(f'{f["name"]} pointed at an entry that no longer exists')
        if not changed:
            continue
        patches.append({'id': it['id'], 'metadata': meta})
        if why:
            findings.append({'id': it['id'], 'form': it.get('form'), 'reasons': why})
    return patches, findings


# ---- rendering ---------------------------------------------------------------

def field_note(field: dict, dictionary: bool) -> str:
    """What a field holds, when it is not plain text on every item: the marker
    shown beside its name so the model knows a reference from a text field."""
    bits = []
    if field.get('type') == FIELD_ITEM:
        bits.append('an entry of this lexicon' if not field.get('many') else 'entries of this lexicon')
    if dictionary and field.get('scope') == SCOPE_ENTRY:
        bits.append('headwords only, not senses')
    return ', '.join(bits)


def vocab_field_summary(vocab: dict) -> List[str]:
    """A lexicon's entry fields for the overview, each marked when it holds a
    reference or belongs to an entry rather than every sense."""
    dictionary = bool(vocab.get('dictionary'))
    out = []
    for f in vocab.get('fields') or []:
        note = field_note(f, dictionary)
        out.append(f'{f["name"]} ({note})' if note else f['name'])
    return out


# ---- the number an item goes by ---------------------------------------------

def build_homonym_index(items: Optional[List[dict]]) -> Dict[str, Optional[int]]:
    """Items sharing a form numbered 1..n in creation order, None for a form
    only one item carries. Mirrors buildHomonymIndex in vocabHomonyms.js: the
    number a vocabulary WITHOUT Lexicography Mode shows beside a headword."""
    by_form: Dict[str, List[dict]] = {}
    for it in items or []:
        by_form.setdefault(it.get('form') or '', []).append(it)
    index: Dict[str, Optional[int]] = {}
    for group in by_form.values():
        if len(group) < 2:
            if len(group) == 1:
                index[group[0]['id']] = None
            continue
        for i, it in enumerate(group):
            index[it['id']] = i + 1
    return index


def homograph_of(item: Optional[dict]):
    """An entry's stored homograph number, or None when unnumbered or zero."""
    v = ((item or {}).get('metadata') or {}).get(HOMOGRAPH_KEY)
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and n > 0 else None


def homograph_groups(items: Optional[List[dict]], tree: Optional[SenseTree] = None) -> Dict[str, List[dict]]:
    """form -> the entries spelled that way, in homograph order then creation
    order. A FLEx import writes FLEx's homograph number, and reordering in the
    app rewrites it 1..n, so this order is the one the user set."""
    if tree is None:
        tree = build_sense_tree(items)
    position = {it['id']: i for i, it in enumerate(items or [])}
    by_form: Dict[str, List[dict]] = {}
    for r in tree.roots:
        by_form.setdefault(r.get('form') or '', []).append(r)

    def key(r):
        h = homograph_of(r)
        # Numbered entries first, in their number; the rest after, as created.
        return (0, h, position.get(r['id'], 0)) if h is not None else (1, 0.0, position.get(r['id'], 0))
    for g in by_form.values():
        g.sort(key=key)
    return by_form


def homograph_group(items: Optional[List[dict]], item_id: str) -> List[dict]:
    """The entries spelled like ``item_id``'s entry, in their order: what the
    homograph dialog lists. Empty when there is only one, which needs no
    number. Mirrors homographGroup in vocabDictionary.js."""
    tree = build_sense_tree(items)
    root = tree.by_id.get(tree.root_of.get(item_id) or '')
    if root is None:
        return []
    group = homograph_groups(items, tree).get(root.get('form') or '', [])
    return group if len(group) > 1 else []


def plan_homograph_order(group: List[dict], ordered_ids) -> List[dict]:
    """Patches writing the homograph numbers 1..n onto ``group`` in the order of
    ``ordered_ids``, for the entries whose number changes."""
    by_id = {r['id']: r for r in group or []}
    out = []
    for i, iid in enumerate(ordered_ids or []):
        r = by_id.get(iid)
        if r is None or homograph_of(r) == i + 1:
            continue
        out.append({'id': iid, 'metadata': {**(r.get('metadata') or {}), HOMOGRAPH_KEY: i + 1}})
    return out


def build_item_numbers(items: Optional[List[dict]]) -> Dict[str, str]:
    """One dotted number per item, the name it goes by everywhere in a
    dictionary vocabulary. The first segment is the HEADWORD's: its place among
    the entries spelled the same ("1", "2"), or "1" when it is alone but has
    senses. A sense carries its headword's segment and then its own path
    ("1.2", "2.1.3"). A lone headword with no senses has no number at all, so
    one segment always means a headword and two or more always mean a sense.

    Mirrors buildItemNumbers in vocabDictionary.js, which is what the
    vocabulary list, Bulk Edit and the interlinear editor draw beside a form.
    """
    tree = build_sense_tree(items)
    seg_of: Dict[str, str] = {}
    for group in homograph_groups(items, tree).values():
        if len(group) > 1:
            for i, r in enumerate(group):
                seg_of[r['id']] = str(i + 1)
        elif tree.children_of.get(group[0]['id']):
            seg_of[group[0]['id']] = '1'
    out: Dict[str, str] = {}
    for it in items or []:
        seg = seg_of.get(tree.root_of.get(it['id']) or '', '')
        path = tree.number_of.get(it['id'], '')
        out[it['id']] = f'{seg}.{path}' if seg and path else (seg or path)
    return out
