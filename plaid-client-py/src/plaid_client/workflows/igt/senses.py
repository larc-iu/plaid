"""A vocabulary's sense tree: which item is a sense of which entry, how the
senses are numbered, and the morph type an item is read by. The one Python
reading of it, for the agent and the services alike (R1-DEBT-CORE-9).

A port of ``buildSenseTree`` and ``morphTypeOf`` in
plaid-igt/src/domain/vocabDictionary.js, cycle handling included, held to it
by ``plaid-agent/tests/test_vocab_mirror.py`` (through
``plaid_agent.igt.vocab``, which re-exports these).

An item's ``metadata.parent`` names the entry it is a sense of, and
``metadata.senseOrder`` orders it among its siblings.
"""

import math
from typing import Dict, List, Optional

PARENT_KEY = 'parent'
SENSE_ORDER_KEY = 'senseOrder'


def _is_id(v) -> bool:
    return isinstance(v, str) and v.strip() != ''


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parent_of(item: Optional[dict]) -> Optional[str]:
    """The id this item is a sense of, or None."""
    v = ((item or {}).get('metadata') or {}).get(PARENT_KEY)
    return v if _is_id(v) else None


def sense_order_of(item: Optional[dict]):
    """The item's order among its siblings, or None when unnumbered."""
    v = ((item or {}).get('metadata') or {}).get(SENSE_ORDER_KEY)
    return v if _is_num(v) else None


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
        # Numbered siblings first, in order. Unnumbered after, in creation order.
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


def morph_type_of(tree: SenseTree, item_id: str):
    """The morph type an item is rendered and classified by: its own, else the
    nearest ancestor's. A sense made by hand carries none of its own, and it is
    the same morph as its headword. None when no item on the chain has one.
    Mirrors morphTypeOf."""
    cur = item_id
    seen = set()
    while cur and cur not in seen:
        seen.add(cur)
        it = tree.by_id.get(cur)
        t = (it.get('metadata') or {}).get('morphType') if it else None
        if isinstance(t, str) and t != '':
            return t
        cur = tree.parent_of.get(cur)
    return None
