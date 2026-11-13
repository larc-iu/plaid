"""What a job applies by itself: THE apply rule (the owner's rulings 17 to 20
of 2026-11-13, "a job applies what it plans").

A job's model has the assistant's whole tool list and stages a plan as the
assistant does. Nobody approves it. When the piece ends, the worker takes the
document's lock, reads the document again, drops what the model staged in a
sentence that changed since it read it (``IgtRunner.recheck``), and asks
:func:`decide` of every other op, by its kind and where it writes:

* applied: every change inside the job's documents and in the project's
  lexicons, whoever wrote what it changes or deletes. A value it writes is
  stamped as the job's unverified machine proposal, an entry it creates gets
  Status ``machine``, and a change with no stamp (a deletion, a merge, a text
  edit) is made under the job's History entry of the document;
* recorded as a PROPOSED CHANGE, not applied: project setup (ruling 19: the
  guidelines, tagsets, a document's metadata, creating or renaming a
  document), the few kinds a job cannot apply for what they are
  (:data:`UNAPPLIED_KINDS`), an op that writes in another document than the
  one under the lock, and a rename, merge or deletion of an entry when the
  person who started the job is no maintainer of the project (core refuses
  it to them);
* an op kind not named here is recorded as proposed: a new kind is never
  applied until it is named. No kind of the plan layer deletes a document
  (ruling 18), and one added later is refused by this rule until it is named.

A plan is split, and an op that depends on one not applied is not applied
either (:func:`depends_on`, the plan layer's own links between ops: a link on
a morpheme a staged analysis makes, a link to an entry the plan creates, a
change in a sentence a reshape of the plan re-cuts).
"""

from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from .plan import KIND, LEXICON_MAINTAINER, RESHAPES, analysed_morphemes, lexicon_need
from .project import IgtProject, is_virtual
from .vocab import ROLE_STATUS

#: Project setup (ruling 19): never applied, listed for a person.
SETUP_KINDS = frozenset({'add_guideline', 'revise_guideline', 'rewrite_guideline', 'assign_tagset', 'set_tagset',
                         'create_document', 'rename_document', 'set_doc_metadata'})
#: Never applied for what they are, besides setup: a corpus-wide rule is
#: resolved over many documents and checked under no one document's lock, a
#: confirmation makes work verified where a job writes only unverified
#: proposals, and a restore is the server's own operation over a whole
#: document, outside the job's History entry of it.
UNAPPLIED_KINDS = frozenset({'bulk_scope', 'confirm', 'restore_document'})
PROPOSED_KINDS = SETUP_KINDS | UNAPPLIED_KINDS
#: Kinds that write nothing of their own: a value kept out of a rule, which
#: means nothing once the rule itself is a proposed change.
IGNORED_KINDS = frozenset({'keep'})
#: Every other kind of the plan layer: applied, in the document under the
#: lock or in the project's own lexicons.
APPLIED_KINDS = frozenset({
    'set_span', 'set_analysis', 'set_orthography', 'respell', 'link', 'unlink', 'link_phrase', 'create_entry',
    'set_entry_field', 'set_entry_metadata', 'merge_entries', 'delete_entry', 'rename_entry', 'discard_analysis',
    'set_morpheme_form', 'set_morph_type', 'split_word', 'merge_words', 'delete_word', 'split_sentence',
    'merge_sentences', 'edit_text', 'add_comment'})
#: Applied ops that take something away, as the report counts them
#: (``deletions``): a value cleared, an analysis discarded, a word deleted, a
#: link removed, an entry deleted. A merge keeps what it merges into, and a
#: rewrite replaces: neither is counted here.
DELETING_KINDS = frozenset({'discard_analysis', 'delete_word', 'unlink', 'delete_entry'})

APPLY, PROPOSE, IGNORE = 'apply', 'propose', 'ignore'

#: The keys an op names a token, span or link by, one or several.
_ONE = ('analysis_word_id', 'word_id', 'morpheme_id', 'token_id', 'sentence_id', 'other_id', 'token_id_hint',
        'entity_id')
_MANY = ('token_ids', 'span_ids', 'link_ids', 'other_ids')


def deletes(op: Dict[str, Any]) -> bool:
    """Whether an applied op takes something away (:data:`DELETING_KINDS`,
    or a value set to nothing)."""
    return op.get('kind') in DELETING_KINDS or (op.get('kind') == 'set_span' and (op.get('value') or '') == '')


def token_of(op: Dict[str, Any]) -> Optional[str]:
    """The token an op is about, as the worker places it: a link of a planned
    morpheme by its word, else the word, the morpheme, the token, the first
    of the tokens it names."""
    for key in _ONE:
        if op.get(key):
            return op[key]
    for key in _MANY:
        if op.get(key):
            return op[key][0]
    return None


def _found(doc, token_id: Optional[str]):
    """(sentence, word, morpheme) of ``token_id`` in ``doc``, or None. A
    word's derived morpheme (``virtual:<word id>``) is its word's."""
    if not token_id:
        return None
    hit = doc.find(token_id)
    if hit is None and is_virtual(token_id):
        hit = doc.find(token_id.split(':', 1)[1])
    return hit


def sentence_of(op: Dict[str, Any], doc):
    """The sentence of ``doc`` an op writes in, or None: by the first token,
    span or link it names, else by its place in the text (``text_id`` and
    ``begin``, a respelling or a text edit)."""
    hit = _found(doc, token_of(op))
    if hit is not None:
        return hit[0]
    if op.get('text_id') is not None and op.get('text_id') == getattr(doc, 'text_id', None) \
            and isinstance(op.get('begin'), int):
        return next((s for s in doc.sentences if s.begin <= op['begin'] < max(s.end, s.begin + 1)), None)
    return None


