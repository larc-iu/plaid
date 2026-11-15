"""Which lexicon entry fits a morpheme: the one rule a job's create guard
(``fitting_entry``) and analyze_sentence's linking (``fits``) share, and
:func:`form_key`, the one rule by which a form names an entry in every tool.

An entry fits a form and a gloss when its form is that form and its gloss is
that gloss, after NFC. The gloss is the value of the entry field the lexicon
declares with the gloss role, never a field found by its name. A morph type
takes part where one is given: a suffix -ka 'go' is not the stem ka 'go'
(for linking, an entry that goes by no type fits a morpheme of any).

The two differ in one place, on purpose. ``fitting_entry`` compares forms as
they are, and analyze_sentence compares them as the Analyze tab's pair picker
finds an entry by its form (plaid-ui ``collationKey``: NFC, then lower case),
so a sentence-initial "Ii" finds the entry "ii". A form the picker would find
is one analyze_sentence never creates beside it.
"""

import unicodedata
from typing import Any, Dict, Iterable, List, Optional

from .project import IgtProject
from .vocab import ROLE_GLOSS, parent_of


def nfc(text) -> str:
    return unicodedata.normalize('NFC', str(text or ''))


def collation_key(form) -> str:
    """plaid-ui's ``collationKey``: NFC, then JavaScript's toLowerCase,
    which Python's ``lower`` is (not ``casefold``)."""
    return nfc(form).lower()


def form_key(form) -> str:
    """The one key by which a form finds a lexicon entry, compared between
    the entry's form as stored and the form given: analyze_sentence's linking
    (:func:`fits`, :func:`spelled`), every tool that names an entry by its
    form (``lexview._dict_hits``, ``Workspace.find_entry``, link_entry among
    them), and the entries a job piece's evidence block lists
    (``evidence.entry_lines``). Every caller reads it through this module, so
    the rule is changed here or nowhere.

    It is plaid-igt's: the pair picker finds the entries spelled like a
    morpheme by plaid-ui's ``collationKey`` of each side (``pairRows.js``
    ``byForm``), and strips no marker, since every writer of an entry form
    stores it without its affix or clitic markers (plaid_client
    ``entry_form``, R27) and its type carries them. So a morpheme "di" fits an
    entry "di" typed suffix and never one stored "-di" (EV2, 2026-11-14)."""
    return collation_key(form)


def surface_key(surface) -> str:
    """The key of a word's surface (never an entry's form, :func:`form_key`
    names those): NFC, then case-folded (CONTRACT 2.3). A job's decisions,
    people's index of analyses, and the evidence and precedent a piece is
    handed (``evidence.form_of``) all key forms by it, so what is looked up
    is found under the key it was kept by (REV-DAY-P-1: "Straße" and a final
    sigma were analysed nowhere under the lower-case key)."""
    return nfc(surface).casefold()


def entry_gloss(item: Dict[str, Any], gloss: Optional[str]) -> str:
    """The NFC value an entry (or a staged create) holds in entry field
    ``gloss``, '' without one."""
    return nfc((item.get('metadata') or {}).get(gloss)) if gloss else ''


def item_morph_type(item: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """The morph type an entry goes by: its own (the reserved key
    ``morphType``), else its headword's, else None. ``morph_type_of``'s rule,
    for items that may be staged creates with no id."""
    seen, cur = set(), item
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        t = (cur.get('metadata') or {}).get('morphType')
        if isinstance(t, str) and t:
            return t
        cur = by_id.get(parent_of({'metadata': cur.get('metadata') or {}}) or '')
    return None


def fitting_entry(v: Dict[str, Any], items: List[Dict[str, Any]], op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The first of ``items`` (entries of lexicon ``v``) that fits the
    create ``op``: the same form, gloss and morph type, after NFC (SPEC 7.2,
    the type since REV-JG3-8: a suffix -ka 'go' is not the stem ka 'go'). No
    entry is created where one fits, made by anyone, of any status."""
    gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
    form, value = nfc(op.get('form')), entry_gloss(op, gloss)
    by_id = {it['id']: it for it in items if it.get('id')}
    kind = item_morph_type(op, by_id)
    return next((it for it in items if nfc(it.get('form')) == form and entry_gloss(it, gloss) == value
                 and item_morph_type(it, by_id) == kind), None)


def fits(v: Dict[str, Any], items: Iterable[Dict[str, Any]], form: str, gloss: str,
         morph_type: Optional[str] = None, by_id: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Every one of ``items`` (entries of lexicon ``v``, senses included,
    and creates this plan stages) whose form is ``form`` as the pair picker
    finds it and whose gloss is ``gloss`` after NFC. A ``morph_type``
    given leaves out the entries that go by another type: an entry that goes
    by none still fits. A gloss is never matched against an entry of a
    lexicon that declares no gloss field."""
    key = IgtProject.lexicon_field(v, ROLE_GLOSS)
    if not key:
        return []
    items = list(items)
    if by_id is None:
        by_id = {it['id']: it for it in items if it.get('id')}
    want, value = form_key(form), nfc(gloss)
    return [it for it in items if form_key(it.get('form')) == want and entry_gloss(it, key) == value
            and (morph_type is None or item_morph_type(it, by_id) in (None, morph_type))]


def spelled(v: Dict[str, Any], items: Iterable[Dict[str, Any]], form: str) -> List[Dict[str, Any]]:
    """The ``items`` whose form is ``form`` as the pair picker finds it,
    whatever their gloss."""
    want = form_key(form)
    return [it for it in items if form_key(it.get('form')) == want]
