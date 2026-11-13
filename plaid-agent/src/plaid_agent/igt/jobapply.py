"""What a job applies by itself: THE apply rule (the owner's ruling 13 of
2026-11-13, "blanks and its own work only").

A job's model has the assistant's whole tool list and stages a plan as the
assistant does. Nobody approves it. When the piece ends, the worker takes the
document's lock, reads the document again, and asks :func:`decide` of every
staged op, by what the op would change in the document AS IT IS THEN, never by
which tool staged it or what the model said:

* applied, as the job's machine proposal: an op that fills something empty
  (an empty value, a word nobody analysed) in a sentence the job has not
  written in before, an op that revises the job's own unverified work it can
  vouch for (:func:`plaid_agent.igt.job.harmonize_bar`, the rule harmonize
  rewrites by), a link from a morpheme the job is writing, and a new lexicon
  entry such a link names, in a lexicon of the project's own with a Status
  field (written with Status ``machine``);
* recorded as a PROPOSED CHANGE, not applied: everything else. A value a
  person wrote or confirmed, another machine's proposal, any deletion, any
  rename, a tagset change, a text or token edit, a guideline, a comment, a
  document or project setting, a corpus-wide rule;
* an op kind not named in :data:`APPLIED_KINDS`, :data:`PROPOSED_KINDS` or
  :data:`IGNORED_KINDS` is recorded as proposed: a new kind is never applied
  until it is named here.

A plan is split, and an op the rule would apply that depends on one it does
not (:func:`depends_on`, the plan layer's own links between ops: a link on a
morpheme a staged analysis makes, a link to an entry the plan creates, a
change in a sentence a reshape of the plan re-cuts) is not applied either.

"Empty" is not enough in a sentence the job has written in before: its
writing rows name every word of such a sentence (``known``, REV-B4-1), and a
value empty there may be one a person cleared. Only the job's own vouched
work is revised there.
"""

from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from .plan import KIND, RESHAPES, analysed_morphemes
from .project import IgtProject, is_virtual
from .vocab import ROLE_STATUS

#: The kinds the rule may apply, each by its own test below.
APPLIED_KINDS = frozenset({'set_span', 'set_analysis', 'link', 'create_entry', 'set_morph_type',
                           'set_morpheme_form'})
#: The kinds the rule never applies: each is recorded as a proposed change.
PROPOSED_KINDS = frozenset({
    'add_comment', 'add_guideline', 'revise_guideline', 'rewrite_guideline', 'assign_tagset', 'set_tagset',
    'bulk_scope', 'confirm', 'create_document', 'delete_entry', 'delete_word', 'discard_analysis', 'edit_text',
    'link_phrase', 'merge_entries', 'merge_sentences', 'merge_words', 'rename_document', 'rename_entry', 'respell',
    'restore_document', 'set_doc_metadata', 'set_entry_field', 'set_entry_metadata', 'set_orthography',
    'split_sentence', 'split_word', 'unlink'})
#: Kinds that write nothing of their own: a value kept out of a rule, which
#: means nothing once the rule itself is a proposed change.
IGNORED_KINDS = frozenset({'keep'})

APPLY, PROPOSE, IGNORE = 'apply', 'propose', 'ignore'


def token_of(op: Dict[str, Any]) -> Optional[str]:
    """The token an op is about, as the worker places it: a link of a planned
    morpheme by its word, else the word, the morpheme, the token."""
    return (op.get('analysis_word_id') or op.get('word_id') or op.get('morpheme_id') or op.get('token_id')
            or op.get('sentence_id'))


def _found(doc, token_id: Optional[str]):
    """(sentence, word, morpheme) of ``token_id`` in ``doc``, or None. A
    word's derived morpheme (``virtual:<word id>``) is its word's."""
    if not token_id:
        return None
    hit = doc.find(token_id)
    if hit is None and is_virtual(token_id):
        hit = doc.find(token_id.split(':', 1)[1])
    return hit