def place(op: Dict[str, Any], doc) -> str:
    """Where an op writes, against ``doc`` (the document under the lock):
    ``here``, ``elsewhere`` (another document, or ids this document does
    not hold), or ``none`` (it names no document: a lexicon change, a
    setting)."""
    named = op.get('document_id') or op.get('doc')
    if named:
        return 'here' if named == doc.id else 'elsewhere'
    if op.get('document_ids') or op.get('documents'):
        return 'elsewhere'
    if op.get('text_id'):
        return 'here' if op['text_id'] == getattr(doc, 'text_id', None) else 'elsewhere'
    ids = [op[k] for k in _ONE if op.get(k)] + [i for k in _MANY for i in op.get(k) or []]
    if not ids:
        return 'none'
    return 'here' if all(_found(doc, i) is not None for i in ids) else 'elsewhere'


class Rule:
    """The rule over one document as read under its lock (``doc``).
    ``maintainer()`` says whether the person who started the job may
    rename, merge or delete entries (core refuses the job's token
    otherwise), asked only of such a change."""

    def __init__(self, doc, project: IgtProject, maintainer: Callable[[], bool] = lambda: True):
        self.doc = doc
        self.project = project
        self.maintainer = maintainer

    def create_entry(self, op) -> bool:
        """An entry is made in a lexicon of the project's own that has a
        Status field, so that it carries Status ``machine`` (ruling 2)."""
        v = next((x for x in self.project.vocabs if x['id'] == op.get('vocab_id')), None)
        return v is not None and not v.get('borrowed') and bool(IgtProject.lexicon_field(v, ROLE_STATUS))

    def alone(self, op) -> str:
        """The rule for ``op`` by itself, before what it depends on."""
        kind = op.get('kind')
        if kind in IGNORED_KINDS:
            return IGNORE
        if kind not in APPLIED_KINDS:
            return PROPOSE
        if place(op, self.doc) == 'elsewhere':
            return PROPOSE  # not under this document's lock
        if kind == 'create_entry' and not self.create_entry(op):
            return PROPOSE
        need = lexicon_need(op)
        if need is not None and need[0] == LEXICON_MAINTAINER and not self.maintainer():
            return PROPOSE  # core refuses it to the starter
        return APPLY


def depends_on(ops: List[Dict[str, Any]], sentence_of: Callable[[Optional[str]], Optional[str]],
               reshaped: Callable[[Dict[str, Any]], Optional[Set[str]]]) -> Dict[int, Set[int]]:
    """For each op (by index), the ops it depends on, by the plan layer's own
    links between ops: a link on a morpheme of a staged analysis, or a change
    to a morpheme the analysis replaces, depends on that analysis; a link to
    an entry the plan creates depends on its create; any op in a sentence a
    reshape of the plan re-cuts (``reshaped(op)``: its sentence ids, or None
    for the whole document) depends on that reshape. ``sentence_of`` places
    a token."""
    deps: Dict[int, Set[int]] = {i: set() for i in range(len(ops))}
    analysis_of = {op.get('word_id'): i for i, op in enumerate(ops) if op.get('kind') == 'set_analysis'}
    rewritten: Dict[str, int] = {}
    for i, op in enumerate(ops):
        if op.get('kind') == 'set_analysis':
            for mid in analysed_morphemes([op]):
                rewritten[mid] = i
    created = {op.get('key'): i for i, op in enumerate(ops) if op.get('kind') == 'create_entry'}
    shapes: List[Tuple[int, Optional[Set[str]]]] = []
    for i, op in enumerate(ops):
        if op.get('kind') in RESHAPES and op.get('kind') not in ('set_analysis', 'discard_analysis'):
            shapes.append((i, reshaped(op)))
    for i, op in enumerate(ops):
        kind = op.get('kind')
        if kind in ('link', 'link_phrase') and op.get('new_entry_key') in created:
            deps[i].add(created[op['new_entry_key']])
        if kind == 'link' and op.get('analysis_word_id') in analysis_of:
            deps[i].add(analysis_of[op['analysis_word_id']])
        for key in ('token_id', 'morpheme_id'):
            if op.get(key) in rewritten and rewritten[op[key]] != i:
                deps[i].add(rewritten[op[key]])
        sid = sentence_of(token_of(op))
        for j, where in shapes:
            if j != i and (where is None or (sid is not None and sid in where)):
                deps[i].add(j)
    return deps


def decide(ops: List[Dict[str, Any]], rule: Rule, sentence_of, reshaped) -> List[str]:
    """APPLY, PROPOSE or IGNORE for each of ``ops``, in order: each op by the
    rule alone, then every op that depends on one not applied is not applied
    either, until nothing changes."""
    fate = [rule.alone(op) for op in ops]
    deps = depends_on(ops, sentence_of, reshaped)
    changed = True
    while changed:
        changed = False
        for i in range(len(ops)):
            if fate[i] == APPLY and any(fate[j] != APPLY for j in deps[i]):
                fate[i] = PROPOSE
                changed = True
    return fate


def known_kinds() -> Set[str]:
    """Every kind the rule names, which a test holds against the plan's
    registry so that a kind added there is named here before it is used."""
    return set(APPLIED_KINDS | PROPOSED_KINDS | IGNORED_KINDS)


def unnamed_kinds() -> Set[str]:
    """Kinds of the plan's registry the rule does not name: refused (recorded
    as proposed) until they are."""
    return set(KIND) - known_kinds()