class Rule:
    """The rule over one document as read under its lock. ``known`` holds the
    tags of every word of a sentence the job wrote in before
    (``IgtRunner.known_words``), ``own(word)`` says whether a word is the
    job's own vouched work (``harmonize_bar`` is None), ``target(word)``
    whether a word is blank (``blank_word``), ``tag(word_id)`` a word's tag
    and ``job_piece(metadata)`` whether a piece is the job's own unverified
    work."""

    def __init__(self, doc, project: IgtProject, known, *, own: Callable[[Any], bool],
                 target: Callable[[Any], bool], tag: Callable[[str], str], job_piece: Callable[[Any], bool],
                 value_blank: Optional[Callable[[Any, str], bool]] = None,
                 value_own: Optional[Callable[[Any, str], bool]] = None):
        self.doc = doc
        self.project = project
        self.known = known
        self.own = own
        self.target = target
        self.tag = tag
        self.job_piece = job_piece
        # A sentence's value: empty for the job (``blank_value``) and its own
        # to revise (``own_value``), read with the document's comments. With
        # no comments read: no span at all, and the job's own span.
        self.value_blank = value_blank or (lambda s, name: s.fields.get(name) is None)
        self.value_own = value_own or (lambda s, name: s.fields.get(name) is not None
                                       and self.job_piece(s.fields[name].metadata))

    def wrote_in(self, s) -> bool:
        return bool(self.known) and any(self.tag(w.id) in self.known for w in s.words)

    def set_span(self, op) -> bool:
        if (op.get('value') or '') == '':
            return False  # a deletion
        f = self.project.field_by_layer(op.get('layer_id'))
        hit = _found(self.doc, op.get('token_id'))
        if f is None or hit is None:
            return False
        s, w, m = hit
        holder = m if f.scope == 'Morpheme' else w if f.scope == 'Word' else s
        if holder is None:
            return False
        if f.scope == 'Sentence':
            # The same rule as a word's (REV-JG3-4): nothing of anyone else's
            # there, an empty span included, and no comment on it.
            if self.value_blank(s, f.name):
                return not self.wrote_in(s)
            return self.value_own(s, f.name)
        sp = holder.fields.get(f.name)
        empty = sp is None or (sp.value or '') == ''
        # A word's or a morpheme's value: filled where the word is blank and
        # its sentence new to the job, or the word's whole analysis is the
        # job's own vouched work (where an empty value of it is the job's to
        # fill, and a value of it the job's to revise).
        if self.own(w):
            return empty or self.job_piece(sp.metadata)
        return empty and self.target(w) and not self.wrote_in(s)

    def set_analysis(self, op) -> bool:
        hit = _found(self.doc, op.get('word_id'))
        if hit is None or hit[1] is None:
            return False
        s, w, _ = hit
        return (self.target(w) and not self.wrote_in(s)) or self.own(w)

    def link(self, op) -> bool:
        if op.get('analysis_word_id'):
            return True  # its analysis decides (``depends_on``)
        hit = _found(self.doc, op.get('token_id'))
        if hit is None or hit[1] is None:
            return False
        s, w, m = hit
        if m is not None and m.virtual:
            return self.target(w) and not self.wrote_in(s)
        return self.own(w)

    def morpheme(self, op) -> bool:
        hit = _found(self.doc, op.get('morpheme_id'))
        return hit is not None and hit[1] is not None and self.own(hit[1])

    def create_entry(self, op) -> bool:
        if op.get('job_why'):
            return False  # an entry the job may not make (``IgtRunner.entries_that_fit``)
        v = next((x for x in self.project.vocabs if x['id'] == op.get('vocab_id')), None)
        if v is None or v.get('borrowed') or not IgtProject.lexicon_field(v, ROLE_STATUS):
            return False
        # A sense hangs off an entry it changes the tree of.
        from .vocab import parent_of
        return not parent_of({'metadata': op.get('metadata') or {}})

    def alone(self, op) -> str:
        """The rule for ``op`` by itself, before what it depends on."""
        kind = op.get('kind')
        if kind in IGNORED_KINDS:
            return IGNORE
        if kind not in APPLIED_KINDS:
            return PROPOSE
        test = {'set_span': self.set_span, 'set_analysis': self.set_analysis, 'link': self.link,
                'set_morph_type': self.morpheme, 'set_morpheme_form': self.morpheme,
                'create_entry': self.create_entry}[kind]
        return APPLY if test(op) else PROPOSE


def depends_on(ops: List[Dict[str, Any]], sentence_of: Callable[[Optional[str]], Optional[str]],
               reshaped: Callable[[Dict[str, Any]], Optional[Set[str]]]) -> Dict[int, Set[int]]:
    """For each op (by index), the ops it depends on, by the plan layer's own
    links between ops: a link on a morpheme of a staged analysis, or a change
    to a morpheme the analysis replaces, depends on that analysis; a link to
    an entry the plan creates depends on its create, and a create on a link
    naming it; any op in a sentence a reshape of the plan re-cuts
    (``reshaped(op)``: its sentence ids, or None for the whole document)
    depends on that reshape. ``sentence_of`` places a token."""
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
    either, until nothing changes. A create is applied only when a link it
    stands for is."""
    fate = [rule.alone(op) for op in ops]
    deps = depends_on(ops, sentence_of, reshaped)
    named = {i: [j for j, o in enumerate(ops) if o.get('kind') in ('link', 'link_phrase')
                 and o.get('new_entry_key') == op.get('key')]
             for i, op in enumerate(ops) if op.get('kind') == 'create_entry'}
    changed = True
    while changed:
        changed = False
        for i in range(len(ops)):
            if fate[i] != APPLY:
                continue
            if any(fate[j] != APPLY for j in deps[i]) or (i in named and not any(fate[j] == APPLY
                                                                                  for j in named[i])):
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
